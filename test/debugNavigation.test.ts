import {test} from 'node:test';
import assert from 'node:assert/strict';
import {detectLoop,navigateGraph,DEFAULT_NAVIGATION_SETTINGS,type GraphStop,type NavigationDriver,type NavigationKind} from '../src/debugNavigation';
function simulation(initial:string[],path:{nodes:string[];skippable?:boolean;reason?:string}[],options:{stuck?:boolean;unresponsivePause?:boolean}={}) {
  let status='stopped',sequence=1,stop:GraphStop={sequence,nodes:initial,reason:'breakpoint',skippable:true},resumes=0,pauses=0;
  const listeners=new Set<(stop:GraphStop)=>void>();
  const emit=(entry:{nodes:string[];skippable?:boolean;reason?:string})=>{status=entry.reason==='terminated'?'terminated':'stopped';stop={sequence:++sequence,nodes:entry.nodes,reason:entry.reason??'breakpoint',skippable:entry.skippable??true};for(const listener of listeners)listener(stop);};
  const driver:NavigationDriver={status:()=>status,lastStop:()=>stop,
    nextStop:(after,signal)=>new Promise((resolve,reject)=>{const cleanup=()=>{listeners.delete(listener);signal.removeEventListener('abort',abort);};const listener=(value:GraphStop)=>{if(value.sequence>after){cleanup();resolve(value);}};const abort=()=>{cleanup();reject(new Error('aborted'));};if(signal.aborted){abort();return;}listeners.add(listener);signal.addEventListener('abort',abort,{once:true});}),
    resume:async()=>{status='running';const next=path[resumes++];if(next)setTimeout(()=>emit(next),0);else if(!options.stuck)setTimeout(()=>emit({nodes:[],reason:'terminated',skippable:false}),0);},
    pause:async()=>{pauses++;if(options.unresponsivePause)return new Promise(()=>{});emit({nodes:[],reason:'pause',skippable:false});},
    predicate:async(expression)=>expression==='ready'&&stop.nodes.includes('output')&&resumes>=2
  };
  return {driver,get resumes(){return resumes;},get pauses(){return pauses;},get listeners(){return listeners.size;}};
}
const run=(s:ReturnType<typeof simulation>,kind:NavigationKind,extra:Partial<Parameters<typeof navigateGraph>[1]>={})=>navigateGraph(s.driver,{kind,cycle:[],settings:{...DEFAULT_NAVIGATION_SETTINGS},signal:new AbortController().signal,progress:()=>{},...extra});
test('detects the smallest observed repeating suffix with a configurable loop length',()=>{
  assert.deepEqual(detectLoop([['1'],['2'],['3'],['2'],['3']]),['2','3']);
  assert.deepEqual(detectLoop([['1'],['2'],['3'],['4'],['3'],['4']]),['3','4']);
  assert.deepEqual(detectLoop([['2'],['3'],['2'],['3']],1),[]);
  assert.deepEqual(detectLoop([['2'],['2']]),[]);assert.deepEqual(detectLoop([['2'],['2'],['2']]),['2']);
  assert.deepEqual(detectLoop([['1'],['2'],['3']]),[]);
});
test('Leap skips same-node module stops and reaches another graph node',async()=>{
  const s=simulation(['2'],[{nodes:['2']},{nodes:['2']},{nodes:['3']},{nodes:['4']}]);
  const result=await run(s,'leap');assert.equal(result.reason,'different-node');assert.equal(result.stops,3);assert.equal(s.resumes,3);assert.equal(result.paused,true);
});
test('Escape loop freezes its nodes and stops at 4 in a 2 ↔ 3 repetition',async()=>{
  const s=simulation(['3'],[{nodes:['2']},{nodes:['3']},{nodes:['2']},{nodes:['4']},{nodes:['5']}]);
  const result=await run(s,'escapeLoop',{cycle:['2','3']});assert.equal(result.reason,'escaped');assert.equal(s.resumes,4);assert.deepEqual(s.driver.lastStop()?.nodes,['4']);
  await assert.rejects(run(simulation(['1'],[]),'escapeLoop'),/No repeating graph path/);
});
test('navigation preserves user breakpoints, exceptions, manual pauses and unknown stops',async()=>{
  for(const reason of ['breakpoint','exception','pause','step','unknown']){
    const s=simulation(['1'],[{nodes:['1'],skippable:false,reason},{nodes:['output']}]);const result=await run(s,'runTo',{target:'output'});assert.equal(result.reason,'user-stop');assert.equal(s.resumes,1);
  }
});
test('target and predicate navigation stop only when the requested goal is observed',async()=>{
  const target=simulation(['1'],[{nodes:['2']},{nodes:['output']},{nodes:['5']}]);assert.equal((await run(target,'runTo',{target:'output'})).reason,'target');assert.equal(target.resumes,2);
  const predicate=simulation(['1'],[{nodes:['output']},{nodes:['output']},{nodes:['5']}]);assert.equal((await run(predicate,'runUntil',{expression:'ready',target:'output'})).reason,'target');assert.equal(predicate.resumes,2);
  const ended=simulation(['1'],[]);assert.equal((await run(ended,'runTo',{target:'output'})).reason,'terminated');
});
test('skipped-stop limits prevent an endless repeating breakpoint sequence',async()=>{
  const s=simulation(['1'],Array.from({length:10},()=>({nodes:['1']})));const result=await run(s,'leap',{settings:{...DEFAULT_NAVIGATION_SETTINGS,maxSkippedStops:3}});assert.equal(result.reason,'limit');assert.equal(s.resumes,3);assert.equal(result.paused,true);
});
test('cancellation and deadlines request pause even when no next breakpoint is hit',async()=>{
  const cancelled=simulation(['1'],[],{stuck:true}),controller=new AbortController();const pending=run(cancelled,'leap',{signal:controller.signal});setTimeout(()=>controller.abort(),10);
  const result=await pending;assert.equal(result.reason,'cancelled');assert.equal(result.paused,true);assert.equal(cancelled.pauses,1);assert.equal(cancelled.listeners,0);
  const timeout=simulation(['1'],[],{stuck:true});assert.equal((await run(timeout,'leap',{settings:{...DEFAULT_NAVIGATION_SETTINGS,timeoutMs:15}})).reason,'timeout');assert.equal(timeout.pauses,1);
});
test('an unresponsive adapter cannot keep cancelled navigation pending indefinitely',async()=>{
  const s=simulation(['1'],[],{stuck:true,unresponsivePause:true}),controller=new AbortController();const start=Date.now(),pending=run(s,'leap',{signal:controller.signal});setTimeout(()=>controller.abort(),5);
  const result=await pending;assert.equal(result.reason,'cancelled');assert.equal(result.paused,false);assert.match(result.message,/has not stopped/);assert.ok(Date.now()-start<5000);assert.equal(s.listeners,0);
});
