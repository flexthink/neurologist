import type {DebugAction,DebugFrame,DebugViewState,DebugWatch,ResolvedAnchor} from './debugModel';
export interface DebugPort {customRequest(command:string,args?:unknown):Thenable<any>|Promise<any>;}
const clipped=(value:unknown)=>String(value??'').slice(0,6000);
/** DAP operations for one owned debug session, independent of VS Code/editor state. */
export class DebugRuntime {
  private watchId=0;
  private epoch=0;private thread?:number;private waiters=new Set<()=>void>();
  constructor(private port:DebugPort,readonly state:DebugViewState,private anchors:ResolvedAnchor[],private changed:()=>void) {}
  private emit(){this.changed();}
  continued() {this.epoch++;this.state.status='running';this.state.activeNodes=[];this.state.stack=[];this.state.frameId=undefined;for(const w of this.state.watches)w.stale=true;this.emit();}
  terminated(){this.epoch++;this.state.status='terminated';this.state.activeNodes=[];this.state.stack=[];this.state.frameId=undefined;for(const w of this.state.watches)w.stale=true;for(const wake of this.waiters)wake();this.emit();}
  async stopped(threadId?:number,reason='breakpoint') {
    const epoch=++this.epoch;this.state.status='stopped';this.state.reason=reason;this.state.activeNodes=[];this.state.stack=[];this.state.frameId=undefined;this.emit();
    try {
      if (threadId===undefined) threadId=(await this.port.customRequest('threads'))?.threads?.[0]?.id;
      if (threadId===undefined) throw new Error('Debugger did not report a stopped thread.');
      const response=await this.port.customRequest('stackTrace',{threadId,startFrame:0,levels:25});if(epoch!==this.epoch)return;
      this.thread=threadId;this.state.stack=(response.stackFrames??[]).map((f:any)=>({id:f.id,name:clipped(f.name),line:f.line,source:f.source}));
      this.state.frameId=this.state.stack[0]?.id;
      const frame=this.state.stack[0];
      this.state.activeNodes=this.nodesForFrame(frame);this.emit();
      await this.refreshWatches(epoch);
    } catch(error) {if(epoch===this.epoch)this.state.diagnostics.push(clipped(error instanceof Error?error.message:error));}
    if(epoch===this.epoch){this.emit();for(const wake of this.waiters)wake();}
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
  async action(action:DebugAction):Promise<unknown> {
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
