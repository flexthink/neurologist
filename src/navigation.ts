import * as vscode from 'vscode';

let codeGroup:vscode.TabGroup | undefined;
let opening:Promise<void> = Promise.resolve();
const isDiagram=(group:vscode.TabGroup) => group.activeTab?.input instanceof vscode.TabInputCustom && group.activeTab.input.viewType==='neurologist.graph';

/** Keep source links and Edit YAML in one reusable group, even after focus changes. */
export function showInCodeGroup(document:vscode.TextDocument, diagramColumn?:vscode.ViewColumn, options:{group?:vscode.TabGroup;preserveFocus?:boolean;selection?:vscode.Range}={}):Promise<vscode.TextEditor> {
  // Serialize rapid clicks so two first-time opens cannot both create a split.
  const result=opening.then(async () => {
    const groups=vscode.window.tabGroups.all;
    const diagramGroup=diagramColumn === undefined ? groups.find(isDiagram) : groups.find(group => group.viewColumn===diagramColumn);
    if(options.group&&groups.includes(options.group)&&options.group!==diagramGroup&&!isDiagram(options.group))codeGroup=options.group;
    if (!codeGroup || !groups.includes(codeGroup) || codeGroup===diagramGroup || isDiagram(codeGroup)) {
      codeGroup=groups.find(group => group!==diagramGroup && group.activeTab?.input instanceof vscode.TabInputText);
    }
    const editor=await vscode.window.showTextDocument(document,{viewColumn:codeGroup?.viewColumn ?? vscode.ViewColumn.Beside,preview:false,preserveFocus:options.preserveFocus??false,selection:options.selection});
    codeGroup=vscode.window.tabGroups.all.find(group => group.viewColumn===editor.viewColumn);
    return editor;
  });
  opening=result.then(() => undefined,() => undefined);
  return result;
}
