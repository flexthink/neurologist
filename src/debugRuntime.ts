import {detectLoop,navigateGraph,type GraphStop,type NavigationKind} from './debugNavigation';
import type {DebugAction,DebugFrame,DebugViewState,DebugWatch,ResolvedAnchor} from './debugModel';
export interface DebugPort {customRequest(command:string,args?:unknown):Thenable<any>|Promise<any>;}
const clipped=(value:unknown)=>String(value??'').slice(0,6000);
/** DAP operations for one owned debug session, independent of VS Code/editor state. */
export class DebugRuntime {
  private stopSequence=0;private graphStop?:GraphStop;private stopListeners=new Set<(stop:GraphStop)=>void>();private navigationAbort?:AbortController;
  private watchId=0;
  private epoch=0;private thread?:number;private waiters=new Set<()=>void>();
  constructor(private port:DebugPort,readonly state:DebugViewState,private anchors:ResolvedAnchor[],private changed:()=>void,private language:'python'|'javascript'='python') {}
  private emit(){this.changed();}
  continued() {this.epoch++;this.state.status='running';this.state.activeNodes=[];this.state.stack=[];this.state.frameId=undefined;for(const w of this.state.watches)w.stale=true;this.emit();}
  terminated(){this.epoch++;this.state.status='terminated';this.state.activeNodes=[];this.state.stack=[];this.state.frameId=undefined;for(const w of this.state.watches)w.stale=true;this.graphStop={sequence:++this.stopSequence,nodes:[],reason:'terminated',skippable:false};for(const listener of this.stopListeners)listener(this.graphStop);for(const wake of this.waiters)wake();this.emit();}
  async stopped(threadId?:number,reason='breakpoint',canSkip:(frame?:DebugFrame)=>boolean=()=>false) {
    const epoch=++this.epoch;this.state.status='stopped';this.state.reason=reason;this.state.activeNodes=[];this.state.stack=[];this.state.frameId=undefined;this.emit();
    try {
      if (threadId===undefined) threadId=(await this.port.customRequest('threads'))?.threads?.[0]?.id;
      if (threadId===undefined) throw new Error('Debugger did not report a stopped thread.');
      const response=await this.port.customRequest('stackTrace',{threadId,startFrame:0,levels:25});if(epoch!==this.epoch)return;
      this.thread=threadId;this.state.stack=(response.stackFrames??[]).map((f:any)=>({id:f.id,name:clipped(f.name),line:f.line,source:f.source}));
      this.state.frameId=this.state.stack[0]?.id;
      const frame=this.state.stack[0];
      this.state.activeNodes=this.nodesForFrame(frame);
      this.recordStop(reason,canSkip(frame));this.emit();
      await this.refreshWatches(epoch);
    } catch(error) {if(epoch===this.epoch){this.recordStop(reason,false);this.state.diagnostics.push(clipped(error instanceof Error?error.message:error));}}
    if(epoch===this.epoch){this.emit();for(const wake of this.waiters)wake();}
  }
  private recordStop(reason:string,skippable:boolean){
    this.graphStop={sequence:++this.stopSequence,nodes:[...this.state.activeNodes].sort(),reason,skippable};
    if(this.graphStop.nodes.length&&(skippable||JSON.stringify(this.state.trace.at(-1))!==JSON.stringify(this.graphStop.nodes))){this.state.trace=[...this.state.trace,this.graphStop.nodes].slice(-256);this.state.detectedLoop=detectLoop(this.state.trace,this.state.navigationSettings.maxLoopLength);}
    for(const listener of this.stopListeners)listener(this.graphStop);
  }
  private nextGraphStop(after:number,signal:AbortSignal):Promise<GraphStop>{
    if(this.graphStop&&this.graphStop.sequence>after)return Promise.resolve(this.graphStop);
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{this.stopListeners.delete(listener);signal.removeEventListener('abort',abort);};
      const listener=(stop:GraphStop)=>{if(stop.sequence>after){cleanup();resolve(stop);}};
      const abort=()=>{cleanup();reject(new Error('Navigation interrupted'));};
      if(signal.aborted){abort();return;}this.stopListeners.add(listener);signal.addEventListener('abort',abort,{once:true});
    });
  }
  cancelNavigation(){this.navigationAbort?.abort();}
  private async navigate(action:DebugAction,signal:AbortSignal){
    if(this.navigationAbort)throw new Error('Graph navigation is already running.');
    const controller=new AbortController();this.navigationAbort=controller;
    const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    try{
      const result=await navigateGraph({
        status:()=>this.state.status,lastStop:()=>this.graphStop,nextStop:(sequence,token)=>this.nextGraphStop(sequence,token),
        resume:async()=>{this.continued();try{return await this.port.customRequest('continue',{threadId:this.thread});}catch(error){await this.stopped(this.thread,'continue failed');throw error;}},
        pause:()=>Promise.resolve(this.port.customRequest('pause',{threadId:this.thread})),
        predicate:async(expression)=>{
          if(this.state.status!=='stopped'||this.state.frameId===undefined)throw new Error('The target is not paused.');
          const wrapped=this.language==='python'?`bool(${expression})`:`Boolean(${expression})`;
          const response=await this.port.customRequest('evaluate',{expression:wrapped,frameId:this.state.frameId,context:'watch'});
          if(['True','true'].includes(response.result))return true;if(['False','false'].includes(response.result))return false;
          throw new Error('The debugger did not return a boolean predicate result.');
        }
      },{kind:action.command as NavigationKind,target:action.node,expression:action.expression,cycle:[...this.state.detectedLoop],settings:{...this.state.navigationSettings},signal:controller.signal,progress:value=>{this.state.navigation=value;this.emit();}});
      this.state.navigationResult=result;return result;
    }finally{signal.removeEventListener('abort',abort);this.navigationAbort=undefined;this.state.navigation=undefined;this.emit();}
  }
  async selectFrame(id:number) {if(!this.state.stack.some(f=>f.id===id))throw new Error('Unknown stack frame.');this.state.frameId=id;this.state.activeNodes=this.nodesForFrame(this.state.stack.find(f=>f.id===id));await this.refreshWatches(++this.epoch);this.emit();}
  async addWatch(watch:DebugWatch) {const existing=this.state.watches.find(w=>w.id===watch.id);if(existing)Object.assign(existing,watch);else {if(this.state.watches.length>=100)throw new Error('At most 100 graph watches are supported.');this.state.watches.push({...watch,stale:true});}if(this.state.status==='stopped')await this.refreshWatches(this.epoch);this.emit();}
  removeWatch(id:string){this.state.watches=this.state.watches.filter(w=>w.id!==id);this.emit();}
  private nodesForFrame(frame?:DebugFrame):string[] {
    if(!frame?.source?.path)return [];
    const fileAnchors=this.anchors.filter(a=>samePath(a.path,frame.source!.path!));
    const exact=fileAnchors.filter(a=>a.line===frame.line);
    const matched=exact.length?exact:fileAnchors.filter(a=>a.kind==='forward'&&frame.line>=a.line&&frame.line<=a.endLine);
    return [...new Set(matched.map(a=>a.node))];
  }
  private async refreshWatches(epoch:number) {
    if(this.state.frameId===undefined)return;
    for(const watch of this.state.watches) {
      if(!this.state.activeNodes.includes(watch.node)){watch.stale=true;continue;}
      try {const result=await this.port.customRequest('evaluate',{expression:watch.expression,frameId:this.state.frameId,context:'watch'});if(epoch!==this.epoch)return;watch.value=clipped(result.result);watch.error=undefined;watch.stale=false;}
      catch(error){if(epoch!==this.epoch)return;watch.error=clipped(error instanceof Error?error.message:error);watch.stale=false;}
    }
  }
  async action(action:DebugAction,signal:AbortSignal=new AbortController().signal):Promise<unknown> {
    if(['leap','escapeLoop','runTo','runUntil'].includes(action.command))return this.navigate(action,signal);
    if(action.command==='watch'){await this.addWatch({id:'chat-watch-'+(++this.watchId),node:action.node,expression:action.expression});return this.state.watches;}
    if(action.command==='unwatch'){this.removeWatch(action.expression);return this.state.watches;}
    if(action.command==='pause') {if(this.state.status!=='running')throw new Error('The debugger is not running.');return this.port.customRequest('pause',{threadId:this.thread});}
    if(this.state.status!=='stopped'||this.state.frameId===undefined)throw new Error('Pause at a breakpoint before inspecting or stepping.');
    const frameId=action.frame||this.state.frameId;
    if(!this.state.stack.some(f=>f.id===frameId))throw new Error('Unknown stack frame.');
    if(['continue','next','stepIn','stepOut'].includes(action.command)) {
      const stop=this.waitForStop();this.continued();
      try {await this.port.customRequest(action.command,{threadId:this.thread});}catch(error){await this.stopped(this.thread,'command failed');throw error;}
      await stop;return {status:this.state.status,stack:this.state.stack,activeNodes:this.state.activeNodes,watches:this.state.watches};
    }
    if(action.command==='stackTrace')return this.state.stack;
    if(action.command==='scopes')return this.port.customRequest('scopes',{frameId});
    if(action.command==='variables')return this.port.customRequest('variables',{variablesReference:action.reference,start:0,count:100});
    if(action.command==='evaluate') {const result=await this.port.customRequest('evaluate',{expression:action.expression,frameId,context:'repl'});await this.refreshWatches(this.epoch);this.emit();return result;}
  }
  private waitForStop():Promise<void> {return new Promise(resolve=>{const done=()=>{clearTimeout(timer);this.waiters.delete(done);resolve();};const timer=setTimeout(done,8000);this.waiters.add(done);});}
}
export function samePath(a:string,b:string){const normalize=(s:string)=>s.replace(/\\/g,'/').replace(/^([A-Z]):/,(_,drive)=>drive.toLowerCase()+':');return normalize(a)===normalize(b);}
