import express from 'express';
import {fileURLToPath} from 'node:url';
import {analyzeContrast,ContrastInputError,type ContrastReport,type ContrastRequest} from '../shared/contrast';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary review findings',revision:3,content:'review findings: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary review findings',revision:5,content:'review findings: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"accessibility-review",count:rows.length}));
  app.get('/api/audits',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/audits/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/audits/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/audits/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});
  // Contrast evaluation. All math lives in src/shared/contrast.ts (shared with
  // the client); this route only validates, caches and serializes. The cache
  // key covers the foreground and every background layer in order.
  const contrastCache=new Map<string,ContrastReport>();
  app.post('/api/contrast',(req,res)=>{
    let report: ContrastReport;
    try{report=analyzeContrast(req.body as ContrastRequest)}
    catch(error){if(error instanceof ContrastInputError)return res.status(400).json({error:'invalid_contrast_request',message:error.message});throw error}
    const cached=contrastCache.get(report.cacheKey);
    if(cached)return res.json({...cached,cacheHit:true});
    contrastCache.set(report.cacheKey,report);
    res.json({...report,cacheHit:false});
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
