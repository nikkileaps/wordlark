/**
 * Arrival Station blockout kit generator.
 *
 * Produces stylized low-poly GLB props for the wordlark project:
 * cliff-rim pieces (island edge dressing), dock platforms, and
 * gray-box structure stand-ins. Chunky faceted look via seeded
 * vertex jitter + flat shading. Each visual part is its own named
 * material so Studio's asset import derives re-bindable surface
 * slots (Rock, Grass, WoodLight, ...).
 *
 * Run: cd packages/render-web && pnpm exec tsx <this file>
 * Output: ~/projects/wordlark/asset-kit/*.glb
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
// Palette — one MeshStandardMaterial per named slot.
// ---------------------------------------------------------------------------
const PALETTE: Record<string, { color: number; roughness?: number; metalness?: number }> = {
  Rock: { color: 0x8a7b6d, roughness: 0.95 },
  RockDark: { color: 0x6e6156, roughness: 0.95 },
  Grass: { color: 0x5f9e57, roughness: 0.9 },
  WoodLight: { color: 0x9a6f44, roughness: 0.85 },
  WoodDark: { color: 0x6b4a2c, roughness: 0.85 },
  Plaster: { color: 0xd9cec0, roughness: 0.9 },
  Stone: { color: 0xa79f93, roughness: 0.95 },
  Roof: { color: 0x4e8f8b, roughness: 0.8 },
  Accent: { color: 0x7ad0c9, roughness: 0.4, metalness: 0.1 }
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
 * Jitter an INDEXED geometry's vertices (welded, so shared corners
 * move together), then facet it (non-indexed + flat normals).
 */
function facetJitter(
  geometry: THREE.BufferGeometry,
  rng: () => number,
  amp: { x: number; y: number; z: number },
  filter?: (x: number, y: number, z: number) => number
): THREE.BufferGeometry {
  const pos = geometry.getAttribute("position");
  // Weld duplicated corners so displacement is consistent: quantize
  // position -> shared random offset.
  const offsets = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
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

function box(
  w: number,
  h: number,
  d: number,
  x = 0,
  y = 0,
  z = 0,
  segs: [number, number, number] = [1, 1, 1],
  rotY = 0
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, segs[0], segs[1], segs[2]);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

function cylinder(
  rTop: number,
  rBottom: number,
  h: number,
  radial: number,
  x = 0,
  y = 0,
  z = 0
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, radial);
  g.translate(x, y, z);
  return g;
}

// ---------------------------------------------------------------------------
// Cliff rim pieces. Pivot: the piece's TOP-INNER edge sits at the
// origin, top surface at y = +0.2 (a slight grass lip above the
// ground plane hides the seam). Rock body hangs DOWN; place along
// the landscape edge with the flat inner side (+z) facing the island.
// ---------------------------------------------------------------------------
function cliffPiece(name: string, width: number, height: number, seed: number) {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.name = name;

  // Rock body: front face (-z) heavily jittered, inner face (+z,
  // toward the island) kept flat so it tucks under the ground edge.
  const depth = 2.6;
  const rock = new THREE.BoxGeometry(width, height, depth, Math.max(3, Math.round(width / 2)), Math.max(3, Math.round(height / 2)), 2);
  rock.translate(0, -height / 2 + 0.05, -depth / 2 + 0.4);
  const rockJittered = facetJitter(rock, rng, { x: 0.45, y: 0.4, z: 0.55 }, (x, y, z) => {
    // Keep the top rim and the island-facing side calm.
    const inner = z > 0.1 ? 0.15 : 1;
    const topCalm = y > -0.4 ? 0.35 : 1;
    return inner * topCalm;
  });
  group.add(mesh(rockJittered, "Rock"));

  // Grass lip: thin jittered slab overhanging the rock's front top.
  const lip = new THREE.BoxGeometry(width + 0.5, 0.42, depth + 0.7, Math.max(4, Math.round(width / 1.5)), 1, 3);
  lip.translate(0, 0, -depth / 2 + 0.45);
  const lipJittered = facetJitter(lip, rng, { x: 0.3, y: 0.12, z: 0.35 });
  const lipMesh = mesh(lipJittered, "Grass");
  lipMesh.position.y = 0;
  group.add(lipMesh);

  return group;
}

