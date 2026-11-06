import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {resolvePythonAnchor,emptyDebugState,debugPlanSchema,debugReplySchema,type DebugAction} from '../src/debugModel';
import {DebugRuntime} from '../src/debugRuntime';
import {parseArchitecture,validateArchitecture} from '../src/model';
import {analysisOutputSchema,chatOutputSchema} from '../src/outputSchemas';
const source='class Other:\n    def forward(self, x):\n        return x\n\nclass Model:\n    def forward(self, x):\n        x = self.encoder(x)\n        return self.head(x)\n';
test('execution anchors resolve qualified symbols and statements after line shifts, refusing ambiguity',()=>{
  assert.deepEqual(resolvePythonAnchor(source,'Model.forward'),{line:7,endLine:9});
  assert.equal(resolvePythonAnchor('# shifted\n'+source,'Model.forward','self.encoder(x)')?.line,8);
  assert.equal(resolvePythonAnchor(source,'forward'),undefined);
  assert.equal(resolvePythonAnchor(source,'Renamed.forward'),undefined);
  assert.equal(resolvePythonAnchor(source,'Model.forward','absent'),undefined);
});
test('legacy YAML needs no execution field; invalid anchor node/path is rejected',()=>{
  const old=parseArchitecture(readFileSync('examples/tiny-encoder.neuro','utf8'));assert.equal(old.execution,undefined);
  const anchor={node:old.nodes[0].id,file:'model.py',symbol:'Model.forward',kind:'forward',statement:''};
  assert.equal(validateArchitecture({...old,execution:[anchor]}).execution?.length,1);
  assert.throws(()=>validateArchitecture({...old,execution:[{...anchor,node:'absent'}]}),/missing node/);
  assert.throws(()=>validateArchitecture({...old,execution:[{...anchor,file:'../private.py'}]}),/workspace-relative/);
});
test('every new debugger output schema uses required fields, closed objects, and supported unions',()=>{
  const walk=(s:any)=>{if(!s||typeof s!=='object')return;assert.ok(!('oneOf'in s));assert.ok(!('exclusiveMinimum'in s));if(s.type==='object'){assert.equal(s.additionalProperties,false);assert.deepEqual(new Set(s.required),new Set(Object.keys(s.properties)));}for(const v of Object.values(s))if(Array.isArray(v))v.forEach(walk);else walk(v);};
  for(const schema of [debugPlanSchema,debugReplySchema,analysisOutputSchema,chatOutputSchema])walk(z.toJSONSchema(schema));
});
const action=(command:DebugAction['command'],extra:Partial<DebugAction>={}):DebugAction=>({command,expression:'',node:'',reference:0,frame:0,...extra});
test('DAP stops highlight the invocation module, evaluate graph watches, and clear highlights on resume',async()=>{
  const state=emptyDebugState(),calls:{command:string;args:any}[]=[];
  const port={async customRequest(command:string,args:any){calls.push({command,args});if(command==='stackTrace')return {stackFrames:[{id:10,name:'Model.forward',line:7,source:{path:'/project/model.py'}}]};if(command==='evaluate'){if(args.expression==='missing')throw new Error('NameError');return {result:'[2, 128]'};}if(command==='scopes')return {scopes:[{name:'Locals',variablesReference:42}]};if(command==='variables')return {variables:[{name:'x',value:'Tensor'}]};return {};}};
  const runtime=new DebugRuntime(port,state,[{node:'encoder',file:'model.py',path:'/project/model.py',symbol:'Model.forward',kind:'invocation',statement:'self.encoder(x)',line:7,endLine:9},{node:'head',file:'model.py',path:'/project/model.py',symbol:'Model.forward',kind:'invocation',statement:'self.head(x)',line:8,endLine:9}],()=>{});
  await runtime.addWatch({id:'shape',node:'encoder',expression:'x.shape'});await runtime.addWatch({id:'bad',node:'encoder',expression:'missing'});
  await runtime.stopped(1);assert.deepEqual(state.activeNodes,['encoder']);assert.equal(state.watches[0].value,'[2, 128]');assert.match(state.watches[1].error!,/NameError/);
  await runtime.action(action('evaluate',{expression:'x.shape'}));assert.ok(calls.some(c=>c.command==='evaluate'&&c.args.context==='repl'&&c.args.frameId===10));
  await runtime.action(action('scopes'));await runtime.action(action('variables',{reference:42}));assert.ok(calls.some(c=>c.command==='variables'&&c.args.variablesReference===42));
  runtime.continued();assert.deepEqual(state.activeNodes,[]);assert.equal(state.watches[0].stale,true);await assert.rejects(runtime.action(action('evaluate',{expression:'x'})),/Pause/);
  runtime.terminated();assert.equal(state.status,'terminated');
});
test('in-flight stop results are discarded after continue or termination',async()=>{
  const state=emptyDebugState();let complete!:(value:any)=>void;
  const runtime=new DebugRuntime({customRequest:async()=>new Promise(resolve=>{complete=resolve;})},state,[],()=>{});
  const stop=runtime.stopped(1);runtime.continued();complete({stackFrames:[{id:1,name:'stale',line:1}]});await stop;
  assert.equal(state.status,'running');assert.deepEqual(state.stack,[]);
});
test('step actions wait for the next stop and watch actions update their owning graph nodes',async()=>{
  const state=emptyDebugState();let runtime:DebugRuntime;
  const port={async customRequest(command:string){if(command==='stackTrace')return {stackFrames:[{id:11,name:'forward',line:5,source:{path:'/model.py'}}]};if(command==='evaluate')return {result:'float32'};if(command==='next')setTimeout(()=>void runtime.stopped(1,'step'),5);return {};}};
  runtime=new DebugRuntime(port,state,[{node:'encoder',file:'model.py',path:'/model.py',symbol:'forward',kind:'forward',statement:'',line:5,endLine:9}],()=>{});await runtime.stopped(1);
  await runtime.action(action('watch',{node:'encoder',expression:'x.dtype'}));assert.equal(state.watches[0].node,'encoder');assert.equal(state.watches[0].value,'float32');
  const id=state.watches[0].id;await runtime.action(action('next'));assert.equal(state.status,'stopped');assert.equal(state.reason,'step');
  await runtime.action(action('unwatch',{expression:id}));assert.equal(state.watches.length,0);
});

