const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vscode=require('vscode');
exports.run=async function () {
  const extension=vscode.extensions.getExtension('neurologist.neurologist');assert.ok(extension);await extension.activate();
  const folder=vscode.workspace.workspaceFolders[0],uri=vscode.Uri.joinPath(folder.uri,'example.neuro');
  const document=await vscode.workspace.openTextDocument(uri),original=document.getText();
  const fixture=require('../fixtures/present.json');
  const mock=vscode.Uri.joinPath(folder.uri,'mock-codex'),captured=vscode.Uri.joinPath(folder.uri,'present-request.txt');
  const node=process.env.NEUROLOGIST_TEST_NODE;assert.ok(node);
  const result={reply:'Here is a minimal draft with the main three blocks.',figure:fixture};
  await fs.writeFile(mock.fsPath,'#!'+node+'\n'+
    'const fs=require("node:fs");const args=process.argv.slice(2);let prompt="";process.stdin.on("data",chunk=>prompt+=chunk);process.stdin.on("end",()=>{fs.writeFileSync('+JSON.stringify(captured.fsPath)+',prompt);fs.writeFileSync(args[args.indexOf("--output-last-message")+1],'+JSON.stringify(JSON.stringify(result))+');});\n',{mode:0o755});
  await vscode.workspace.getConfiguration('neurologist').update('codexPath',mock.fsPath,vscode.ConfigurationTarget.Global);
  try {
    await vscode.commands.executeCommand('vscode.openWith',uri,'neurologist.graph');
    await vscode.commands.executeCommand('neurologist.present',uri);
    const tabsDeadline=Date.now()+10000;
    while (Date.now()<tabsDeadline && !vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('neurologist.present')))) await new Promise(resolve=>setTimeout(resolve,100));
    assert.ok(vscode.window.tabGroups.all.some(group=>group.tabs.some(tab=>tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('neurologist.present'))),'Present! tab did not open');
    let prompt='';const deadline=Date.now()+15000;
    while (Date.now()<deadline) {try {prompt=await fs.readFile(captured.fsPath,'utf8');break;}catch {await new Promise(resolve=>setTimeout(resolve,100));}}
    assert.match(prompt,/INITIAL DRAFT/);assert.match(prompt,/SAME LEVEL OF DETAIL/);assert.match(prompt,/NEVER means removing arrows/);assert.match(prompt,/Original architecture:/);assert.match(prompt,/Tiny encoder/);
    assert.equal(document.getText(),original);
    const count=vscode.window.tabGroups.all.reduce((total,group)=>total+group.tabs.length,0);
    await vscode.commands.executeCommand('neurologist.present',uri);
    assert.equal(vscode.window.tabGroups.all.reduce((total,group)=>total+group.tabs.length,0),count);
    console.log('HOST SMOKE PASSED: Present! command, automatic reference-detail draft through mock Codex, original YAML preservation, presentation tab reuse.');
  } finally {await vscode.workspace.getConfiguration('neurologist').update('codexPath',undefined,vscode.ConfigurationTarget.Global);}
};