// Freestanding crag: irregular tapered rock spire, usable as a
// corner mass below the rim or a feature boulder above ground.
function cragPiece(name: string, radius: number, height: number, seed: number) {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.name = name;

  const spire = new THREE.CylinderGeometry(radius * 0.25, radius, height, 6, 3);
  spire.translate(0, height / 2, 0);
  group.add(mesh(facetJitter(spire, rng, { x: radius * 0.3, y: height * 0.06, z: radius * 0.3 }), "Rock"));

  const base = new THREE.CylinderGeometry(radius * 0.9, radius * 1.25, height * 0.28, 7, 2);
  base.translate(radius * 0.35, height * 0.14, radius * 0.2);
  group.add(mesh(facetJitter(base, rng, { x: radius * 0.25, y: 0.1, z: radius * 0.25 }), "RockDark"));

  return group;
}

// ---------------------------------------------------------------------------
// Dock pieces. Deck surface at y = +0.14; posts drop 5m below for
// the over-the-void / over-water look. Pivot at deck center.
// ---------------------------------------------------------------------------
function dockPlatform(name: string, width: number, length: number, seed: number) {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.name = name;

  // Planks across the width, slight irregular lengths/heights.
  const planks: THREE.BufferGeometry[] = [];
  const plankW = 0.48;
  const gap = 0.05;
  const count = Math.floor(width / (plankW + gap));
  for (let i = 0; i < count; i += 1) {
    const x = -width / 2 + plankW / 2 + i * (plankW + gap) + gap / 2;
    const jitterLen = length - rng() * 0.35;
    planks.push(box(plankW, 0.09, jitterLen, x, 0.14, (rng() - 0.5) * 0.12));
  }
  group.add(mesh(merged(planks), "WoodLight"));

  // Frame + posts + mooring bollards.
  const dark: THREE.BufferGeometry[] = [];
  dark.push(box(width + 0.2, 0.16, 0.3, 0, 0.02, length / 2 - 0.15));
  dark.push(box(width + 0.2, 0.16, 0.3, 0, 0.02, -length / 2 + 0.15));
  dark.push(box(0.3, 0.16, length, width / 2 - 0.05, 0.02, 0));
  dark.push(box(0.3, 0.16, length, -width / 2 + 0.05, 0.02, 0));
  const postXs = [-width / 2 + 0.25, width / 2 - 0.25];
  const postZs = [-length / 2 + 0.35, 0, length / 2 - 0.35];
  for (const px of postXs) {
    for (const pz of postZs) {
      dark.push(cylinder(0.16, 0.19, 5.2, 7, px, -2.4, pz));
    }
  }
  // Mooring bollards: two stubby leaning posts on one long edge.
  for (const pz of [-length / 4, length / 4]) {
    const bollard = new THREE.CylinderGeometry(0.14, 0.18, 1.1, 7);
    bollard.translate(0, 0.62, 0);
    bollard.rotateZ(0.12 + rng() * 0.1);
    bollard.translate(width / 2 - 0.2, 0, pz);
    dark.push(bollard);
  }
  group.add(mesh(merged(dark), "WoodDark"));

  return group;
}

