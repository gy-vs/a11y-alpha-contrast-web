import {describe,expect,it} from 'vitest';
import {
  analyzeContrast,
  compositeOver,
  ContrastInputError,
  contrastCacheKey,
  formatRatio,
  meetsThreshold,
  parseColor,
  relativeLuminance,
  srgbChannelToLinear,
  srgbToLinear,
  type ContrastRequest,
} from '../src/shared/contrast';
import {contrastVectors} from '../src/shared/contrast.vectors';

const asNum=(v:number|{min:number;max:number})=>{if(typeof v!=='number')throw new Error('expected a single value, got a range');return v};
const ratioOf=(req:ContrastRequest)=>asNum(analyzeContrast(req).contrast.ratio);

describe('sRGB linearization',()=>{
  it('maps 0 -> 0 and 1 -> 1',()=>{
    expect(srgbChannelToLinear(0)).toBe(0);
    expect(srgbChannelToLinear(1)).toBe(1);
  });
  it('uses the linear segment at and below 0.04045',()=>{
    expect(srgbChannelToLinear(0.04045)).toBeCloseTo(0.04045/12.92,12);
    expect(srgbChannelToLinear(10/255)).toBeCloseTo((10/255)/12.92,12);
  });
  it('uses the power segment above 0.04045',()=>{
    const c=11/255;
    expect(srgbChannelToLinear(c)).toBeCloseTo(Math.pow((c+0.055)/1.055,2.4),12);
  });
  it('is continuous across the segment boundary',()=>{
    const below=srgbChannelToLinear(0.04045);
    const above=srgbChannelToLinear(0.04045+1e-9);
    expect(Math.abs(below-above)).toBeLessThan(1e-6);
  });
  it('linearizes #808080 to the known WCAG value',()=>{
    const linear=srgbToLinear([128/255,128/255,128/255]);
    expect(relativeLuminance(linear)).toBeCloseTo(0.2158605,5);
  });
});

