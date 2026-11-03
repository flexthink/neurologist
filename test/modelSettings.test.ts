import {test} from 'node:test';
import assert from 'node:assert/strict';

test('model choices synchronize across views, persist, and stay isolated by workspace folder',async()=>{
  const Module=require('node:module'),original=Module._load;
  const fakeVscode={workspace:{isTrusted:false,getConfiguration:()=>({get:(_key:string,fallback:unknown)=>fallback}),onDidChangeConfiguration:()=>({dispose(){}})}};
  let Settings:typeof import('../src/modelSettings').ModelSettings;
  Module._load=function(id:string,...args:unknown[]) {return id==='vscode' ? fakeVscode : original.call(this,id,...args);};
  try {Settings=require('../src/modelSettings').ModelSettings;}finally {Module._load=original;}
  const values=new Map<string,unknown>(),context={workspaceState:{get:(key:string,fallback:unknown)=>values.get(key)??fallback,update:async(key:string,value:unknown)=>{values.set(key,structuredClone(value));}}};
  const folder=(id:string)=>({uri:{toString:()=>id,scheme:'file',fsPath:'/tmp/'+id}}) as any;
  const a=folder('a'),b=folder('b'),service=new Settings(context as any);
  function webview() {
    const callbacks:((message:any)=>Promise<void>)[]=[],sent:any[]=[];
    return {sent,onDidReceiveMessage:(callback:any)=>{callbacks.push(callback);return {dispose(){const i=callbacks.indexOf(callback);if(i>=0)callbacks.splice(i,1);}};},postMessage:(message:any)=>{sent.push(message);return Promise.resolve(true);},receive:async(message:any)=>{for(const cb of callbacks) await cb(message);}};
  }
  const viewA=webview(),viewB=webview(),sidebar=webview();
  const bindingA=service.bind(viewA as any,()=>a),bindingB=service.bind(viewB as any,()=>b),bindingSidebar=service.bind(sidebar as any,id=>id==='a'?a:id==='b'?b:undefined);
  await sidebar.receive({type:'modelSettingsRequest',folder:'a'});
  await sidebar.receive({type:'modelSelection',folder:'a',selection:{model:'test-model',effort:'high'}});
  assert.deepEqual(service.selection(a),{model:'test-model',effort:'high'});
  assert.deepEqual(viewA.sent.at(-1).selection,{model:'test-model',effort:'high'});
  assert.deepEqual(viewB.sent.at(-1).selection,{model:'',effort:''});
  const restored=new Settings(context as any);assert.deepEqual(restored.selection(a),{model:'test-model',effort:'high'});
  await sidebar.receive({type:'modelSettingsRequest',folder:'b'});assert.equal(sidebar.sent.at(-1).selection.model,'');
  await sidebar.receive({type:'modelSelection',folder:'b',selection:{model:'another',effort:'low'}});
  assert.equal(service.selection(a).model,'test-model');assert.equal(service.selection(b).model,'another');
  await sidebar.receive({type:'modelSelection',folder:'b',selection:{model:'',effort:''}});assert.equal(service.selection(b).model,'');
  bindingA.dispose();bindingB.dispose();bindingSidebar.dispose();service.dispose();restored.dispose();
});
