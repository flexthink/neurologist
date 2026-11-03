import * as vscode from 'vscode';
import type {ModelSettings} from './modelSettings';
import {randomBytes} from 'node:crypto';

export type DiagramEntry = {kind:'folder';folder:vscode.WorkspaceFolder} | {kind:'diagram';uri:vscode.Uri;folder:vscode.WorkspaceFolder};
export class DiagramProvider implements vscode.TreeDataProvider<DiagramEntry>,vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<DiagramEntry | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions:vscode.Disposable[];
  private timer:ReturnType<typeof setTimeout> | undefined;
  constructor() {
    const watcher=vscode.workspace.createFileSystemWatcher('**/*.neuro');
    const refresh=() => {clearTimeout(this.timer);this.timer=setTimeout(() => this.refresh(),120);};
    this.subscriptions=[watcher,watcher.onDidCreate(refresh),watcher.onDidDelete(refresh),watcher.onDidChange(refresh),vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())];
  }
  refresh() {this.changed.fire(undefined);}
  getTreeItem(entry:DiagramEntry):vscode.TreeItem {
    if (entry.kind==='folder') {
      const item=new vscode.TreeItem(entry.folder.name,vscode.TreeItemCollapsibleState.Expanded);
      item.id=entry.folder.uri.toString();item.resourceUri=entry.folder.uri;item.iconPath=new vscode.ThemeIcon('root-folder');return item;
    }
    const relative=vscode.workspace.asRelativePath(entry.uri,false);
    const name=entry.uri.path.split('/').at(-1)!;
    const item=new vscode.TreeItem(name,vscode.TreeItemCollapsibleState.None);
    item.id=entry.uri.toString();item.resourceUri=entry.uri;
    item.description=relative.includes('/') ? relative.slice(0,relative.lastIndexOf('/')) : undefined;
    item.tooltip=relative;item.iconPath=new vscode.ThemeIcon('type-hierarchy-sub');
    item.command={command:'neurologist.openDiagram',title:'Open Architecture Diagram',arguments:[entry.uri]};
    item.contextValue='neuroDiagram';return item;
  }
  async getChildren(entry?:DiagramEntry):Promise<DiagramEntry[]> {
    if (entry?.kind==='diagram') return [];
    const folders=vscode.workspace.workspaceFolders ?? [];
    if (!entry && folders.length>1) return folders.map(folder => ({kind:'folder',folder}));
    const folder=entry?.kind==='folder' ? entry.folder : folders[0];
    if (!folder) return [];
    const files=await vscode.workspace.findFiles(new vscode.RelativePattern(folder,'**/*.neuro'),'**/{node_modules,.git,.venv,venv}/**');
    return files.sort((a,b) => a.path.localeCompare(b.path)).map(uri => ({kind:'diagram',uri,folder}));
  }
  dispose() {clearTimeout(this.timer);this.changed.dispose();for (const subscription of this.subscriptions) subscription.dispose();}
}
export class AnalysisView implements vscode.WebviewViewProvider {
  constructor(private context:vscode.ExtensionContext,private modelSettings:ModelSettings) {}
  resolveWebviewView(view:vscode.WebviewView) {
    const webview=view.webview;
    const modelBinding=this.modelSettings.bind(webview,uri=>vscode.workspace.workspaceFolders?.find(folder=>folder.uri.toString()===uri));
    webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'dist')]};
    const script=webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'dist/sidebar.js'));
    const css=webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'dist/sidebar.css'));
    const nonce=randomBytes(24).toString('base64');
    webview.html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src data: ${webview.cspSource};"><link rel="stylesheet" href="${css}"></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const update=() => {void webview.postMessage({type:'folders',folders:(vscode.workspace.workspaceFolders ?? []).map(folder => ({uri:folder.uri.toString(),name:folder.name}))});};
    const changes=vscode.workspace.onDidChangeWorkspaceFolders(update);
    const messages=webview.onDidReceiveMessage(async message => {
      try {
        if (message.type==='ready') update();
        if (message.type==='analyze') {
          if (typeof message.instructions!=='string' || message.instructions.length>12000) throw new Error('Instructions must be at most 12,000 characters.');
          const folder=vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString()===message.folder);
          if (!folder) throw new Error('Select an open workspace folder to analyze.');
          await vscode.commands.executeCommand('neurologist.analyze',{instructions:message.instructions,folder:folder.uri.toString(),start:true});
        }
      } catch (error) {void webview.postMessage({type:'error',message:error instanceof Error ? error.message : String(error)});}
    });
    view.onDidDispose(() => {modelBinding.dispose();changes.dispose();messages.dispose();});
  }
}