test('watches never borrow same-named variables from a different module frame',async()=>{
  const state=emptyDebugState();let line=2,evaluations=0;
  const runtime=new DebugRuntime({async customRequest(command:string){if(command==='stackTrace')return {stackFrames:[{id:1,name:'caller',line,source:{path:'/model.py'}}]};if(command==='evaluate'){evaluations++;return {result:'encoder value'};}return {};}},state,[{node:'encoder',file:'model.py',path:'/model.py',symbol:'caller',kind:'invocation',statement:'encoder(x)',line:2,endLine:8},{node:'head',file:'model.py',path:'/model.py',symbol:'caller',kind:'invocation',statement:'head(x)',line:7,endLine:8}],()=>{});
  await runtime.addWatch({id:'x',node:'encoder',expression:'x'});await runtime.stopped(1);assert.equal(evaluations,1);
  runtime.continued();line=7;await runtime.stopped(1);assert.deepEqual(state.activeNodes,['head']);assert.equal(evaluations,1);assert.equal(state.watches[0].stale,true);assert.equal(state.watches[0].value,'encoder value');
});

test('qualified execution anchors handle multiline signatures and inline function bodies',()=>{
  const code='class Model:\n    def forward(\n        self,\n        x: Tensor,\n    ) -> Tensor:\n        return self.encoder(x)\n\n    def head(self, x): return x\n';
  assert.equal(resolvePythonAnchor(code,'Model.forward')?.line,6);
  assert.equal(resolvePythonAnchor(code,'Model.forward','self.encoder(x)')?.line,6);
  assert.equal(resolvePythonAnchor(code,'Model.head')?.line,8);
});
