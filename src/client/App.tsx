import {useEffect,useState} from 'react';
import {FlaskConical,Play,Save} from 'lucide-react';
import {
  analyzeContrast,
  formatLuminanceValue,
  formatRatioValue,
  type ContrastReport,
  type ContrastRequest,
  type LayerInput,
} from '../shared/contrast';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};
type ServerContrast=ContrastReport&{cacheHit:boolean};

/** One layer per line: "<color> [alpha]", or "?" for an unknown base. */
function parseLayerLines(text:string):LayerInput[]{
  return text.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
    if(line==='?'||/^unknown$/i.test(line))return{color:null};
    const alphaSuffix=/^(.*?)\s+([0-9]*\.?[0-9]+)$/.exec(line);
    if(alphaSuffix&&alphaSuffix[1]){
      const alpha=Number(alphaSuffix[2]);
      if(alpha>=0&&alpha<=1)return{color:alphaSuffix[1],alpha};
    }
    return{color:line};
  });
}

function LayerTable({report}:{report:ContrastReport}){
  const rows=[report.foreground&&{...report.foreground,role:'text',stackLuminance:null as null},...report.background.layers.map(layer=>({...layer,role:'bg'}))];
  return <table className="layers"><thead><tr><th>Layer</th><th>Input</th><th>Source</th><th>α</th><th>Own L</th><th>Stack L</th></tr></thead><tbody>
    {rows.map((layer,i)=><tr key={i} className={layer.warnings.length?'warn':''}>
      <td>{layer.role==='text'?'text':`bg ${layer.index}`}</td>
      <td>{layer.unknown?'(unknown)':layer.input}</td>
      <td>{layer.source}{layer.warnings.length?` ⚠ ${layer.warnings.join('; ')}`:''}</td>
      <td>{layer.unknown?'—':layer.alpha}</td>
      <td>{layer.luminance===null?'—':formatLuminanceValue(layer.luminance)}</td>
      <td>{layer.stackLuminance==null?'—':formatLuminanceValue(layer.stackLuminance)}</td>
    </tr>)}
  </tbody></table>;
}

function ContrastPanel(){
  const [foreground,setForeground]=useState('#1a2b3c');
  const [fgAlpha,setFgAlpha]=useState('1');
  const [layersText,setLayersText]=useState('rgba(255,255,255,0.6)\n#102030');
  const [threshold,setThreshold]=useState('4.5');
  const [server,setServer]=useState<ServerContrast|null>(null);
  const [error,setError]=useState<string|null>(null);

  const request:ContrastRequest={
    foreground:{color:foreground,alpha:Number(fgAlpha)},
    background:parseLayerLines(layersText),
    threshold:Number(threshold),
  };
  // The explanation view is computed by the exact same module the server
  // uses; nothing here re-implements the formula.
  let local:ContrastReport|null=null;
  let localError:string|null=null;
  try{local=analyzeContrast(request)}catch(e){localError=e instanceof Error?e.message:String(e)}

  async function evaluate(){
    setError(null);
    const response=await fetch('/api/contrast',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
    const body=await response.json();
    if(!response.ok){setServer(null);setError(body.message??'request failed');return}
    setServer(body);
  }

  const report=local;
  const parity=server&&report?server.verdict===report.verdict&&JSON.stringify(server.contrast.ratio)===JSON.stringify(report.contrast.ratio):null;
  return <section className="contrast">
    <h2>Contrast</h2>
    <label>Text color <input value={foreground} onChange={e=>setForeground(e.target.value)}/></label>
    <label>Text alpha <input type="number" min="0" max="1" step="0.05" value={fgAlpha} onChange={e=>setFgAlpha(e.target.value)}/></label>
    <label>Background layers (top → bottom, <code>?</code> = unknown base)
      <textarea className="layers-input" value={layersText} onChange={e=>setLayersText(e.target.value)}/></label>
    <label>Threshold <input type="number" min="1" step="0.5" value={threshold} onChange={e=>setThreshold(e.target.value)}/></label>
    <button onClick={evaluate}><Play size={15}/>Evaluate</button>
    {(localError||error)&&<p className="error">{localError??error}</p>}
    {report&&<div className={`verdict ${report.verdict}`}>
      <strong>{report.verdict.toUpperCase()}</strong>
      <span> ratio {formatRatioValue(report.contrast.ratio)} vs {report.threshold}</span>
      {report.contrast.unknown&&<small> unknown base: range over all possible base colors (coverage {(report.background.coverage*100).toFixed(0)}%)</small>}
    </div>}
    {report&&<LayerTable report={report}/>}
    {report&&<p className="lum">Background L: {formatLuminanceValue(report.background.luminance)} · Text L: {formatLuminanceValue(report.text.luminance)}</p>}
    {server&&<p className="parity">Server: {server.verdict} {formatRatioValue(server.contrast.ratio)} (cache {server.cacheHit?'hit':'miss'}){parity===true?' · matches local module':parity===false?' · MISMATCH':''}</p>}
  </section>;
}

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);const [selected,setSelected]=useState('alpha');const [row,setRow]=useState<Row|null>(null);const [draft,setDraft]=useState('');const [analysis,setAnalysis]=useState<unknown>(null);const [status,setStatus]=useState('Ready');
  useEffect(()=>{fetch('/api/audits').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{setStatus('Loading');fetch('/api/audits/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/audits/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/audits/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>Accessibility Review</strong><small>Local workspace</small></header><section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><span>{status}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(analysis??row,null,2)}</pre><ContrastPanel/></aside></section></main>;
}
