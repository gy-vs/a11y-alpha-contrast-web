import {useMemo, useState} from 'react';
import {
  analyzeContrast,
  formatContrast,
  formatLuminance,
  formatLinearSRGB,
  relativeLuminance,
  type ColorSource,
  type CompositeStep,
  type ContrastRequest,
  type ContrastResult,
} from '../shared/contrast';
import {scenarios, type Scenario} from '../shared/vectors';

/**
 * Explanation view for contrast findings. Every number shown here is produced
 * by src/shared/contrast.ts — the same module the server uses. This component
 * must NOT re-derive luminance/contrast; it only renders and formats the
 * engine's output (format* helpers, display only; thresholds use raw values
 * inside the engine).
 */

function SourceBadge({source}: {source: ColorSource}) {
  const label =
    source.kind === 'sample' ? '采样色' : source.kind === 'unknown' ? '未知底色' : '绘制层';
  return <span className={`badge kind-${source.kind}`}>{label}</span>;
}

function SourceRow({source}: {source: ColorSource}) {
  const clamped = source.channels
    .map((state, i) => (state === 'in-gamut' ? null : ['R', 'G', 'B'][i]))
    .filter(Boolean)
    .join('');
  return (
    <li className="source-row">
      <SourceBadge source={source} />
      <strong>{source.name}</strong>
      <span className="meta">
        {source.kind === 'unknown' ? (
          '未指定颜色'
        ) : (
          <>
            {source.sourceSpace} → {source.resolvedSpace}
            {' · '}α={source.opacity}（{alphaLabel(source.alphaState)}）
            {source.downgraded && (
              <em className="downgrade"> · 已降级钳制 {clamped}</em>
            )}
          </>
        )}
      </span>
    </li>
  );
}

function alphaLabel(state: ColorSource['alphaState']) {
  return state === 'opaque' ? '不透明' : state === 'transparent' ? '完全透明' : '半透明';
}

function Lum({label, value}: {label: string; value: number | {min: number; max: number}}) {
  return (
    <div className="lum-row">
      <span>{label}</span>
      {typeof value === 'number' ? (
        <strong>{formatLuminance(value)}</strong>
      ) : (
        <strong>
          {formatLuminance(value.min)} – {formatLuminance(value.max)}
        </strong>
      )}
    </div>
  );
}

function StepRow({step}: {step: CompositeStep}) {
  return (
    <tr>
      <td>{step.name}</td>
      <td>
        <span className="swatch" style={{background: formatLinearSRGB(step.over)}} />
      </td>
      <td className="num">{step.coverage.toFixed(3)}</td>
      <td className="num">{formatLuminance(relativeLuminance(step.over))}</td>
    </tr>
  );
}

function Verdict({result}: {result: ContrastResult}) {
  const {contrast, threshold, pass} = result;
  const passLabel = pass === true ? '通过' : pass === 'partial' ? '部分背景通过' : '不通过';
  return (
    <div className={`verdict verdict-${pass === true ? 'pass' : pass === false ? 'fail' : 'partial'}`}>
      <div>
        {contrast.kind === 'exact' ? (
          <>
            对比度 <strong>{formatContrast(contrast.value)}</strong>
            <span className="raw">（原始值 {contrast.value.toFixed(6)}）</span>
          </>
        ) : (
          <>
            对比度范围{' '}
            <strong>
              {formatContrast(contrast.min)} – {formatContrast(contrast.max)}
            </strong>
            <span className="raw">
              （原始 {contrast.min.toFixed(6)} … {contrast.max.toFixed(6)}）
            </span>
          </>
        )}
      </div>
      <div>
        阈值 {threshold}:1（按未舍入值比较）→ <strong>{passLabel}</strong>
      </div>
      {contrast.kind === 'exact' &&
        Math.round(contrast.value * 100) / 100 >= threshold &&
        contrast.value < threshold && (
          <div className="warn">
            显示值四舍五入后达到 {threshold}:1，但原始值未达标——判定以原始值为准。
          </div>
        )}
    </div>
  );
}

