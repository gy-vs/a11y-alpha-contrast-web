# Accessibility Review

Local workbench for review findings, with a linear-light alpha compositing and
WCAG contrast engine shared by server and client.

Run `npm install`, then `npm run dev`.

## Contrast engine (`src/shared/contrast.ts`)

Single source of truth — the server (`POST /api/contrast`) and the client
explanation view both import this module; neither side implements its own
luminance/compositing formulas.

- sRGB encoded input is linearized with the WCAG EOTF (also supports
  `srgb-255`).
- Layers are composited bottom-up with Porter-Duff "source over" in linear
  light, using premultiplied (associated) colors.
- Wide-gamut input (`display-p3`, `prophoto-rgb`) is linearized in its own
  space, downgraded to linear sRGB (ProPhoto includes a Bradford D50→D65
  adaptation), then per-channel clamped; every clamped channel is reported as
  color provenance so a downgraded color is never mistaken for native sRGB.
- When the bottom backdrop is unknown (`kind: 'unknown'`), the stack is
  resolved over opaque black and opaque white and the result is a contrast
  **range** (`min`/`max` plus per-extreme ratios), never a single
  pseudo-precise value. `pass` is `true` / `'partial'` / `false`.
- Threshold comparisons use the **unrounded** ratio. `formatContrast` /
  `formatLuminance` / `toSRGB255` are display-only helpers (half-up rounding).
- `buildCacheKey` serializes every background layer (space, components, alpha,
  kind, id, name) in stack order; adding, removing, reordering or retinting a
  layer always changes the key. The server memoizes on it.

Shared demo scenarios and hand-computed expected results live in
`src/shared/vectors.ts`; both the test suite and the client UI consume them.

## Tests

`npm test` — tests cover sRGB linearization, alpha 0/1 boundaries,
multi-layer backgrounds, unknown backdrops (range), wide-gamut downgrade and
the rounding boundary (a raw 4.4995 displays as "4.50:1" but fails 4.5).
