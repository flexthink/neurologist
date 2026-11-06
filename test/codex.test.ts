import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {analyze} from '../src/codex';

async function mockCli(code:string, run:(executable:string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(),'neurologist-test-'));
  const executable = join(directory,'codex-mock');
  await writeFile(executable,`#!${process.execPath}\n${code}`,{mode:0o755});
  try {await run(executable);} finally {await rm(directory,{recursive:true,force:true});}
}
const defaults = {cwd:process.cwd(),model:'',instructions:'Focus on encoder',log:() => {}};
test('CLI integration passes read-only/schema/stdin flags and parses structured results', async () => {
  await mockCli(`const fs = require('node:fs'); const args = process.argv.slice(2);
    if (args[0] !== 'exec' || args[args.indexOf('--sandbox')+1] !== 'read-only') process.exit(3);
    if (args.includes('--model')||args.includes('--config')) process.exit(6);
    const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
    if (!schema.properties.architectures) process.exit(4);
    let prompt=''; process.stdin.on('data',chunk => prompt+=chunk); process.stdin.on('end',() => {
      if (!prompt.includes('Focus on encoder')) process.exit(5);
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify({architectures:[]}));
    });`, async executable => {
      assert.deepEqual(await analyze({...defaults,executable,signal:new AbortController().signal}),[]);
    });
});
test('surfaces CLI failures with useful diagnostics', async () => {
  await mockCli(`process.stderr.write('Please sign in');process.exit(2)`,async executable => {
    await assert.rejects(analyze({...defaults,executable,signal:new AbortController().signal}),/Please sign in/);
  });
});
test('supports cancellation of running analysis', async () => {
  await mockCli(`process.stdin.resume();setInterval(() => {},1000)`,async executable => {
    const controller = new AbortController();
    const result = analyze({...defaults,executable,signal:controller.signal});
    setTimeout(() => controller.abort(),100);
    await assert.rejects(result,{name:'AbortError'});
  });
});
test('rejects malformed model output before persisting charts', async () => {
  await mockCli(`const fs=require('node:fs');const args=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',() => fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'{"architectures":[{"version":99}]}'));`,async executable => {
    await assert.rejects(analyze({...defaults,executable,signal:new AbortController().signal}));
  });
});

test('chat runs with streamed activities, selected-node context, and structured explanations', async () => {
  const {converse}=await import('../src/codex');
  const {ActivityReporter}=await import('../src/progress');
  const {parseArchitecture}=await import('../src/model');
  const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));
  const activities:import('../src/progress').Activity[]=[];
  await mockCli(`const fs=require('node:fs');const args=process.argv.slice(2);
    if (!args.includes('--json')) process.exit(7);
    let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
      if (!prompt.includes('Selected node IDs: ["projection"]') || !prompt.includes('Mode: explain')) process.exit(8);
      process.stdout.write(JSON.stringify({type:'item.started',item:{id:'read',type:'command_execution',command:'cat model.py',status:'in_progress'}})+'\\n');
      process.stdout.write(JSON.stringify({type:'item.completed',item:{id:'read',type:'command_execution',command:'cat model.py',status:'completed',aggregated_output:'class Encoder',exit_code:0}})+'\\n');
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({reply:'The projection maps 128 input features to 256 hidden features.',sources:[{kind:'definition',file:'model.py',symbol:'Encoder'}],architecture:null}));
    });`,async executable => {
      const result=await converse({...defaults,executable,signal:new AbortController().signal,architecture,mode:'explain',message:'Explain this layer',selected:['projection'],history:[],activity:new ActivityReporter(item => activities.push(item))});
      assert.match(result.reply,/128 input/);assert.equal(result.architecture,null);assert.equal(result.sources[0].symbol,'Encoder');
      assert.ok(activities.some(item => item.id==='read' && item.state==='running'));
      assert.ok(activities.some(item => item.id==='read' && item.state==='complete'));
    });
});
test('chat rejects an attempted diagram mutation in explanation mode', async () => {
  const {converse}=await import('../src/codex');const {parseArchitecture}=await import('../src/model');const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));
  const response={reply:'Changed it',sources:[],architecture};
  await mockCli(`const fs=require('node:fs');const args=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>fs.writeFileSync(args[args.indexOf('--output-last-message')+1],${JSON.stringify(JSON.stringify(response))}));`,async executable => {
    await assert.rejects(converse({...defaults,executable,signal:new AbortController().signal,architecture,mode:'explain',message:'Explain this',selected:[],history:[]}),/cannot change the diagram/);
  });
});

