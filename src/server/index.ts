import express from 'express';
import {fileURLToPath} from 'node:url';
import {analyzeContrast, buildCacheKey, type ContrastRequest, type ContrastResult} from '../shared/contrast';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary review findings',revision:3,content:'review findings: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary review findings',revision:5,content:'review findings: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  // Cache key includes EVERY background layer (see buildCacheKey), so this
  // map can safely memoize across requests.
  const contrastCache=new Map<string,ContrastResult>();
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"accessibility-review",count:rows.length}));
  app.get('/api/audits',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/audits/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/audits/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/audits/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});
  app.post('/api/contrast',(req,res)=>{
    const request=req.body as ContrastRequest;
    let key:string;
    try{key=buildCacheKey(request)}catch(err){return res.status(400).json({error:'invalid_request',message:(err as Error).message})}
    let result=contrastCache.get(key);
    const cacheHit=result!==undefined;
    if(!result){
      try{result=analyzeContrast(request)}catch(err){return res.status(400).json({error:'invalid_request',message:(err as Error).message})}
      contrastCache.set(key,result);
    }
    // Echo the cache key and whether it was a hit so client/tests can assert
    // the key spans all background layers.
    res.set('X-Contrast-Cache-Key',key).json({result,cacheKey:key,cacheHit});
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
