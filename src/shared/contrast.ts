/**
 * Layer-by-layer alpha compositing in a linear-light space, plus WCAG
 * relative luminance / contrast on the composited pixels.
 *
 * This module is the single source of truth imported by BOTH the server and
 * the client explanation view. Neither side may implement its own variant of
 * these formulas; shared test vectors live in ./vectors.ts.
 *
 * Pipeline:
 *   sRGB / display-p3 / prophoto-rgb encoded components
 *     -> linearize (EOTF or gamma 1.8)
 *     -> wide-gamut matrix downgrade to linear sRGB + per-channel clamp
 *     -> Porter-Duff "source over" stacking, bottom background first
 *     -> relative luminance -> contrast ratio against threshold (unrounded)
 *
 * When the bottom backdrop is unknown, compositing over black and over white
 * yields a contrast *range*; we never report a single pseudo-precise value.
 */

export type ColorSpace = 'srgb' | 'srgb-255' | 'display-p3' | 'prophoto-rgb';

/** A color as authored or sampled, in its source encoding. */
export interface ColorInput {
  /** sRGB encoded 0..1, 8-bit 0..255, or wide-gamut encoded 0..1. */
  rgb: [number, number, number];
  /** Defaults to 'srgb'. */
  space?: ColorSpace;
  /** 0 = fully transparent, 1 = fully opaque. Defaults to 1. */
  alpha?: number;
}

/** One paint layer. Backgrounds stack bottom-first. */
export interface LayerInput {
  id?: string;
  name?: string;
  /** 'sample' = known sampled pixel (e.g. from a background image), 'unknown' = unspecified backdrop. */
  kind?: 'paint' | 'sample' | 'unknown';
  color?: ColorInput;
}

export interface ContrastRequest {
  foreground: LayerInput;
  /** Bottom layer first. Only the first entry may be {kind:'unknown'}. */
  backgrounds: LayerInput[];
  /** WCAG threshold, e.g. 4.5. Defaults to 4.5. */
  threshold?: number;
}

/** What happened to a single channel while downgrading into the sRGB gamut. */
export type ChannelState = 'in-gamut' | 'clamped-low' | 'clamped-high';

/** Provenance of one layer's linearized color. */
export interface ColorSource {
  layerId: string;
  name: string;
  kind: 'paint' | 'sample' | 'unknown';
  /** Space the caller supplied, before any downgrade. */
  sourceSpace: ColorSpace | 'none';
  /** Space actually used for math ('srgb-linear' for all sRGB encodings). */
  resolvedSpace: 'srgb-linear' | 'display-p3-linear' | 'prophoto-linear' | 'none';
  /** Linear components in the source space (pre-downgrade when wide gamut). */
  linear: [number, number, number];
  /** Linear sRGB components after matrix downgrade + clamp. */
  linearSRGB: [number, number, number];
  /** Per-channel clamp status of the downgrade. */
  channels: [ChannelState, ChannelState, ChannelState];
  /** True when the color was modified while fitting the sRGB gamut. */
  downgraded: boolean;
  opacity: number;
  /** 'opaque' alpha === 1, 'transparent' alpha === 0. */
  alphaState: 'opaque' | 'transparent' | 'translucent';
}

export interface CompositeStep {
  layerId: string;
  name: string;
  /** Accumulated pixel color (linear sRGB) after this layer is applied. */
  over: [number, number, number];
  /**
   * Effective coverage of the accumulated stack after this layer.
   * 1 means everything below is fully occluded.
   */
  coverage: number;
}

