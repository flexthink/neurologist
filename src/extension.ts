import {ScenarioProvider,type ScenarioTreeEntry} from './debugScenarios';
export {DebugController} from './debugController';
import {DebugController} from './debugController';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { isMap, isScalar, parseDocument, stringify } from 'yaml';
import { Architecture, parseArchitecture, safeRelativePath, sourceSchema, SourceLink, validateArchitecture } from './model';
import { analyze, converse } from './codex';
import { ActivityReporter, reduceActivities, type Activity } from './progress';
import { chatModeSchema, type ChatTurn } from './chat';
import { AnalysisView, DiagramProvider } from './sidebar';
export { DiagramProvider } from './sidebar';
import {ModelSettings} from './modelSettings';
import { registerPresent } from './presentView';
import { showInCodeGroup } from './navigation';
import { findSymbolOffsets } from './resolve';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Neurologist');
  const diagnostics = vscode.languages.createDiagnosticCollection('neurologist');
  const busy = new Set<string>();
  const activitySnapshots = new Map<vscode.WebviewPanel,{title:string;items:Activity[]}>();
  const pendingSnapshots = new Map<string,{title:string;items:Activity[]}>();
  const controllers = new Map<vscode.WebviewPanel, AbortController>();
  const panels = new Map<string, vscode.WebviewPanel>();
  context.subscriptions.push(output, diagnostics);
  const modelSettings=new ModelSettings(context);context.subscriptions.push(modelSettings);
  registerPresent(context,output,modelSettings);
  const debugControllers=new Map<string,DebugController>();
  const scenarios=new ScenarioProvider();context.subscriptions.push(scenarios,vscode.window.createTreeView('neurologist.scenarios',{treeDataProvider:scenarios}));
  for(const [command,run,rename] of [['neurologist.loadScenario',false,false],['neurologist.runScenario',true,false],['neurologist.renameScenario',false,true]] as const)context.subscriptions.push(vscode.commands.registerCommand(command,async (entry:ScenarioTreeEntry)=>{
    try{
      if(!entry?.folder||!entry.scenario)throw new Error('Select a saved scenario in the Neurologist sidebar.');
      const uri=vscode.Uri.joinPath(entry.folder.uri,entry.scenario.diagram);await ensureWithinWorkspace(entry.folder,uri);
      await vscode.commands.executeCommand('vscode.openWith',uri,'neurologist.graph');
      const controller=debugControllers.get(uri.toString());if(!controller)throw new Error('Could not open the scenario diagram.');
      if(rename)await controller.renameScenario(entry.scenario.id);else await controller.loadScenario(entry.scenario.id,run);
    }catch(error){handleError(error);}
  }));
  const diagrams=new DiagramProvider();
  context.subscriptions.push(diagrams,vscode.window.createTreeView('neurologist.diagrams',{treeDataProvider:diagrams,showCollapseAll:true}));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('neurologist.analysis',new AnalysisView(context,modelSettings),{webviewOptions:{retainContextWhenHidden:true}}));
  context.subscriptions.push(vscode.commands.registerCommand('neurologist.refreshDiagrams',() => diagrams.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand('neurologist.openDiagram',async (uri?:vscode.Uri) => {
    try {
      if (!(uri instanceof vscode.Uri) || !uri.path.endsWith('.neuro')) throw new Error('Select a .neuro diagram in the Neurologist sidebar.');
      const folder=vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) throw new Error('The diagram must be inside an open workspace folder.');
      await ensureWithinWorkspace(folder,uri);
      await vscode.commands.executeCommand('vscode.openWith',uri,'neurologist.graph');
    } catch (error) {handleError(error);}
  }));

  function html(webview: vscode.Webview, view:'diagram'|'analysis'='diagram') {
    webview.options = {enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')]};
    const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist/webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist/webview.css'));
    const nonce = randomBytes(24).toString('base64');
    return `<!DOCTYPE html><html data-view="${view}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};"><link rel="stylesheet" href="${css}"></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
  async function chooseFolder(uri?: vscode.Uri) {
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    if (folder) return folder;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error('Open a local codebase folder before analyzing.');
    return folders.length === 1 ? folders[0] : vscode.window.showWorkspaceFolderPick({placeHolder:'Choose the codebase to analyze'});
  }
  function startActivity(panel:vscode.WebviewPanel, title:string) {
    void panel.webview.postMessage({type:'activityReset',title});
    const snapshot = {title,items:[] as Activity[]};
    activitySnapshots.set(panel,snapshot);
    const report = new ActivityReporter(activity => {snapshot.items=reduceActivities(snapshot.items,activity);void panel.webview.postMessage({type:'activity',activity});});
    const controller = new AbortController();
    controllers.set(panel,controller);
    const disposed = panel.onDidDispose(() => {controller.abort();activitySnapshots.delete(panel);});
    return {report,controller,dispose:() => {disposed.dispose(); controllers.delete(panel);}};
  }
  function restoreActivity(panel:vscode.WebviewPanel) {
    const snapshot=activitySnapshots.get(panel);
    if (snapshot) {void panel.webview.postMessage({type:'activityReset',title:snapshot.title});for (const activity of snapshot.items) void panel.webview.postMessage({type:'activity',activity});}
    void panel.webview.postMessage({type:'busy',value:controllers.has(panel)});
  }
  function failActivity(panel:vscode.WebviewPanel, report:ActivityReporter, error:unknown) {
    const cancelled = error instanceof Error && error.name === 'AbortError';
    report.finish(cancelled ? 'cancelled' : 'error');
    const message = cancelled ? 'Exploration paused. Your diagram is unchanged.' : error instanceof Error ? error.message : String(error);
    report.update('result',cancelled ? 'Until the next spark' : 'A snag in the synapses',message,cancelled ? 'cancelled' : 'error');
    void panel.webview.postMessage({type:'operationError',message});
  }
  async function generate(panel: vscode.WebviewPanel, instructions: string, document?: vscode.TextDocument, folder?: vscode.WorkspaceFolder) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to run Codex analysis.');
    folder ??= await chooseFolder(document?.uri);
    if (!folder) return;
    if (folder.uri.scheme !== 'file') throw new Error('Analysis currently requires a local filesystem workspace.');
    const key = folder.uri.toString();
    if (busy.has(key)) throw new Error('An analysis is already running for this folder.');
    const previous = document ? parseArchitecture(document.getText()) : undefined;
    const startingVersion = document?.version;
    const config = vscode.workspace.getConfiguration('neurologist', folder.uri);
    busy.add(key);
    void panel.webview.postMessage({type:'busy', value:true});
    const {report,controller,dispose} = startActivity(panel,document ? 'Rewiring the architecture' : 'Mapping the neural landscape');
    try {
      const architectures = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification, title:'Neurologist: analyzing with Codex', cancellable:true}, async (_progress, token) => {
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try { return await analyze({cwd:folder!.uri.fsPath, executable:config.get<string>('codexPath', 'codex'), ...modelSettings.selection(folder), instructions, previous, activity:report, signal:controller.signal, log:chunk => output.append(chunk)}); }
        finally { cancellation.dispose(); }
      });
      controller.signal.throwIfAborted();
      report.update('validate','Connections checked',`Validated ${architectures.length} architecture(s).`,'complete');
      if (!architectures.length) { report.update('result','No neural pathways found','Try narrowing or changing Instructions. No matching architectures were discovered.','complete'); void vscode.window.showInformationMessage('Codex found no neural architectures matching these Instructions.'); return; }
      report.update('save','Putting the map on paper','Saving the validated architecture diagrams.');
      // Validate the complete response before modifying any files.
      if (document) {
        if (architectures.length !== 1) throw new Error('Regeneration must return exactly one architecture. Refine Instructions or run a new analysis.');
        if (document.version !== startingVersion) throw new Error('The YAML changed during analysis. Run regeneration again to preserve your edits.');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), stringify({...architectures[0], instructions}));
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not update architecture.');
      } else {
        const directory = config.get<string>('outputDirectory', '.neurologist');
        if (!safeRelativePath(directory)) throw new Error('Output directory must be workspace-relative and cannot contain ..');
        const target = vscode.Uri.joinPath(folder.uri, directory);
        await ensureWithinWorkspace(folder, target, true);
        await vscode.workspace.fs.createDirectory(target);
        const edit = new vscode.WorkspaceEdit();
        const uris = architectures.map((architecture, index) => {
          const slug = architecture.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'architecture';
          const uri = vscode.Uri.joinPath(target, `${slug}-${Date.now()}-${randomBytes(3).toString('hex')}-${index + 1}.neuro`);
          edit.createFile(uri, {overwrite:false});
          edit.insert(uri, new vscode.Position(0,0), stringify({...architecture, instructions}));
          return uri;
        });
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not create architecture files.');
        for (const uri of uris) await (await vscode.workspace.openTextDocument(uri)).save();
        report.update('save','The map is ready',`Created ${architectures.length} .neuro file(s).`,'complete');
        report.finish('complete');
        const snapshot=activitySnapshots.get(panel);
        if (snapshot) for (const uri of uris) pendingSnapshots.set(uri.toString(),snapshot);
        await vscode.commands.executeCommand('vscode.openWith', uris[0], 'neurologist.graph');
        void vscode.window.showInformationMessage(`Created ${uris.length} architecture file${uris.length === 1 ? '' : 's'} in ${directory}.`);
      }
      report.update('save','The map is ready',document ? 'Diagram updated. Undo is available in VS Code.' : `Created ${architectures.length} .neuro file(s).`,'complete');
      report.finish('complete');
    } catch (error) { failActivity(panel,report,error); throw error; }
    finally { dispose(); busy.delete(key); void panel.webview.postMessage({type:'busy', value:false}); }
  }
  function handleError(error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') return;
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(message);
    void vscode.window.showErrorMessage(`Neurologist: ${message.slice(0,700)}`, 'Show Log').then(action => { if (action) output.show(); });
  }
  async function chat(panel:vscode.WebviewPanel, document:vscode.TextDocument, history:ChatTurn[], message:unknown, mode:unknown, selected:unknown) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to chat with Codex.');
    if (typeof message !== 'string' || !message.trim() || message.length > 12000) throw new Error('Send a message between 1 and 12,000 characters.');
    const chatMode = chatModeSchema.parse(mode);
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || folder.uri.scheme !== 'file') throw new Error('Chat requires a local codebase workspace.');
    const key = folder.uri.toString();
    if (busy.has(key)) throw new Error('Wait for the current exploration to finish, or cancel it first.');
    const architecture = parseArchitecture(document.getText());
    const version = document.version;
    const contextHistory = history.slice(-20);
    const selection = Array.isArray(selected) ? selected.filter((id):id is string => typeof id === 'string').slice(0,500) : [];
    const config = vscode.workspace.getConfiguration('neurologist',folder.uri);
    busy.add(key);
    const {report,controller,dispose} = startActivity(panel,chatMode === 'explain' ? 'A closer look at the architecture' : chatMode === 'regenerate' ? 'Rebuilding the map from source' : 'A little neural rewiring');
    history.push({role:'user',content:message.trim(),mode:chatMode});
    history.splice(0,Math.max(0,history.length-40));
    const publishHistory = async () => {
      void panel.webview.postMessage({type:'chatHistory',messages:history});
      await context.workspaceState.update('chat:'+document.uri.toString(),history);
    };
    void panel.webview.postMessage({type:'busy',value:true});
    try {
      await publishHistory();
      const response = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Neurologist: chatting with Codex',cancellable:true},async (_progress,token) => {
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try { return await converse({cwd:folder.uri.fsPath,executable:config.get<string>('codexPath','codex'),...modelSettings.selection(folder),signal:controller.signal,log:chunk => output.append(chunk),activity:report,architecture,history:contextHistory,message:message.trim(),mode:chatMode,selected:selection}); }
        finally {cancellation.dispose();}
      });
      controller.signal.throwIfAborted();
      report.update('validate','Connections checked','Response and source anchors validated.','complete');
      let revised = false;
      if (response.architecture) {
        if (document.version !== version) throw new Error('The diagram changed while Codex was replying. Your edits were preserved; ask again using the latest diagram.');
        report.update('apply',chatMode === 'regenerate' ? 'Rebuilding the diagram' : 'Rewiring the diagram','Applying the architecture as an undoable YAML edit.');
        await applyDiagramRevision(document,response.architecture,version);
        revised = true;
        report.update('apply','New connections in place',chatMode === 'regenerate' ? 'Diagram regenerated from source. Save when ready; Undo restores the previous version.' : 'Diagram revised. Save when ready; VS Code Undo restores the previous version.','complete');
      }
      history.push({role:'assistant',content:response.reply,sources:response.sources,revised,mode:chatMode});
      history.splice(0,Math.max(0,history.length-40));
      await publishHistory();
      report.update('result',revised ? 'A fresh perspective' : 'The dots, connected',revised ? (chatMode === 'regenerate' ? 'Diagram regenerated from current source and configuration.' : 'Diagram revised and explanation added to the conversation.') : 'Explanation ready in the conversation.','complete');
      report.finish('complete');
    } catch (error) {failActivity(panel,report,error);throw error;}
    finally {dispose();busy.delete(key);void panel.webview.postMessage({type:'busy',value:false});}
  }
  const provider: vscode.CustomTextEditorProvider = {
    resolveCustomTextEditor(document, panel) {
      panel.webview.html = html(panel.webview);
      panels.set(document.uri.toString(), panel);
      const modelBinding=modelSettings.bind(panel.webview,()=>vscode.workspace.getWorkspaceFolder(document.uri));
      const debuggerController=new DebugController(document,panel,modelSettings,output,context.workspaceState);
      debugControllers.set(document.uri.toString(),debuggerController);
      panel.onDidDispose(()=>{if(debugControllers.get(document.uri.toString())===debuggerController)debugControllers.delete(document.uri.toString());});
      const snapshot=pendingSnapshots.get(document.uri.toString());
      if (snapshot) {activitySnapshots.set(panel,snapshot);pendingSnapshots.delete(document.uri.toString());}
      const history:ChatTurn[] = context.workspaceState.get<ChatTurn[]>('chat:'+document.uri.toString(),[]).slice(-40);
      const update = () => {
        try {
          const architecture = parseArchitecture(document.getText());
          diagnostics.delete(document.uri);
          void panel.webview.postMessage({type:'architecture', architecture});
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          diagnostics.set(document.uri, [new vscode.Diagnostic(new vscode.Range(0,0,0,1),message,vscode.DiagnosticSeverity.Error)]);
          void panel.webview.postMessage({type:'error', message});
        }
      };
      const changes = vscode.workspace.onDidChangeTextDocument(event => { if (event.document.uri.toString() === document.uri.toString()) update(); });
      const messages = panel.webview.onDidReceiveMessage(async message => {
        try {
          if (String(message.type).startsWith('debug')) {await debuggerController.handle(message);return;}
          if (message.type === 'ready') {update();void panel.webview.postMessage({type:'chatHistory',messages:history});restoreActivity(panel);}
          if (message.type === 'source') {
            const source = sourceSchema.parse(message.source);
            // A webview may only navigate links present in the current validated document.
            const model = parseArchitecture(document.getText());
            if (!model.nodes.some(node => node.sources.some(link => JSON.stringify(link) === JSON.stringify(source))) && !history.some(turn => turn.sources?.some(link => JSON.stringify(link) === JSON.stringify(source)))) throw new Error('Unknown source link.');
            const folder = vscode.workspace.getWorkspaceFolder(document.uri);
            if (!folder) throw new Error('The architecture must be inside its codebase workspace.');
            await openSource(folder, source,panel.viewColumn);
          }
          if (message.type === 'present') await vscode.commands.executeCommand('neurologist.present',document.uri);
          if (message.type === 'cancel') controllers.get(panel)?.abort();
          if (message.type === 'chat') await chat(panel,document,history,message.message,message.mode,message.selected);
          if (message.type === 'clearChat') {if (busy.has(vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() ?? '')) throw new Error('Wait for the current exploration to finish before clearing chat.'); history.length=0;await context.workspaceState.update('chat:'+document.uri.toString(),[]);void panel.webview.postMessage({type:'chatHistory',messages:[]});}
          if (message.type === 'edit') await showInCodeGroup(document,panel.viewColumn);
          if (message.type === 'generate' && typeof message.instructions === 'string') await generate(panel,message.instructions,document);
        } catch (error) { if (!(error instanceof Error && error.name === 'AbortError')) void panel.webview.postMessage({type:'operationError',message:error instanceof Error ? error.message : String(error)}); handleError(error); }
      });
      panel.onDidDispose(() => {debuggerController.dispose();modelBinding.dispose();panels.delete(document.uri.toString()); activitySnapshots.delete(panel); changes.dispose(); messages.dispose(); diagnostics.delete(document.uri);});
    }
  };
  context.subscriptions.push(vscode.window.registerCustomEditorProvider('neurologist.graph',provider,{webviewOptions:{retainContextWhenHidden:true},supportsMultipleEditorsPerDocument:false}));
  context.subscriptions.push(vscode.commands.registerCommand('neurologist.analyze', async (request?:{instructions?:unknown;folder?:unknown;start?:unknown}) => {
    try {
      const requestedFolder=typeof request?.folder==='string' ? vscode.workspace.workspaceFolders?.find(folder => folder.uri.toString()===request.folder) : undefined;
      const folder = requestedFolder ?? await chooseFolder(); if (!folder) return;
      const initialInstructions=typeof request?.instructions==='string' ? request.instructions.slice(0,12000) : '';
      let autoStart=request?.start===true;
      const panel = vscode.window.createWebviewPanel('neurologist.analysis','Neurologist · Analyze',vscode.ViewColumn.Active,{enableScripts:true});
      const modelBinding=modelSettings.bind(panel.webview,()=>folder);
      panel.webview.html = html(panel.webview,'analysis');
      const listener = panel.webview.onDidReceiveMessage(async message => {
        try {
          if (message.type === 'ready') {void panel.webview.postMessage({type:'home',folder:folder.name,instructions:initialInstructions});restoreActivity(panel);if (autoStart) {autoStart=false;await generate(panel,initialInstructions,undefined,folder);}}
          if (message.type === 'cancel') controllers.get(panel)?.abort();
          if (message.type === 'generate' && typeof message.instructions === 'string') await generate(panel,message.instructions,undefined,folder);
        } catch (error) { handleError(error); }
      });
      panel.onDidDispose(() => {modelBinding.dispose();listener.dispose();activitySnapshots.delete(panel);});
    } catch (error) {handleError(error);}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('neurologist.regenerate',async (uri?: vscode.Uri) => {
    try {
      const selected = uri ?? vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const target = selected instanceof vscode.Uri ? selected : selected instanceof vscode.TabInputCustom ? selected.uri : vscode.window.activeTextEditor?.document.uri;
      if (!target?.path.endsWith('.neuro')) throw new Error('Open a .neuro file to regenerate it.');
      await vscode.commands.executeCommand('vscode.openWith',target,'neurologist.graph');
      const panel = panels.get(target.toString());
      if (panel) await generate(panel, parseArchitecture((await vscode.workspace.openTextDocument(target)).getText()).instructions, await vscode.workspace.openTextDocument(target));
    } catch (error) {handleError(error);}
  }));
  context.subscriptions.push(vscode.commands.registerCommand('neurologist.openSource',async () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputCustom) await showInCodeGroup(await vscode.workspace.openTextDocument(input.uri),vscode.window.tabGroups.activeTabGroup.viewColumn);
  }));
}

async function ensureWithinWorkspace(folder: vscode.WorkspaceFolder, uri: vscode.Uri, allowMissing = false) {
  const root = await realpath(folder.uri.fsPath);
  let candidate = uri.fsPath;
  while (true) {
    try { candidate = await realpath(candidate); break; }
    catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate); if (parent === candidate) throw error; candidate = parent;
    }
  }
  const relative = path.relative(root,candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Source and output paths must stay within the workspace, including symlinks.');
}
export async function openSource(folder: vscode.WorkspaceFolder, link: SourceLink, diagramColumn?:vscode.ViewColumn) {
  if (!safeRelativePath(link.file)) throw new Error('Invalid source path.');
  const uri = vscode.Uri.joinPath(folder.uri,link.file);
  await ensureWithinWorkspace(folder,uri);
  const document = await vscode.workspace.openTextDocument(uri);
  const ranges: {name:string; range:vscode.Range}[] = [];
  if (/\.(?:ya?ml|neuro)$/i.test(link.file)) {
    const doc = parseDocument(document.getText(), {customTags: () => []});
    function walk(value: unknown, parts: string[]) {
      if (!isMap(value)) return;
      for (const pair of value.items) {
        if (!isScalar(pair.key)) continue;
        const names = [...parts,String(pair.key.value)];
        if (names.join('.') === link.symbol && pair.key.range) {
          const position = document.positionAt(pair.key.range[0]); ranges.push({name:names.join('.'), range:new vscode.Range(position,position)});
        }
        walk(pair.value,names);
      }
    }
    walk(doc.contents,[]);
  }
  if (!ranges.length) {
    const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider',uri);
    function collect(items: (vscode.DocumentSymbol | vscode.SymbolInformation)[], prefix = '') {
      for (const item of items) {
        const qualified = prefix ? `${prefix}.${item.name}` : item.name;
        if (qualified === link.symbol || qualified.endsWith(`.${link.symbol}`) || item.name === link.symbol) ranges.push({name:qualified,range:'selectionRange' in item ? item.selectionRange : item.location.range});
        if ('children' in item) collect(item.children,qualified);
      }
    }
    collect(symbols ?? []);
  }
  if (!ranges.length) for (const offset of findSymbolOffsets(document.getText(),link.symbol)) {
    const position = document.positionAt(offset); ranges.push({name:`${link.symbol} · line ${position.line + 1}`,range:new vscode.Range(position,position)});
  }
  let hit = ranges[0];
  if (ranges.length > 1) {
    const choice = await vscode.window.showQuickPick(ranges.map((item,index) => ({label:item.name,description:`Line ${item.range.start.line + 1}`,index})),{placeHolder:'Multiple matches: choose the source symbol'});
    if (!choice) return; hit = ranges[choice.index];
  }
  const editor = await showInCodeGroup(document,diagramColumn);
  if (hit) { editor.selection = new vscode.Selection(hit.range.start,hit.range.end); editor.revealRange(hit.range,vscode.TextEditorRevealType.InCenter); }
  else void vscode.window.showWarningMessage(`Symbol "${link.symbol}" was not found in ${link.file}. The file is open; regenerate if it was renamed.`);
}

export async function applyDiagramRevision(document:vscode.TextDocument, architecture:Architecture, expectedVersion:number) {
  const validated = validateArchitecture(architecture);
  if (document.version !== expectedVersion) throw new Error("The diagram changed while Codex was replying. Your edits were preserved; ask again using the latest diagram.");
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),stringify(validated));
  if (!await vscode.workspace.applyEdit(edit)) throw new Error("Could not apply diagram revision.");
}
