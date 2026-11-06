import {renderFigureSvg} from '../src/figure';
import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {readFile,copyFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {parseArchitecture} from '../src/model';
async function main() {
const architecture = parseArchitecture(await readFile('examples/tiny-encoder.neuro','utf8'));
const server = createServer(async (req,res) => {
  if (['/webview.js','/webview.css','/sidebar.js','/sidebar.css','/present.js','/present.css'].includes(req.url ?? '')) {
    res.setHeader('Content-Type',req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    res.end(await readFile(`dist${req.url}`));
  } else {const bundle=req.url==='/sidebar' ? 'sidebar' : req.url==='/present' ? 'present' : 'webview';res.setHeader('Content-Type','text/html');res.end(`<html><head><link rel="stylesheet" href="/${bundle}.css"></head><body><div id="root"></div><script src="/${bundle}.js"></script></body></html>`);}
});
await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
const address = server.address() as {port:number};
const browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE ?? '/Users/artem/Library/Caches/ms-playwright/chromium-1134/chrome-mac/Chromium.app/Contents/MacOS/Chromium'});
try {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(8000);
  const errors:string[]=[]; page.on('pageerror',error => {errors.push(error.message); console.error('Browser error:',error.message);});
  await page.addInitScript('window.__name = (fn) => fn;');
  await page.addInitScript(model => {
    const target = window as any; target.messages=[];
    target.acquireVsCodeApi = () => ({getState:() => undefined,setState:() => {},postMessage:(message:any) => {
      if (['modelSettingsRequest','modelsRefresh','modelSelection'].includes(message.type)) {
        target.modelSelection=message.selection??target.modelSelection??{model:'',effort:''};
        setTimeout(()=>window.postMessage({type:'modelSettings',folder:message.folder??'',selection:target.modelSelection,loading:false,error:'',models:[{model:'test-deep',displayName:'Test Deep',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'Thorough'}]},{model:'test-fast',displayName:'Test Fast',isDefault:false,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Quick'}]}]},'*'),0);
      }

      target.messages.push(message);
      if (message.type === 'ready') setTimeout(() => window.postMessage({type:'architecture',architecture:model},'*'),0);
    }});
  },architecture);
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByRole('heading',{name:'Tiny encoder',exact:true}).waitFor({timeout:10000}).catch(async error => {await page.screenshot({path:'dist/ui-error.png'});console.error(await page.locator('body').innerText());throw error;});
  await page.locator('.react-flow__node').first().waitFor();
  await page.getByRole('button',{name:'Debug',exact:true}).click();
  await page.locator('.debugInstructions summary').click();
  assert.match(await page.getByLabel('Debug instructions',{exact:true}).inputValue(),/synthetic inputs/);
  await page.getByLabel('Debug instructions',{exact:true}).fill('Use synthetic inputs and random weights. Mock network services; keep the encoder real.');
  await page.getByLabel('Describe the debugging scenario',{exact:true}).fill('Run one encoder inference with existing inputs');
  await page.getByRole('button',{name:'Prepare scenario',exact:true}).click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugPrepare'&&m.message.includes('encoder inference')&&m.instructions.includes('Mock network services'))));
  await page.locator('.debugInstructions summary').click();
  const debugState={scenarioId:'inference',scenarioName:'Synthetic inference',scenarios:[{id:'inference',name:'Synthetic inference'},{id:'alternate',name:'Alternate inference'}],status:'prepared',activeNodes:[],watches:[],stack:[],reason:'',diagnostics:[],entry:'.neurologist/debug/scenario.py',messages:[{role:'assistant',content:'Entry script is ready for review.'}],busy:false};
  await page.evaluate(state=>window.postMessage({type:'debugState',state},'*'),debugState);
  await page.getByLabel('Saved debugging scenarios',{exact:true}).selectOption('alternate');
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugLoadScenario'&&m.id==='alternate')));
  await page.getByRole('button',{name:'Rename',exact:true}).click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugRenameScenario')));
  await page.getByRole('button',{name:'Run debug',exact:true}).click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugRun')));
  const stopped={...debugState,status:'stopped',reason:'breakpoint',activeNodes:['projection'],frameId:10,stack:[{id:10,name:'Encoder.forward',line:7,source:{name:'tiny_encoder.py'}}],watches:[{id:'shape',node:'projection',expression:'x.shape',value:'[2, 128]',stale:false}]};
  await page.evaluate(state=>window.postMessage({type:'debugState',state},'*'),stopped);
  await page.locator('.react-flow__node.debugStopped[data-id="projection"]').waitFor();
  const debugToolbar=page.getByRole('toolbar',{name:'Debugger controls',exact:true});
  assert.equal(await debugToolbar.locator('button svg').count(),10);
  assert.equal(await page.locator('.debuggerPane .debugControls').count(),0);
  const toolbarBounds=await debugToolbar.boundingBox(),chartBounds=await page.locator('.canvas').boundingBox();
  assert.ok(toolbarBounds&&chartBounds&&toolbarBounds.y+toolbarBounds.height<=chartBounds.y+1,'Debugger toolbar belongs above the chart');
  await debugToolbar.getByRole('button',{name:'Continue',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Step over');
  const originalViewport=page.viewportSize()!;
  await page.setViewportSize({width:700,height:900});
  assert.equal(await debugToolbar.evaluate(el=>el.clientHeight<55),true,'Narrow toolbar stays on one row');
  await debugToolbar.getByRole('button',{name:'Leap',exact:true}).click();
  await page.setViewportSize(originalViewport);

  await page.getByText('Paused in this module',{exact:false}).waitFor();
  assert.equal(await page.locator('.moduleWatches').getByText('[2, 128]',{exact:true}).count(),1);
  await page.getByLabel('Ask the debugger',{exact:true}).fill('Explain this shape and watch hidden.dtype on projection');
  await page.getByRole('button',{name:'Ask debugger →',exact:true}).click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugChat'&&m.message.includes('hidden.dtype'))));
  await page.getByRole('button',{name:'Step over',exact:true}).click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugCommand'&&m.command==='next')));
  assert.equal(await page.getByRole('button',{name:'Escape loop',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Leap',exact:true}).click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugCommand'&&m.command==='leap')));
  await page.evaluate(state=>window.postMessage({type:'debugState',state:{...state,detectedLoop:['projection','activation'],trace:[['projection'],['activation'],['projection'],['activation']]}},'*'),stopped);
  await page.getByRole('button',{name:'Escape loop',exact:true}).click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugCommand'&&m.command==='escapeLoop')));
  await page.locator('.navigationSettings summary').click();
  await page.getByLabel('Maximum skipped stops',{exact:true}).fill('25');
  await page.locator('.navigationSettings summary').click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugNavigationSettings'&&m.settings.maxSkippedStops===25)));
  await page.evaluate(state=>window.postMessage({type:'debugState',state:{...state,status:'running',busy:true,navigation:{kind:'runTo',stops:4,cycleNodes:[],target:'output'}}},'*'),stopped);
  await page.getByRole('button',{name:'Hide debugger',exact:true}).click();
  await debugToolbar.waitFor();
  await page.getByRole('button',{name:'Cancel navigation',exact:true}).click();
  await page.getByRole('button',{name:'Debug',exact:true}).click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugCancelNavigation')));
  await page.evaluate(state=>window.postMessage({type:'debugState',state},'*'),stopped);

  await page.locator('.debugWatches summary').click();
  await page.getByLabel('Watch module',{exact:true}).selectOption('projection');
  await page.getByLabel('Watch expression',{exact:true}).fill('x.dtype');
  await page.getByRole('button',{name:'Add graph watch',exact:true}).click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='debugWatch'&&m.watch.node==='projection'&&m.watch.expression==='x.dtype')));
  await page.getByRole('button',{name:/fit view/i}).click();
  await page.screenshot({path:'dist/debug-preview.png'});
  if(process.env.UPDATE_SCREENSHOT==='1')await copyFile('dist/debug-preview.png','docs/debugger.png');
  await page.evaluate(state=>window.postMessage({type:'debugState',state:{...state,status:'running',activeNodes:[],watches:state.watches.map(w=>({...w,stale:true}))}},'*'),stopped);
  await page.locator('.react-flow__node.debugStopped').waitFor({state:'hidden'});
  assert.equal(await page.locator('.react-flow__node.debugStopped').count(),0);
  await page.evaluate(state=>window.postMessage({type:'debugState',state:{...state,status:'terminated',entry:undefined}},'*'),debugState);
  await page.getByRole('button',{name:'Hide debugger',exact:true}).click();
  await page.getByRole('button',{name:'✦ Chat',exact:true}).click();
  const chatRequestsBeforeDemo=await page.evaluate(()=>(window as any).messages.filter((m:any)=>m.type==='chat').length);
  await page.getByRole('button',{name:'Create demo',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Revise diagram',exact:true}).getAttribute('aria-pressed'),'true');
  assert.match(await page.getByLabel('Describe your diagram revision',{exact:true}).inputValue(),/Create a step-by-step demo/);
  assert.equal(await page.evaluate(()=>(window as any).messages.filter((m:any)=>m.type==='chat').length),chatRequestsBeforeDemo,'Create demo should prepare an editable request without sending it');
  await page.getByLabel('Describe your diagram revision',{exact:true}).fill('');
  await page.getByRole('button',{name:'Explain architecture',exact:true}).click();
  await page.getByLabel('Codex model',{exact:true}).selectOption('test-deep');
  await page.getByLabel('Reasoning effort',{exact:true}).selectOption('high');
  await page.getByLabel('Codex model',{exact:true}).selectOption('test-fast');
  assert.equal(await page.getByLabel('Reasoning effort',{exact:true}).inputValue(),'');
  assert.equal(await page.getByLabel('Reasoning effort',{exact:true}).locator('option[value="high"]').count(),0);
  await page.getByLabel('Reasoning effort',{exact:true}).selectOption('low');
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='modelSelection'&&m.selection.model==='test-fast'&&m.selection.effort==='low')));
  await page.getByRole('button',{name:'Present!',exact:true}).click();
  assert.ok(await page.evaluate(() => (window as any).messages.some((m:any)=>m.type==='present')));
  assert.equal(await page.locator('.react-flow__node').count(),4);
  await page.getByRole('button',{name:'Collapse description',exact:true}).click();
  assert.equal(await page.locator('#diagramDescription').count(),0);
  assert.equal(await page.locator('.react-flow__node').count(),4);
  await page.getByRole('button',{name:'Expand description',exact:true}).click();
  await page.locator('#diagramDescription').waitFor();
  await page.evaluate(() => {
    window.postMessage({type:'activityReset',title:'Mapping the neural landscape'},'*');
    window.postMessage({type:'busy',value:true},'*');
    window.postMessage({type:'activity',activity:{id:'command-1',kind:'command',label:'Following the paper trail',detail:'rg encoder config/\nFound config/model.yaml',state:'running',startedAt:Date.now()}},'*');
  });
  await page.getByText('Following the paper trail',{exact:true}).first().click();
  await page.getByText('Found config/model.yaml',{exact:false}).waitFor();
  await page.getByRole('button',{name:'Cancel exploration'}).click();
  assert.ok(await page.evaluate(() => (window as any).messages.some((m:any) => m.type==='cancel')));
  await page.evaluate(() => {window.postMessage({type:'activity',activity:{id:'command-1',kind:'command',label:'Following the paper trail',detail:'rg encoder config/\nFound config/model.yaml',state:'complete',startedAt:Date.now()-2000,endedAt:Date.now()}},'*');window.postMessage({type:'busy',value:false},'*');});
  await page.getByRole('button',{name:'Explain architecture',exact:true}).click();
  await page.getByLabel('Ask Neurologist',{exact:true}).fill('Why 256 hidden features?');
  await page.getByRole('button',{name:'Ask →',exact:true}).click();
  assert.ok(await page.evaluate(() => (window as any).messages.some((m:any) => m.type==='chat' && m.mode==='explain' && m.message==='Why 256 hidden features?')));
  await page.evaluate(() => window.postMessage({type:'chatHistory',messages:[{role:'user',content:'Why 256 hidden features?',mode:'explain'},{role:'assistant',content:'The **projection** maps 128 features to 256 hidden features. <script>window.bad=true</script>',sources:[{kind:'configuration',file:'examples/tiny_encoder.yaml',symbol:'model.hidden_size'}]}]},'*'));
  await page.getByRole('button',{name:'model.hidden_size',exact:false}).click();
  assert.ok(await page.evaluate(() => (window as any).messages.some((m:any) => m.type==='source' && m.source.symbol==='model.hidden_size')));
  assert.equal(await page.evaluate(() => (window as any).bad),undefined);
  await page.getByRole('button',{name:'Revise diagram',exact:true}).click();
  await page.getByLabel('Describe your diagram revision').fill('Rename Projection to Feature projection');
  await page.getByRole('button',{name:'Revise →',exact:true}).click();
  assert.ok(await page.evaluate(() => (window as any).messages.some((m:any) => m.type==='chat' && m.mode==='revise')));
  await page.evaluate(()=>window.postMessage({type:'chatHistory',messages:[{role:'user',content:'Rename Projection to Feature projection',mode:'revise'}]},'*'));
  await page.getByRole('button',{name:'Regenerate diagram',exact:true}).click();
  await page.getByLabel('Regeneration instructions',{exact:true}).fill('Re-read HyperPyYAML and rebuild this model with all residual connections');
  await page.getByRole('button',{name:'Regenerate →',exact:true}).click();
  assert.ok(await page.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='chat'&&m.mode==='regenerate'&&m.message.includes('Re-read HyperPyYAML'))));
  await page.evaluate(()=>window.postMessage({type:'chatHistory',messages:[{role:'user',content:'Re-read HyperPyYAML and rebuild this model with all residual connections',mode:'regenerate'},{role:'assistant',content:'Rebuilt this architecture from current source and configuration.',mode:'regenerate',revised:true}]},'*'));
  await page.getByText('✓ Diagram regenerated',{exact:true}).waitFor();
  assert.equal(await page.locator('.toolbar textarea').count(),0,'The diagram header must not contain Instructions');
  assert.equal(await page.locator('.toolbar .generate').count(),0,'The diagram header must not contain Regenerate controls');
  await page.getByRole('button',{name:'Hide chat',exact:true}).click();
  await page.getByLabel('Find a layer').fill('Projection');
  await page.locator('.results').getByRole('button',{name:'Projection',exact:true}).click();
  await page.getByLabel('Find a layer').fill('');
  await page.getByRole('button',{name:'configuration ↗'}).click();
  assert.ok(await page.evaluate(() => (window as any).messages.some((m:any) => m.type === 'source' && m.source.symbol === 'model.hidden_size')));
  await page.getByRole('button',{name:/fit view/i}).click();
  await page.waitForTimeout(500);
  await page.getByRole('button',{name:'✦ Chat',exact:true}).click();
  await page.getByRole('button',{name:'Explain architecture',exact:true}).click();
  await page.evaluate(() => window.postMessage({type:'chatHistory',messages:[{role:'user',content:'Why 256 hidden features?',mode:'explain'},{role:'assistant',content:'The **projection** maps each 128-feature input to a **256-feature hidden representation**.\n\nThe size is controlled by `model.hidden_size` in the YAML configuration. Both the ReLU branch and the residual branch keep this shape, so they can be added element by element.',sources:[{kind:'configuration',file:'examples/tiny_encoder.yaml',symbol:'model.hidden_size'}]}]},'*'));
  await page.getByRole('button',{name:'Collapse description',exact:true}).click();
  await page.getByRole('button',{name:'Expand description',exact:true}).click();
  await page.getByLabel('Ask Neurologist',{exact:true}).fill('');
  // Exercise the shipped Demo Mode against the real webview bundle.
  const demoArchitecture={...architecture,demos:[{name:'Walkthrough',steps:[
    {duration:1000,operations:[{type:'add',nodes:[{id:'temporary',label:'Temporary demo node',kind:'',description:'',parameters:[],sources:[]}]},{type:'highlight',nodes:['temporary']},{type:'explain',target:'temporary',text:'Temporary explanation'}]},
    {duration:1000,operations:[{type:'point',target:'temporary'}]},
    {duration:1000,operations:[{type:'remove',nodes:['temporary']}]}]},
    {name:'Independent demo',steps:[{operations:[{type:'dim',nodes:[architecture.nodes[0].id]}]}]}]};
  await page.evaluate(architecture=>window.postMessage({type:'architecture',architecture},'*'),demoArchitecture);
  await page.getByRole('button',{name:'▶ Demo',exact:true}).waitFor();
  const beforeDemo=await page.locator('.react-flow__node').evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute('data-id'),style:node.getAttribute('style')})));
  const messageCount=await page.evaluate(()=>(window as any).messages.length);
  await page.getByRole('button',{name:'▶ Demo',exact:true}).click();
  await page.getByText('Temporary explanation',{exact:true}).waitFor();
  assert.equal(await page.locator('.react-flow__node.demoHighlight').count(),1);
  await page.getByRole('button',{name:'Forward',exact:true}).click();
  await page.locator('.demoPointer').waitFor();
  assert.equal(await page.locator('.demoCallout').count(),0);
  assert.equal(await page.locator('.react-flow__node.demoHighlight').count(),0);
  await page.getByRole('button',{name:'Forward',exact:true}).click();
  await page.getByText('Temporary demo node',{exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByText('Temporary demo node',{exact:true}).waitFor();
  await page.locator('.demoPointer').waitFor();
  await page.getByLabel('Choose step',{exact:true}).selectOption('0');
  await page.getByText('Temporary explanation',{exact:true}).waitFor();
  await page.getByLabel('Choose demo',{exact:true}).selectOption('1');
  await page.getByText('Temporary demo node',{exact:true}).waitFor({state:'hidden'});
  assert.equal(await page.locator('.react-flow__node.demoDim').count(),1);
  await page.getByLabel('Choose demo',{exact:true}).selectOption('0');
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  assert.equal(await page.getByLabel('Choose step',{exact:true}).inputValue(),'0');
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.getByText('Temporary demo node',{exact:true}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Play',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Choose step',{exact:true}).inputValue(),'2');
  await page.getByRole('button',{name:'Exit demo',exact:true}).click();
  assert.deepEqual(await page.locator('.react-flow__node').evaluateAll(nodes=>nodes.map(node=>({id:node.getAttribute('data-id'),style:node.getAttribute('style')}))),beforeDemo);
  assert.deepEqual(await page.evaluate(count=>(window as any).messages.slice(count),messageCount),[],'Demo navigation must never send editor/save operations');
  await page.evaluate(architecture=>window.postMessage({type:'architecture',architecture},'*'),architecture);
  await page.waitForTimeout(350);
  await page.screenshot({path:'dist/ui-preview.png'});
  if (process.env.UPDATE_SCREENSHOT==='1') {await mkdir('docs',{recursive:true});await copyFile('dist/ui-preview.png','docs/screenshot.png');}
  await page.setViewportSize({width:700,height:900});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),false);
  await page.evaluate(() => window.postMessage({type:'error',message:'Duplicate node id: projection'},'*'));
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('button',{name:'Open YAML to fix',exact:true}).isVisible(),true);
  assert.equal(await page.locator('.toolbar .generate').count(),0);
  assert.deepEqual(errors,[]);
  const analysis=await browser.newPage({viewport:{width:1100,height:800}});
  await analysis.addInitScript('window.__name = (fn) => fn;');
  await analysis.addInitScript(()=>{const target=window as any;target.messages=[];target.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>{},postMessage:(message:any)=>{
      if (['modelSettingsRequest','modelsRefresh','modelSelection'].includes(message.type)) {
        target.modelSelection=message.selection??target.modelSelection??{model:'',effort:''};
        setTimeout(()=>window.postMessage({type:'modelSettings',folder:message.folder??'',selection:target.modelSelection,loading:false,error:'',models:[{model:'test-deep',displayName:'Test Deep',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'Thorough'}]},{model:'test-fast',displayName:'Test Fast',isDefault:false,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Quick'}]}]},'*'),0);
      }
target.messages.push(message);if(message.type==='ready')setTimeout(()=>window.postMessage({type:'home',folder:'Sample codebase',instructions:''},'*'),0);}});});
  await analysis.goto(`http://127.0.0.1:${address.port}/analysis`);
  await analysis.locator('#instructions').fill('Analyze all HyperPyYAML model configurations');
  await analysis.getByLabel('Codex model',{exact:true}).selectOption('test-deep');
  await analysis.getByLabel('Reasoning effort',{exact:true}).selectOption('high');
  await analysis.screenshot({path:'dist/analysis-preview.png'});
  await analysis.getByRole('button',{name:'Analyze codebase →',exact:true}).click();
  assert.ok(await analysis.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='generate'&&m.instructions==='Analyze all HyperPyYAML model configurations')));
  const sidebar=await browser.newPage({viewport:{width:320,height:620}});
  sidebar.setDefaultTimeout(8000);
  sidebar.on('pageerror',error => errors.push(error.message));
  await sidebar.addInitScript('window.__name = (fn) => fn;');
  await sidebar.addInitScript(() => {
    const target=window as any;target.messages=[];
    target.acquireVsCodeApi=() => ({getState:() => undefined,setState:(state:any) => {target.saved=state;},postMessage:(message:any) => {
      if (['modelSettingsRequest','modelsRefresh','modelSelection'].includes(message.type)) {
        target.modelSelection=message.selection??target.modelSelection??{model:'',effort:''};
        setTimeout(()=>window.postMessage({type:'modelSettings',folder:message.folder??'',selection:target.modelSelection,loading:false,error:'',models:[{model:'test-deep',displayName:'Test Deep',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'Thorough'}]},{model:'test-fast',displayName:'Test Fast',isDefault:false,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Quick'}]}]},'*'),0);
      }

      target.messages.push(message);
      if (message.type==='ready') setTimeout(() => window.postMessage({type:'folders',folders:[{uri:'file:///sample/model-a',name:'Model A'},{uri:'file:///sample/model-b',name:'Model B'}]},'*'),0);
    }});
  });
  await sidebar.goto(`http://127.0.0.1:${address.port}/sidebar`);
  await sidebar.getByLabel('Codebase',{exact:true}).selectOption('file:///sample/model-b');
  await sidebar.getByLabel('Instructions',{exact:false}).fill('Explore the HyperPyYAML models');
  await sidebar.getByLabel('Codex model',{exact:true}).selectOption('test-fast');
  await sidebar.getByLabel('Reasoning effort',{exact:true}).selectOption('low');
  assert.ok(await sidebar.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='modelSelection'&&m.folder==='file:///sample/model-b'&&m.selection.effort==='low')));
  await sidebar.getByRole('button',{name:'Analyze codebase →',exact:true}).click();
  assert.ok(await sidebar.evaluate(() => (window as any).messages.some((m:any) => m.type==='analyze' && m.folder==='file:///sample/model-b' && m.instructions==='Explore the HyperPyYAML models')));
  assert.equal(await sidebar.getByRole('img',{name:/neon neural network/}).count(),1);
  await sidebar.screenshot({path:'dist/sidebar-preview.png'});
  if (process.env.UPDATE_SCREENSHOT==='1') await copyFile('dist/sidebar-preview.png','docs/sidebar.png');
  await sidebar.evaluate(() => window.postMessage({type:'folders',folders:[]},'*'));
  await sidebar.getByText('Open a codebase folder to get started.').waitFor();
  assert.equal(await sidebar.getByRole('button',{name:'Analyze codebase →',exact:true}).isDisabled(),true);
  await sidebar.setViewportSize({width:230,height:620});
  assert.equal(await sidebar.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  assert.deepEqual(errors,[]);
  const presentation=await browser.newPage({viewport:{width:1440,height:960}});
  presentation.setDefaultTimeout(8000);presentation.on('pageerror',error=>errors.push(error.message));
  const sendPresentation=async (message:any)=>presentation.evaluate(message=>window.postMessage(message,'*'),{...message,svg:await renderFigureSvg(message.figure)});
  const sampleFigure=JSON.parse(await readFile('test/fixtures/present.json','utf8'));
  await presentation.addInitScript('window.__name = (fn) => fn;');
  await presentation.addInitScript(({figure,svg})=>{
    const target=window as any;target.messages=[];
    target.acquireVsCodeApi=()=>({getState:()=>undefined,setState:()=>{},postMessage:(message:any)=>{
      if (['modelSettingsRequest','modelsRefresh','modelSelection'].includes(message.type)) {
        target.modelSelection=message.selection??target.modelSelection??{model:'',effort:''};
        setTimeout(()=>window.postMessage({type:'modelSettings',folder:message.folder??'',selection:target.modelSelection,loading:false,error:'',models:[{model:'test-deep',displayName:'Test Deep',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'Thorough'}]},{model:'test-fast',displayName:'Test Fast',isDefault:false,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low',description:'Quick'}]}]},'*'),0);
      }

      target.messages.push(message);
      if (message.type==='ready') setTimeout(()=>window.postMessage({type:'presentation',figure,svg,messages:[{role:'assistant',content:'I grouped the projection and activation into one encoder block, keeping just the main data flow.'}],source:'Tiny encoder',canUndo:false},'*'),0);
      if (message.type==='copyImage') window.postMessage({type:'notice',message:'Image copied. Paste it into your slide or document.'},'*');
    }});
  },{figure:sampleFigure,svg:await renderFigureSvg(sampleFigure)});
  await presentation.goto(`http://127.0.0.1:${address.port}/present`);
  await presentation.getByRole('heading',{name:'Make it yours',exact:true}).waitFor();
  await presentation.getByRole('img',{name:'Tiny encoder',exact:true}).waitFor();
  const caption=presentation.locator('.figureCaptionDetails');
  assert.equal(await caption.evaluate(element=>(element as HTMLDetailsElement).open),false);
  assert.equal(await caption.locator('p').isVisible(),false);
  await caption.locator('summary').click();assert.equal(await caption.locator('p').isVisible(),true);
  await caption.locator('summary').click();assert.equal(await caption.locator('p').isVisible(),false);
  await presentation.getByLabel('Codex model',{exact:true}).selectOption('test-deep');
  await presentation.getByLabel('Reasoning effort',{exact:true}).selectOption('high');
  assert.ok(await presentation.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='modelSelection'&&m.selection.effort==='high')));

  await presentation.getByRole('button',{name:'Zoom in',exact:true}).click();
  assert.equal(await presentation.getByLabel('Zoom level',{exact:true}).innerText(),'125%');
  await presentation.getByRole('button',{name:'Zoom out',exact:true}).click();
  assert.equal(await presentation.getByLabel('Zoom level',{exact:true}).innerText(),'100%');
  await presentation.getByRole('button',{name:'Fit',exact:true}).click();
  await presentation.getByRole('button',{name:'100%',exact:true}).click();
  assert.equal(await presentation.getByLabel('Zoom level',{exact:true}).innerText(),'100%');
  const stage=await presentation.getByRole('region',{name:'Scrollable figure preview'}).boundingBox();
  assert.ok(stage);
  await presentation.mouse.move(stage!.x+stage!.width/2,stage!.y+stage!.height/2);
  await presentation.keyboard.down('Control');await presentation.mouse.wheel(0,-100);await presentation.keyboard.up('Control');
  await presentation.waitForFunction(()=>parseInt(document.querySelector('output[aria-label="Zoom level"]')!.textContent!)>100);
  await presentation.getByRole('button',{name:'100%',exact:true}).click();
  await presentation.getByRole('button',{name:'Copy image',exact:true}).click();
  await presentation.getByText('Image copied. Paste it into your slide or document.',{exact:false}).waitFor();
  assert.ok(await presentation.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='copyImage'&&m.png.startsWith('data:image/png;base64,'))));
  await presentation.getByRole('button',{name:'Export PNG',exact:true}).click();
  await presentation.waitForFunction(()=>(window as any).messages.some((m:any)=>m.type==='export'&&m.format==='png'));
  await presentation.getByRole('button',{name:'Export SVG',exact:true}).click();
  assert.ok(await presentation.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='export'&&m.format==='svg')));
  await presentation.getByLabel('Refine this figure',{exact:true}).fill('Make it vertical and monochrome');
  await presentation.getByRole('button',{name:'Refine →',exact:true}).click();
  assert.ok(await presentation.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='refine'&&m.message==='Make it vertical and monochrome')));
  await sendPresentation({type:'presentation',figure:{...sampleFigure,direction:'TB',palette:'monochrome'},messages:[{role:'user',content:'Make it vertical and monochrome'},{role:'assistant',content:'Updated the figure to a vertical layout with a monochrome palette.'}],source:'Tiny encoder',canUndo:true});
  await presentation.getByRole('button',{name:'Undo refinement',exact:true}).click();
  assert.ok(await presentation.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='undo')));
  await presentation.getByLabel('Format',{exact:true}).selectOption('slides');
  assert.ok(await presentation.evaluate(()=>(window as any).messages.some((m:any)=>m.type==='refine'&&m.target==='slides')));
  const longFigure={...sampleFigure,direction:'LR',nodes:Array.from({length:12},(_,i)=>({id:'n'+i,label:'Block '+i,subtitle:'',sourceIds:[]})),edges:Array.from({length:11},(_,i)=>({id:'e'+i,source:'n'+i,target:'n'+(i+1),label:''}))};
  await sendPresentation({type:'presentation',figure:longFigure,messages:[],source:'Scroll test',canUndo:false});
  await presentation.waitForFunction(()=>{const stage=document.querySelector('.figureStage')!;return stage.scrollWidth>stage.clientWidth;});
  assert.ok(await presentation.locator('.figureStage').evaluate(stage=>{stage.scrollLeft=stage.scrollWidth;return stage.scrollLeft>0;}));
  const panViewport=presentation.getByRole('region',{name:'Scrollable figure preview'});
  const panBounds=await panViewport.boundingBox();assert.ok(panBounds);
  const beforeX=await panViewport.evaluate(stage=>{stage.scrollLeft=300;return stage.scrollLeft;});
  await presentation.mouse.move(panBounds!.x+panBounds!.width/2,panBounds!.y+panBounds!.height/2);
  await presentation.mouse.down();await presentation.mouse.move(panBounds!.x+panBounds!.width/2+120,panBounds!.y+panBounds!.height/2,{steps:5});
  assert.ok(await panViewport.evaluate((stage,before)=>stage.scrollLeft<before,beforeX),'Dragging right must pan to the left of the image');
  await presentation.mouse.up();assert.equal(await panViewport.evaluate(stage=>stage.classList.contains('panning')),false);

  await sendPresentation({type:'presentation',figure:{...longFigure,direction:'TB'},messages:[],source:'Scroll test',canUndo:false});
  await presentation.waitForFunction(()=>{const stage=document.querySelector('.figureStage')!;return stage.scrollHeight>stage.clientHeight;});
  assert.ok(await presentation.locator('.figureStage').evaluate(stage=>{stage.scrollTop=stage.scrollHeight;return stage.scrollTop>0;}));
  const beforeY=await panViewport.evaluate(stage=>{stage.scrollTop=300;return stage.scrollTop;});
  await presentation.mouse.move(panBounds!.x+panBounds!.width/2,panBounds!.y+panBounds!.height/2);
  await presentation.mouse.down();await presentation.mouse.move(panBounds!.x+panBounds!.width/2,panBounds!.y+panBounds!.height/2+100,{steps:5});
  assert.ok(await panViewport.evaluate((stage,before)=>stage.scrollTop<before,beforeY),'Dragging down must pan upward through the image');
  await presentation.mouse.move(panBounds!.x-20,panBounds!.y+50);await presentation.mouse.up();
  assert.equal(await panViewport.evaluate(stage=>stage.classList.contains('panning')),false,'Releasing outside the viewport must end panning');

  await presentation.getByRole('button',{name:'Fit',exact:true}).click();
  assert.ok(parseInt(await presentation.getByLabel('Zoom level',{exact:true}).innerText())<100);
  const referenceFigure=JSON.parse(await readFile('test/fixtures/transformer-style.json','utf8'));
  await sendPresentation({type:'presentation',figure:referenceFigure,messages:[{role:'assistant',content:'This draft uses the style and sublayer-level detail of Attention Is All You Need, Figure 1: pastel operations, black connectors, residual paths, and a repeated encoder frame.'}],source:'Illustrative Transformer encoder',canUndo:true});
  await presentation.getByRole('img',{name:'Transformer encoder',exact:true}).waitFor();
  await presentation.getByRole('button',{name:'Fit',exact:true}).click();
  await presentation.getByRole('button',{name:'Copy image',exact:true}).click();
  await presentation.getByText('Image copied. Paste it into your slide or document.',{exact:false}).waitFor();
  await presentation.waitForTimeout(100);
  await presentation.screenshot({path:'dist/present-preview.png'});
  if (process.env.UPDATE_SCREENSHOT==='1') await copyFile('dist/present-preview.png','docs/present.png');
  await presentation.setViewportSize({width:600,height:900});
  assert.equal(await presentation.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('UI SMOKE PASSED: graph, source link messages, instructions, regeneration, search, responsive layout, invalid YAML state, expandable activity, cancellation, Explain/Revise/Regenerate chat, preserved Analyze instructions, no diagram header form, safe Markdown, collapsible description, sidebar instructions and workspace selection, Present! draft preview, refinements, PNG copy, SVG/PNG export, horizontal/vertical figure scrolling, zoom controls and modifier-wheel zoom, reference-style repeat frames and detailed SVG image copying, mouse-drag panning on both axes and release outside the viewport, collapsed caption disclosure, model/effort selectors on every surface, effort compatibility resets, and Demo Mode navigation, transient effects, independent demos, playback, source-view restoration, debugger scenario/chat controls, stopped-module highlights, scoped inline watches, Leap/Escape controls, navigation limits, and interruption controls.');
} finally {await browser.close(); server.close();}

}
main().catch(error => {console.error(error); process.exitCode=1;});
