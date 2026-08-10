/**
 * Distant mountain kit generator.
 *
 * Produces three low-poly mountain masses for the wordlark project, meant to
 * sit OUTSIDE the playable landscape as horizon silhouettes -- the mid-ground
 * layer between the region and the sky dome. Same stylized language as
 * generate-blockout-kit.ts (seeded vertex jitter + flat shading + one named
 * material per slot so Studio derives re-bindable surface slots).
 *
 * Three silhouettes, meant to be LAYERED rather than used alone:
 *   mountain-ridge-a  wide multi-peak ridge   -- fills a span of horizon
 *   mountain-peak-b   single tall peak        -- the one your eye lands on
 *   mountain-far-c    low broad hump          -- the furthest, faintest layer
 *
 * Conventions (see the asset export convention -- these matter):
 *   - PIVOT IS BOTTOM-CENTER. Geometry base sits exactly at y = 0, centered on
 *     x/z, so dropping one at ground level needs no manual Y nudge.
 *   - Object stays at the world origin; no baked transforms.
 *   - Poly budget is deliberately tiny. These are read at 200-600 units, where
 *     silhouette is the only thing that survives -- detail there is wasted.
 *
 * SCALE: authored at real size (ridge ~200 units across, peak ~110 tall), not
 * at 1-unit "import then scale up". Camera far is 1000 and the fog sky-gate
 * band starts at 940, so a mountain placed 300-600 units out sits comfortably
 * inside both and picks up atmospheric haze automatically when fog is on.
 *
 * Run: cd packages/render-web && pnpm exec tsx ~/projects/wordlark/asset-kit/generate-mountains.ts
 * Output: ~/projects/wordlark/asset-kit/mountain-*.glb
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// GLTFExporter's binary path reads a Blob through FileReader.
class FileReaderShim {
  onloadend: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  result: ArrayBuffer | string | null = null;
  readAsArrayBuffer(blob: Blob) {
    blob
      .arrayBuffer()
      .then((buffer) => {
        this.result = buffer;
        this.onloadend?.();
      })
      .catch((error) => this.onerror?.(error));
  }
  readAsDataURL(blob: Blob) {
    blob
      .arrayBuffer()
      .then((buffer) => {
        this.result = `data:application/octet-stream;base64,${Buffer.from(buffer).toString("base64")}`;
        this.onloadend?.();
      })
      .catch((error) => this.onerror?.(error));
  }
}
(globalThis as Record<string, unknown>).FileReader = FileReaderShim;

const OUT_DIR = resolve(homedir(), "projects/wordlark/asset-kit");
mkdirSync(OUT_DIR, { recursive: true });

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Palette. `Rock` / `RockDark` match generate-blockout-kit.ts so a mountain
// re-binds to the same surfaces as the cliff pieces. `Snow` is new and only
// used for peak caps -- rebind or delete the slot in Studio if you don't want
// snow on a golden-hour island.
// ---------------------------------------------------------------------------
const PALETTE: Record<string, { color: number; roughness?: number; metalness?: number }> = {
  Rock: { color: 0x8a7b6d, roughness: 0.95 },
  RockDark: { color: 0x6e6156, roughness: 0.95 },
  Snow: { color: 0xe8e6ea, roughness: 0.85 }
};

function makeMaterial(name: string): THREE.MeshStandardMaterial {
  const spec = PALETTE[name];
  if (!spec) throw new Error(`Unknown material ${name}`);
  const material = new THREE.MeshStandardMaterial({
    color: spec.color,
    roughness: spec.roughness ?? 0.9,
    metalness: spec.metalness ?? 0
  });
  material.name = name;
  return material;
}

/**
 * Jitter an INDEXED geometry's vertices (welded, so shared corners move
 * together), then facet it (non-indexed + flat normals).
 */
