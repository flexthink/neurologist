import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root = process.cwd();
const temporary = await mkdtemp(path.join(tmpdir(),'neurologist-host-'));
try {
  const workspace = path.join(temporary,'workspace');await mkdir(workspace);
  await writeFile(path.join(workspace,'example.neuro'),await readFile('examples/tiny-encoder.neuro'));
  await writeFile(path.join(workspace,'model.py'),'# added comment\n\nclass Encoder:\n    # shifted method\n    def forward(self, x):\n        return x\n');
  await writeFile(path.join(workspace,'config.yaml'),'# added comment\n\nmodules:\n  encoder: !new:models.Encoder\n    hidden_size: 256\n');
  const executable = process.env.VSCODE_EXECUTABLE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const args = ['--new-window','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-extensions',`--user-data-dir=${path.join(temporary,'profile')}`,`--extensions-dir=${path.join(temporary,'extensions')}`,`--extensionDevelopmentPath=${root}`,`--extensionTestsPath=${path.join(root,process.argv.includes('--present') ? 'test/host-present/index.cjs' : 'test/host/index.cjs')}`,workspace];
  await new Promise((resolve,reject) => {
    const environment = {...process.env,NEUROLOGIST_TEST_NODE:process.execPath}; delete environment.ELECTRON_RUN_AS_NODE;
    let passed = false; let logs = '';
    const child = spawn(executable,args,{stdio:['ignore','pipe','pipe'],env:environment});
    const receive = data => {logs = (logs + data.toString()).slice(-16000); if (logs.includes('HOST SMOKE PASSED:') && !passed) {passed = true; console.log(logs.split('\n').find(line => line.startsWith('HOST SMOKE PASSED:'))); child.kill();}};
    child.stdout.on('data',receive); child.stderr.on('data',receive);
    const timeout=setTimeout(() => {child.kill();reject(new Error('VS Code smoke test timed out'));},60000);
    child.on('error',error=>{clearTimeout(timeout);reject(error);});
    child.on('close',code=>{clearTimeout(timeout);passed ? resolve() : reject(new Error(`VS Code exited ${code}: ${logs}`));});
  });
} finally {await rm(temporary,{recursive:true,force:true});}
