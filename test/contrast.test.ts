import {describe, expect, it} from 'vitest';
import {
  analyzeContrast,
  buildCacheKey,
  formatContrast,
  formatLuminance,
  roundHalfUp,
  srgbToLinear,
  toSRGB255,
  type ContrastRequest,
} from '../src/shared/contrast';
import {expectedResults, expectedFor, scenarioById, scenarios} from '../src/shared/vectors';

describe('sRGB linearization', () => {
  it('matches the WCAG piecewise EOTF at known knots', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBe(1);
    // linear-section breakpoint
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 15);
    // 0.5 -> ~0.2140411
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404114048223255, 14);
  });

  it('round-trips through the OETF used by the preview quantizer', () => {
    for (const value of [0, 0.001, 0.04, 0.21404114048223255, 1]) {
      expect(toSRGB255(value)).toBeGreaterThanOrEqual(0);
      expect(toSRGB255(value)).toBeLessThanOrEqual(255);
    }
    expect(toSRGB255(0)).toBe(0);
    expect(toSRGB255(1)).toBe(255);
    expect(toSRGB255(0.21404114048223255)).toBe(128);
  });
});

describe('shared vectors', () => {
  for (const expected of expectedResults) {
    it(`${expected.scenarioId}: ${expected.kind} verdict`, () => {
      const scenario = scenarioById(expected.scenarioId);
      const result = analyzeContrast(scenario.request);

      expect(result.contrast.kind).toBe(expected.kind);
      expect(result.pass).toBe(expected.pass);

      if (expected.kind === 'exact') {
        expect(result.contrast.kind).toBe('exact');
        if (result.contrast.kind !== 'exact') return;
        expect(result.contrast.value).toBeCloseTo(expected.exact!, 12);
      } else {
        expect(result.contrast.kind).toBe('range');
        if (result.contrast.kind !== 'range') return;
        expect(result.contrast.min).toBeCloseTo(expected.min!, 12);
        expect(result.contrast.max).toBeCloseTo(expected.max!, 12);
        expect(result.contrast.min).toBeLessThanOrEqual(result.contrast.max);
        expect(result.contrast.overBlack).toBeGreaterThan(0);
        expect(result.contrast.overWhite).toBeGreaterThan(0);
      }

      if (expected.facts) {
        if (expected.facts.foregroundDowngraded !== undefined) {
          expect(result.foreground.downgraded).toBe(expected.facts.foregroundDowngraded);
        }
        if (expected.facts.foregroundChannels) {
          expect(result.foreground.channels).toEqual(expected.facts.foregroundChannels);
        }
        if (expected.facts.foregroundAlphaState) {
          expect(result.foreground.alphaState).toBe(expected.facts.foregroundAlphaState);
        }
        if (expected.facts.traceSteps !== undefined) {
          const steps = result.trace.exact ?? result.trace.range!.overBlack;
          expect(steps).toHaveLength(expected.facts.traceSteps);
        }
      }
    });
  }
});

describe('alpha boundaries', () => {
  it('alpha 0 foreground leaves the sampled backdrop unchanged', () => {
    const result = analyzeContrast({
      foreground: {name: 't', color: {rgb: [0, 0, 0], alpha: 0}},
      backgrounds: [{name: 'b', color: {rgb: [1, 1, 1]}}],
    });
    expect(result.contrast).toMatchObject({kind: 'exact', value: 1});
    expect(result.foreground.alphaState).toBe('transparent');
  });

  it('alpha 0 background layer is a no-op between opaque layers', () => {
    const withGap = analyzeContrast({
      foreground: {name: 't', color: {rgb: [0, 0, 0]}},
      backgrounds: [
        {name: 'page', color: {rgb: [1, 1, 1]}},
        {name: 'invisible veil', color: {rgb: [0, 0, 0], alpha: 0}},
      ],
    });
    expect(withGap.contrast).toMatchObject({kind: 'exact', value: 21});
  });

  it('alpha 1 translucent layer fully occludes everything below', () => {
    const result = analyzeContrast({
      foreground: {name: 't', color: {rgb: [1, 1, 1]}},
      backgrounds: [
        {name: 'page', color: {rgb: [0, 0, 0]}},
        {name: 'card', color: {rgb: [0.2, 0.5, 0.9], alpha: 1}},
      ],
    });
    const plain = analyzeContrast({
      foreground: {name: 't', color: {rgb: [1, 1, 1]}},
      backgrounds: [{name: 'card', color: {rgb: [0.2, 0.5, 0.9]}}],
    });
    expect(result.contrast).toEqual(plain.contrast);
  });
});

