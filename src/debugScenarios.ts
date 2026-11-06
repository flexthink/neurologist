import * as vscode from 'vscode';
import {realpath} from 'node:fs/promises';
import * as path from 'node:path';
import {scenarioSchema,type SavedScenario} from './debugScenarioModel';
export {uniqueScenarioName,type SavedScenario} from './debugScenarioModel';
export const scenarioDirectory=(folder:vscode.WorkspaceFolder)=>vscode.Uri.joinPath(folder.uri,'.neurologist','debug');
async function within(folder:vscode.WorkspaceFolder,uri:vscode.Uri){const root=await realpath(folder.uri.fsPath),actual=await realpath(uri.fsPath);if(!actual.startsWith(root+path.sep))throw new Error('Scenario storage resolves outside the workspace.');}
export async function listScenarios(folder:vscode.WorkspaceFolder):Promise<SavedScenario[]>{
 const files=await vscode.workspace.findFiles(new vscode.RelativePattern(folder,'.neurologist/debug/*.scenario.json'));
 const results=await Promise.all(files.map(async uri=>{try{await within(folder,uri);const value=scenarioSchema.parse(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')));return uri.path.endsWith('/'+value.id+'.scenario.json')?value:undefined;}catch{return undefined;}}));
 return results.filter((s):s is SavedScenario=>!!s).sort((a,b)=>a.name.localeCompare(b.name));
}
export async function saveScenario(folder:vscode.WorkspaceFolder,scenario:SavedScenario){const data=scenarioSchema.parse(scenario),uri=vscode.Uri.joinPath(scenarioDirectory(folder),data.id+'.scenario.json');await within(folder,scenarioDirectory(folder));try{await within(folder,uri);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await vscode.workspace.fs.writeFile(uri,Buffer.from(JSON.stringify(data,null,2)+'\n'));}
export type ScenarioTreeEntry={folder:vscode.WorkspaceFolder;scenario:SavedScenario};
export class ScenarioProvider implements vscode.TreeDataProvider<ScenarioTreeEntry>,vscode.Disposable {
 private emitter=new vscode.EventEmitter<void>();readonly onDidChangeTreeData=this.emitter.event;
 private watcher=vscode.workspace.createFileSystemWatcher('**/.neurologist/debug/*.scenario.json');
 private subscriptions=[this.watcher.onDidCreate(()=>this.emitter.fire()),this.watcher.onDidChange(()=>this.emitter.fire()),this.watcher.onDidDelete(()=>this.emitter.fire()),vscode.workspace.onDidChangeWorkspaceFolders(()=>this.emitter.fire())];
 async getChildren(){return (await Promise.all((vscode.workspace.workspaceFolders??[]).map(async folder=>(await listScenarios(folder)).map(scenario=>({folder,scenario}))))).flat();}
 getTreeItem(entry:ScenarioTreeEntry){const item=new vscode.TreeItem(entry.scenario.name);item.id=entry.folder.uri.toString()+entry.scenario.id;item.description=entry.scenario.diagram;item.tooltip=entry.folder.name+' · '+entry.scenario.diagram;item.iconPath=new vscode.ThemeIcon('debug-alt');item.contextValue='neuroScenario';item.command={command:'neurologist.loadScenario',title:'Load debugging scenario',arguments:[entry]};return item;}
 dispose(){this.watcher.dispose();this.emitter.dispose();this.subscriptions.forEach(s=>s.dispose());}
}
