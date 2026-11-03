import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArchitecture, safeRelativePath, validateArchitecture } from '../src/model';
import { findSymbolOffsets } from '../src/resolve';
import { analysisPrompt } from '../src/codex';
const example = () => parseArchitecture(readFileSync('examples/tiny-encoder.neuro','utf8'));
test('reads the documented YAML format with residual connections and source anchors', () => {
  const model = example();
  assert.equal(model.nodes.length,4);
  assert.equal(model.edges.find(e => e.id === 'residual')?.target,'output');
  assert.equal(model.nodes[1].sources[2].symbol,'model.hidden_size');
});
test('rejects invalid graphs, duplicate IDs, unknown versions, and unsafe source paths', () => {
  const missing = example(); missing.edges[0].source = 'missing'; assert.throws(() => validateArchitecture(missing),/missing node/);
  const duplicate = example(); duplicate.nodes[1].id = 'input'; assert.throws(() => validateArchitecture(duplicate),/Duplicate node/);
  const duplicateEdge = example(); duplicateEdge.edges[1].id = duplicateEdge.edges[0].id; assert.throws(() => validateArchitecture(duplicateEdge),/Duplicate edge/);
  const unsafe = example(); unsafe.nodes[1].sources[0].file = '../secrets'; assert.throws(() => validateArchitecture(unsafe),/workspace-relative/);
  assert.throws(() => validateArchitecture({...example(),version:2}));
});
test('rejects malformed YAML, duplicate keys, and excessive aliases', () => {
  assert.throws(() => parseArchitecture('title: A\ntitle: B'),/unique/);
  assert.throws(() => parseArchitecture('nodes: ['));
});
test('only accepts workspace-relative paths on Unix and Windows', () => {
  for (const value of ['../x','/etc/passwd','C:\\test','\\\\server\\share','a/../../x','file:///tmp/x','a\0b']) assert.equal(safeRelativePath(value),false,value);
  assert.equal(safeRelativePath('models/encoder.py'),true);
});
test('fallback resolves declarations after line insertions and avoids references', () => {
  const source = '# comment\n\nclass Encoder:\n    def forward(self, x):\n        self.projection = Linear(4, 8)\n        return self.projection(x)\n';
  for (const symbol of ['Encoder','Encoder.forward','Encoder.projection']) {
    const before = findSymbolOffsets(source,symbol);
    const after = findSymbolOffsets('# new comment\n' + source,symbol);
    assert.equal(before.length,1,symbol);
    assert.equal(after[0],before[0] + '# new comment\n'.length);
  }
  assert.equal(findSymbolOffsets('x = Encoder()','Encoder').length,0);
});
test('retains multiple fallback declarations so navigation can ask instead of guessing', () => {
  assert.equal(findSymbolOffsets('class A:\n  def forward(self): pass\nclass B:\n  def forward(self): pass','forward').length,2);
});
test('prompt grounds architecture and supports regeneration instructions', () => {
  const prompt = analysisPrompt('Focus on attention',example());
  assert.match(prompt,/Focus on attention/); assert.match(prompt,/NEVER line numbers/); assert.match(prompt,/retaining node IDs/); assert.match(prompt,/Do not modify files/);
});
