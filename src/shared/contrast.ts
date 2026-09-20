/**
 * Alpha-composited contrast computation in linear color space.
 *
 * This module is the single source of truth for both the server API and the
 * client explanation view. Neither side may re-implement these formulas.
 *
 * Pipeline: parse color -> sRGB -> linearize -> source-over composite per
 * layer (bottom-up) -> WCAG relative luminance -> contrast ratio.
 *
 * When the base of the background stack is unknown (explicitly marked, or
 * the known layers do not fully cover), results are reported as {min,max}
 * ranges over every possible base color instead of a pseudo-precise value.
 */

export type Channel3 = [number, number, number];

export interface LayerInput {
  /** CSS-ish color string, or null / "?" / "unknown" for an unknown base. */
  color: string | null;
  /** Extra alpha (0..1), multiplied with any alpha carried by the color. */
  alpha?: number;
}

export interface ContrastRequest {
  foreground: LayerInput;
  /** Background layers, top -> bottom. Only the bottom layer may be unknown. */
  background: LayerInput[];
  /** WCAG-style threshold, default 4.5. Compared against unrounded values. */
  threshold?: number;
}

export class ContrastInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContrastInputError';
  }
}

// ---------------------------------------------------------------------------
// sRGB transfer functions (WCAG / IEC 61966-2-1)
// ---------------------------------------------------------------------------