// ---------------------------------------------------------------------------
// Structure stand-ins.
// ---------------------------------------------------------------------------
function stationStandin(name: string) {
  const group = new THREE.Group();
  group.name = name;

  // Plinth + steps.
  const stone: THREE.BufferGeometry[] = [];
  stone.push(cylinder(5.2, 5.7, 1.0, 10, 0, 0.5, 0));
  stone.push(box(3.4, 0.5, 2.2, 0, 0.25, 5.6));
  stone.push(box(2.8, 0.5, 1.4, 0, 0.75, 5.0));
  group.add(mesh(merged(stone), "Stone"));

  // Tower body + door reveal.
  const plaster: THREE.BufferGeometry[] = [];
  plaster.push(cylinder(3.1, 3.5, 7.6, 10, 0, 4.8, 0));
  group.add(mesh(merged(plaster), "Plaster"));

  // Wood: door, balcony ring, trim bands.
  const wood: THREE.BufferGeometry[] = [];
  wood.push(box(1.6, 2.6, 0.4, 0, 2.3, 3.35));
  wood.push(cylinder(3.7, 3.7, 0.35, 10, 0, 7.2, 0));
  wood.push(cylinder(3.35, 3.55, 0.3, 10, 0, 1.15, 0));
  group.add(mesh(merged(wood), "WoodDark"));

  // Roof cone + spire + accent orb (the skyline landmark).
  const roof: THREE.BufferGeometry[] = [];
  roof.push(cylinder(0.18, 4.35, 4.4, 10, 0, 10.8, 0));
  roof.push(cylinder(0.1, 0.14, 1.6, 6, 0, 13.4, 0));
  group.add(mesh(merged(roof), "Roof"));

  const orb = new THREE.IcosahedronGeometry(0.55, 0);
  orb.translate(0, 14.5, 0);
  group.add(mesh(orb, "Accent"));

  return group;
}

function houseStandin(name: string, w: number, h: number, d: number, seed: number) {
  const rng = mulberry32(seed);
  const group = new THREE.Group();
  group.name = name;

  const body = box(w, h, d, 0, h / 2, 0);
  group.add(mesh(body, "Plaster"));

  // Pitched roof: squashed 4-sided pyramid, slight overhang.
  const roof = new THREE.CylinderGeometry(0.15, Math.max(w, d) * 0.78, h * 0.65, 4);
  roof.rotateY(Math.PI / 4);
  roof.scale(w / Math.max(w, d), 1, d / Math.max(w, d));
  roof.translate(0, h + h * 0.32, 0);
  group.add(mesh(roof, "Roof"));

  const wood: THREE.BufferGeometry[] = [];
  wood.push(box(1.1, 1.9, 0.25, (rng() - 0.5) * (w / 3), 0.95, d / 2 + 0.05));
  wood.push(box(w + 0.35, 0.3, d + 0.35, 0, h - 0.15, 0));
  group.add(mesh(merged(wood), "WoodDark"));

  return group;
}

function shrineStandin(name: string) {
  const group = new THREE.Group();
  group.name = name;

  const stone: THREE.BufferGeometry[] = [];
  stone.push(box(3.6, 0.5, 3.6, 0, 0.25, 0));
  stone.push(box(2.6, 0.5, 2.6, 0, 0.75, 0));
  group.add(mesh(merged(stone), "Stone"));

  const rng = mulberry32(77);
  const obelisk = new THREE.CylinderGeometry(0.4, 0.95, 4.6, 6, 3);
  obelisk.translate(0, 3.3, 0);
  group.add(mesh(facetJitter(obelisk, rng, { x: 0.08, y: 0.1, z: 0.08 }), "Rock"));

  const orb = new THREE.IcosahedronGeometry(0.45, 0);
  orb.translate(0, 6.1, 0);
  group.add(mesh(orb, "Accent"));

  return group;
}

// ---------------------------------------------------------------------------
// Export.
// ---------------------------------------------------------------------------
const pieces: THREE.Group[] = [
  cliffPiece("cliff-edge-a", 8, 6, 11),
  cliffPiece("cliff-edge-b", 12, 8, 23),
  cliffPiece("cliff-edge-c", 5, 5, 37),
  cragPiece("cliff-crag", 2.6, 5.5, 41),
  dockPlatform("dock-platform", 4, 8, 53),
  dockPlatform("dock-platform-small", 3, 4, 67),
  stationStandin("station-standin"),
  houseStandin("house-standin-a", 5, 3.4, 4.2, 71),
  houseStandin("house-standin-b", 3.6, 2.8, 3.2, 83),
  shrineStandin("shrine-statue-standin")
];

const exporter = new GLTFExporter();

async function exportPiece(piece: THREE.Group): Promise<void> {
  const scene = new THREE.Scene();
  scene.add(piece);
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
  console.log(`${piece.name}.glb  ${(result.byteLength / 1024).toFixed(1)} KB`);
}

async function main() {
  for (const piece of pieces) {
    await exportPiece(piece);
  }
  console.log(`\nWrote ${pieces.length} pieces to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
