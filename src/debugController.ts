import {visualizationSpecSchema,savedVisualizationSchema,visualizationExpression,pngDataUri,MAX_IMAGE_BYTES,PYTHON_VISUALIZATION_BRIDGE,JAVASCRIPT_VISUALIZATION_BRIDGE,type DebugVisualization} from './debugVisualization';
import {listScenarios,saveScenario,uniqueScenarioName,type SavedScenario} from './debugScenarios';
import {navigationSettingsSchema,detectLoop} from './debugNavigation';
import * as vscode from 'vscode';
import {realpath} from 'node:fs/promises';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {stringify} from 'yaml';
import {parseArchitecture,validateArchitecture,safeRelativePath,type Architecture} from './model';
import {prepareDebug,debugConversation} from './codex';
import {DebugRuntime,samePath} from './debugRuntime';
import {emptyDebugState,DEFAULT_DEBUG_INSTRUCTIONS,resolvePythonAnchor,watchSchema,type ExecutionAnchor,type ResolvedAnchor,type DebugAction,type DebugPlan} from './debugModel';
import type {ModelSettings} from './modelSettings';
import {showInCodeGroup} from './navigation';
import {ActivityReporter} from './progress';

class UnsavedDebugSource extends Error {}

/** One editor owns one debug session. Other sessions and user breakpoints are untouched. */
export class DebugController implements vscode.Disposable {
  private readonly owner=randomUUID();private state=emptyDebugState();private plan?:DebugPlan;
  private entry?:vscode.Uri;private session?:vscode.DebugSession;private rootSession?:vscode.DebugSession;private ownedSessions=new Set<string>();private runtime?:DebugRuntime;
  private sourceAliases=new Map<string,string>();
  private entryGroup?:vscode.TabGroup;private originalTabs=new Set<vscode.Tab>();private routedFrame='';private routing=Promise.resolve();private routeTimer:ReturnType<typeof setTimeout>|undefined;
  private anchors:ResolvedAnchor[]=[];private breakpoints:vscode.SourceBreakpoint[]=[];
  private abort?:AbortController;private activity?:ActivityReporter;private disposed=false;private subscriptions:vscode.Disposable[]=[];
  constructor(private document:vscode.TextDocument,private panel:vscode.WebviewPanel,private models:ModelSettings,private output:vscode.OutputChannel,private storage?:vscode.Memento) {
    const saved=storage?.get<string>(this.instructionsKey());if(typeof saved==='string')this.state.instructions=saved;
    const limits=navigationSettingsSchema.safeParse(storage?.get('debugNavigation:'+this.document.uri.toString()));if(limits.success)this.state.navigationSettings=limits.data;
    this.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*',{createDebugAdapterTracker:session=>{
      if(session.configuration.neurologistOwner!==this.owner&&!this.ownedSessions.has(session.parentSession?.id??''))return;
      this.ownedSessions.add(session.id);if(!this.rootSession)this.rootSession=session;
      this.session=session;this.runtime=new DebugRuntime(session,this.state,this.anchors,()=>this.publish(),this.plan?.entry?.language??'python',(visual,frame,hit)=>this.renderVisualization(session,visual,frame,hit));
      const requests=new Map<number,{path:string;lines:number[]}>(),bound=new Map<number,ResolvedAnchor[]>(),pending=new Map<number,string>(),navigationIds=new Set<number>();
      return {
        onWillReceiveMessage:message=>{if(message.type==='request'&&message.command==='setBreakpoints')requests.set(message.seq,{path:message.arguments.source?.path,lines:(message.arguments.breakpoints??[]).map((b:any)=>b.line)});},
        onDidSendMessage:message=>{
          if(this.session?.id!==session.id)return;
          if(message.type==='event'&&message.event==='breakpoint'){
            const bp=message.body?.breakpoint,matched=bound.get(bp?.id)??[];
            if(bp?.verified){if(typeof bp.line==='number')for(const a of matched){a.line=bp.line;a.endLine=Math.max(a.endLine,bp.line);}const prior=pending.get(bp.id);if(prior){this.state.diagnostics=this.state.diagnostics.filter(d=>d!==prior);pending.delete(bp.id);this.publish();}}
          }
          if(message.type==='event'&&message.event==='stopped'){
            const body=message.body??{},hits:number[]=body.hitBreakpointIds??[];
            void this.runtime?.stopped(body.threadId,body.reason,frame=>{
              if(body.reason!=='breakpoint'||!frame?.source?.path)return false;
              const userAtStop=vscode.debug.breakpoints.some(bp=>bp instanceof vscode.SourceBreakpoint&&bp.enabled&&this.sameSource(bp.location.uri.fsPath,frame.source!.path!)&&bp.location.range.start.line+1===frame.line&&(!this.breakpoints.some(own=>own.id===bp.id)||!!bp.condition||!!bp.hitCondition||!!bp.logMessage));
              if(userAtStop)return false;
              if(hits.length)return hits.every(id=>navigationIds.has(id));
              return [...bound].some(([id,anchors])=>navigationIds.has(id)&&anchors.some(a=>this.sameSource(a.path,frame.source!.path!)&&a.line===frame.line));
            });
          }
          if(message.type==='event'&&message.event==='continued')this.runtime?.continued();
          if(message.type==='event'&&message.event==='terminated')this.ended();
          if(message.type==='response'&&message.command==='setBreakpoints') {
            const request=requests.get(message.request_seq);requests.delete(message.request_seq);
            if(request)for(const [index,bp]of (message.body?.breakpoints??[]).entries()) {
              const matched=this.anchors.filter(a=>this.sameSource(a.path,request.path)&&a.line===request.lines[index]);
              if(typeof bp.id==='number'){bound.set(bp.id,matched);const owned=this.breakpoints.some(own=>this.sameSource(own.location.uri.fsPath,request.path)&&own.location.range.start.line+1===request.lines[index]);if(owned)navigationIds.add(bp.id);else navigationIds.delete(bp.id);}
              if(bp.verified&&typeof bp.line==='number')for(const a of matched){a.line=bp.line;a.endLine=Math.max(a.endLine,bp.line);}
              else if(matched.length){const diagnostic='Unverified breakpoint: '+matched.map(a=>a.file+' → '+a.symbol).join(', ')+(bp.message?' — '+bp.message:'');if(typeof bp.id==='number')pending.set(bp.id,diagnostic);this.diagnostic(diagnostic);}
            }
          }
          if(message.type==='response'&&['launch','attach'].includes(message.command)&&!message.success){this.diagnostic(message.message??'Debugger launch failed');this.ended();}
        },onError:error=>this.diagnostic(error.message),onExit:()=>{if(this.session?.id===session.id)this.ended();}
      };
    }}),vscode.debug.onDidTerminateDebugSession(session=>{if(session.id===this.session?.id)this.ended();}),vscode.debug.onDidChangeActiveStackItem(item=>{
      if(item instanceof vscode.DebugStackFrame&&item.session.id===this.session?.id&&this.state.status==='stopped'&&this.state.frameId!==item.frameId&&this.state.stack.some(f=>f.id===item.frameId))void this.runtime?.selectFrame(item.frameId).catch(error=>this.diagnostic(String(error)));
    }),vscode.window.onDidChangeActiveTextEditor(editor=>{const source=this.state.stack.find(f=>f.id===this.state.frameId)?.source?.path;if(editor&&source&&this.state.status==='stopped'&&editor.viewColumn!==this.entryGroup?.viewColumn&&this.sameSource(editor.document.uri.fsPath,source))this.routeStoppedSource(true);}),vscode.window.tabGroups.onDidChangeTabs(event=>{const source=this.state.stack.find(f=>f.id===this.state.frameId)?.source?.path;if(source&&this.state.status==='stopped'&&event.opened.some(tab=>tab.input instanceof vscode.TabInputText&&this.sameSource(tab.input.uri.fsPath,source)))this.routeStoppedSource(true);}));
  }
  private sameSource(a?:string,b?:string){return !!a&&!!b&&samePath(this.sourceAliases.get(a)??a,this.sourceAliases.get(b)??b);}
  private instructionsKey(){return 'debugInstructions:'+this.document.uri.toString();}
  private async setInstructions(value:unknown){if(typeof value!=='string'||value.length>12000)throw new Error('Debug instructions must be at most 12,000 characters.');this.state.instructions=value.trim()||DEFAULT_DEBUG_INSTRUCTIONS;await this.storage?.update(this.instructionsKey(),this.state.instructions);await this.updateSavedScenario();this.publish();}
  private folder(){const f=vscode.workspace.getWorkspaceFolder(this.document.uri);if(!f||f.uri.scheme!=='file')throw new Error('Debugging requires a local workspace.');if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before running code with the debugger.');return f;}
  private publish(){if(!this.disposed){void this.panel.webview.postMessage({type:'debugState',state:this.state});this.routeStoppedSource();}}
  private async openCode(document:vscode.TextDocument,preserveFocus=false,selection?:vscode.Range){
    const editor=await showInCodeGroup(document,this.panel.viewColumn,{group:this.entryGroup,preserveFocus,selection});
    this.entryGroup=vscode.window.tabGroups.all.find(group=>group.viewColumn===editor.viewColumn);return editor;
  }
  private routeStoppedSource(force=false){
    if(this.disposed||this.state.status!=='stopped'){this.routedFrame='';return;}
    const frame=this.state.stack.find(f=>f.id===this.state.frameId);if(!frame?.source?.path||!path.isAbsolute(frame.source.path))return;
    const key=frame.id+':'+frame.source.path+':'+frame.line;
    if(!force&&key===this.routedFrame)return;this.routedFrame=key;
    clearTimeout(this.routeTimer);
    this.routeTimer=setTimeout(()=>{this.routing=this.routing.then(async()=>{
      if(this.disposed||this.state.status!=='stopped'||this.routedFrame!==key)return;
      const uri=vscode.Uri.file(frame.source!.path!),document=await vscode.workspace.openTextDocument(uri);
      if(this.disposed||this.state.status!=='stopped'||this.routedFrame!==key)return;
      const line=Math.max(0,Math.min(frame.line-1,document.lineCount-1)),position=new vscode.Position(line,0);
      await this.openCode(document,true,new vscode.Range(position,position));
      if(this.disposed||this.state.status!=='stopped'||this.routedFrame!==key)return;
      // VS Code can reveal a stopped source in the group that held the graph.
      // Relocate newly opened debugger tabs only; never close pre-existing user tabs.
      const misplaced=vscode.window.tabGroups.all.filter(group=>group!==this.entryGroup).flatMap(group=>group.tabs).filter(tab=>!this.originalTabs.has(tab)&&tab.input instanceof vscode.TabInputText&&this.sameSource(tab.input.uri.fsPath,uri.fsPath));
      if(misplaced.length)await vscode.window.tabGroups.close(misplaced,true);
      if(!this.disposed)this.panel.reveal(this.panel.viewColumn,true);
    }).catch(error=>{if(!this.disposed)this.diagnostic('Could not route debugger source: '+String(error));});},0);
  }
  private diagnostic(message:string){if(this.disposed)return;this.state.diagnostics=[...this.state.diagnostics,message].slice(-100);this.output.appendLine('Debug: '+message);this.publish();}
  private ended(){if(this.state.status==='terminated')return;this.runtime?.terminated();this.session=undefined;vscode.debug.removeBreakpoints(this.breakpoints);this.breakpoints=[];this.publish();}
  private async within(relative:string){if(!safeRelativePath(relative))throw new Error('Debug source must be workspace-relative.');const f=this.folder(),uri=vscode.Uri.joinPath(f.uri,relative),root=await realpath(f.uri.fsPath),actual=await realpath(uri.fsPath);if(actual!==root&&!actual.startsWith(root+path.sep))throw new Error('Debug source resolves outside the workspace.');this.sourceAliases.set(uri.fsPath,actual);this.sourceAliases.set(actual,actual);return vscode.Uri.file(actual);}
  private async resolve(anchor:ExecutionAnchor):Promise<ResolvedAnchor|undefined> {
    try {
      const uri=await this.within(anchor.file),doc=await vscode.workspace.openTextDocument(uri);
      const dirtySource=doc.isDirty||(await Promise.all(vscode.workspace.textDocuments.filter(open=>open.isDirty&&open.uri.scheme==='file').map(async open=>{try{return await realpath(open.uri.fsPath)===uri.fsPath;}catch{return false;}}))).some(Boolean);
      if(dirtySource)throw new UnsavedDebugSource('Save '+anchor.file+' before running the debugger; its execution anchors must match the code on disk.');
      if(/\.py$/i.test(anchor.file)) {const hit=resolvePythonAnchor(doc.getText(),anchor.symbol,anchor.statement);if(!hit)throw new Error('Missing or ambiguous qualified symbol/statement');return {...anchor,path:uri.fsPath,...hit};}
      const symbols=await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider',uri),hits:vscode.DocumentSymbol[]=[];
      const walk=(items:vscode.DocumentSymbol[],prefix='')=>{for(const item of items){const name=prefix?prefix+'.'+item.name:item.name;if(name===anchor.symbol)hits.push(item);if(item.children)walk(item.children,name);}};walk(symbols??[]);
      if(hits.length!==1)throw new Error('Missing or ambiguous qualified symbol');
      const hit=hits[0];let line=hit.selectionRange.start.line;
      if(anchor.statement){const matches:number[]=[];for(let i=hit.range.start.line;i<=hit.range.end.line;i++)if(doc.lineAt(i).text.includes(anchor.statement))matches.push(i);if(matches.length!==1)throw new Error('Missing or ambiguous invocation statement');line=matches[0];}
      else if(line<hit.range.end.line)line++;
      return {...anchor,path:uri.fsPath,line:line+1,endLine:hit.range.end.line+1};
    }catch(error){if(error instanceof UnsavedDebugSource)throw error;this.diagnostic(`${anchor.node}: ${anchor.file} → ${anchor.symbol}: ${error instanceof Error?error.message:String(error)}`);return;}
  }
  private options(signal:AbortSignal){const folder=this.folder(),config=vscode.workspace.getConfiguration('neurologist',folder.uri);return {cwd:folder.uri.fsPath,executable:config.get<string>('codexPath','codex'),...this.models.selection(folder),signal,log:(chunk:string)=>this.output.append(chunk),activity:this.activity};}
  private async refreshScenarios(){this.state.scenarios=(await listScenarios(this.folder())).filter(s=>s.diagram===vscode.workspace.asRelativePath(this.document.uri,false)).map(({id,name})=>({id,name}));}
  async loadScenario(id:string,run=false){
    if(this.state.busy||this.session||this.state.status==='starting')throw new Error('Stop the current operation/session before loading a scenario.');
    const saved=(await listScenarios(this.folder())).find(s=>s.id===id&&s.diagram===vscode.workspace.asRelativePath(this.document.uri,false));if(!saved)throw new Error('Saved scenario no longer exists for this diagram.');
    this.state.busy=true;this.publish();try{
    await this.within(saved.entry);const entry=vscode.Uri.joinPath(this.folder().uri,saved.entry);if(!saved.plan.entry)throw new Error('Scenario has no runnable entry script.');
    const architecture=parseArchitecture(this.document.getText());validateArchitecture({...architecture,execution:saved.plan.anchors});
    const edit=new vscode.WorkspaceEdit();edit.replace(this.document.uri,new vscode.Range(this.document.positionAt(0),this.document.positionAt(this.document.getText().length)),stringify({...architecture,execution:saved.plan.anchors}));
    if(!await vscode.workspace.applyEdit(edit))throw new Error('Could not restore scenario execution anchors.');
    this.plan=saved.plan;this.entry=entry;this.runtime=undefined;Object.assign(this.state,{status:'prepared',scenarioId:saved.id,scenarioName:saved.name,entry:saved.entry,instructions:saved.instructions,navigationSettings:saved.navigationSettings,visualizations:(saved.visualizations??[]).filter(v=>architecture.nodes.some(n=>n.id===v.node)).map(v=>({...v,stale:true})),watches:saved.watches.filter(w=>architecture.nodes.some(n=>n.id===w.node)).map(w=>({...w,stale:true})),activeNodes:[],stack:[],trace:[],detectedLoop:[],navigationResult:undefined,diagnostics:[],reason:'',messages:[{role:'user',content:saved.request},{role:'assistant',content:'Loaded '+saved.name+'. Review the entry script, then choose Run debug.'}]});
    await this.refreshScenarios();await this.openCode(await vscode.workspace.openTextDocument(entry));this.publish();void this.panel.webview.postMessage({type:'debugOpen'});if(run)await this.launch();
    }finally{this.state.busy=false;this.publish();}
  }
  async renameScenario(id=this.state.scenarioId){
    if(this.state.busy)throw new Error('Wait for the current operation before renaming.');
    const all=await listScenarios(this.folder()),saved=all.find(s=>s.id===id);if(!saved)throw new Error('Load a saved scenario first.');
    const name=await vscode.window.showInputBox({title:'Rename debugging scenario',value:saved.name,validateInput:value=>!value.trim()?'Enter a scenario name.':value.trim().length>120?'Use at most 120 characters.':undefined});if(name===undefined)return;
    saved.name=uniqueScenarioName(name,all.filter(s=>s.id!==id).map(s=>s.name));await saveScenario(this.folder(),saved);if(id===this.state.scenarioId)this.state.scenarioName=saved.name;await this.refreshScenarios();this.publish();
  }
  private async updateSavedScenario(){
    if(!this.state.scenarioId)return;const folder=this.folder(),saved=(await listScenarios(folder)).find(s=>s.id===this.state.scenarioId);if(!saved)return;
    saved.visualizations=(this.state.visualizations??[]).map(v=>savedVisualizationSchema.parse({id:v.id,title:v.title,node:v.node,language:v.language,function:v.function,context:v.context,condition:v.condition,anchor:v.anchor,file:v.file}));saved.instructions=this.state.instructions;saved.navigationSettings=this.state.navigationSettings;saved.watches=this.state.watches.map(({id,node,expression})=>({id,node,expression}));await saveScenario(folder,saved);
  }
  private async persistScenario(request:string){
    if(!this.entry||!this.plan?.entry)return;const folder=this.folder(),all=await listScenarios(folder),id=randomUUID();
    const saved:SavedScenario={version:1,id,name:uniqueScenarioName(this.plan.name??request.slice(0,100),all.map(s=>s.name)),diagram:vscode.workspace.asRelativePath(this.document.uri,false),entry:vscode.workspace.asRelativePath(this.entry,false),instructions:this.state.instructions,request,plan:this.plan,navigationSettings:this.state.navigationSettings,watches:this.state.watches.map(({id,node,expression})=>({id,node,expression}))};
    await saveScenario(folder,saved);this.state.scenarioId=id;this.state.scenarioName=saved.name;await this.refreshScenarios();
  }
  private async generate(scenario:string) {
    if(this.session||this.state.status==='starting')throw new Error('Stop the current debug session before preparing another scenario.');
    const architecture=parseArchitecture(this.document.getText()),version=this.document.version;
    const response=await prepareDebug({...this.options(this.abort!.signal),architecture,scenario,instructions:this.state.instructions,history:this.state.messages.slice(-20)});
    if(!response.entry){this.state.messages.push({role:'assistant',content:response.reply});this.publish();return;}
    const candidate=validateArchitecture({...architecture,execution:response.anchors});
    for(const watch of response.watches)if(!candidate.nodes.some(n=>n.id===watch.node))throw new Error('Watch references an unknown node: '+watch.node);
    for(const anchor of response.anchors)await this.within(anchor.file);
    this.abort!.signal.throwIfAborted();if(this.document.version!==version)throw new Error('Diagram changed during preparation. Your edits were preserved; prepare again.');
    // Create a unique, reviewable entry file. Never overwrite project source or launch.json.
    const folder=this.folder(),directory=vscode.Uri.joinPath(folder.uri,'.neurologist','debug');
    const root=await realpath(folder.uri.fsPath);let ancestor=directory.fsPath;
    while(true){try{const resolved=await realpath(ancestor);if(resolved!==root&&!resolved.startsWith(root+path.sep))throw new Error('Debug output directory resolves outside the workspace.');break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;ancestor=path.dirname(ancestor);}}
    await vscode.workspace.fs.createDirectory(directory);const actual=await realpath(directory.fsPath);
    if(!actual.startsWith(root+path.sep))throw new Error('Debug output directory resolves outside the workspace.');
    const entry=vscode.Uri.joinPath(directory,`scenario-${randomUUID()}.${response.entry.language==='python'?'py':'js'}`);
    const edit=new vscode.WorkspaceEdit();edit.createFile(entry,{overwrite:false});edit.insert(entry,new vscode.Position(0,0),response.entry.code);
    edit.replace(this.document.uri,new vscode.Range(this.document.positionAt(0),this.document.positionAt(this.document.getText().length)),stringify(candidate));
    if(!await vscode.workspace.applyEdit(edit))throw new Error('Could not create the entry script and execution anchors.');
    await (await vscode.workspace.openTextDocument(entry)).save();
    this.entry=entry;this.plan=response;this.runtime=undefined;this.state.status='prepared';this.state.entry=vscode.workspace.asRelativePath(entry,false);this.state.watches=response.watches.map(w=>({...w,stale:true}));this.state.activeNodes=[];this.state.stack=[];this.state.diagnostics=[];
    this.state.visualizations=[];await this.persistScenario(scenario);
    this.state.messages.push({role:'assistant',content:response.reply+'\n\nEntry script is open for review. Choose Run debug to execute it. Execution anchors are an undoable YAML edit; save the diagram when ready.'});
    await this.openCode(await vscode.workspace.openTextDocument(entry));this.publish();
  }
  private async launch() {
    const folder=this.folder();if(!this.plan||!this.entry)throw new Error('Prepare a scenario first.');if(this.session||this.state.status==='starting')throw new Error('A debug session is already active.');
    const saved=(await listScenarios(folder)).find(s=>s.id===this.state.scenarioId);
    if(saved){saved.visualizations=(this.state.visualizations??[]).map(v=>savedVisualizationSchema.parse({id:v.id,title:v.title,node:v.node,language:v.language,function:v.function,context:v.context,condition:v.condition,anchor:v.anchor,file:v.file}));saved.instructions=this.state.instructions;saved.navigationSettings=this.state.navigationSettings;saved.watches=this.state.watches.map(({id,node,expression})=>({id,node,expression}));saved.plan.anchors=parseArchitecture(this.document.getText()).execution??[];await saveScenario(folder,saved);}
    const doc=await vscode.workspace.openTextDocument(this.entry);if(!await doc.save())throw new Error('Save the entry script before launching.');
    if(!this.plan.entry)throw new Error('Prepare a runnable scenario first.');
    if(this.plan.entry.language==='python'&&!vscode.extensions.getExtension('ms-python.debugpy'))throw new Error('Install the Python Debugger extension (ms-python.debugpy), select your Python interpreter, then Run debug.');
    const architecture=parseArchitecture(this.document.getText());this.anchors.length=0;this.state.diagnostics=[];
    for(const anchor of [...(architecture.execution??[]),...(this.state.visualizations??[]).flatMap(v=>v.anchor?[v.anchor]:[])]){const resolved=await this.resolve(anchor);if(resolved)this.anchors.push(resolved);}
    const locations=new Map<string,string[]>();for(const anchor of this.anchors){const key=anchor.path+':'+anchor.line;locations.set(key,[...(locations.get(key)??[]),anchor.node]);}
    for(const nodes of locations.values())if(new Set(nodes).size>1)this.diagnostic('Shared execution location: '+nodes.join(', ')+'. Add distinct invocation anchors to disambiguate module instances.');
    vscode.debug.removeBreakpoints(this.breakpoints);this.breakpoints=[];
    for(const anchor of this.anchors) {
      const location=new vscode.Location(vscode.Uri.file(anchor.path),new vscode.Position(anchor.line-1,0));
      const existing=[...vscode.debug.breakpoints,...this.breakpoints].some(bp=>bp instanceof vscode.SourceBreakpoint&&bp.enabled&&this.sameSource(bp.location.uri.fsPath,location.uri.fsPath)&&bp.location.range.start.line===location.range.start.line);
      if(!existing)this.breakpoints.push(new vscode.SourceBreakpoint(location));
    }
    await this.openCode(doc,true);this.originalTabs=new Set(vscode.window.tabGroups.all.flatMap(group=>group.tabs));
    vscode.debug.addBreakpoints(this.breakpoints);this.rootSession=undefined;this.ownedSessions.clear();this.state.trace=[];this.state.detectedLoop=[];this.state.navigationResult=undefined;this.state.status='starting';this.publish();
    const config:vscode.DebugConfiguration={type:this.plan.entry.language==='python'?'debugpy':'pwa-node',request:'launch',name:'Neurologist: '+architecture.title,program:this.entry.fsPath,cwd:folder.uri.fsPath,args:this.plan.entry.args,stopOnEntry:true,neurologistOwner:this.owner,console:this.plan.entry.language==='python'?'integratedTerminal':'internalConsole',...(this.plan.entry.language==='python'?{justMyCode:false,subProcess:false}:{})};
    try {if(!await vscode.debug.startDebugging(folder,config,{suppressSaveBeforeStart:true}))throw new Error('Debugger did not start. Check the selected interpreter/runtime and debugger extension.');}
    catch(error){this.state.status='prepared';vscode.debug.removeBreakpoints(this.breakpoints);this.breakpoints=[];this.publish();throw error;}
  }
  private async conversation(message:string) {
    if(!this.plan||!this.state.scenarioId)throw new Error('Prepare or load a scenario before adding a visualization.');
    const runtime=this.runtime,session=this.session,architecture=parseArchitecture(this.document.getText()),tools:unknown[]=[];
    this.state.messages.push({role:'user',content:message});
    for(let i=0;i<8;i++) {
      const response=await debugConversation({...this.options(this.abort!.signal),architecture,message,history:this.state.messages.slice(-20),context:{instructions:this.state.instructions,entry:this.state.entry,status:this.state.status,reason:this.state.reason,activeNodes:this.state.activeNodes,stack:this.state.stack,frameId:this.state.frameId,watches:this.state.watches,visualizations:await this.visualizationContext(),scenarioId:this.state.scenarioId,language:this.plan.entry?.language,observedPath:this.state.trace.slice(-64),detectedLoop:this.state.detectedLoop,navigationSettings:this.state.navigationSettings,lastNavigation:this.state.navigationResult,mappedNodes:[...new Set(this.anchors.map(a=>a.node))]},tools});
      this.abort!.signal.throwIfAborted();if(session?.id!==this.session?.id)throw new Error('The debug session ended or changed.');
      this.state.messages.push({role:'assistant',content:response.reply});this.publish();if(!response.action)return;
      let result:unknown;try {this.checkAction(response.action,architecture);if(response.action.command==='visualize')result=await this.installVisualization(response.action.expression);else if(response.action.command==='removeVisualization'){this.state.visualizations=this.state.visualizations?.filter(v=>v.id!==response.action!.expression);this.pruneCaptureAnchors();await this.updateSavedScenario();result={removed:response.action.expression};}else{if(!runtime)throw new Error('Run the scenario before using live debugger actions.');result=await runtime.action(response.action,this.abort!.signal);}}catch(error){result={error:error instanceof Error?error.message:String(error)};}
      this.abort!.signal.throwIfAborted();const tool={action:response.action,result:JSON.stringify(result).slice(0,18000)};tools.push(tool);this.state.messages.push({role:'tool',content:JSON.stringify(tool)});this.publish();
      if(['leap','escapeLoop','runTo','runUntil'].includes(response.action.command)&&result&&typeof result==='object'&&'reason'in result&&['user-stop','cancelled','timeout','limit','error'].includes(String(result.reason))){this.state.messages.push({role:'assistant',content:String((result as {message?:string}).message??'Navigation paused.')});this.publish();return;}
      if(this.state.status==='terminated'){this.state.messages.push({role:'assistant',content:'The debug session ended. The last debugger result is shown above; Run debug starts the scenario again.'});this.publish();return;}
    }
    this.state.messages.push({role:'assistant',content:'Reached the eight-action limit for this request. Ask a follow-up to continue.'});this.publish();
  }
  private pruneCaptureAnchors(){
    const key=(a:ExecutionAnchor)=>JSON.stringify([a.node,a.file,a.symbol,a.kind,a.statement??'']);
    const desired=new Set([...(parseArchitecture(this.document.getText()).execution??[]),...(this.state.visualizations??[]).flatMap(v=>v.anchor?[v.anchor]:[])].map(key));
    const kept=this.anchors.filter(a=>desired.has(key(a)));this.anchors.splice(0,this.anchors.length,...kept);
    const obsolete=this.breakpoints.filter(bp=>!this.anchors.some(a=>this.sameSource(bp.location.uri.fsPath,a.path)&&bp.location.range.start.line===a.line-1));
    vscode.debug.removeBreakpoints(obsolete);this.breakpoints=this.breakpoints.filter(bp=>!obsolete.includes(bp));
  }
  private async visualizationContext(){return Promise.all((this.state.visualizations??[]).map(async v=>{let code='';try{const uri=await this.within(v.file);code=(await vscode.workspace.openTextDocument(uri)).getText().slice(0,100000);}catch{}return {...v,image:undefined,code};}));}
  private async renderVisualization(session:vscode.DebugSession,visual:DebugVisualization,frameId:number,hit:number){
    const frame=this.state.stack.find(f=>f.id===frameId);if(visual.anchor){const bound=this.anchors.find(a=>a.node===visual.node&&a.file===visual.anchor!.file&&a.symbol===visual.anchor!.symbol&&a.statement===visual.anchor!.statement);if(!bound||!frame?.source?.path||!this.sameSource(bound.path,frame.source.path)||bound.line!==frame.line)return;}
    const evaluate=async(expression:string)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([Promise.resolve(session.customRequest('evaluate',{expression,frameId,context:'repl'})),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Visualization evaluation timed out. Stop the debugger if the sidecar is still executing.')),10000);})]);}finally{clearTimeout(timer);}};
    if(visual.condition.trim()){const result=await evaluate(visual.language==='python'?`bool(${visual.condition})`:`Boolean(${visual.condition})`);if(['False','false'].includes(result.result))return;if(!['True','true'].includes(result.result))throw new Error('Visualization condition did not return a boolean.');}
    const file=await this.within(visual.file),source=await vscode.workspace.openTextDocument(file);if(source.isDirty)throw new Error('Save the sidecar before refreshing this visualization.');
    const output=vscode.Uri.joinPath(this.folder().uri,'.neurologist','debug',`image-${this.owner}-${randomUUID()}.png`);
    try{await evaluate(visualizationExpression(visual,file.fsPath,output.fsPath,hit,this.state.scenarioId!));await this.within(vscode.workspace.asRelativePath(output,false));const stat=await vscode.workspace.fs.stat(output);if(stat.size>MAX_IMAGE_BYTES)throw new Error('Visualization exceeds the 4 MB image limit.');return pngDataUri(await vscode.workspace.fs.readFile(output));}
    finally{try{await vscode.workspace.fs.delete(output);}catch{}}
  }
  private async installVisualization(expression:string){
    const spec=visualizationSpecSchema.parse(JSON.parse(expression));if(!this.state.scenarioId||!this.plan?.entry)throw new Error('Prepare a scenario first.');
    if(spec.language!==this.plan.entry.language)throw new Error('Sidecar language must match the scenario.');
    const architecture=parseArchitecture(this.document.getText());if(!architecture.nodes.some(n=>n.id===spec.node))throw new Error('Visualization references an unknown graph node.');if(spec.anchor&&spec.anchor.node!==spec.node)throw new Error('Capture anchor must belong to the visualization node.');
    const previous=this.state.visualizations?.find(v=>v.id===spec.id);if(!previous&&(this.state.visualizations?.length??0)>=20)throw new Error('At most 20 visualizations per scenario.');
    const resolved=spec.anchor&&this.session?await this.resolve(spec.anchor):undefined;if(spec.anchor&&this.session&&!resolved)throw new Error('Could not resolve the visualization capture anchor.');
    const folder=this.folder(),file=previous?.file??`.neurologist/debug/visual-${this.state.scenarioId}-${spec.id}-${randomUUID()}.${spec.language==='python'?'py':'cjs'}`,uri=vscode.Uri.joinPath(folder.uri,file);
    // The scenario directory and any preexisting target must resolve within the workspace.
    await this.within('.neurologist/debug');try{await this.within(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const open=vscode.workspace.textDocuments.find(d=>this.sameSource(d.uri.fsPath,uri.fsPath));if(open?.isDirty)throw new Error('Save your sidecar edits before asking to revise it.');
    const edit=new vscode.WorkspaceEdit();if(previous){const doc=await vscode.workspace.openTextDocument(uri);edit.replace(uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),spec.code);}else{edit.createFile(uri,{overwrite:false});edit.insert(uri,new vscode.Position(0,0),spec.code);}if(!await vscode.workspace.applyEdit(edit))throw new Error('Could not write the visualization sidecar.');await(await vscode.workspace.openTextDocument(uri)).save();
    const bridgeName=spec.language==='python'?'neurologist_visualization_bridge.py':'neurologist_visualization_bridge.cjs',bridge=vscode.Uri.joinPath(folder.uri,'.neurologist/debug',bridgeName);try{await this.within('.neurologist/debug/'+bridgeName);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await vscode.workspace.fs.writeFile(bridge,Buffer.from(spec.language==='python'?PYTHON_VISUALIZATION_BRIDGE:JAVASCRIPT_VISUALIZATION_BRIDGE));
    const {code,...definition}=spec;const visual:DebugVisualization={...definition,file,stale:true};this.state.visualizations=[...(this.state.visualizations??[]).filter(v=>v.id!==spec.id),visual];if(resolved){this.anchors.push(resolved);const location=new vscode.Location(vscode.Uri.file(resolved.path),new vscode.Position(resolved.line-1,0));if(!vscode.debug.breakpoints.some(bp=>bp instanceof vscode.SourceBreakpoint&&bp.enabled&&this.sameSource(bp.location.uri.fsPath,resolved.path)&&bp.location.range.start.line===resolved.line-1)){const bp=new vscode.SourceBreakpoint(location);this.breakpoints.push(bp);vscode.debug.addBreakpoints([bp]);}}this.pruneCaptureAnchors();await this.updateSavedScenario();await this.openCode(await vscode.workspace.openTextDocument(uri),true);this.publish();await this.runtime?.refreshVisualizations(undefined,spec.id);
    return {id:spec.id,title:spec.title,file,imageReady:!!visual.image,error:visual.error??null,status:visual.image?'captured':'Waiting for a matching stopped frame and available context'};
  }
  private checkAction(action:DebugAction,architecture:Architecture) {
    if(action.command==='runTo'||action.command==='runUntil'){
      if(action.command==='runTo'&&!action.node)throw new Error('Run to needs a target graph node ID.');
      if(action.node&&(!architecture.nodes.some(n=>n.id===action.node)||!this.anchors.some(a=>a.node===action.node)))throw new Error('The target node has no resolved execution anchor. Choose a mapped node or a Run until predicate instead.');
      if(action.command==='runUntil'&&!action.expression.trim())throw new Error('Run until needs a boolean debugger expression.');
    }if(action.command==='watch'&&(!action.expression.trim()||!architecture.nodes.some(n=>n.id===action.node)))throw new Error('A watch needs an expression and a valid graph node ID.');}
  async handle(message:any) {
    if(!String(message.type).startsWith('debug'))return;
    try {
      if(message.type==='debugNavigationSettings'){if(this.state.busy)throw new Error('Change navigation limits after the current action finishes.');this.state.navigationSettings=navigationSettingsSchema.parse(message.settings);this.state.detectedLoop=detectLoop(this.state.trace,this.state.navigationSettings.maxLoopLength);await this.storage?.update('debugNavigation:'+this.document.uri.toString(),this.state.navigationSettings);await this.updateSavedScenario();this.publish();return;}
      if(message.type==='debugInstructions'){if(!this.state.busy)await this.setInstructions(message.instructions);return;}
      if(message.type==='debugReady'){await this.refreshScenarios();this.publish();return;}
      if(message.type==='debugLoadScenario'){await this.loadScenario(String(message.id));return;}
      if(message.type==='debugRenameScenario'){await this.renameScenario();return;}
      if(message.type==='debugCancel'||message.type==='debugCancelNavigation'){this.abort?.abort();this.runtime?.cancelNavigation();return;}
      if(message.type==='debugStop'){this.abort?.abort();if(this.session)await vscode.debug.stopDebugging(this.rootSession??this.session);return;}
      if(this.state.busy)throw new Error('Wait for the current debugger operation, or cancel it.');
      this.folder();if(message.navigationSettings!==undefined)this.state.navigationSettings=navigationSettingsSchema.parse(message.navigationSettings);if(message.type==='debugPrepare'&&message.instructions!==undefined)await this.setInstructions(message.instructions);this.state.busy=true;this.abort=new AbortController();this.publish();
      if(['debugPrepare','debugChat'].includes(message.type)){void this.panel.webview.postMessage({type:'activityReset',title:message.type==='debugPrepare'?'Preparing a live exploration':'Following the live computation'});this.activity=new ActivityReporter(activity=>{void this.panel.webview.postMessage({type:'activity',activity});});}
      try {
        if(message.type==='debugPrepare'){if(typeof message.message!=='string'||!message.message.trim()||message.message.length>12000)throw new Error('Describe the scenario in 1–12,000 characters.');this.state.messages.push({role:'user',content:message.message});await this.generate(message.message);}
        if(message.type==='debugRun')await this.launch();
        if(message.type==='debugChat'){if(typeof message.message!=='string'||!message.message.trim()||message.message.length>12000)throw new Error('Send a question in 1–12,000 characters.');await this.conversation(message.message);}
        if(message.type==='debugCommand'){if(!this.runtime)throw new Error('No active debugger.');const action={command:message.command,expression:'',node:'',frame:0,reference:0};const {debugActionSchema}=await import('./debugModel');const parsed=debugActionSchema.parse(action);this.checkAction(parsed,parseArchitecture(this.document.getText()));await this.runtime.action(parsed,this.abort!.signal);}
        if(message.type==='debugFrame'){if(!this.runtime)throw new Error('No active debugger.');await this.runtime.selectFrame(Number(message.frame));}
        if(message.type==='debugWatch'){const watch=watchSchema.parse(message.watch),architecture=parseArchitecture(this.document.getText());if(!architecture.nodes.some(n=>n.id===watch.node))throw new Error('Unknown watch node.');if(this.runtime)await this.runtime.addWatch(watch);else {this.state.watches.push({...watch,stale:true});}}
        if(message.type==='debugUnwatch'){if(this.runtime)this.runtime.removeWatch(String(message.id));else this.state.watches=this.state.watches.filter(w=>w.id!==message.id);}
        if(message.type==='debugVisualizationRemove'){this.state.visualizations=this.state.visualizations?.filter(v=>v.id!==message.id);this.pruneCaptureAnchors();await this.updateSavedScenario();}
        if(message.type==='debugVisualizationRefresh'){if(!this.runtime)throw new Error('Run and pause the scenario before refreshing.');await this.runtime.refreshVisualizations(undefined,String(message.id));}
        if(message.type==='debugVisualizationSource'){const visual=this.state.visualizations?.find(v=>v.id===message.id);if(visual)await this.openCode(await vscode.workspace.openTextDocument(await this.within(visual.file)));}
        if(message.type==='debugEntry'&&this.entry)await this.openCode(await vscode.workspace.openTextDocument(this.entry));
        if(['debugWatch','debugUnwatch','debugChat','debugRun'].includes(message.type))await this.updateSavedScenario();
        this.activity?.finish('complete');
      }catch(error){const cancelled=this.abort?.signal.aborted;this.activity?.finish(cancelled?'cancelled':'error');if(message.type==='debugPrepare'){const detail=error instanceof Error?error.message:String(error);this.state.messages.push({role:'assistant',content:cancelled?'Preparation was cancelled. You can add details and try again.':`Preparation failed: ${detail}\n\nYou can provide more information or ask me to try another approach.`});}throw error;}finally {this.activity=undefined;this.state.busy=false;this.abort=undefined;this.state.messages=this.state.messages.slice(-60);this.publish();}
    }catch(error){this.diagnostic(error instanceof Error?error.message:String(error));void this.panel.webview.postMessage({type:'operationError',message:error instanceof Error?error.message:String(error)});}
  }
  dispose(){this.disposed=true;clearTimeout(this.routeTimer);this.abort?.abort();if(this.session)void vscode.debug.stopDebugging(this.rootSession??this.session);vscode.debug.removeBreakpoints(this.breakpoints);for(const s of this.subscriptions)s.dispose();}
}