function facetJitter(
  geometry: THREE.BufferGeometry,
  rng: () => number,
  amp: { x: number; y: number; z: number },
  filter?: (x: number, y: number, z: number) => number
): THREE.BufferGeometry {
  const pos = geometry.getAttribute("position");
  const offsets = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    let offset = offsets.get(key);
    if (!offset) {
      offset = [
        (rng() * 2 - 1) * amp.x,
        (rng() * 2 - 1) * amp.y,
        (rng() * 2 - 1) * amp.z
      ];
      offsets.set(key, offset);
    }
    const scale = filter ? filter(x, y, z) : 1;
    pos.setXYZ(i, x + offset[0] * scale, y + offset[1] * scale, z + offset[2] * scale);
  }
  const faceted = geometry.toNonIndexed();
  faceted.computeVertexNormals();
  return faceted;
}

function mesh(geometry: THREE.BufferGeometry, materialName: string): THREE.Mesh {
  const m = new THREE.Mesh(geometry, makeMaterial(materialName));
  m.name = materialName.toLowerCase();
  return m;
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return out;
}

/**
 * One mountain mass, base at y = 0.
 *
 * A plain cone reads as a party hat: its slope is perfectly straight and its
 * base is a clean circle. Two things fix that cheaply.
 *
 * 1. PROFILE REMAP. Cone radius is linear in height; real massifs flare out
 *    near the base and taper faster up top. Each vertex's radius is remapped
 *    by (1 - t)^profileExponent where t is normalized height, giving a concave
 *    slope that reads as rock rather than as a triangle.
 * 2. PER-COLUMN RADIUS NOISE. Every radial column gets its own multiplier, so
 *    the footprint is irregular and ridges run down the flanks.
 */
function mountainMass(
  options: {
    radius: number;
    height: number;
    radialSegments: number;
    heightSegments: number;
    profileExponent: number;
    columnNoise: number;
    seed: number;
    x?: number;
    z?: number;
    rotY?: number;
  }
): THREE.BufferGeometry {
  const {
    radius,
    height,
    radialSegments,
    heightSegments,
    profileExponent,
    columnNoise,
    seed,
    x = 0,
    z = 0,
    rotY = 0
  } = options;
  const rng = mulberry32(seed);

  const geometry = new THREE.ConeGeometry(
    radius * 0.02,
    radius,
    radialSegments,
    heightSegments,
    false
  );
  // ConeGeometry is centred on its own origin; lift so the base sits at y = 0.
  geometry.scale(1, height / radius, 1);
  geometry.translate(0, height / 2, 0);

  // One radius multiplier per radial column, so a column's whole vertical run
  // moves together and forms a continuous ridge instead of per-vertex confetti.
  const columnScales: number[] = [];
  for (let i = 0; i <= radialSegments; i += 1) {
    columnScales.push(1 + (rng() * 2 - 1) * columnNoise);
  }

  const pos = geometry.getAttribute("position");
  for (let i = 0; i < pos.count; i += 1) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const t = Math.min(1, Math.max(0, py / height));
    const angle = Math.atan2(pz, px);
    const column = Math.round(
      ((angle + Math.PI) / (Math.PI * 2)) * radialSegments
    );
    const profile = Math.pow(1 - t, profileExponent);
    // Guard the apex: scaling a near-zero radius by noise would wobble the
    // summit off-centre and break the silhouette's read.
    const scale = profile * (t > 0.92 ? 1 : columnScales[column] ?? 1);
    const currentRadius = Math.hypot(px, pz);
    if (currentRadius > 1e-4) {
      const target = radius * scale;
      pos.setXYZ(i, (px / currentRadius) * target, py, (pz / currentRadius) * target);
    }
  }

  const jittered = facetJitter(
    geometry,
    rng,
    { x: radius * 0.05, y: height * 0.035, z: radius * 0.05 },
    (_jx, jy) => {
      // Keep the base ring planar so the mountain never floats above ground,
      // and calm the summit so it stays a point rather than a shredded mess.
      const t = Math.min(1, Math.max(0, jy / height));
      if (t < 0.02) return 0;
      return t > 0.9 ? 0.35 : 1;
    }
  );

  if (rotY) jittered.rotateY(rotY);
  jittered.translate(x, 0, z);
  return jittered;
}