export function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearChannelToSrgb(l: number): number {
  return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

export function srgbToLinear(srgb: Channel3): Channel3 {
  return [srgbChannelToLinear(srgb[0]), srgbChannelToLinear(srgb[1]), srgbChannelToLinear(srgb[2])];
}

/** WCAG relative luminance of a linear-space color. */
export function relativeLuminance(linear: Channel3): number {
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

// ---------------------------------------------------------------------------
// Wide-gamut input: converted (degraded) into sRGB, clamped with a warning
// ---------------------------------------------------------------------------

/** Display-P3 linear -> sRGB linear (both D65), composed matrix. */
const P3_TO_SRGB_LINEAR: [Channel3, Channel3, Channel3] = [
  [1.2249401767967224, -0.2249401767967224, 0],
  [-0.0420569548706745, 1.0420569548706745, 0],
  [-0.0196375545899722, -0.0786360460017177, 1.0982736005916898],
];

function applyMatrix(m: [Channel3, Channel3, Channel3], v: Channel3): Channel3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

// ---------------------------------------------------------------------------
// Color parsing
// ---------------------------------------------------------------------------

export interface ParsedColor {
  /** Normalized encoded sRGB channels, 0..1. */
  srgb: Channel3;
  /** Alpha carried by the color notation itself, 0..1. */
  alpha: number;
  /** Where the color came from: 'hex' | 'rgb' | 'display-p3'. */
  source: string;
  /** Degradation notes, e.g. gamut clamping of wide-gamut input. */
  warnings: string[];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function parseChannel(token: string, warnings: string[]): number {
  let value: number;
  if (token.endsWith('%')) {
    value = (parseFloat(token.slice(0, -1)) / 100) * 255;
  } else {
    value = parseFloat(token);
  }
  if (Number.isNaN(value)) throw new ContrastInputError(`invalid rgb channel: "${token}"`);
  if (value < 0 || value > 255) {
    warnings.push(`channel ${token} out of 0..255, clamped`);
    value = Math.min(255, Math.max(0, value));
  }
  return value / 255;
}

function parseAlphaToken(token: string, warnings: string[]): number {
  let value = token.endsWith('%') ? parseFloat(token.slice(0, -1)) / 100 : parseFloat(token);
  if (Number.isNaN(value)) throw new ContrastInputError(`invalid alpha: "${token}"`);
  if (value < 0 || value > 1) {
    warnings.push(`alpha ${token} out of 0..1, clamped`);
    value = clamp01(value);
  }
  return value;
}

/** Splits "1 0 0 / 0.5" or "1,0,0,0.5" into value tokens + optional alpha token. */
function splitColorArgs(inner: string): {values: string[]; alpha: string | null} {
  if (inner.includes(',')) {
    const parts = inner.split(',').map((p) => p.trim());
    return {values: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : null};
  }
  const [valuesPart, alphaPart] = inner.split('/');
  const values = valuesPart.trim().split(/\s+/);
  return {values, alpha: alphaPart !== undefined ? alphaPart.trim() : null};
}

export function parseColor(raw: string): ParsedColor {
  const input = raw.trim();
  const warnings: string[] = [];

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = digits.split('').map((d) => d + d).join('');
    const srgb: Channel3 = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255) as Channel3;
    const alpha = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1;
    return {srgb, alpha, source: 'hex', warnings};
  }

  const rgb = /^rgba?\((.+)\)$/i.exec(input);
  if (rgb) {
    const {values, alpha} = splitColorArgs(rgb[1]);
    if (values.length !== 3) throw new ContrastInputError(`rgb() needs 3 channels: "${input}"`);
    const srgb = values.map((v) => parseChannel(v, warnings)) as Channel3;
    return {srgb, alpha: alpha !== null ? parseAlphaToken(alpha, warnings) : 1, source: 'rgb', warnings};
  }

  const colorFn = /^color\((\S+)\s+(.+)\)$/i.exec(input);
  if (colorFn) {
    const space = colorFn[1].toLowerCase();
    if (space !== 'display-p3') {
      throw new ContrastInputError(`unsupported color space "${space}" (only display-p3 is degraded to sRGB)`);
    }
    const {values, alpha} = splitColorArgs(colorFn[2]);
    if (values.length !== 3) throw new ContrastInputError(`color(display-p3 ...) needs 3 channels: "${input}"`);
    const encoded = values.map((token) => {
      const v = token.endsWith('%') ? parseFloat(token.slice(0, -1)) / 100 : parseFloat(token);
      if (Number.isNaN(v)) throw new ContrastInputError(`invalid display-p3 channel: "${token}"`);
      return v;
    }) as Channel3;
    // Degrade wide-gamut input to sRGB: decode transfer, convert gamut in
    // linear space, re-encode, then clamp whatever sRGB cannot represent.
    const p3Linear = srgbToLinear(encoded);
    const srgbLinear = applyMatrix(P3_TO_SRGB_LINEAR, p3Linear);
    const srgbEncoded = srgbLinear.map(linearChannelToSrgb) as Channel3;
    const clamped = srgbEncoded.map(clamp01) as Channel3;
    if (clamped.some((c, i) => Math.abs(c - srgbEncoded[i]) > 1e-9)) {
      warnings.push(`display-p3 color is outside sRGB gamut, clamped (source: ${input})`);
    }
    return {srgb: clamped, alpha: alpha !== null ? parseAlphaToken(alpha, warnings) : 1, source: 'display-p3', warnings};
  }

  throw new ContrastInputError(`unrecognized color: "${raw}"`);
}

export function isUnknownLayer(layer: LayerInput): boolean {
  return layer.color === null || /^\s*(\?|unknown)\s*$/i.test(layer.color);
}

// ---------------------------------------------------------------------------
// Linear-space source-over compositing
// ---------------------------------------------------------------------------

export interface LinearColor {
  rgb: Channel3;
  alpha: number;
}

export function compositeOver(top: LinearColor, bottom: LinearColor): LinearColor {
  const alpha = top.alpha + bottom.alpha * (1 - top.alpha);
  if (alpha === 0) return {rgb: [0, 0, 0], alpha: 0};
  const rgb = top.rgb.map((c, i) => (c * top.alpha + bottom.rgb[i] * bottom.alpha * (1 - top.alpha)) / alpha) as Channel3;
  return {rgb, alpha};
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface Range {
  min: number;
  max: number;
}

export interface LayerReport {
  /** Position in the request, 0 = topmost. */
  index: number;
  input: string | null;
  unknown: boolean;
  /** Color source: 'hex' | 'rgb' | 'display-p3' | 'unknown'. */
  source: string;
  /** Normalized encoded sRGB actually used (after any gamut degradation). */
  srgb: Channel3 | null;
  /** Effective alpha used (color alpha x layer alpha). */
  alpha: number;
  warnings: string[];
  /** The layer's own luminance; null when unknown. */
  luminance: number | null;
  /** Luminance of the sub-stack from this layer down to the base. */
  stackLuminance: number | Range;
}

export interface ContrastReport {
  foreground: Omit<LayerReport, 'stackLuminance'>;
  background: {
    layers: LayerReport[];
    /** Fraction of the final background determined by known layers (1 = fully known). */
    coverage: number;
    unknownBase: boolean;
    luminance: number | Range;
  };
  /** Effective text luminance after compositing the foreground over the stack. */
  text: {luminance: number | Range};
  contrast: {ratio: number | Range; unknown: boolean};
  threshold: number;
  /** Compared with unrounded values. 'undetermined' when the range straddles the threshold. */
  verdict: 'pass' | 'fail' | 'undetermined';
  cacheKey: string;
}

function effectiveAlpha(parsed: ParsedColor, layerAlpha: number | undefined): number {
  if (layerAlpha === undefined) return parsed.alpha;
  if (Number.isNaN(layerAlpha) || layerAlpha < 0 || layerAlpha > 1) {
    throw new ContrastInputError(`layer alpha must be within 0..1, got ${layerAlpha}`);
  }
  return parsed.alpha * layerAlpha;
}

function asRange(min: number, max: number): number | Range {
  return min === max ? min : {min, max};
}

function rangeOf(v: number | Range): Range {
  return typeof v === 'number' ? {min: v, max: v} : v;
}

/** Unrounded threshold comparison. Display formatting must never feed this. */
export function meetsThreshold(ratio: number, threshold: number): boolean {
  return ratio >= threshold;
}

export function analyzeContrast(request: ContrastRequest): ContrastReport {
  if (!request || typeof request !== 'object') throw new ContrastInputError('request body must be an object');
  const threshold = request.threshold ?? 4.5;
  if (typeof threshold !== 'number' || Number.isNaN(threshold) || threshold <= 0) {
    throw new ContrastInputError(`threshold must be a positive number, got ${request.threshold}`);
  }
  if (!request.foreground || isUnknownLayer(request.foreground)) {
    throw new ContrastInputError('foreground color must be known');
  }
  const bgInputs = request.background ?? [];
  bgInputs.forEach((layer, i) => {
    if (isUnknownLayer(layer) && i !== bgInputs.length - 1) {
      throw new ContrastInputError(`unknown background layer only allowed at the bottom (index ${i})`);
    }
  });

  // Foreground.
  const fgParsed = parseColor(request.foreground.color!);
  const fgAlpha = effectiveAlpha(fgParsed, request.foreground.alpha);
  const fgLinear = srgbToLinear(fgParsed.srgb);
  const fgLuminance = relativeLuminance(fgLinear);

  // Background, composited bottom-up in linear space. The accumulated stack
  // is K + M * base, where base is the unknown bottom color (linear) and
  // M = product of (1 - alpha) over all known layers. Luminance then only
  // depends on the base luminance u in [0,1]: L(u) = lum(K) + M * u.
  const layers = bgInputs.length > 0 ? bgInputs : [{color: null}];
  let acc: LinearColor = {rgb: [0, 0, 0], alpha: 1}; // black placeholder for the unknown base
  let coverage = 1; // multiplier applied to the unknown base
  const bottomUp: LayerReport[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const input = layers[i];
    if (isUnknownLayer(input)) {
      bottomUp.push({
        index: i, input: input.color, unknown: true, source: 'unknown',
        srgb: null, alpha: 0, warnings: [], luminance: null,
        stackLuminance: asRange(0, 1),
      });
      continue;
    }
    const parsed = parseColor(input.color!);
    const alpha = effectiveAlpha(parsed, input.alpha);
    const linear = srgbToLinear(parsed.srgb);
    acc = compositeOver({rgb: linear, alpha}, acc);
    coverage *= 1 - alpha;
    bottomUp.push({
      index: i, input: input.color, unknown: false, source: parsed.source,
      srgb: parsed.srgb, alpha, warnings: parsed.warnings,
      luminance: relativeLuminance(linear),
      stackLuminance: asRange(relativeLuminance(acc.rgb), relativeLuminance(acc.rgb) + coverage),
    });
  }
  const bgLayers = bottomUp.reverse();

  const knownLum = relativeLuminance(acc.rgb); // stack composited over black
  const unknownBase = coverage > 0;
  const bgLumAt = (u: number) => knownLum + coverage * u;
  const bgLuminance = unknownBase ? asRange(bgLumAt(0), bgLumAt(1)) : knownLum;

  // Effective text luminance: foreground composited over the background.
  const textLumAt = (u: number) => fgAlpha * fgLuminance + (1 - fgAlpha) * bgLumAt(u);
  const textLuminance = unknownBase
    ? asRange(Math.min(textLumAt(0), textLumAt(1)), Math.max(textLumAt(0), textLumAt(1)))
    : textLumAt(0);

  // Contrast as a function of the unknown base luminance u in [0,1]. Both
  // luminances are linear in u, so extrema sit at the endpoints, plus a
  // possible crossing where the ratio dips to 1.
  const ratioAt = (u: number) => {
    const text = textLumAt(u);
    const bg = bgLumAt(u);
    const hi = Math.max(text, bg);
    const lo = Math.min(text, bg);
    return (hi + 0.05) / (lo + 0.05);
  };
  let ratio: number | Range;
  if (!unknownBase) {
    ratio = ratioAt(0);
  } else {
    const crosses = (textLumAt(0) - bgLumAt(0)) * (textLumAt(1) - bgLumAt(1)) <= 0;
    ratio = {
      min: crosses ? 1 : Math.min(ratioAt(0), ratioAt(1)),
      max: Math.max(ratioAt(0), ratioAt(1)),
    };
  }

  let verdict: ContrastReport['verdict'];
  if (typeof ratio === 'number') {
    verdict = meetsThreshold(ratio, threshold) ? 'pass' : 'fail';
  } else if (meetsThreshold(ratio.min, threshold)) {
    verdict = 'pass';
  } else if (!meetsThreshold(ratio.max, threshold)) {
    verdict = 'fail';
  } else {
    verdict = 'undetermined';
  }

  return {
    foreground: {
      index: -1, input: request.foreground.color, unknown: false, source: fgParsed.source,
      srgb: fgParsed.srgb, alpha: fgAlpha, warnings: fgParsed.warnings, luminance: fgLuminance,
    },
    background: {layers: bgLayers, coverage: 1 - coverage, unknownBase, luminance: bgLuminance},
    text: {luminance: textLuminance},
    contrast: {ratio, unknown: unknownBase},
    threshold,
    verdict,
    cacheKey: contrastCacheKey(request),
  };
}

// ---------------------------------------------------------------------------
// Cache key: includes the foreground and *every* background layer in order,
// normalized so textually different but equal inputs share a key.
// ---------------------------------------------------------------------------

export function contrastCacheKey(request: ContrastRequest): string {
  const num = (v: number) => Number(v.toPrecision(12));
  const layerKey = (layer: LayerInput): unknown => {
    if (isUnknownLayer(layer)) return 'unknown';
    const parsed = parseColor(layer.color!);
    const alpha = effectiveAlpha(parsed, layer.alpha);
    return [...parsed.srgb.map(num), num(alpha)];
  };
  const bg = request.background?.length ? request.background : [{color: null}];
  return JSON.stringify({
    fg: layerKey(request.foreground ?? {color: null}),
    bg: bg.map(layerKey),
    th: request.threshold ?? 4.5,
  });
}

// ---------------------------------------------------------------------------
// Display formatting. UI-only: rule evaluation always uses unrounded values.
// ---------------------------------------------------------------------------

export function formatRatio(ratio: number): string {
  return ratio.toFixed(2);
}

export function formatRatioValue(ratio: number | Range): string {
  return typeof ratio === 'number' ? formatRatio(ratio) : `${formatRatio(ratio.min)} – ${formatRatio(ratio.max)}`;
}

export function formatLuminance(luminance: number): string {
  return luminance.toFixed(4);
}

export function formatLuminanceValue(luminance: number | Range): string {
  return typeof luminance === 'number'
    ? formatLuminance(luminance)
    : `${formatLuminance(luminance.min)} – ${formatLuminance(luminance.max)}`;
}