test('Present! creates a structured reference-style draft and carries refinement history',async()=>{
  const {presentFigure}=await import('../src/codex');const {parseArchitecture}=await import('../src/model');const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));
  const figure=JSON.parse(await readFile('test/fixtures/present.json','utf8'));
  const response={reply:'Here is a minimal figure with three main blocks.',figure};
  await mockCli(`const fs=require('node:fs');const args=process.argv.slice(2);let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{if (!prompt.includes('Original architecture:') || !prompt.includes('Do not modify files')) process.exit(8);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],${JSON.stringify(JSON.stringify(response))});});`,async executable=>{
    const initial=await presentFigure({...defaults,executable,signal:new AbortController().signal,architecture,previous:null,history:[],message:'',target:'paper'});
    assert.equal(initial.figure?.nodes.length,3);
    assert.equal(initial.figure?.palette,'transformer');assert.equal(initial.figure?.direction,'BT');assert.equal(initial.figure?.showTitle,false);
    const refined=await presentFigure({...defaults,executable,signal:new AbortController().signal,architecture,previous:figure,history:[{role:'assistant',content:'Created the draft'}],message:'Make it vertical',target:'slides'});
    assert.equal(refined.figure?.title,'Tiny encoder');
  });
});
test('Present! requires an initial figure but permits clarification in follow-up chat',async()=>{
  const {presentFigure}=await import('../src/codex');const {parseArchitecture}=await import('../src/model');const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));const figure=JSON.parse(await readFile('test/fixtures/present.json','utf8'));
  await mockCli(`const fs=require('node:fs');const args=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({reply:'Which blocks would you like to group?',figure:null})));`,async executable=>{
    const options={...defaults,executable,signal:new AbortController().signal,architecture,history:[],message:'Group these',target:'paper' as const};
    await assert.rejects(presentFigure({...options,previous:null}),/initial figure/);
    assert.equal((await presentFigure({...options,previous:figure})).figure,null);
  });
});

test('Present! automatically retries a disconnected response without guessing ambiguous links',async()=>{
  const {presentFigure}=await import('../src/codex');const {parseArchitecture}=await import('../src/model');const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));
  const figure=JSON.parse(await readFile('test/fixtures/present.json','utf8'));figure.nodes.forEach((node:{sourceIds:string[]})=>node.sourceIds=[]);
  const invalid={...figure,edges:[]};
  await mockCli(`const fs=require('node:fs');const args=process.argv.slice(2);let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{const repair=prompt.includes('REPAIR REQUIRED:');fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({reply:repair?'Restored all data-flow arrows.':'Draft',figure:repair?${JSON.stringify(figure)}:${JSON.stringify(invalid)}}));});`,async executable=>{
    const result=await presentFigure({...defaults,executable,signal:new AbortController().signal,architecture,previous:null,history:[],message:'',target:'paper'});
    assert.equal(result.figure?.edges.length,2);assert.match(result.reply,/Restored/);
  });
});
test('Present! fails clearly after one repair attempt if Codex still returns disconnected blocks',async()=>{
  const {presentFigure}=await import('../src/codex');const {parseArchitecture}=await import('../src/model');const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));const figure=JSON.parse(await readFile('test/fixtures/present.json','utf8'));figure.edges=[];figure.nodes.forEach((node:{sourceIds:string[]})=>node.sourceIds=[]);
  await mockCli(`const fs=require('node:fs');const args=process.argv.slice(2);process.stdin.resume();process.stdin.on('end',()=>fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({reply:'Draft',figure:${JSON.stringify(figure)}})));`,async executable=>{
    await assert.rejects(presentFigure({...defaults,executable,signal:new AbortController().signal,architecture,previous:null,history:[],message:'',target:'paper'}),/disconnected blocks/);
  });
});

test('chat regeneration passes fresh-analysis guidance to Codex and validates the rebuilt architecture',async()=>{
  const {converse}=await import('../src/codex');const {parseArchitecture}=await import('../src/model');const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));
  const rebuilt=structuredClone(architecture);rebuilt.title='Rebuilt encoder';rebuilt.instructions='Explore current HyperPyYAML definitions and include residual paths';
  const response={reply:'Rebuilt the encoder from the current HyperPyYAML configuration.',sources:[],architecture:rebuilt};
  await mockCli(`const fs=require('node:fs');const args=process.argv.slice(2);let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{if(!prompt.includes('Mode: regenerate')||!prompt.includes('REGENERATE FROM CURRENT SOURCE')||!prompt.includes('Read latest HyperPyYAML'))process.exit(9);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],${JSON.stringify(JSON.stringify(response))});});`,async executable=>{
    const result=await converse({...defaults,executable,signal:new AbortController().signal,architecture,history:[],message:'Read latest HyperPyYAML and regenerate','mode':'regenerate',selected:[]});
    assert.equal(result.architecture?.title,'Rebuilt encoder');assert.match(result.architecture!.instructions,/HyperPyYAML/);
  });
});

