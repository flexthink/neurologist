import {test} from 'node:test';
import assert from 'node:assert/strict';
import {uniqueScenarioName,scenarioSchema} from '../src/debugScenarioModel';
import {DEFAULT_NAVIGATION_SETTINGS} from '../src/debugNavigation';
test('scenario names preserve display text and suffix duplicates case-insensitively',()=>{
 assert.equal(uniqueScenarioName('  Encoder pass  ',[]),'Encoder pass');
 assert.equal(uniqueScenarioName('Encoder pass',['encoder pass','Encoder pass (2)']),'Encoder pass (3)');
 assert.equal(uniqueScenarioName('',[]),'Debug scenario');
});
test('saved scenarios restore runnable setup without saved runtime lines or watch values',()=>{
 const saved={version:1,id:'b3d1c5d8-4be7-41e4-a2c0-2746f39d3205',name:'Encoder pass',diagram:'models/encoder.neuro',entry:'.neurologist/debug/scenario.py',instructions:'Mock inputs',request:'Run encoder',plan:{reply:'Ready',entry:{language:'python',code:'model(x)',args:['--test']},anchors:[{node:'encoder',file:'model.py',symbol:'Model.forward',kind:'forward',statement:''}],watches:[]},navigationSettings:DEFAULT_NAVIGATION_SETTINGS,watches:[{id:'shape',node:'encoder',expression:'x.shape'}]};
 assert.deepEqual(scenarioSchema.parse(saved),saved);
 assert.equal(scenarioSchema.safeParse({...saved,entry:'../outside.py'}).success,false);
 assert.equal(scenarioSchema.safeParse({...saved,diagram:'/absolute.neuro'}).success,false);
 assert.equal(scenarioSchema.safeParse({...saved,id:'../escape'}).success,false);
 assert.equal(scenarioSchema.safeParse({...saved,watches:[{...saved.watches[0],value:'old tensor'}]}).success,false);
});
