import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveCodexExecutable} from '../src/executable';
async function fixture(run:(home:string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(),'neurologist-path-'));
  try {await mkdir(join(home,'.local','bin'),{recursive:true});await run(home);}
  finally {await rm(home,{recursive:true,force:true});}
}
test('finds a user-local CLI even when GUI PATH does not contain it', async () => {
  await fixture(async home => {
    const cli = join(home,'.local','bin','codex');await writeFile(cli,'#!/bin/sh\nexit 0\n',{mode:0o755});
    assert.equal(await resolveCodexExecutable('codex',{home,pathEnv:join(home,'empty')}),cli);
  });
});
test('honors PATH before common installation locations', async () => {
  await fixture(async home => {
    const local = join(home,'.local','bin','codex'); await writeFile(local,'',{mode:0o755});
    const cli = join(home,'codex');await writeFile(cli,'',{mode:0o755});
    assert.equal(await resolveCodexExecutable('codex',{home,pathEnv:home}),cli);
  });
});
test('expands ~/ paths and honors explicit paths containing spaces', async () => {
  await fixture(async home => {
    const cli = join(home,'my codex');await writeFile(cli,'',{mode:0o755});
    assert.equal(await resolveCodexExecutable('~/my codex',{home,pathEnv:''}),cli);
    assert.equal(await resolveCodexExecutable(cli,{home,pathEnv:''}),cli);
  });
});
test('missing configured paths give actionable errors instead of silently switching installs', async () => {
  await fixture(async home => {
    await assert.rejects(resolveCodexExecutable(join(home,'missing'),{home,pathEnv:''}),/neurologist.codexPath.*User Settings/);
  });
});
test('directories and non-executable files cannot be selected as the CLI', async () => {
  await fixture(async home => {
    const cli = join(home,'not-executable');await writeFile(cli,'',{mode:0o644});
    await assert.rejects(resolveCodexExecutable(cli,{home,pathEnv:''}),/Cannot find/);
    await assert.rejects(resolveCodexExecutable(home,{home,pathEnv:''}),/Cannot find/);
  });
});