export interface ContrastResult {
  foreground: ColorSource;
  backgrounds: ColorSource[];
  /** Compositing trace, bottom background up through the foreground. */
  trace: {
    /** Defined for the fully-known-backdrop case only. */
    exact: CompositeStep[] | null;
    /** Defined when the bottom backdrop is unknown. */
    range: {
      overBlack: CompositeStep[];
      overWhite: CompositeStep[];
    } | null;
  };
  /** Final effective text pixel (linear sRGB). */
  effectiveText:
    | {kind: 'exact'; rgb: [number, number, number]}
    | {
        kind: 'range';
        overBlack: [number, number, number];
        overWhite: [number, number, number];
      };
  /** Final effective backdrop pixel (linear sRGB) behind the text. */
  effectiveBackdrop:
    | {kind: 'exact'; rgb: [number, number, number]}
    | {
        kind: 'range';
        overBlack: [number, number, number];
        overWhite: [number, number, number];
      };
  /** Relative luminance of the text pixel. */
  textLuminance: number | {min: number; max: number};
  /** Relative luminance of the backdrop pixel. */
  backdropLuminance: number | {min: number; max: number};
  /**
   * Contrast ratio. Threshold comparisons MUST use these unrounded values;
   * formatContrast() is for display only.
   */
  contrast:
    | {kind: 'exact'; value: number}
    | {
        kind: 'range';
        min: number;
        max: number;
        /** Ratios for the two resolved backdrops. */
        overBlack: number;
        overWhite: number;
      };
  threshold: number;
  pass: boolean | 'partial';
  /**
   * Stable cache key. Every background layer is included, in stack order,
   * with color space, components, alpha and kind — adding/removing/reordering
   * a layer always changes the key.
   */
  cacheKey: string;
}

