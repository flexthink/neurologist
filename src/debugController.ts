import * as vscode from 'vscode';
import {realpath} from 'node:fs/promises';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {stringify} from 'yaml';
import {parseArchitecture,validateArchitecture,safeRelativePath,type Architecture} from './model';
import {prepareDebug,debugConversation} from './codex';
import {DebugRuntime,samePath} from './debugRuntime';
import {emptyDebugState,resolvePythonAnchor,watchSchema,type ExecutionAnchor,type ResolvedAnchor,type DebugAction,type DebugPlan} from './debugModel';
import type {ModelSettings} from './modelSettings';
import {showInCodeGroup} from './navigation';
import {ActivityReporter} from './progress';

class UnsavedDebugSource extends Error {}

/** One editor owns one debug session. Other sessions and user breakpoints are untouched. */
export class DebugController implements vscode.Disposable {
  private readonly owner=randomUUID();private state=emptyDebugState();private plan?:DebugPlan;
  private entry?:vscode.Uri;private session?:vscode.DebugSession;private rootSession?:vscode.DebugSession;private ownedSessions=new Set<string>();private runtime?:DebugRuntime;
  private anchors:ResolvedAnchor[]=[];private breakpoints:vscode.SourceBreakpoint[]=[];
  private abort?:AbortController;private disposed=false;private subscriptions:vscode.Disposable[]=[];
  constructor(private document:vscode.TextDocument,private panel:vscode.WebviewPanel,private models:ModelSettings,private output:vscode.OutputChannel) {
    this.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('*',{createDebugAdapterTracker:session=>{
      if(session.configuration.neurologistOwner!==this.owner&&!this.ownedSessions.has(session.parentSession?.id??''))return;
      this.ownedSessions.add(session.id);if(!this.rootSession)this.rootSession=session;
      this.session=session;this.runtime=new DebugRuntime(session,this.state,this.anchors,()=>this.publish());
      const requests=new Map<number,{path:string;lines:number[]}>(),bound=new Map<number,ResolvedAnchor[]>(),pending=new Map<number,string>();
      return {
        onWillReceiveMessage:message=>{if(message.type==='request'&&message.command==='setBreakpoints')requests.set(message.seq,{path:message.arguments.source?.path,lines:(message.arguments.breakpoints??[]).map((b:any)=>b.line)});},
        onDidSendMessage:message=>{
          if(this.session?.id!==session.id)return;
          if(message.type==='event'&&message.event==='breakpoint'){
            const bp=message.body?.breakpoint,matched=bound.get(bp?.id)??[];
            if(bp?.verified){if(typeof bp.line==='number')for(const a of matched){a.line=bp.line;a.endLine=Math.max(a.endLine,bp.line);}const prior=pending.get(bp.id);if(prior){this.state.diagnostics=this.state.diagnostics.filter(d=>d!==prior);pending.delete(bp.id);this.publish();}}
          }
          if(message.type==='event'&&message.event==='stopped')void this.runtime?.stopped(message.body?.threadId,message.body?.reason);
          if(message.type==='event'&&message.event==='continued')this.runtime?.continued();
          if(message.type==='event'&&message.event==='terminated')this.ended();
          if(message.type==='response'&&message.command==='setBreakpoints') {
            const request=requests.get(message.request_seq);requests.delete(message.request_seq);
            if(request)for(const [index,bp]of (message.body?.breakpoints??[]).entries()) {
              const matched=this.anchors.filter(a=>samePath(a.path,request.path)&&a.line===request.lines[index]);
              if(typeof bp.id==='number')bound.set(bp.id,matched);
              if(bp.verified&&typeof bp.line==='number')for(const a of matched){a.line=bp.line;a.endLine=Math.max(a.endLine,bp.line);}
              else if(matched.length){const diagnostic='Unverified breakpoint: '+matched.map(a=>a.file+' → '+a.symbol).join(', ')+(bp.message?' — '+bp.message:'');if(typeof bp.id==='number')pending.set(bp.id,diagnostic);this.diagnostic(diagnostic);}
            }
          }
          if(message.type==='response'&&['launch','attach'].includes(message.command)&&!message.success){this.diagnostic(message.message??'Debugger launch failed');this.ended();}
        },onError:error=>this.diagnostic(error.message),onExit:()=>{if(this.session?.id===session.id)this.ended();}
      };
    }}),vscode.debug.onDidTerminateDebugSession(session=>{if(session.id===this.session?.id)this.ended();}),vscode.debug.onDidChangeActiveStackItem(item=>{
      if(item instanceof vscode.DebugStackFrame&&item.session.id===this.session?.id&&this.state.status==='stopped'&&this.state.frameId!==item.frameId&&this.state.stack.some(f=>f.id===item.frameId))void this.runtime?.selectFrame(item.frameId).catch(error=>this.diagnostic(String(error)));
    }));
  }
  private folder(){const f=vscode.workspace.getWorkspaceFolder(this.document.uri);if(!f||f.uri.scheme!=='file')throw new Error('Debugging requires a local workspace.');if(!vscode.workspace.isTrusted)throw new Error('Trust this workspace before running code with the debugger.');return f;}
  private publish(){if(!this.disposed)void this.panel.webview.postMessage({type:'debugState',state:this.state});}
  private diagnostic(message:string){if(this.disposed)return;this.state.diagnostics=[...this.state.diagnostics,message].slice(-100);this.output.appendLine('Debug: '+message);this.publish();}
  private ended(){if(this.state.status==='terminated')return;this.runtime?.terminated();this.session=undefined;vscode.debug.removeBreakpoints(this.breakpoints);this.breakpoints=[];this.publish();}
  private async within(relative:string){if(!safeRelativePath(relative))throw new Error('Debug source must be workspace-relative.');const f=this.folder(),uri=vscode.Uri.joinPath(f.uri,relative),root=await realpath(f.uri.fsPath),actual=await realpath(uri.fsPath);if(actual!==root&&!actual.startsWith(root+path.sep))throw new Error('Debug source resolves outside the workspace.');return vscode.Uri.file(actual);}
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
  private options(signal:AbortSignal){const folder=this.folder(),config=vscode.workspace.getConfiguration('neurologist',folder.uri);return {cwd:folder.uri.fsPath,executable:config.get<string>('codexPath','codex'),...this.models.selection(folder),signal,log:(chunk:string)=>this.output.append(chunk),activity:new ActivityReporter(activity=>{void this.panel.webview.postMessage({type:'activity',activity});})};}
  private async generate(scenario:string) {
    if(this.session||this.state.status==='starting')throw new Error('Stop the current debug session before preparing another scenario.');
    const architecture=parseArchitecture(this.document.getText()),version=this.document.version;
    const response=await prepareDebug({...this.options(this.abort!.signal),architecture,scenario});
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
    this.state.messages.push({role:'assistant',content:response.reply+'\n\nEntry script is open for review. Choose Run debug to execute it. Execution anchors are an undoable YAML edit; save the diagram when ready.'});
    await showInCodeGroup(await vscode.workspace.openTextDocument(entry),this.panel.viewColumn);this.publish();
  }
  private async launch() {
    const folder=this.folder();if(!this.plan||!this.entry)throw new Error('Prepare a scenario first.');if(this.session||this.state.status==='starting')throw new Error('A debug session is already active.');
    const doc=await vscode.workspace.openTextDocument(this.entry);if(!await doc.save())throw new Error('Save the entry script before launching.');
    if(this.plan.entry.language==='python'&&!vscode.extensions.getExtension('ms-python.debugpy'))throw new Error('Install the Python Debugger extension (ms-python.debugpy), select your Python interpreter, then Run debug.');
    const architecture=parseArchitecture(this.document.getText());this.anchors.length=0;this.state.diagnostics=[];
    for(const anchor of architecture.execution??[]){const resolved=await this.resolve(anchor);if(resolved)this.anchors.push(resolved);}
    const locations=new Map<string,string[]>();for(const anchor of this.anchors){const key=anchor.path+':'+anchor.line;locations.set(key,[...(locations.get(key)??[]),anchor.node]);}
    for(const nodes of locations.values())if(new Set(nodes).size>1)this.diagnostic('Shared execution location: '+nodes.join(', ')+'. Add distinct invocation anchors to disambiguate module instances.');
    vscode.debug.removeBreakpoints(this.breakpoints);this.breakpoints=[];
    for(const anchor of this.anchors) {
      const location=new vscode.Location(vscode.Uri.file(anchor.path),new vscode.Position(anchor.line-1,0));
      const existing=[...vscode.debug.breakpoints,...this.breakpoints].some(bp=>bp instanceof vscode.SourceBreakpoint&&bp.enabled&&bp.location.uri.toString()===location.uri.toString()&&bp.location.range.start.line===location.range.start.line);
      if(!existing)this.breakpoints.push(new vscode.SourceBreakpoint(location));
    }
    vscode.debug.addBreakpoints(this.breakpoints);this.rootSession=undefined;this.ownedSessions.clear();this.state.status='starting';this.publish();
    const config:vscode.DebugConfiguration={type:this.plan.entry.language==='python'?'debugpy':'pwa-node',request:'launch',name:'Neurologist: '+architecture.title,program:this.entry.fsPath,cwd:folder.uri.fsPath,args:this.plan.entry.args,stopOnEntry:true,neurologistOwner:this.owner,console:this.plan.entry.language==='python'?'integratedTerminal':'internalConsole',...(this.plan.entry.language==='python'?{justMyCode:false,subProcess:false}:{})};
    try {if(!await vscode.debug.startDebugging(folder,config,{suppressSaveBeforeStart:true}))throw new Error('Debugger did not start. Check the selected interpreter/runtime and debugger extension.');}
    catch(error){this.state.status='prepared';vscode.debug.removeBreakpoints(this.breakpoints);this.breakpoints=[];this.publish();throw error;}
  }
  private async conversation(message:string) {
    if(!this.runtime||!this.session)throw new Error('Run a scenario before chatting with the live debugger.');
    const runtime=this.runtime,session=this.session,architecture=parseArchitecture(this.document.getText()),tools:unknown[]=[];
    this.state.messages.push({role:'user',content:message});
    for(let i=0;i<8;i++) {
      const response=await debugConversation({...this.options(this.abort!.signal),architecture,message,history:this.state.messages.slice(-20),context:{status:this.state.status,reason:this.state.reason,activeNodes:this.state.activeNodes,stack:this.state.stack,frameId:this.state.frameId,watches:this.state.watches},tools});
      this.abort!.signal.throwIfAborted();if(session.id!==this.session?.id)throw new Error('The debug session ended or changed.');
      this.state.messages.push({role:'assistant',content:response.reply});this.publish();if(!response.action)return;
      let result:unknown;try {this.checkAction(response.action,architecture);result=await runtime.action(response.action);}catch(error){result={error:error instanceof Error?error.message:String(error)};}
      this.abort!.signal.throwIfAborted();const tool={action:response.action,result:JSON.stringify(result).slice(0,18000)};tools.push(tool);this.state.messages.push({role:'tool',content:JSON.stringify(tool)});this.publish();
      if(this.state.status==='terminated'){this.state.messages.push({role:'assistant',content:'The debug session ended. The last debugger result is shown above; Run debug starts the scenario again.'});this.publish();return;}
    }
    this.state.messages.push({role:'assistant',content:'Reached the eight-action limit for this request. Ask a follow-up to continue.'});this.publish();
  }
  private checkAction(action:DebugAction,architecture:Architecture) {if(action.command==='watch'&&(!action.expression.trim()||!architecture.nodes.some(n=>n.id===action.node)))throw new Error('A watch needs an expression and a valid graph node ID.');}
  async handle(message:any) {
    if(!String(message.type).startsWith('debug'))return;
    try {
      if(message.type==='debugReady'){this.publish();return;}
      if(message.type==='debugCancel'){this.abort?.abort();return;}
      if(message.type==='debugStop'){this.abort?.abort();if(this.session)await vscode.debug.stopDebugging(this.rootSession??this.session);return;}
      if(this.state.busy)throw new Error('Wait for the current debugger operation, or cancel it.');
      this.folder();this.state.busy=true;this.abort=new AbortController();this.publish();
      if(['debugPrepare','debugChat'].includes(message.type))void this.panel.webview.postMessage({type:'activityReset',title:message.type==='debugPrepare'?'Preparing a live exploration':'Following the live computation'});
      try {
        if(message.type==='debugPrepare'){if(typeof message.message!=='string'||!message.message.trim()||message.message.length>12000)throw new Error('Describe the scenario in 1–12,000 characters.');this.state.messages.push({role:'user',content:message.message});await this.generate(message.message);}
        if(message.type==='debugRun')await this.launch();
        if(message.type==='debugChat'){if(typeof message.message!=='string'||!message.message.trim()||message.message.length>12000)throw new Error('Send a question in 1–12,000 characters.');await this.conversation(message.message);}
        if(message.type==='debugCommand'){if(!this.runtime)throw new Error('No active debugger.');const action={command:message.command,expression:'',node:'',frame:0,reference:0};const {debugActionSchema}=await import('./debugModel');await this.runtime.action(debugActionSchema.parse(action));}
        if(message.type==='debugFrame'){if(!this.runtime)throw new Error('No active debugger.');await this.runtime.selectFrame(Number(message.frame));}
        if(message.type==='debugWatch'){const watch=watchSchema.parse(message.watch),architecture=parseArchitecture(this.document.getText());if(!architecture.nodes.some(n=>n.id===watch.node))throw new Error('Unknown watch node.');if(this.runtime)await this.runtime.addWatch(watch);else {this.state.watches.push({...watch,stale:true});}}
        if(message.type==='debugUnwatch'){if(this.runtime)this.runtime.removeWatch(String(message.id));else this.state.watches=this.state.watches.filter(w=>w.id!==message.id);}
        if(message.type==='debugEntry'&&this.entry)await showInCodeGroup(await vscode.workspace.openTextDocument(this.entry),this.panel.viewColumn);
      }finally {this.state.busy=false;this.abort=undefined;this.state.messages=this.state.messages.slice(-60);this.publish();}
    }catch(error){this.diagnostic(error instanceof Error?error.message:String(error));void this.panel.webview.postMessage({type:'operationError',message:error instanceof Error?error.message:String(error)});}
  }
  dispose(){this.disposed=true;this.abort?.abort();if(this.session)void vscode.debug.stopDebugging(this.rootSession??this.session);vscode.debug.removeBreakpoints(this.breakpoints);for(const s of this.subscriptions)s.dispose();}
}
