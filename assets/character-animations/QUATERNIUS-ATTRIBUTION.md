# Quaternius Universal Animation Library

The animation clips in `clips/` are derived from the
**Universal Animation Library** by [Quaternius](https://quaternius.com),
released under **CC0 1.0 Universal** (see LICENSE — no attribution
required; provided gladly anyway).

- Source distribution: https://quaternius.itch.io/universal-animation-library
- Vendored via the glTF mirror `J-Ponzo/gltf-universal-animation-library`
  at commit `e24c23cf2a1323488a3faa226ea7ea21f644b73e`.
- Extraction: `scripts/vendor-character-clips.mjs` splits the single
  library glTF into one self-contained GLB per curated clip (bone
  hierarchy + one animation; no mesh) and regenerates the standard-rig
  contract data in `packages/domain/src/standard-rig/rig-data.ts`
  from the same source.

When the Character Wizard copies clips into a game project, this file
rides along into `assets/character-animations/`.