const BLACK: [number, number, number] = [0, 0, 0];
const WHITE: [number, number, number] = [1, 1, 1];

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** sRGB EOTF: encoded 0..1 -> linear sRGB 0..1. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB OETF: linear sRGB -> encoded 0..1 (display formatting only). */
export function linearToSRGB(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** ProPhoto (ROMM RGB) linear-light EOTF (gamma 1.8, Etc=1/512). */
function prophotoToLinear(c: number): number {
  return c >= 1 / 512 ? Math.pow(c, 1.8) : c / 16;
}

/**
 * Linear display-p3 -> linear sRGB (D65-adapted primaries).
 * Derived from the published primary matrices; both end on the same white
 * point so no chromatic adaptation is needed.
 */
const P3_TO_SRGB: ReadonlyArray<readonly [number, number, number]> = [
  [1.2249401, -0.2249404, -0.0000001],
  [-0.0420569, 1.0420571, -0.0000003],
  [-0.0196376, -0.0786361, 1.1583331],
];

/**
 * Linear ProPhoto/ROMM (D50) -> linear sRGB (D65): Bradford adaptation from
 * D50 to D65 followed by XYZ D65 -> linear sRGB.
 */
const PROPHOTO_TO_SRGB: ReadonlyArray<readonly [number, number, number]> = [
  [2.0343996519788328, -0.7274499208283165, -0.3067903850062068],
  [-0.22880793991292703, 1.2317016765371016, -0.0029168947159331875],
  [-0.008567704400697061, -0.1532498564145905, 1.1615777127393279],
];

function applyMatrix(
  m: ReadonlyArray<readonly [number, number, number]>,
  c: [number, number, number],
): [number, number, number] {
  return [
    m[0][0] * c[0] + m[0][1] * c[1] + m[0][2] * c[2],
    m[1][0] * c[0] + m[1][1] * c[1] + m[1][2] * c[2],
    m[2][0] * c[0] + m[2][1] * c[1] + m[2][2] * c[2],
  ];
}

/**
 * Fit a linear-light color into the sRGB gamut by clamping each channel to
 * [0,1]. Returns the clamped color and per-channel provenance. Clamping is a
 * deliberate downgrade (it changes hue/saturation) and is reported per
 * channel so callers never mistake a wide-gamut color for an sRGB one.
 */
function clampToSRGB(
  c: [number, number, number],
): {rgb: [number, number, number]; channels: [ChannelState, ChannelState, ChannelState]} {
  const channels = c.map(value =>
    value < 0 ? 'clamped-low' : value > 1 ? 'clamped-high' : 'in-gamut',
  ) as [ChannelState, ChannelState, ChannelState];
  return {
    rgb: [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])],
    channels,
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function validateColor(color: ColorInput | undefined, layerLabel: string) {
  if (!color || !Array.isArray(color.rgb) || color.rgb.length !== 3) {
    throw new Error(`${layerLabel}: color.rgb must be three numbers`);
  }
  const space = color.space ?? 'srgb';
  if (
    space !== 'srgb' &&
    space !== 'srgb-255' &&
    space !== 'display-p3' &&
    space !== 'prophoto-rgb'
  ) {
    throw new Error(`${layerLabel}: unsupported color space "${space}"`);
  }
  for (const component of color.rgb) {
    if (!isFiniteNumber(component)) {
      throw new Error(`${layerLabel}: rgb components must be finite numbers`);
    }
  }
  const alpha = color.alpha ?? 1;
  if (!isFiniteNumber(alpha)) {
    throw new Error(`${layerLabel}: alpha must be a finite number`);
  }
  if (space === 'srgb-255') {
    for (const component of color.rgb) {
      if (component < 0 || component > 255) {
        throw new Error(`${layerLabel}: srgb-255 components must be within 0..255`);
      }
    }
  } else {
    for (const component of color.rgb) {
      if (component < 0 || component > 1) {
        throw new Error(`${layerLabel}: ${space} components must be within 0..1`);
      }
    }
  }
  if (alpha < 0 || alpha > 1) {
    throw new Error(`${layerLabel}: alpha must be within 0..1`);
  }
  return {space, alpha};
}

function layerId(layer: LayerInput, role: string, index: number): string {
  return layer.id ?? `${role}-${index}`;
}

/**
 * Linearize one authored layer and downgrade wide-gamut input into linear
 * sRGB. The returned ColorSource records exactly where the color came from
 * and whether gamut clamping touched it.
 */
export function linearizeLayer(
  layer: LayerInput,
  role: 'foreground' | 'background',
  index: number,
): ColorSource {
  const id = layerId(layer, role, index);
  const name = layer.name ?? id;
  const kind = layer.kind ?? (role === 'background' ? 'paint' : 'paint');

  if (kind === 'unknown') {
    // An unknown backdrop has no color math; it is resolved separately over
    // black and white. It must still carry a valid (or absent) color.
    if (layer.color !== undefined) validateColor(layer.color, name);
    return {
      layerId: id,
      name,
      kind,
      sourceSpace: 'none',
      resolvedSpace: 'none',
      linear: [0, 0, 0],
      linearSRGB: [0, 0, 0],
      channels: ['in-gamut', 'in-gamut', 'in-gamut'],
      downgraded: false,
      opacity: 1,
      alphaState: 'opaque',
    };
  }

  const {space, alpha} = validateColor(layer.color, name);
  const encoded =
    space === 'srgb-255'
      ? ((layer.color!.rgb as [number, number, number]).map(v => v / 255) as [
          number,
          number,
          number,
        ])
      : ([...(layer.color!.rgb as [number, number, number])] as [number, number, number]);

  let linear: [number, number, number];
  let resolvedSpace: ColorSource['resolvedSpace'];
  if (space === 'display-p3') {
    linear = encoded.map(srgbToLinear) as [number, number, number];
    resolvedSpace = 'display-p3-linear';
  } else if (space === 'prophoto-rgb') {
    linear = encoded.map(prophotoToLinear) as [number, number, number];
    resolvedSpace = 'prophoto-linear';
  } else {
    linear = encoded.map(srgbToLinear) as [number, number, number];
    resolvedSpace = 'srgb-linear';
  }

  let linearSRGB: [number, number, number];
  let channels: [ChannelState, ChannelState, ChannelState];
  let downgraded: boolean;
  if (space === 'display-p3' || space === 'prophoto-rgb') {
    const converted = applyMatrix(
      space === 'display-p3' ? P3_TO_SRGB : PROPHOTO_TO_SRGB,
      linear,
    );
    const fitted = clampToSRGB(converted);
    linearSRGB = fitted.rgb;
    channels = fitted.channels;
    downgraded = channels.some(state => state !== 'in-gamut');
  } else {
    linearSRGB = linear;
    channels = ['in-gamut', 'in-gamut', 'in-gamut'];
    downgraded = false;
  }

  return {
    layerId: id,
    name,
    kind,
    sourceSpace: space,
    resolvedSpace,
    linear,
    linearSRGB,
    channels,
    downgraded,
    opacity: alpha,
    alphaState: alpha === 0 ? 'transparent' : alpha === 1 ? 'opaque' : 'translucent',
  };
}

/**
 * Porter-Duff "source over" on PREMULTIPLIED (associated) colors:
 *   αo = αs + (1−αs)·αb
 *   Co = αs·Cs + (1−αs)·Cb      (Co, Cb already premultiplied)
 * Premultiplied source-over is associative, so stacking any number of
 * translucent layers is just repeated application. We only unpremultiply when
 * materializing the resolved pixel (coverage === 1 above an opaque/known base,
 * or against the chosen black/white extreme above an unknown base).
 */
function sourceOverPremul(
  source: ColorSource,
  backdropPremul: [number, number, number],
  backdropCoverage: number,
): {premul: [number, number, number]; coverage: number} {
  const a = source.opacity;
  const coverage = a + (1 - a) * backdropCoverage;
  const cs = source.linearSRGB;
  return {
    premul: [
      a * cs[0] + (1 - a) * backdropPremul[0],
      a * cs[1] + (1 - a) * backdropPremul[1],
      a * cs[2] + (1 - a) * backdropPremul[2],
    ],
    coverage,
  };
}

/** Convert an accumulated premultiplied pixel to plain color. */
function unpremultiply(
  premul: [number, number, number],
  coverage: number,
): [number, number, number] {
  if (coverage === 0) return [0, 0, 0];
  return [premul[0] / coverage, premul[1] / coverage, premul[2] / coverage];
}

/** WCAG 2 relative luminance from linear-sRGB components. */
export function relativeLuminance(rgb: [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** WCAG contrast ratio. Compare thresholds using this unrounded value. */
export function contrastRatio(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Full analysis: linearize every layer, composite the background stack
 * bottom-up, then composite the foreground on top. Returns per-layer color
 * sources, the full compositing trace, final luminances and the (possibly
 * ranged) contrast verdict against the threshold.
 */
export function analyzeContrast(request: ContrastRequest): ContrastResult {
  if (!request || typeof request !== 'object') {
    throw new Error('request must be an object');
  }
  if (!request.foreground) {
    throw new Error('foreground layer is required');
  }
  if (!Array.isArray(request.backgrounds)) {
    throw new Error('backgrounds must be an array (bottom layer first)');
  }
  const threshold = request.threshold ?? 4.5;
  if (!isFiniteNumber(threshold) || threshold < 1) {
    throw new Error('threshold must be a finite number >= 1');
  }

  const backgrounds = request.backgrounds.map((layer, index) =>
    linearizeLayer(layer, 'background', index),
  );
  const foreground = linearizeLayer(request.foreground, 'foreground', 0);

  backgrounds.forEach((source, index) => {
    if (source.kind === 'unknown' && index !== 0) {
      throw new Error(
        `layer "${source.name}": an unknown backdrop may only be the bottom background layer`,
      );
    }
  });
  if (foreground.kind === 'unknown') {
    throw new Error('foreground cannot be an unknown layer');
  }
  if (backgrounds.length === 0) {
    throw new Error(
      'at least one background layer is required (use an unknown layer if the page backdrop is unspecified)',
    );
  }
  if (backgrounds[0].kind !== 'unknown' && backgrounds[0].opacity !== 1) {
    throw new Error(
      `bottom background layer "${backgrounds[0].name}" must be opaque (alpha 1) or marked unknown`,
    );
  }

  const hasUnknownBase = backgrounds[0].kind === 'unknown';
  const knownStack = hasUnknownBase ? backgrounds.slice(1) : backgrounds;

  interface Accumulated {
    /** Premultiplied stack of known backgrounds above the extreme/base. */
    stackPremul: [number, number, number];
    stackCoverage: number;
    backgroundSteps: CompositeStep[];
  }

  /**
   * Repeated premultiplied source-over of the known background stack, starting
   * from `basePremul`/`baseCoverage`: an opaque known bottom layer, or the
   * black/white extreme for an unknown backdrop. Trace entries hold the
   * resolved plain color plus accumulated coverage at each layer.
   */
  const accumulateBackgrounds = (
    basePremul: [number, number, number],
    baseCoverage: number,
  ): Accumulated => {
    const backgroundSteps: CompositeStep[] = [];
    let premul = [...basePremul] as [number, number, number];
    let coverage = baseCoverage;
    for (const source of knownStack) {
      ({premul, coverage} = sourceOverPremul(source, premul, coverage));
      backgroundSteps.push({
        layerId: source.layerId,
        name: source.name,
        over: unpremultiply(premul, coverage),
        coverage,
      });
    }
    return {stackPremul: premul, stackCoverage: coverage, backgroundSteps};
  };

  const cacheKey = buildCacheKey(request);

  /** Unassociated "source over" against an OPAQUE backdrop: aC + (1−a)b. */
  const overOpaque = (
    source: ColorSource,
    backdrop: [number, number, number],
  ): [number, number, number] => {
    const a = source.opacity;
    const cs = source.linearSRGB;
    return [
      a * cs[0] + (1 - a) * backdrop[0],
      a * cs[1] + (1 - a) * backdrop[1],
      a * cs[2] + (1 - a) * backdrop[2],
    ];
  };

  if (!hasUnknownBase) {
    // The bottom known layer is opaque; start from an empty backdrop and let
    // the bottom layer be the first source-over source.
    const acc = accumulateBackgrounds([0, 0, 0], 0);
    const backdrop = unpremultiply(acc.stackPremul, acc.stackCoverage);
    const withText = sourceOverPremul(foreground, acc.stackPremul, acc.stackCoverage);
    const text = unpremultiply(withText.premul, withText.coverage);
    const steps: CompositeStep[] = [
      ...acc.backgroundSteps,
      {
        layerId: foreground.layerId,
        name: foreground.name,
        over: text,
        coverage: withText.coverage,
      },
    ];

    const value = contrastRatio(text, backdrop);
    return {
      foreground,
      backgrounds,
      trace: {exact: steps, range: null},
      effectiveText: {kind: 'exact', rgb: text},
      effectiveBackdrop: {kind: 'exact', rgb: backdrop},
      textLuminance: relativeLuminance(text),
      backdropLuminance: relativeLuminance(backdrop),
      contrast: {kind: 'exact', value},
      threshold,
      pass: value >= threshold,
      cacheKey,
    };
  }

  // Unknown base: run TWO hypothetical pipelines over each extreme base
  // color.
  //   backdrop pixel = composite(known backgrounds) over extreme
  //   text pixel     = composite(known backgrounds + foreground) over extreme
  // Contrast for one extreme compares the two pixels from that SAME pipeline.
  // This is the meaningful quantity: with the text present vs. just behind it,
  // both sharing the hypothetical base. Extrema over any base color occur at
  // black/white (contrast is concave in the backdrop luminance).
  const resolveExtreme = (
    extreme: [number, number, number],
  ): {
    backdrop: [number, number, number];
    text: [number, number, number];
    steps: CompositeStep[];
  } => {
    const steps: CompositeStep[] = [];
    let pixel = [...extreme] as [number, number, number];
    for (const source of knownStack) {
      pixel = overOpaque(source, pixel);
      steps.push({layerId: source.layerId, name: source.name, over: pixel, coverage: 1});
    }
    const backdrop = [...pixel] as [number, number, number];
    pixel = overOpaque(foreground, pixel);
    steps.push({layerId: foreground.layerId, name: foreground.name, over: pixel, coverage: 1});
    return {backdrop, text: pixel, steps};
  };

  const overBlack = resolveExtreme(BLACK);
  const overWhite = resolveExtreme(WHITE);

  const ratioBlack = contrastRatio(overBlack.text, overBlack.backdrop);
  const ratioWhite = contrastRatio(overWhite.text, overWhite.backdrop);
  // Contrast is concave in the backdrop luminance, so the extrema over any
  // backdrop color are attained at black and white.
  const min = Math.min(ratioBlack, ratioWhite);
  const max = Math.max(ratioBlack, ratioWhite);
  const pass: boolean | 'partial' =
    min >= threshold ? true : max >= threshold ? 'partial' : false;

  const lumMin = (a: [number, number, number], b: [number, number, number]) =>
    Math.min(relativeLuminance(a), relativeLuminance(b));
  const lumMax = (a: [number, number, number], b: [number, number, number]) =>
    Math.max(relativeLuminance(a), relativeLuminance(b));

  return {
    foreground,
    backgrounds,
    trace: {
      exact: null,
      range: {overBlack: overBlack.steps, overWhite: overWhite.steps},
    },
    effectiveText: {kind: 'range', overBlack: overBlack.text, overWhite: overWhite.text},
    effectiveBackdrop: {
      kind: 'range',
      overBlack: overBlack.backdrop,
      overWhite: overWhite.backdrop,
    },
    textLuminance: {
      min: lumMin(overBlack.text, overWhite.text),
      max: lumMax(overBlack.text, overWhite.text),
    },
    backdropLuminance: {
      min: lumMin(overBlack.backdrop, overWhite.backdrop),
      max: lumMax(overBlack.backdrop, overWhite.backdrop),
    },
    contrast: {kind: 'range', min, max, overBlack: ratioBlack, overWhite: ratioWhite},
    threshold,
    pass,
    cacheKey,
  };
}

/**
 * Deterministic cache key for a request. Serializes every layer — including
 * space, all three components, alpha, kind, id and name — in stack order, so
 * two requests with different background layers never share a cache entry.
 */
export function buildCacheKey(request: ContrastRequest): string {
  const color = (color: ColorInput | undefined) => {
    if (!color) return null;
    return [
      color.space ?? 'srgb',
      color.rgb.map(v => Number(v.toFixed(6))),
      color.alpha ?? 1,
    ];
  };
  const layer = (layer: LayerInput) => [
    layer.id ?? null,
    layer.name ?? null,
    layer.kind ?? 'paint',
    color(layer.color),
  ];
  return stableStringify([
    'contrast-v1',
    layer(request.foreground),
    request.backgrounds.map(layer),
    request.threshold ?? 4.5,
  ]);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

/* ------------------------------------------------------------------ */
/* Display formatting ONLY. Never feed these back into threshold math. */
/* ------------------------------------------------------------------ */

/** Round half away from zero to `digits` decimal places (ties go up). */
export function roundHalfUp(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  // Shift via string rounding of the integer magnitude to avoid 1.005-style
  // binary representation surprises at the tie.
  const sign = value < 0 ? -1 : 1;
  const shifted = Math.round(Math.abs(value) * factor);
  return (sign * shifted) / factor;
}

/** "4.5:1" style display string. Uses the UNROUNDED ratio internally only. */
export function formatContrast(value: number, digits = 2): string {
  return `${roundHalfUp(value, digits).toFixed(digits)}:1`;
}

/** Format a luminance for display (4 decimals). */
export function formatLuminance(value: number, digits = 4): string {
  return roundHalfUp(value, digits).toFixed(digits);
}

/** Quantize a linear-sRGB channel to the 8-bit sRGB value used by previews. */
export function toSRGB255(linearChannel: number): number {
  const encoded = linearToSRGB(clamp01(linearChannel));
  return Math.round(clamp01(encoded) * 255);
}

/** CSS rgb() string from linear-sRGB components, for swatches. */
export function formatLinearSRGB(rgb: [number, number, number]): string {
  return `rgb(${toSRGB255(rgb[0])}, ${toSRGB255(rgb[1])}, ${toSRGB255(rgb[2])})`;
}
