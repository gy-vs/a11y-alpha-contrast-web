import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {analyzeContrast} from '../src/shared/contrast';
import {expectedResults, scenarioById} from '../src/shared/vectors';

describe('POST /api/contrast', () => {
  it('matches the shared engine for every shared vector', async () => {
    const app = createApp();
    for (const expected of expectedResults) {
      const scenario = scenarioById(expected.scenarioId);
      const local = analyzeContrast(scenario.request);
      const response = await request(app)
        .post('/api/contrast')
        .send(scenario.request)
        .expect(200);
      // Same single implementation, same digest.
      expect(response.body.cacheKey).toBe(local.cacheKey);
      expect(response.body.result.contrast).toEqual(local.contrast);
      expect(response.body.result.pass).toBe(local.pass);
      expect(response.body.result.foreground).toEqual(local.foreground);
      expect(response.body.result.backgrounds).toEqual(local.backgrounds);
      expect(response.body.result.textLuminance).toEqual(local.textLuminance);
      expect(response.body.result.backdropLuminance).toEqual(local.backdropLuminance);
      expect(response.body.result.trace).toEqual(local.trace);
      expect(response.body.cacheHit).toBe(false);
    }
  });

  it('memoizes by a key spanning all background layers', async () => {
    const app = createApp();
    const scenario = scenarioById('multi-layer');

    const first = await request(app).post('/api/contrast').send(scenario.request).expect(200);
    expect(first.body.cacheHit).toBe(false);

    const second = await request(app).post('/api/contrast').send(scenario.request).expect(200);
    expect(second.body.cacheHit).toBe(true);
    expect(second.body.cacheKey).toBe(first.body.cacheKey);

    // An extra background layer must miss even though the top layers match.
    const withLayer = {
      ...scenario.request,
      backgrounds: [...scenario.request.backgrounds, {name: 'extra', color: {rgb: [1, 0, 1], alpha: 0.1}}],
    };
    const third = await request(app).post('/api/contrast').send(withLayer).expect(200);
    expect(third.body.cacheKey).not.toBe(first.body.cacheKey);
    expect(third.body.cacheHit).toBe(false);
  });

  it('returns 400 for invalid layers instead of a pseudo-result', async () => {
    const app = createApp();
    await request(app)
      .post('/api/contrast')
      .send({
        foreground: {color: {rgb: [0, 0, 0]}},
        backgrounds: [{color: {rgb: [1, 1, 1], alpha: 0.5}}],
      })
      .expect(400)
      .expect(({body}) => expect(body.error).toBe('invalid_request'));

    await request(app)
      .post('/api/contrast')
      .send({foreground: {color: {rgb: [0, 0, 0]}} as unknown as object})
      .expect(400);
  });

  it('reports an unknown backdrop as a range, never a single ratio', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/contrast')
      .send(scenarioById('unknown-base').request)
      .expect(200);
    expect(response.body.result.contrast.kind).toBe('range');
    expect(response.body.result.contrast).not.toHaveProperty('value');
    expect(response.body.result.effectiveText.kind).toBe('range');
  });
});
