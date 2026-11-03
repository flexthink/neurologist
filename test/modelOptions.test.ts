import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {discoverModels,modelSelectionSchema} from '../src/modelOptions';
async function mock(code:string,run:(executable:string)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'neurologist-models-')),executable=join(directory,'codex');
  await writeFile(executable,`#!${process.execPath}\n${code}`,{mode:0o755});
  try {await run(executable);}finally {await rm(directory,{recursive:true,force:true});}
}
test('discovers paginated models using only app-server initialization and metadata requests',async()=>{
  await mock(`if (process.argv[2]!=='app-server') process.exit(2);
    const rl=require('node:readline').createInterface({input:process.stdin});let initialized=false;
    const model=(name,hidden=false)=>({model:name,displayName:name,hidden,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'Thorough'}],isDefault:name==='first'});
    const send=value=>{const line=JSON.stringify(value)+'\\n';process.stdout.write(line.slice(0,7));process.stdout.write(line.slice(7));};
    rl.on('line',line=>{const req=JSON.parse(line);
      if(req.method==='initialize') {send({method:'notification'});send({id:req.id,result:{}});}
      else if(req.method==='initialized') initialized=true;
      else if(req.method==='model/list'&&initialized) send({id:req.id,result:req.params.cursor?{data:[model('second'),model('first')],nextCursor:null}:{data:[model('first'),model('hidden',true)],nextCursor:'page2'}});
      else process.exit(3);
    });`,async executable=>{
      const models=await discoverModels({executable,cwd:process.cwd()});assert.deepEqual(models.map(model=>model.model),['first','second']);assert.equal(models[0].supportedReasoningEfforts[1].reasoningEffort,'high');
    });
});
test('model discovery reports protocol errors and bounded timeouts',async()=>{
  await mock(`process.stdin.on('data',()=>process.stdout.write(JSON.stringify({id:1,error:{message:'Please sign in'}})+'\\n'));`,async executable=>{
    await assert.rejects(discoverModels({executable,cwd:process.cwd()}),/Please sign in/);
  });
  await mock(`process.stdin.resume();setInterval(()=>{},1000);`,async executable=>{
    await assert.rejects(discoverModels({executable,cwd:process.cwd(),timeoutMs:60}),/timed out/);
  });
});
test('model selections accept CLI defaults and future effort names and reject unsafe config values',()=>{
  assert.deepEqual(modelSelectionSchema.parse({model:'',effort:''}),{model:'',effort:''});
  assert.equal(modelSelectionSchema.parse({model:'custom-provider/model',effort:'ultra'}).effort,'ultra');
  assert.throws(()=>modelSelectionSchema.parse({model:'model\nother',effort:'high'}));
  assert.throws(()=>modelSelectionSchema.parse({model:'model',effort:'high"\nother=true'}));
});
