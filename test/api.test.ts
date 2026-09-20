import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {contrastVectors} from '../src/shared/contrast.vectors';

describe('service',()=>{
  it('loads and conditionally updates a record',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/audits/alpha').expect(200);
    await request(app).put('/api/audits/alpha').send({content:'updated',revision:before.body.revision}).expect(200);
    await request(app).put('/api/audits/alpha').send({content:'stale',revision:before.body.revision}).expect(409);
  });
});

describe('contrast endpoint',()=>{
  // The server must agree with the shared module on every shared vector.
  for(const vector of contrastVectors){
    it(`matches shared vector: ${vector.name}`,async()=>{
      const app=createApp();
      const {body}=await request(app).post('/api/contrast').send(vector.request).expect(200);
      const precision=vector.precision??6;
      const ratio=body.contrast.ratio;
      if(vector.expect.ratio!==undefined){
        if(typeof vector.expect.ratio==='number')expect(ratio).toBeCloseTo(vector.expect.ratio,precision);
        else{expect(ratio.min).toBeCloseTo(vector.expect.ratio[0],precision);expect(ratio.max).toBeCloseTo(vector.expect.ratio[1],precision)}
      }
      expect(body.verdict).toBe(vector.expect.verdict);
    });
  }

  it('returns per-layer color source and luminance',async()=>{
    const app=createApp();
    const {body}=await request(app).post('/api/contrast').send({
      foreground:{color:'color(display-p3 1 0 0)'},
      background:[{color:'rgba(255,255,255,0.5)'},{color:null}],
      threshold:4.5,
    }).expect(200);
    expect(body.foreground.source).toBe('display-p3');
    expect(body.foreground.warnings.join(' ')).toMatch(/outside sRGB gamut/);
    expect(body.background.layers).toHaveLength(2);
    expect(body.background.layers[0].source).toBe('rgb');
    expect(body.background.layers[0].luminance).toBeCloseTo(1,10);
    expect(body.background.layers[1].unknown).toBe(true);
    expect(body.background.luminance).toEqual({min:0.5,max:1});
    expect(body.text.luminance).toBeDefined();
  });

  it('caches by a key covering all background layers',async()=>{
    const app=createApp();
    const base={foreground:{color:'#1a2b3c'},background:[{color:'rgba(255,255,255,0.6)'},{color:'#102030'}],threshold:4.5};
    const first=await request(app).post('/api/contrast').send(base).expect(200);
    expect(first.body.cacheHit).toBe(false);
    const second=await request(app).post('/api/contrast').send(base).expect(200);
    expect(second.body.cacheHit).toBe(true);
    expect(second.body.cacheKey).toBe(first.body.cacheKey);
    // Equivalent notation hits the same cache entry.
    const sameColors=await request(app).post('/api/contrast').send({...base,background:[{color:'rgba(255, 255, 255, 0.6)'},{color:'rgb(16, 32, 48)'}]}).expect(200);
    expect(sameColors.body.cacheHit).toBe(true);
    // Changing only the deepest background layer must miss the cache.
    const deeper=await request(app).post('/api/contrast').send({...base,background:[{color:'rgba(255,255,255,0.6)'},{color:'#102031'}]}).expect(200);
    expect(deeper.body.cacheHit).toBe(false);
    expect(deeper.body.cacheKey).not.toBe(first.body.cacheKey);
    // Layer order and threshold are part of the key too.
    const swapped=await request(app).post('/api/contrast').send({...base,background:[{color:'#102030'},{color:'rgba(255,255,255,0.6)'}]}).expect(200);
    expect(swapped.body.cacheKey).not.toBe(first.body.cacheKey);
    const otherThreshold=await request(app).post('/api/contrast').send({...base,threshold:3}).expect(200);
    expect(otherThreshold.body.cacheKey).not.toBe(first.body.cacheKey);
  });

  it('rejects invalid requests with 400',async()=>{
    const app=createApp();
    const cases:object[]=[
      {foreground:{color:null},background:[{color:'#fff'}]},
      {foreground:{color:'#000'},background:[{color:null},{color:'#fff'}]},
      {foreground:{color:'not-a-color'},background:[{color:'#fff'}]},
      {foreground:{color:'#000',alpha:1.5},background:[{color:'#fff'}]},
      {foreground:{color:'#000'},background:[{color:'#fff'}],threshold:-1},
      {foreground:{color:'#000'},background:[{color:'color(rec2020 1 0 0)'}]},
    ];
    for(const body of cases){
      const response=await request(app).post('/api/contrast').send(body).expect(400);
      expect(response.body.error).toBe('invalid_contrast_request');
    }
  });
});
