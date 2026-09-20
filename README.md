# Accessibility Review

Local workbench for review findings.

Run `npm install`, then `npm run dev`.

## Alpha-composited contrast

All contrast math lives in `src/shared/contrast.ts` and is shared by the
server (`POST /api/contrast`) and the client explanation view. Neither side
re-implements the formula; `src/shared/contrast.vectors.ts` holds the shared
test vectors that both the unit tests and the API tests run against.

Pipeline: parse color → sRGB → linearize (IEC 61966-2-1) → source-over
composite layer by layer **in linear space** → WCAG relative luminance →
contrast ratio.

- **Unknown base**: mark the bottom background layer as `null` / `?` /
  `unknown` (or leave the stack non-opaque). Results come back as
  `{min, max}` ranges over every possible base color, and the verdict is
  `pass` / `fail` / `undetermined` — never a pseudo-precise single value.
- **Per-layer reporting**: each layer returns its color source
  (`hex` / `rgb` / `display-p3` / `unknown`), normalized sRGB, alpha,
  own luminance and the luminance of the sub-stack down to the base.
- **Wide-gamut input**: `color(display-p3 r g b)` is converted to sRGB in
  linear space and clamped with a `warnings` entry. Other spaces are
  rejected explicitly.
- **Thresholds** are compared against unrounded values; `formatRatio` /
  `formatLuminance` are display-only. A ratio of 4.49999999 displays as
  `4.50` and still fails a 4.5 threshold.
- **Caching**: the server cache key includes the foreground, every
  background layer in order, and the threshold, normalized so equivalent
  color notations share an entry.

### Example

```
POST /api/contrast
{
  "foreground": {"color": "#1a2b3c", "alpha": 0.8},
  "background": [
    {"color": "rgba(255,255,255,0.6)"},
    {"color": "#102030"},
    {"color": null}
  ],
  "threshold": 4.5
}
```

Run `npm test` for the coverage: sRGB linearization, alpha 0/1, multi-layer
backgrounds, unknown base ranges, wide-gamut degradation, rounding
boundaries and cache-key composition.