export default function ContrastPanel() {
  const [scenario, setScenario] = useState<Scenario>(scenarios[0]);
  const [serverNote, setServerNote] = useState<string>('');
  const [extreme, setExtreme] = useState<'overBlack' | 'overWhite'>('overBlack');

  // Client-side computation from the SAME shared module.
  const local = useMemo(() => analyzeContrast(scenario.request), [scenario]);

  async function askServer() {
    setServerNote('计算中…');
    try {
      const response = await fetch('/api/contrast', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(scenario.request satisfies ContrastRequest),
      });
      const body = (await response.json()) as
        | {result: ContrastResult; cacheKey: string; cacheHit: boolean}
        | {error: string; message?: string};
      if (!response.ok || 'error' in body) {
        setServerNote(`服务端错误: ${'message' in body ? body.message ?? '' : ''}`);
        return;
      }
      // Parity check: server must return exactly what the shared module
      // computes locally (same cacheKey proves identical input digest).
      const same =
        body.cacheKey === local.cacheKey &&
        JSON.stringify(body.result.contrast) === JSON.stringify(local.contrast);
      setServerNote(
        `${body.cacheHit ? '缓存命中' : '实时计算'} · 与本地共享模块${same ? '一致 ✓' : '不一致 ✗'}`,
      );
    } catch (err) {
      setServerNote(`请求失败: ${(err as Error).message}`);
    }
  }

  const trace =
    local.trace.exact ??
    (extreme === 'overBlack'
      ? local.trace.range?.overBlack
      : local.trace.range?.overWhite) ??
    [];

  return (
    <div className="contrast-panel">
      <h2>对比度解释视图</h2>
      <label className="field">
        场景
        <select
          value={scenario.id}
          onChange={e => {
            setScenario(scenarios.find(s => s.id === e.target.value)!);
            setExtreme('overBlack');
            setServerNote('');
          }}
        >
          {scenarios.map(s => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <p className="desc">{scenario.description}</p>

      <Verdict result={local} />

      <section className="luminance">
        <h3>最终相对亮度 Y（线性）</h3>
        <Lum label="文字像素" value={local.textLuminance} />
        <Lum label="背景像素" value={local.backdropLuminance} />
      </section>

      <section>
        <h3>每层颜色来源</h3>
        <ul className="sources">
          {local.backgrounds.map(source => (
            <SourceRow key={source.layerId} source={source} />
          ))}
          <SourceRow source={local.foreground} />
        </ul>
      </section>

      <section>
        <h3>逐层合成（线性 sRGB）</h3>
        {local.trace.range && (
          <div className="extreme-toggle">
            假设未知底色为：
            <button
              className={extreme === 'overBlack' ? 'active' : ''}
              onClick={() => setExtreme('overBlack')}
            >
              纯黑
            </button>
            <button
              className={extreme === 'overWhite' ? 'active' : ''}
              onClick={() => setExtreme('overWhite')}
            >
              纯白
            </button>
          </div>
        )}
        <table className="trace">
          <thead>
            <tr>
              <th>层（自底向上）</th>
              <th>合成像素</th>
              <th>覆盖率</th>
              <th>最终亮度 Y</th>
            </tr>
          </thead>
          <tbody>
            {trace.map(step => (
              <StepRow key={step.layerId} step={step} />
            ))}
          </tbody>
        </table>
        {local.trace.range && local.contrast.kind === 'range' && (
          <p className="note">
            底色未知：上表为“压黑”极端（对比度 {formatContrast(local.contrast.overBlack)}
            ），“压白”极端为 {formatContrast(local.contrast.overWhite)}。结论以范围{' '}
            <strong>
              {formatContrast(local.contrast.min)} – {formatContrast(local.contrast.max)}
            </strong>{' '}
            呈现，不给单一伪精确值。
          </p>
        )}
      </section>

      <section className="server-check">
        <button onClick={askServer}>请求服务端核对</button>
        <span>{serverNote}</span>
      </section>
    </div>
  );
}