test('analysis, chat, and Present! all pass selected model and reasoning effort as CLI arguments',async()=>{
  const {converse,presentFigure}=await import('../src/codex');
  const {parseArchitecture}=await import('../src/model');
  const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));
  const fixture=JSON.parse(await readFile('test/fixtures/present.json','utf8'));
  await mockCli(`const fs=require('node:fs'),args=process.argv.slice(2);
    if(args[args.indexOf('--model')+1]!=='test-model'||args[args.indexOf('--config')+1]!=='model_reasoning_effort="high"') process.exit(9);
    let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
      const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
      const result=schema.properties.architectures?{architectures:[]}:schema.properties.figure?{reply:'Draft',figure:${JSON.stringify(fixture)}}:{reply:'Explanation',architecture:null,sources:[]};
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
    });`,async executable=>{
      const options={...defaults,executable,model:'test-model',effort:'high',signal:new AbortController().signal};
      await analyze(options);
      await converse({...options,architecture,history:[],message:'Explain',mode:'explain',selected:[]});
      await presentFigure({...options,architecture,previous:null,history:[],message:'',target:'paper'});
    });
});

test('chat sends a strict demos schema when revising an old diagram without demos',async()=>{
  const {converse}=await import('../src/codex');
  const {parseArchitecture}=await import('../src/model');
  const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));
  assert.equal(architecture.demos,undefined);
  await mockCli(`const fs=require('node:fs'),args=process.argv.slice(2);
    const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
    function check(s){if(!s||typeof s!=='object')return;if('oneOf' in s||'allOf' in s||'exclusiveMinimum' in s)process.exit(14);if(s.type==='object'&&Object.keys(s.properties||{}).some(k=>!s.required?.includes(k)))process.exit(12);for(const v of Object.values(s)){if(Array.isArray(v))v.forEach(check);else check(v);}}
    check(schema);
    let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
      if(!prompt.includes('use [] when there are none'))process.exit(13);
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({reply:'Updated.',sources:[],architecture:{...${JSON.stringify(architecture)},title:'Updated old diagram',demos:[]}}));
    });`,async executable=>{
      const response=await converse({...defaults,executable,signal:new AbortController().signal,architecture,history:[],message:'Rename this model',mode:'revise',selected:[]});
      assert.equal(response.architecture?.title,'Updated old diagram');assert.deepEqual(response.architecture?.demos,[]);assert.equal(architecture.demos,undefined);
    });
});

test('debug scenario preparation and interactive action responses use strict schemas and evidence context',async()=>{
  const {prepareDebug,debugConversation}=await import('../src/codex');
  const {parseArchitecture}=await import('../src/model');const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));
  const plan={reply:'Prepared.',entry:{language:'python',code:'print("scenario")\n',args:[]},anchors:[{node:'projection',file:'examples/tiny_encoder.py',symbol:'Encoder.forward',kind:'forward',statement:''}],watches:[{id:'shape',node:'projection',expression:'x.shape'}]};
  await mockCli(`const fs=require('node:fs'),args=process.argv.slice(2),schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));
    function check(s){if(!s||typeof s!=='object')return;if('oneOf'in s||'exclusiveMinimum'in s)process.exit(12);if(s.type==='object'&&Object.keys(s.properties||{}).some(k=>!s.required.includes(k)))process.exit(13);for(const v of Object.values(s))if(Array.isArray(v))v.forEach(check);else check(v);}check(schema);
    let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
      if(!prompt.includes('Do not modify')&&!prompt.includes('do not modify'))process.exit(14);
      const result=schema.properties.entry?${JSON.stringify(plan)}:{reply:'Inspecting the input shape.',action:{command:'watch',expression:'x.shape',node:'projection',reference:0,frame:0}};
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(result));
    });`,async executable=>{
      const options={...defaults,executable,signal:new AbortController().signal,architecture};
      assert.deepEqual(await prepareDebug({...options,scenario:'One inference pass'}),plan);
      const response=await debugConversation({...options,message:'Watch the input shape',context:{status:'stopped',frameId:1},history:[],tools:[]});
      assert.equal(response.action?.command,'watch');assert.equal(response.action?.node,'projection');
    });
});

test('debug preparation defaults to mocking and accepts a replacement instruction policy',async()=>{
  const {prepareDebug}=await import('../src/codex');const {parseArchitecture}=await import('../src/model');const {readFile}=await import('node:fs/promises');
  const architecture=parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));
  await mockCli(`const fs=require('node:fs'),args=process.argv.slice(2);let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
    if(!prompt.includes('Synthetic data, random weights and peripheral mocks are allowed'))process.exit(16);
    if(prompt.includes('custom-policy-scenario')){if(!prompt.includes('Use the real checkpoint but mock the dataset loader.')||prompt.includes('Mock or synthesize everything that can reasonably'))process.exit(17);}
    else if(!prompt.includes('Mock or synthesize everything that can reasonably')||!prompt.includes('untrained model weights'))process.exit(18);
    fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({reply:'Ready to clarify only essential details.',entry:null,anchors:[],watches:[]}));
  });`,async executable=>{
    const options={...defaults,instructions:undefined,architecture,executable,signal:new AbortController().signal};
    await prepareDebug({...options,scenario:'Default policy scenario'});
    await prepareDebug({...options,scenario:'custom-policy-scenario',instructions:'Use the real checkpoint but mock the dataset loader.'});
  });
});