/**
 * A snow cap sized to the mass it sits on.
 *
 * This has to be derived, not eyeballed. The mass's radius at a given height
 * is NOT its base radius -- it is `radius * (1 - t)^profileExponent` after the
 * profile remap, which for a steep peak is a small number: peak-b is 52 wide
 * at the base but under 5 at 78% height. A cap authored with a hand-picked
 * radius either swallows the summit or floats inside it.
 *
 * (The first version of this function passed `radius * 0.02` as ConeGeometry's
 * FIRST argument, copying the shape of mountainMass -- but mountainMass gets
 * away with that because it rewrites every vertex radius afterwards. Here it
 * just produced a needle 0.34 units wide, i.e. invisible snow. It rendered
 * "fine" and the slot showed up in the material list, so only looking at it
 * caught it.)
 */
function snowCap(
  options: {
    massRadius: number;
    massHeight: number;
    profileExponent: number;
    /** Normalized height where the snow line starts. */
    startT: number;
    radialSegments: number;
    seed: number;
    x?: number;
    z?: number;
  }
): THREE.BufferGeometry {
  const {
    massRadius,
    massHeight,
    profileExponent,
    startT,
    radialSegments,
    seed,
    x = 0,
    z = 0
  } = options;
  const rng = mulberry32(seed);

  const baseY = massHeight * startT;
  // Slightly wider than the rock at the snow line so the cap reads as lying ON
  // the peak rather than being flush with it and z-fighting.
  const baseRadius = massRadius * Math.pow(1 - startT, profileExponent) * 1.12;
  const capHeight = massHeight - baseY;

  const cap = new THREE.ConeGeometry(baseRadius, capHeight, radialSegments, 2, false);
  cap.translate(0, baseY + capHeight / 2, 0);

  const jittered = facetJitter(
    cap,
    rng,
    { x: baseRadius * 0.22, y: capHeight * 0.06, z: baseRadius * 0.22 },
    (_jx, jy) => (jy > baseY + capHeight * 0.85 ? 0.3 : 1)
  );
  jittered.translate(x, 0, z);
  return jittered;
}

// ---------------------------------------------------------------------------
// The three silhouettes.
// ---------------------------------------------------------------------------

/** Wide multi-peak ridge. Three overlapping masses of descending height. */
function mountainRidgeA(name: string): THREE.Group {
  const group = new THREE.Group();
  group.name = name;

  const body = merged([
    mountainMass({
      radius: 58,
      height: 82,
      radialSegments: 11,
      heightSegments: 5,
      profileExponent: 1.35,
      columnNoise: 0.16,
      seed: 101
    }),
    mountainMass({
      radius: 46,
      height: 61,
      radialSegments: 10,
      heightSegments: 4,
      profileExponent: 1.3,
      columnNoise: 0.18,
      seed: 137,
      x: -74,
      z: 14,
      rotY: 0.7
    }),
    mountainMass({
      radius: 40,
      height: 49,
      radialSegments: 9,
      heightSegments: 4,
      profileExponent: 1.25,
      columnNoise: 0.2,
      seed: 173,
      x: 68,
      z: -10,
      rotY: 1.9
    })
  ]);
  group.add(mesh(body, "Rock"));

  // Only the tallest peak gets snow -- a ridge where every summit is capped at
  // the same altitude reads as a cardboard cutout.
  group.add(
    mesh(
      snowCap({
        massRadius: 58,
        massHeight: 82,
        profileExponent: 1.35,
        startT: 0.74,
        radialSegments: 9,
        seed: 211
      }),
      "Snow"
    )
  );

  return group;
}

/** Single dramatic peak with a shoulder. */
function mountainPeakB(name: string): THREE.Group {
  const group = new THREE.Group();
  group.name = name;

  group.add(
    mesh(
      mountainMass({
        radius: 52,
        height: 112,
        radialSegments: 11,
        heightSegments: 6,
        profileExponent: 1.3,
        columnNoise: 0.17,
        seed: 307
      }),
      "Rock"
    )
  );

  // Shoulder in the darker rock so the mass reads as two planes, not one cone.
  group.add(
    mesh(
      mountainMass({
        radius: 34,
        height: 52,
        radialSegments: 9,
        heightSegments: 4,
        profileExponent: 1.2,
        columnNoise: 0.22,
        seed: 349,
        x: 52,
        z: 18,
        rotY: 2.4
      }),
      "RockDark"
    )
  );

  group.add(
    mesh(
      snowCap({
        massRadius: 52,
        massHeight: 112,
        profileExponent: 1.3,
        startT: 0.7,
        radialSegments: 10,
        seed: 383
      }),
      "Snow"
    )
  );

  return group;
}