describe('alpha 0 and 1',()=>{
  it('alpha 0 foreground is invisible: contrast is exactly 1',()=>{
    expect(ratioOf({foreground:{color:'#000000',alpha:0},background:[{color:'#ffffff'}]})).toBe(1);
    expect(ratioOf({foreground:{color:'rgba(10,200,90,0)'},background:[{color:'#123456'}]})).toBe(1);
  });
  it('alpha 1 foreground text luminance equals its own luminance',()=>{
    const report=analyzeContrast({foreground:{color:'#808080',alpha:1},background:[{color:'#000000'}]});
    expect(asNum(report.text.luminance)).toBeCloseTo(0.2158605,6);
  });
  it('alpha 0 background layer contributes nothing',()=>{
    const withLayer=ratioOf({foreground:{color:'#ffffff'},background:[{color:'rgba(9,99,200,0)'},{color:'#000000'}]});
    const without=ratioOf({foreground:{color:'#ffffff'},background:[{color:'#000000'}]});
    expect(withLayer).toBe(without);
  });
  it('alpha 1 background layer hides everything below it',()=>{
    const a=ratioOf({foreground:{color:'#ffffff'},background:[{color:'#336699'},{color:'#000000'}]});
    const b=ratioOf({foreground:{color:'#ffffff'},background:[{color:'#336699'},{color:'#ffffff'}]});
    const c=ratioOf({foreground:{color:'#ffffff'},background:[{color:'#336699'},{color:null}]});
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

describe('multi-layer compositing',()=>{
  it('composites in linear space, not on encoded sRGB',()=>{
    // 50% white over black is 0.5 in linear space (luminance 0.5),
    // not the ~0.735 that averaging encoded sRGB would give.
    const report=analyzeContrast({foreground:{color:'#000000'},background:[{color:'rgba(255,255,255,0.5)'},{color:'#000000'}]});
    expect(asNum(report.background.luminance)).toBeCloseTo(0.5,12);
  });
  it('matches a manual three-layer linear computation',()=>{
    const report=analyzeContrast({
      foreground:{color:'#ffffff'},
      background:[{color:'rgba(255,0,0,0.25)'},{color:'rgba(0,255,0,0.5)'},{color:'#000080'}],
    });
    const blue=srgbChannelToLinear(128/255);
    const mid=[0,0.5,0.5*blue];
    const top=[0.25*1+0.75*mid[0],0.75*mid[1],0.75*mid[2]];
    const expected=0.2126*top[0]+0.7152*top[1]+0.0722*top[2];
    expect(asNum(report.background.luminance)).toBeCloseTo(expected,12);
  });
  it('layer order matters',()=>{
    const ab=ratioOf({foreground:{color:'#000'},background:[{color:'rgba(255,255,255,0.5)'},{color:'rgba(0,0,0,0.5)'},{color:'#fff'}]});
    const ba=ratioOf({foreground:{color:'#000'},background:[{color:'rgba(0,0,0,0.5)'},{color:'rgba(255,255,255,0.5)'},{color:'#fff'}]});
    expect(ab).toBeCloseTo(16,10); // 0.75 stack
    expect(ba).toBeCloseTo(11,10); // 0.5 stack
    expect(ab).not.toBeCloseTo(ba,6);
  });
  it('compositeOver follows source-over algebra',()=>{
    const out=compositeOver({rgb:[1,0,0],alpha:0.25},{rgb:[0,0,1],alpha:0.5});
    expect(out.alpha).toBeCloseTo(0.625,12);
    expect(out.rgb[0]).toBeCloseTo(0.4,12);
    expect(out.rgb[2]).toBeCloseTo(0.6,12);
  });
});

describe('unknown base color',()=>{
  it('returns a luminance and ratio range instead of a single value',()=>{
    const report=analyzeContrast({foreground:{color:'#000000'},background:[{color:'rgba(255,255,255,0.5)'},{color:null}]});
    expect(report.background.unknownBase).toBe(true);
    expect(report.background.luminance).toEqual({min:0.5,max:1});
    expect(report.contrast.ratio).toEqual({min:11,max:21});
  });
  it('verdict is undetermined only when the range straddles the threshold',()=>{
    const base:ContrastRequest={foreground:{color:'#000000'},background:[{color:'rgba(255,255,255,0.5)'},{color:null}],threshold:4.5};
    expect(analyzeContrast(base).verdict).toBe('pass');
    expect(analyzeContrast({...base,threshold:15}).verdict).toBe('undetermined');
    expect(analyzeContrast({...base,threshold:25}).verdict).toBe('fail');
  });
  it('treats a non-opaque stack without a base as implicitly unknown',()=>{
    const report=analyzeContrast({foreground:{color:'#ffffff'},background:[{color:'rgba(0,0,0,0.5)'}]});
    expect(report.background.unknownBase).toBe(true);
    expect(report.background.coverage).toBeCloseTo(0.5,12);
  });
  it('detects text/background luminance crossing inside the range',()=>{
    // grey text at 50% alpha crosses the unknown background luminance,
    // so the minimum possible contrast is exactly 1.
    const report=analyzeContrast({foreground:{color:'#808080',alpha:0.5},background:[{color:null}]});
    const ratio=report.contrast.ratio as {min:number;max:number};
    expect(ratio.min).toBe(1);
    expect(ratio.max).toBeCloseTo(3.1586,3);
  });
  it('rejects unknown layers above the bottom',()=>{
    expect(()=>analyzeContrast({foreground:{color:'#000'},background:[{color:null},{color:'#fff'}]})).toThrow(ContrastInputError);
  });
  it('rejects an unknown foreground',()=>{
    expect(()=>analyzeContrast({foreground:{color:null},background:[{color:'#fff'}]})).toThrow(ContrastInputError);
  });
});

describe('wide-gamut input degradation',()=>{
  it('clamps display-p3 red to sRGB red with a warning',()=>{
    const parsed=parseColor('color(display-p3 1 0 0)');
    expect(parsed.source).toBe('display-p3');
    expect(parsed.srgb).toEqual([1,0,0]);
    expect(parsed.warnings.join(' ')).toMatch(/outside sRGB gamut/);
  });
  it('display-p3 green clamps the channels sRGB cannot represent',()=>{
    // linear P3 green maps to linear sRGB (-0.225, 1.042, -0.079): red and
    // blue go negative, green overflows to ~1.018 after encoding.
    const parsed=parseColor('color(display-p3 0 1 0)');
    expect(parsed.srgb).toEqual([0,1,0]);
    expect(parsed.warnings.length).toBe(1);
    expect(parsed.warnings.join(' ')).toMatch(/outside sRGB gamut/);
  });
  it('in-gamut display-p3 colors convert without warnings',()=>{
    const parsed=parseColor('color(display-p3 0.5 0.5 0.5)');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.srgb[0]).toBeCloseTo(0.5,3);
  });
  it('clamps out-of-range rgb() channels with a warning',()=>{
    const parsed=parseColor('rgb(300, -5, 0)');
    expect(parsed.srgb).toEqual([1,0,0]);
    expect(parsed.warnings.join(' ')).toMatch(/clamped/);
  });
  it('rejects unsupported color spaces explicitly',()=>{
    expect(()=>parseColor('color(rec2020 1 0 0)')).toThrow(ContrastInputError);
  });
});

describe('rounding boundaries',()=>{
  it('compares thresholds against unrounded values',()=>{
    expect(meetsThreshold(4.49999999,4.5)).toBe(false);
    expect(meetsThreshold(4.5,4.5)).toBe(true);
    expect(meetsThreshold(4.50000001,4.5)).toBe(true);
  });
  it('display formatting can show 4.50 while the rule still fails',()=>{
    expect(formatRatio(4.49999999)).toBe('4.50');
    expect(meetsThreshold(4.49999999,4.5)).toBe(false);
  });
  it('verdict flips within one display-rounding step of the threshold',()=>{
    // black text at alpha a over white: ratio = 1.05 / (1.05 - a) ... derived
    // from text luminance (1-a); a0 gives a ratio of exactly ~4.5.
    const a0=1-(1.05/4.5-0.05);
    const at=analyzeContrast({foreground:{color:'#000000',alpha:a0},background:[{color:'#ffffff'}],threshold:4.5});
    expect(Math.abs((at.contrast.ratio as number)-4.5)).toBeLessThan(1e-9);
    const below=analyzeContrast({foreground:{color:'#000000',alpha:a0-1e-6},background:[{color:'#ffffff'}],threshold:4.5});
    const above=analyzeContrast({foreground:{color:'#000000',alpha:a0+1e-6},background:[{color:'#ffffff'}],threshold:4.5});
    expect(below.verdict).toBe('fail');
    expect(above.verdict).toBe('pass');
    // ...yet both display as 4.50
    expect(formatRatio(below.contrast.ratio as number)).toBe('4.50');
    expect(formatRatio(above.contrast.ratio as number)).toBe('4.50');
  });
});

describe('cache key',()=>{
  it('is stable across equivalent color notations',()=>{
    const a=contrastCacheKey({foreground:{color:'#fff'},background:[{color:'rgb(255, 0, 0)'},{color:'#000000'}]});
    const b=contrastCacheKey({foreground:{color:'#ffffff'},background:[{color:'#ff0000'},{color:'rgb(0,0,0)'}]});
    expect(a).toBe(b);
  });
  it('includes every background layer, in order',()=>{
    const base={foreground:{color:'#000'},threshold:4.5};
    const one=contrastCacheKey({...base,background:[{color:'#fff'}]});
    const two=contrastCacheKey({...base,background:[{color:'#fff'},{color:'#000'}]});
    const twoSwapped=contrastCacheKey({...base,background:[{color:'#000'},{color:'#fff'}]});
    const twoDeepChange=contrastCacheKey({...base,background:[{color:'#fff'},{color:'#010101'}]});
    expect(one).not.toBe(two);
    expect(two).not.toBe(twoSwapped);
    expect(two).not.toBe(twoDeepChange); // deepest layer still affects the key
  });
  it('includes foreground, alpha, threshold and the unknown marker',()=>{
    const req:ContrastRequest={foreground:{color:'#000'},background:[{color:null}],threshold:4.5};
    expect(contrastCacheKey(req)).not.toBe(contrastCacheKey({...req,foreground:{color:'#000',alpha:0.5}}));
    expect(contrastCacheKey(req)).not.toBe(contrastCacheKey({...req,threshold:3}));
    expect(contrastCacheKey(req)).not.toBe(contrastCacheKey({...req,background:[{color:'#000'}]}));
    // empty background normalizes to the same key as an explicit unknown base
    expect(contrastCacheKey({...req,background:[]})).toBe(contrastCacheKey(req));
  });
});

describe('shared test vectors',()=>{
  for(const vector of contrastVectors){
    it(vector.name,()=>{
      const report=analyzeContrast(vector.request);
      const precision=vector.precision??6;
      const check=(actual:number|{min:number;max:number},expected:number|[number,number])=>{
        if(typeof expected==='number'){
          expect(actual).toBeTypeOf('number');
          expect(actual as number).toBeCloseTo(expected,precision);
        }else{
          expect(actual).toHaveProperty('min');
          const range=actual as {min:number;max:number};
          expect(range.min).toBeCloseTo(expected[0],precision);
          expect(range.max).toBeCloseTo(expected[1],precision);
        }
      };
      if(vector.expect.backgroundLuminance!==undefined)check(report.background.luminance,vector.expect.backgroundLuminance);
      if(vector.expect.textLuminance!==undefined)check(report.text.luminance,vector.expect.textLuminance);
      if(vector.expect.ratio!==undefined)check(report.contrast.ratio,vector.expect.ratio);
      expect(report.verdict).toBe(vector.expect.verdict);
      if(vector.expect.warnings){
        const all=[...report.foreground.warnings,...report.background.layers.flatMap(l=>l.warnings)].join('\n');
        for(const warning of vector.expect.warnings)expect(all).toContain(warning);
      }
    });
  }
});
