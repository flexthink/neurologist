import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ActivityReporter,CodexEventStream,reduceActivities,type Activity} from '../src/progress';
test('streamed start/update/complete events update one expandable step across split records', () => {
  let items:Activity[]=[];
  const stream=new CodexEventStream(new ActivityReporter(item => {items=reduceActivities(items,item);}));
  const event=(type:string,status:string,output:string) => JSON.stringify({type,item:{id:'command-1',type:'command_execution',command:'rg encoder config/',status,aggregated_output:output}})+'\n';
  const text=event('item.started','in_progress','')+event('item.updated','in_progress','Found model')+event('item.completed','completed','Found model and config');
  for (let i=0;i<text.length;i+=7) stream.push(text.slice(i,i+7));stream.end();
  assert.equal(items.length,1);assert.equal(items[0].state,'complete');assert.match(items[0].detail,/model and config/);assert.equal(items[0].label,'Following the paper trail');
});
test('handles failures, incomplete trailing records, and hides the structured final reply', () => {
  const items:Activity[]=[];const report=new ActivityReporter(item => items.push(item));const stream=new CodexEventStream(report);
  stream.push('not json\n');
  stream.push(JSON.stringify({type:'item.completed',item:{id:'final',type:'agent_message',text:'{"architectures":[]}'}})+'\n');
  stream.push(JSON.stringify({type:'error',message:'Model unavailable'}));stream.end();
  assert.equal(items.length,1);assert.equal(items[0].state,'error');assert.equal(items[0].detail,'Model unavailable');
});
test('finishes only running steps on cancellation and retains failed steps', () => {
  let items:Activity[]=[];const report=new ActivityReporter(item => {items=reduceActivities(items,item);});
  report.update('a','Reading');report.update('b','Failed','oops','error');report.finish('cancelled');
  assert.deepEqual(items.map(item => item.state),['cancelled','error']);assert.ok(items[0].endedAt);
});
test('bounds activity snapshots while retaining the newest evidence', () => {
  let items:Activity[]=[];
  for (let i=0;i<200;i++) items=reduceActivities(items,{id:String(i),kind:'command',label:'Read',detail:'x'.repeat(15000),startedAt:i,state:'complete'});
  assert.equal(items.length,150);assert.ok(items.reduce((total,item) => total+item.detail.length,0)<=100000);assert.equal(items.at(-1)?.detail.length,12000);assert.equal(items.at(-1)?.id,'199');
});