/** Low broad hump for the furthest layer. No snow -- it should read as a
 *  flat, hazy shape, not as a detailed object competing with the foreground. */
function mountainFarC(name: string): THREE.Group {
  const group = new THREE.Group();
  group.name = name;

  const body = merged([
    mountainMass({
      radius: 86,
      height: 54,
      radialSegments: 12,
      heightSegments: 4,
      profileExponent: 1.15,
      columnNoise: 0.13,
      seed: 419
    }),
    mountainMass({
      radius: 62,
      height: 38,
      radialSegments: 10,
      heightSegments: 3,
      profileExponent: 1.1,
      columnNoise: 0.15,
      seed: 457,
      x: -96,
      z: 22,
      rotY: 1.2
    })
  ]);
  group.add(mesh(body, "RockDark"));

  return group;
}

// ---------------------------------------------------------------------------
// Export.
// ---------------------------------------------------------------------------
const pieces: THREE.Group[] = [
  mountainRidgeA("mountain-ridge-a"),
  mountainPeakB("mountain-peak-b"),
  mountainFarC("mountain-far-c")
];

const exporter = new GLTFExporter();

/**
 * Force the bottom-center pivot the convention promises.
 *
 * Every mountain here is several off-axis masses merged, so the combined
 * bounding box drifts off x/z = 0 even though each individual cone was built
 * centered -- ridge-a landed 1.5 units off, peak-b a full 18. That drift is
 * invisible in the file and shows up as "the gizmo is not on the mountain" on
 * every single placement. Correct it at the geometry, not by asking the author
 * to compensate.
 */
function recenterHorizontally(piece: THREE.Group): void {
  const box = new THREE.Box3().setFromObject(piece);
  const dx = (box.min.x + box.max.x) / 2;
  const dz = (box.min.z + box.max.z) / 2;
  const dy = box.min.y;
  piece.traverse((child) => {
    if (child instanceof THREE.Mesh) child.geometry.translate(-dx, -dy, -dz);
  });
}

async function exportPiece(piece: THREE.Group): Promise<void> {
  const scene = new THREE.Scene();
  scene.add(piece);
  recenterHorizontally(piece);

  // Assert the convention rather than trusting it.
  const box = new THREE.Box3().setFromObject(piece);
  const baseY = box.min.y;
  const centerX = (box.min.x + box.max.x) / 2;
  const centerZ = (box.min.z + box.max.z) / 2;
  for (const [axis, value] of [["base y", baseY], ["centre x", centerX], ["centre z", centerZ]] as const) {
    if (Math.abs(value) > 0.01) {
      throw new Error(`${piece.name}: ${axis} is ${value.toFixed(3)}, expected 0 (bottom-center pivot)`);
    }
  }

  const result = await new Promise<ArrayBuffer>((resolvePromise, rejectPromise) => {
    exporter.parse(
      scene,
      (output) => resolvePromise(output as ArrayBuffer),
      (error) => rejectPromise(error),
      { binary: true }
    );
  });
  const outPath = resolve(OUT_DIR, `${piece.name}.glb`);
  writeFileSync(outPath, Buffer.from(result));
  const magic = Buffer.from(result.slice(0, 4)).toString("ascii");
  if (magic !== "glTF") {
    throw new Error(`${piece.name}: bad GLB magic`);
  }
  console.log(
    `${piece.name}.glb  ${(result.byteLength / 1024).toFixed(1)} KB  ` +
      `${(box.max.x - box.min.x).toFixed(0)} x ${box.max.y.toFixed(0)} x ${(box.max.z - box.min.z).toFixed(0)} units  ` +
      `base y=${baseY.toFixed(2)}  centre=(${centerX.toFixed(1)}, ${centerZ.toFixed(1)})`
  );
}

async function main() {
  for (const piece of pieces) {
    await exportPiece(piece);
  }
  console.log(`\nWrote ${pieces.length} mountains to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