describe('multi-layer stacking', () => {
  it('composites every background layer and reports each source', () => {
    const result = analyzeContrast({
      foreground: {name: 'text', color: {rgb: [0, 0, 0]}},
      backgrounds: [
        {id: 'p', name: 'page', color: {rgb: [1, 1, 1]}},
        {id: 's1', name: 'shade', kind: 'sample', color: {rgb: [0, 0, 0], alpha: 0.25}},
        {id: 's2', name: 'tint', color: {rgb: [0, 0, 0], alpha: 0.25}},
      ],
    });
    expect(result.backgrounds).toHaveLength(3);
    expect(result.backgrounds.map(b => b.kind)).toEqual(['paint', 'sample', 'paint']);
    expect(result.trace.exact).toHaveLength(4);
    // Two independent 25% black layers composite to 1−.75² = 43.75% black
    // over white -> linear 0.5625 -> ratio (0.5625+.05)/.05.
    expect(result.contrast).toMatchObject({kind: 'exact'});
    if (result.contrast.kind !== 'exact') throw new Error('expected exact');
    expect(result.contrast.value).toBeCloseTo(12.25, 12);
  });
});

describe('unknown backdrop', () => {
  it('returns a range spanning 1..21 for opaque black text', () => {
    const result = analyzeContrast({
      foreground: {color: {rgb: [0, 0, 0]}},
      backgrounds: [{kind: 'unknown'}],
    });
    expect(result.contrast.kind).toBe('range');
    if (result.contrast.kind !== 'range') return;
    expect(result.contrast.min).toBeCloseTo(1, 12);
    expect(result.contrast.max).toBeCloseTo(21, 12);
    expect(result.pass).toBe('partial');
  });

  it('is partial when only some backdrops clear the threshold', () => {
    const result = analyzeContrast(scenarioById('translucent-unknown').request);
    expect(result.pass).toBe('partial');
  });

  it('fails outright when even the best backdrop cannot clear the threshold', () => {
    // Mid-gray text over unknown: on black ~5.25, on white ~1.61; below 8:1
    // on every backdrop.
    const result = analyzeContrast({
      foreground: {color: {rgb: [0.6, 0.6, 0.6]}},
      backgrounds: [{kind: 'unknown'}],
      threshold: 8,
    });
    expect(result.contrast.kind).toBe('range');
    if (result.contrast.kind !== 'range') return;
    expect(result.contrast.max).toBeLessThan(8);
    expect(result.pass).toBe(false);
  });

  it('passes when the worst backdrop already clears the threshold', () => {
    // A 99% black scrim with near-opaque WHITE text: even if the unknown base
    // is white, the scrim darkens the backdrop to ~0.01 while the text stays
    // near white -> the least favorable extreme still clears 4.5:1.
    const result = analyzeContrast({
      foreground: {color: {rgb: [1, 1, 1], alpha: 0.99}},
      backgrounds: [
        {kind: 'unknown'},
        {color: {rgb: [0, 0, 0], alpha: 0.99}},
      ],
      threshold: 4.5,
    });
    if (result.contrast.kind !== 'range') return;
    expect(result.contrast.min).toBeGreaterThanOrEqual(4.5);
    expect(result.pass).toBe(true);
  });

  it('rejects an unknown layer anywhere except the bottom', () => {
    expect(() =>
      analyzeContrast({
        foreground: {color: {rgb: [0, 0, 0]}},
        backgrounds: [{color: {rgb: [1, 1, 1]}}, {kind: 'unknown'}],
      }),
    ).toThrow(/bottom background layer/);
  });

  it('rejects a translucent bottom known layer (would hide an unknown base)', () => {
    expect(() =>
      analyzeContrast({
        foreground: {color: {rgb: [0, 0, 0]}},
        backgrounds: [{color: {rgb: [1, 1, 1], alpha: 0.5}}],
      }),
    ).toThrow(/opaque/);
  });
});

