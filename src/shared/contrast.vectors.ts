import type {ContrastRequest} from './contrast';

/**
 * Shared test vectors. Both the unit tests (module level) and the API tests
 * (server round-trip) run against these, so the frontend, backend and tests
 * can never drift onto separate formulas.
 *
 * Expected values below are closed-form: every vector uses colors whose
 * linear values are exact (0, 1, or alpha blends of those), except the
 * display-p3 degradation case which carries a lower comparison precision.
 */
export interface ContrastVector {
  name: string;
  request: ContrastRequest;
  expect: {
    backgroundLuminance?: number | [number, number];
    textLuminance?: number | [number, number];
    ratio?: number | [number, number];
    verdict: 'pass' | 'fail' | 'undetermined';
    /** Substrings that must appear in some layer's warnings. */
    warnings?: string[];
  };
  /** Decimal precision for floating comparisons (default 6). */
  precision?: number;
}

export const contrastVectors: ContrastVector[] = [
  {
    name: 'black on white',
    request: {foreground: {color: '#000000'}, background: [{color: '#ffffff'}], threshold: 4.5},
    expect: {backgroundLuminance: 1, textLuminance: 0, ratio: 21, verdict: 'pass'},
  },
  {
    name: 'white on black',
    request: {foreground: {color: '#ffffff'}, background: [{color: '#000000'}], threshold: 4.5},
    expect: {backgroundLuminance: 0, textLuminance: 1, ratio: 21, verdict: 'pass'},
  },
  {
    name: 'half-opaque white over black',
    request: {
      foreground: {color: '#000'},
      background: [{color: 'rgba(255,255,255,0.5)'}, {color: '#000000'}],
      threshold: 4.5,
    },
    expect: {backgroundLuminance: 0.5, textLuminance: 0, ratio: 11, verdict: 'pass'},
  },
  {
    name: 'three-layer stack composites bottom-up',
    request: {
      foreground: {color: '#000000'},
      background: [
        {color: 'rgba(255,255,255,0.5)'},
        {color: 'rgba(0,0,0,0.5)'},
        {color: '#ffffff'},
      ],
      threshold: 4.5,
    },
    // 1 -> 0.5 (black 50%) -> 0.75 (white 50%)
    expect: {backgroundLuminance: 0.75, textLuminance: 0, ratio: 16, verdict: 'pass'},
  },
  {
    name: 'semi-transparent text over white',
    request: {foreground: {color: '#000000', alpha: 0.5}, background: [{color: '#ffffff'}], threshold: 4.5},
    expect: {backgroundLuminance: 1, textLuminance: 0.5, ratio: 1.909091, verdict: 'fail'},
  },
  {
    name: 'fully transparent text has contrast 1',
    request: {foreground: {color: 'rgba(0,0,0,0)'}, background: [{color: '#ffffff'}], threshold: 4.5},
    expect: {backgroundLuminance: 1, textLuminance: 1, ratio: 1, verdict: 'fail'},
  },
  {
    name: 'unknown base returns a range, straddling threshold',
    request: {
      foreground: {color: '#000000'},
      background: [{color: 'rgba(255,255,255,0.5)'}, {color: null}],
      threshold: 15,
    },
    expect: {backgroundLuminance: [0.5, 1], textLuminance: 0, ratio: [11, 21], verdict: 'undetermined'},
  },
  {
    name: 'unknown base, range fully above threshold',
    request: {
      foreground: {color: '#000000'},
      background: [{color: 'rgba(255,255,255,0.5)'}, {color: '?'}],
      threshold: 4.5,
    },
    expect: {backgroundLuminance: [0.5, 1], ratio: [11, 21], verdict: 'pass'},
  },
  {
    name: 'unknown base, range fully below threshold',
    request: {
      foreground: {color: '#000000'},
      background: [{color: 'rgba(255,255,255,0.5)'}, {color: 'unknown'}],
      threshold: 25,
    },
    expect: {backgroundLuminance: [0.5, 1], ratio: [11, 21], verdict: 'fail'},
  },
  {
    name: 'non-opaque stack without a base is implicitly unknown',
    request: {foreground: {color: '#ffffff'}, background: [{color: 'rgba(0,0,0,0.5)'}], threshold: 4.5},
    // base luminance u in [0,1]: bg = 0.5u, text = 1 -> ratio 21 .. 1.909091
    expect: {backgroundLuminance: [0, 0.5], textLuminance: 1, ratio: [1.909091, 21], verdict: 'undetermined'},
  },
  {
    name: 'semi-transparent white over fully unknown base dips to 1',
    request: {foreground: {color: '#ffffff', alpha: 0.5}, background: [{color: null}], threshold: 4.5},
    // text = 0.5 + 0.5u meets bg = u at u = 1 -> min ratio exactly 1
    expect: {backgroundLuminance: [0, 1], textLuminance: [0.5, 1], ratio: [1, 11], verdict: 'undetermined'},
  },
  {
    name: 'display-p3 red degrades to clamped sRGB red',
    request: {foreground: {color: 'color(display-p3 1 0 0)'}, background: [{color: '#ffffff'}], threshold: 4.5},
    // clamps to sRGB (1,0,0): luminance 0.2126, ratio 1.05 / 0.2626
    expect: {textLuminance: 0.2126, ratio: 3.998477, verdict: 'fail', warnings: ['outside sRGB gamut']},
    precision: 4,
  },
];
