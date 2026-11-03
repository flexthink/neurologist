import * as vscode from 'vscode';
import {discoverModels,modelSelectionSchema,type ModelSelection,type CodexModel} from './modelOptions';

/** A workspace-folder preference shared by every Codex surface. */
export class ModelSettings implements vscode.Disposable {
  private selections:Record<string,ModelSelection>;
  private catalogs=new Map<string,{models:CodexModel[];loading:boolean;error:string;promise?:Promise<void>}>();
  private listeners=new Set<()=>void>();
  constructor(private context:vscode.ExtensionContext) {this.selections=context.workspaceState.get('modelSelections',{});}
  selection(folder?:vscode.WorkspaceFolder):ModelSelection {
    const saved=this.selections[folder?.uri.toString()??''];
    if (saved&&modelSelectionSchema.safeParse(saved).success) return saved;
    const config=vscode.workspace.getConfiguration('neurologist',folder?.uri);
    return modelSelectionSchema.parse({model:config.get('model',''),effort:config.get('reasoningEffort','')});
  }
  bind(webview:vscode.Webview,resolveFolder:(uri?:string)=>vscode.WorkspaceFolder|undefined):vscode.Disposable {
    let requestedFolder:string|undefined;
    const folder=()=>resolveFolder(requestedFolder);
    const key=()=>{const f=folder();return (f?.uri.toString()??'')+'\n'+vscode.workspace.getConfiguration('neurologist',f?.uri).get('codexPath','codex');};
    const publish=()=>{
      const data=this.catalogs.get(key());let selection:ModelSelection={model:'',effort:''},error=data?.error??'';
      try {selection=this.selection(folder());}catch {error='Check neurologist.model and neurologist.reasoningEffort in Settings.';}
      void webview.postMessage({type:'modelSettings',folder:folder()?.uri.toString()??'',selection,models:data?.models??[],loading:data?.loading??false,error});
    };
    this.listeners.add(publish);
    const notify=()=>{for (const listener of this.listeners) listener();};
    const load=async (refresh=false)=>{
      const f=folder(),k=key();if (!f||f.uri.scheme!=='file') {publish();return;}
      if (!vscode.workspace.isTrusted) {this.catalogs.set(k,{models:[],loading:false,error:'Trust this workspace to discover Codex models.'});publish();return;}
      const cached=this.catalogs.get(k);if (cached&&!refresh) {publish();return cached.promise;}
      if (cached?.loading) return cached.promise;
      const data={models:cached?.models??[],loading:true,error:'',promise:undefined as Promise<void>|undefined};this.catalogs.set(k,data);notify();
      data.promise=discoverModels({cwd:f.uri.fsPath,executable:vscode.workspace.getConfiguration('neurologist',f.uri).get('codexPath','codex')}).then(models=>{data.models=models;},error=>{data.error=error instanceof Error ? error.message : String(error);}).finally(()=>{data.loading=false;notify();});
      await data.promise;
    };
    const messages=webview.onDidReceiveMessage(async message=>{
      if (!['modelSettingsRequest','modelSelection','modelsRefresh'].includes(message.type)) return;
      try {
        if (typeof message.folder==='string') requestedFolder=message.folder;
        if (message.type==='modelSelection') {
          const selection=modelSelectionSchema.parse(message.selection),f=folder();
          if (!f) throw new Error('Select a workspace folder before choosing a model.');
          this.selections[f.uri.toString()]=selection;notify();
          await this.context.workspaceState.update('modelSelections',this.selections);
        } else {publish();await load(message.type==='modelsRefresh');}
      } catch (error) {void webview.postMessage({type:'operationError',message:error instanceof Error ? error.message : String(error)});publish();}
    });
    const config=vscode.workspace.onDidChangeConfiguration(event=>{if (event.affectsConfiguration('neurologist')) {this.catalogs.clear();publish();}});
    return {dispose:()=>{messages.dispose();config.dispose();this.listeners.delete(publish);}};
  }
  dispose() {this.listeners.clear();}
}