describe('wide-gamut downgrade', () => {
  it('clamps out-of-gamut display-p3 channels and flags them', () => {
    const result = analyzeContrast({
      foreground: {color: {rgb: [1, 0, 0], space: 'display-p3'}},
      backgrounds: [{color: {rgb: [1, 1, 1]}}],
    });
    expect(result.foreground.downgraded).toBe(true);
    expect(result.foreground.channels).toEqual(['clamped-high', 'clamped-low', 'clamped-low']);
    // After the clamp the red is sRGB (1,0,0): ratio ~3.998.
    if (result.contrast.kind !== 'exact') throw new Error('expected exact');
    expect(result.contrast.value).toBeCloseTo(3.9984767707539985, 12);
    expect(result.foreground.sourceSpace).toBe('display-p3');
    expect(result.foreground.resolvedSpace).toBe('display-p3-linear');
  });

  it('leaves in-gamut P3 colors untouched and not flagged', () => {
    const result = analyzeContrast({
      foreground: {color: {rgb: [0.5, 0.5, 0.5], space: 'display-p3'}},
      backgrounds: [{color: {rgb: [0, 0, 0]}}],
    });
    expect(result.foreground.downgraded).toBe(false);
    expect(result.foreground.channels.every(c => c === 'in-gamut')).toBe(true);
  });

  it('downgrades ProPhoto through the D50->D65 matrix', () => {
    const result = analyzeContrast(scenarioById('wide-gamut-prophoto').request);
    expect(result.foreground.resolvedSpace).toBe('prophoto-linear');
    expect(result.foreground.downgraded).toBe(true);
  });
});

describe('rounding boundary', () => {
  it('uses the unrounded ratio for the threshold but a rounded string for display', () => {
    const result = analyzeContrast(scenarioById('rounding-boundary').request);
    if (result.contrast.kind !== 'exact') throw new Error('expected exact');
    expect(result.contrast.value).toBeLessThan(4.5);
    expect(result.pass).toBe(false);
    expect(formatContrast(result.contrast.value)).toBe('4.50:1');
  });

  it('roundHalfUp sends ties up (half away from zero)', () => {
    expect(roundHalfUp(4.4995, 2)).toBe(4.5);
    expect(roundHalfUp(4.494, 2)).toBe(4.49);
    expect(roundHalfUp(2.5, 0)).toBe(3);
    expect(roundHalfUp(-2.5, 0)).toBe(-3);
  });

  it('formats luminances for display without mutating raw values', () => {
    const result = analyzeContrast(scenarioById('encoded-255').request);
    expect(typeof result.backdropLuminance).toBe('number');
    expect(formatLuminance(result.backdropLuminance as number)).toMatch(/^\d+\.\d{4}$/);
  });
});

