import {test} from 'node:test';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,utimes} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {z} from 'zod';
import {visualizationSpecSchema,savedVisualizationSchema,pngDataUri,visualizationExpression,PYTHON_VISUALIZATION_BRIDGE,JAVASCRIPT_VISUALIZATION_BRIDGE,type SavedVisualization} from '../src/debugVisualization';
import {DebugRuntime} from '../src/debugRuntime';
import {emptyDebugState} from '../src/debugModel';
const python=process.env.NEUROLOGIST_TEST_PYTHON??join(homedir(),'venv/ml/bin/python');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV3sAAAAASUVORK5CYII=','base64');
const visual:SavedVisualization={id:'attention',title:'Layer 4 attention',node:'encoder',language:'python',function:'plot',context:[{name:'weights',expression:'attention'},{name:'index',expression:'layer_index'}],condition:'layer_index == 3',anchor:null,file:'.neurologist/debug/visual-scenario-attention.py'};
test('visualization contracts are strict, bounded and backward compatible with structured output',()=>{
 const spec={...visual,code:'def plot(context, output_path): pass'};delete (spec as any).file;
 assert.equal(visualizationSpecSchema.parse(spec).title,visual.title);
 assert.equal(savedVisualizationSchema.safeParse({...visual,file:'../other.py'}).success,false);
 assert.equal(visualizationSpecSchema.safeParse({...spec,id:'../escape'}).success,false);
 const schema=z.toJSONSchema(visualizationSpecSchema);const walk=(s:any)=>{if(!s||typeof s!=='object')return;if(s.type==='object')assert.deepEqual(new Set(s.required),new Set(Object.keys(s.properties)));assert.ok(!s.oneOf);Object.values(s).forEach(v=>Array.isArray(v)?v.forEach(walk):walk(v));};walk(schema);
 assert.ok(pngDataUri(png).startsWith('data:image/png;base64,'));assert.throws(()=>pngDataUri(Buffer.from('<svg/>')),/PNG/);
 const huge=Buffer.from(png);huge.writeUInt32BE(10000,16);assert.throws(()=>pngDataUri(huge),/dimensions/);
});
test('Python sidecar receives live objects, layer context and persistent module globals',{skip:!existsSync(python)},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'neuro-visual-python-'));
 try{
  const bridge=join(dir,'neurologist_visualization_bridge.py'),file=join(dir,'plot.py'),output=join(dir,'image.png');await writeFile(bridge,PYTHON_VISUALIZATION_BRIDGE);
  await writeFile(file,`count=0\ndef plot(context, output):\n    global count\n    count+=1\n    assert context['weights'][0][1] == 0.9\n    assert context['index']==3\n    assert context['__neurologist']['scenario']=='scenario'\n    with open(output,'wb') as f: f.write(bytes.fromhex('${png.toString('hex')}'))\n`);
  const expr=visualizationExpression(visual,file,output,1,'scenario');
  const script=`attention=[[0.1,0.9],[0.6,0.4]]\nlayer_index=3\nassert eval(${JSON.stringify(expr)})=='Neurologist image written'\nimport neurologist_visualization_bridge as b\nmodule=b._modules[${JSON.stringify(file)}][1]\nassert module.count==1\nassert eval(${JSON.stringify(expr)})=='Neurologist image written'\nassert module.count==2\nprint('captured')\n`;
  const result=spawnSync(python,['-c',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/captured/);assert.deepEqual(await readFile(output),png);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('JavaScript sidecar uses the same function/context contract and reloads edited source',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'neuro-visual-js-'));
 try{
  const file=join(dir,'plot.cjs'),output=join(dir,'image.png');await writeFile(join(dir,'neurologist_visualization_bridge.cjs'),JAVASCRIPT_VISUALIZATION_BRIDGE);
  await writeFile(file,"let count=0;exports.plot=(ctx,path)=>{if(ctx.weights[0]!==7||ctx.index!==3)throw Error('context');require('fs').writeFileSync(path,Buffer.from([++count,ctx.__neurologist.hit]));};");
  const require=createRequire(__filename),attention=[7],layer_index=3;const expression=visualizationExpression({...visual,language:'javascript'},file,output,4,'scenario');eval(expression);eval(expression);assert.deepEqual([...await readFile(output)],[2,4]);
  await writeFile(file,"exports.plot=(ctx,path)=>require('fs').writeFileSync(path,Buffer.from([9]));");await utimes(file,new Date(),new Date(Date.now()+2000));eval(expression);assert.deepEqual([...await readFile(output)],[9]);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('runtime captures before publishing navigation stops, scopes images and discards late results',async()=>{
 const state=emptyDebugState();state.visualizations=[{...visual,stale:true}];const events:string[]=[];
 const port={customRequest:async()=>({stackFrames:[{id:1,name:'forward',line:2,source:{path:'/model.py'}}]})};
 let resolve!:(image:string)=>void;
 const runtime=new DebugRuntime(port,state,[{node:'encoder',file:'model.py',symbol:'forward',kind:'forward',statement:'',path:'/model.py',line:2,endLine:5}],()=>{if(state.trace.length)events.push('stop published');},'python',async()=>{events.push('capture');return pngDataUri(png);});
 await runtime.stopped(1);assert.equal(state.visualizations[0].stale,false);assert.equal(events[0],'capture');assert.ok(events.includes('stop published'));
 runtime.continued();assert.equal(state.visualizations[0].stale,true);
 const late=new DebugRuntime(port,state,[{node:'encoder',file:'model.py',symbol:'forward',kind:'forward',statement:'',path:'/model.py',line:2,endLine:5}],()=>{},'python',()=>new Promise(r=>resolve=r));
 const stopping=late.stopped(1);await new Promise(r=>setTimeout(r,0));late.continued();resolve('late image');await stopping;assert.notEqual(state.visualizations[0].image,'late image');assert.equal(state.status,'running');
});
