import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseArchitecture} from '../src/model';
import {computeDemoStep} from '../src/demo';

const source = parseArchitecture(JSON.stringify({version:1,title:'Example',summary:'',instructions:'',nodes:[{id:'a',label:'A',kind:'',description:'',parameters:[],sources:[]}],edges:[],demos:[{name:'First',steps:[{operations:[{type:'add',nodes:[{id:'b',label:'B',kind:'',description:'',parameters:[],sources:[]}]},{type:'highlight',nodes:['b']}]},{operations:[{type:'point',target:'b'}]},{operations:[{type:'remove',nodes:['b']}]}]},{name:'Second',steps:[{operations:[{type:'dim',nodes:['a']}]}]}]}));
test('replay is independent of navigation and preserves the source',()=>{
  const before=structuredClone(source), demo=source.demos![0];
  const first=computeDemoStep(source,demo,0);
  assert.deepEqual(first.graph.nodes.map(n=>n.id),['a','b']);
  assert.deepEqual(first.presentation.highlightedNodes,['b']);
  const middle=computeDemoStep(source,demo,1);
  assert.deepEqual(middle.presentation.highlightedNodes,[]);
  assert.deepEqual(middle.presentation.points,['b']);
  assert.deepEqual(computeDemoStep(source,demo,2).graph.nodes.map(n=>n.id),['a']);
  assert.deepEqual(computeDemoStep(source,demo,0),first);
  assert.deepEqual(computeDemoStep(source,source.demos![1],0).graph.nodes.map(n=>n.id),['a']);
  assert.deepEqual(source,before);
});
test('invalid definitions fail and missing references produce diagnostics',()=>{
  assert.throws(()=>parseArchitecture(JSON.stringify({...source,demos:[{name:'bad',steps:[{duration:-1,operations:[]}]}]})));
  const demo={name:'missing',steps:[{operations:[{type:'focus' as const,target:'missing'},{type:'remove' as const,nodes:['missing']}]}]};
  const state=computeDemoStep(source,demo,0);
  assert.equal(state.diagnostics.length,2);
  assert.equal(state.presentation.focus,undefined);
});