describe('validation', () => {
  const base = (): ContrastRequest => ({
    foreground: {color: {rgb: [0, 0, 0]}},
    backgrounds: [{color: {rgb: [1, 1, 1]}}],
  });

  it('rejects out-of-range srgb-255 and unit srgb components', () => {
    const bad255 = base();
    bad255.backgrounds = [{color: {rgb: [300, 0, 0], space: 'srgb-255'}}];
    expect(() => analyzeContrast(bad255)).toThrow(/0\.\.255/);

    const badUnit = base();
    badUnit.backgrounds = [{color: {rgb: [1.2, 0, 0]}}];
    expect(() => analyzeContrast(badUnit)).toThrow(/0\.\.1/);

    const badAlpha = base();
    badAlpha.foreground = {color: {rgb: [0, 0, 0], alpha: 2}};
    expect(() => analyzeContrast(badAlpha)).toThrow(/alpha/);
  });

  it('rejects unknown color spaces and non-finite numbers', () => {
    const badSpace = base();
    // @ts-expect-error intentionally invalid space
    badSpace.backgrounds = [{color: {rgb: [0, 0, 0], space: 'cmyk'}}];
    expect(() => analyzeContrast(badSpace)).toThrow(/color space/);

    const badNumber = base();
    badNumber.backgrounds = [{color: {rgb: [NaN, 0, 0]}}];
    expect(() => analyzeContrast(badNumber)).toThrow(/finite/);
  });
});

describe('cache key', () => {
  it('is stable for equivalent requests regardless of property order', () => {
    const a: ContrastRequest = {
      threshold: 4.5,
      foreground: {name: 't', color: {rgb: [0, 0, 0], alpha: 0.5}},
      backgrounds: [
        {name: 'page', color: {rgb: [1, 1, 1]}},
        {name: 'veil', color: {rgb: [0, 0, 0], alpha: 0.25}},
      ],
    };
    const b: ContrastRequest = {
      foreground: {color: {alpha: 0.5, rgb: [0, 0, 0]}, name: 't'},
      backgrounds: [
        {color: {rgb: [1, 1, 1]}, name: 'page'},
        {color: {alpha: 0.25, rgb: [0, 0, 0]}, name: 'veil'},
      ],
      threshold: 4.5,
    };
    expect(buildCacheKey(a)).toBe(buildCacheKey(b));
  });

  it('changes when ANY background layer is added, removed, reordered or retinted', () => {
    const baseKey = buildCacheKey(scenarioById('multi-layer').request);
    const request = scenarioById('multi-layer').request;

    const added: ContrastRequest = {
      ...request,
      backgrounds: [...request.backgrounds, {name: 'extra', color: {rgb: [1, 0, 1], alpha: 0.1}}],
    };
    expect(buildCacheKey(added)).not.toBe(baseKey);

    const removed: ContrastRequest = {...request, backgrounds: request.backgrounds.slice(0, 1)};
    expect(buildCacheKey(removed)).not.toBe(baseKey);

    const reordered: ContrastRequest = {
      ...request,
      backgrounds: [request.backgrounds[1], request.backgrounds[0]],
    };
    expect(buildCacheKey(reordered)).not.toBe(baseKey);

    const retinted: ContrastRequest = {
      ...request,
      backgrounds: [
        request.backgrounds[0],
        {...request.backgrounds[1], color: {rgb: [0, 0, 0], alpha: 0.6}},
      ],
    };
    expect(buildCacheKey(retinted)).not.toBe(baseKey);

    const sampled: ContrastRequest = {
      ...request,
      backgrounds: [
        request.backgrounds[0],
        {...request.backgrounds[1], kind: 'sample' as const},
      ],
    };
    expect(buildCacheKey(sampled)).not.toBe(baseKey);
  });

  it('includes color space and threshold', () => {
    const srgb = scenarioById('wide-gamut-p3').request;
    const p3Key = buildCacheKey(srgb);
    const converted: ContrastRequest = {
      ...srgb,
      foreground: {name: 'p3 red text', color: {rgb: [1, 0, 0]}},
    };
    expect(buildCacheKey(converted)).not.toBe(p3Key);
    expect(buildCacheKey({...srgb, threshold: 3})).not.toBe(p3Key);
  });

  it('covers every scenario deterministically', () => {
    const keys = scenarios.map(s => buildCacheKey(s.request));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
