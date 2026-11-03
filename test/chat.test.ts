import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseArchitecture} from '../src/model';
import {chatPrompt,validateChatResponse,type ChatTurn} from '../src/chat';
const model = () => parseArchitecture(readFileSync('examples/tiny-encoder.neuro','utf8'));
test('explanation responses cannot edit diagrams', () => {
  assert.equal(validateChatResponse({reply:'The input is projected to 256 features.',sources:[],architecture:null},'explain').architecture,null);
  assert.throws(() => validateChatResponse({reply:'Changed it',sources:[],architecture:model()},'explain'),/cannot change/);
});
test('revisions are validated for graph consistency and source anchors', () => {
  const revised=model();revised.title='A clearer encoder';
  assert.equal(validateChatResponse({reply:'Updated the label.',sources:[],architecture:revised},'revise').architecture?.title,'A clearer encoder');
  revised.edges[0].target='missing';assert.throws(() => validateChatResponse({reply:'Updated',sources:[],architecture:revised},'revise'),/missing node/);
  assert.throws(() => validateChatResponse({reply:'See the source',sources:[{kind:'definition',file:'../private.py',symbol:'X'}],architecture:null},'explain'),/workspace-relative/);
});
test('prompt carries current architecture, bounded history, valid selection, and mode restrictions', () => {
  const history:ChatTurn[]=Array.from({length:25},(_,i) => ({role:'user',content:'Turn '+i}));
  const prompt=chatPrompt(model(),history,'What does projection do?','explain',['projection','not-a-node']);
  assert.match(prompt,/architecture MUST be null/);assert.match(prompt,/"projection"/);assert.doesNotMatch(prompt,/not-a-node/);assert.doesNotMatch(prompt,/Turn 0"/);assert.match(prompt,/Turn 24/);assert.match(prompt,/What does projection do/);
});

test('regeneration re-reads source and treats the current diagram as potentially stale',()=>{
  const architecture=model();architecture.instructions='Use HyperPyYAML definitions';
  const prompt=chatPrompt(architecture,[{role:'user',content:'Include residual paths'}],'Regenerate using the latest configs','regenerate',['projection']);
  assert.match(prompt,/REGENERATE FROM CURRENT SOURCE/);assert.match(prompt,/analyze the current codebase afresh/);assert.match(prompt,/may be stale/);assert.match(prompt,/HyperPyYAML/);assert.match(prompt,/Consolidate the prior Instructions/);assert.match(prompt,/Include residual paths/);assert.match(prompt,/regenerate the whole scoped architecture/);
  assert.equal(validateChatResponse({reply:'Rebuilt from source',sources:[],architecture},'regenerate').architecture?.title,architecture.title);
  assert.equal(validateChatResponse({reply:'Which configuration should define the model?',sources:[],architecture:null},'regenerate').architecture,null);
});
