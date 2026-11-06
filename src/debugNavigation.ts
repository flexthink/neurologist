import {z} from 'zod';
export const navigationSettingsSchema=z.object({maxLoopLength:z.number().int().min(1).max(64),maxSkippedStops:z.number().int().min(1).max(100000),timeoutMs:z.number().int().min(1).max(600000)}).strict();
export type NavigationSettings=z.infer<typeof navigationSettingsSchema>;
export const DEFAULT_NAVIGATION_SETTINGS:NavigationSettings={maxLoopLength:16,maxSkippedStops:500,timeoutMs:30000};
export type NavigationKind='leap'|'escapeLoop'|'runTo'|'runUntil';
export interface GraphStop {sequence:number;nodes:string[];reason:string;skippable:boolean;}
export interface NavigationResult {reason:'target'|'escaped'|'different-node'|'user-stop'|'limit'|'timeout'|'cancelled'|'terminated'|'error';message:string;stops:number;paused:boolean;}
export interface NavigationProgress {kind:NavigationKind;stops:number;cycleNodes:string[];target:string;}
export interface NavigationDriver {
  status():string;
  lastStop():GraphStop|undefined;
  nextStop(after:number,signal:AbortSignal):Promise<GraphStop>;
  resume():Promise<unknown>;
  pause():Promise<unknown>;
  predicate(expression:string):Promise<boolean>;
}
/** Smallest repeated suffix: an observed inner loop, frozen when Escape starts. */
export function detectLoop(trace:string[][],maximum=16):string[] {
  const tokens=trace.map(nodes=>JSON.stringify([...nodes].sort()));
  for(let size=1;size<=Math.min(maximum,Math.floor(tokens.length/2));size++) {
    if(size===1&&tokens.length<3)continue; // Avoid mistaking one duplicate module anchor for a loop.
    const count=size===1?3:2;if(tokens.length<size*count)continue;
    const end=tokens.slice(-size);let matches=true;
    for(let repetition=2;repetition<=count;repetition++)if(end.some((value,i)=>value!==tokens[tokens.length-repetition*size+i])){matches=false;break;}
    if(matches)return [...new Set(trace.slice(-size).flat())].sort();
  }
  return [];
}
export function abortable<T>(promise:PromiseLike<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new Error('Navigation interrupted'));};
    if(signal.aborted){abort();return;}
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
/** Repeated continue with one overall deadline. Never skips an unclassified/user stop. */
export async function navigateGraph(driver:NavigationDriver,request:{kind:NavigationKind;target?:string;expression?:string;cycle:string[];settings:NavigationSettings;signal:AbortSignal;progress:(value:NavigationProgress)=>void}):Promise<NavigationResult> {
  const settings=navigationSettingsSchema.parse(request.settings),initial=driver.lastStop();
  if(driver.status()!=='stopped'||!initial)throw new Error('Pause at a breakpoint before navigating the graph.');
  if(request.kind==='escapeLoop'&&!request.cycle.length)throw new Error('No repeating graph path has been observed yet. Continue or Leap to collect a path first.');
  if(request.kind==='runTo'&&!request.target)throw new Error('Choose a target graph node.');
  if(request.kind==='runUntil'&&!request.expression?.trim())throw new Error('Provide a debugger predicate for Run until.');
  const controller=new AbortController();let timedOut=false,stops=0,lastPredicateError='';
  const abort=()=>controller.abort();request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},settings.timeoutMs);
  const report=()=>request.progress({kind:request.kind,stops,cycleNodes:request.cycle,target:request.target??''});
  const result=(reason:NavigationResult['reason'],message:string):NavigationResult=>({reason,message,stops,paused:driver.status()==='stopped'});
  let sequence=initial.sequence;
  const reached=async(stop:GraphStop):Promise<NavigationResult|undefined>=>{
    if(request.kind==='leap'&&stop.nodes.some(node=>!initial.nodes.includes(node)))return result('different-node','Reached a different graph node.');
    if(request.kind==='escapeLoop'&&stop.nodes.some(node=>!request.cycle.includes(node)))return result('escaped','Left the detected loop.');
    if(request.kind==='runTo'&&stop.nodes.includes(request.target!))return result('target','Reached graph node '+request.target+'.');
    if(request.kind==='runUntil'&&(!request.target||stop.nodes.includes(request.target))) {
      try{if(await abortable(driver.predicate(request.expression!),controller.signal))return result('target','Debugger predicate is true.');}
      catch(error){if(controller.signal.aborted)throw error;lastPredicateError=error instanceof Error?error.message:String(error);}
    }
  };
  async function pauseIfRunning(){
    if(driver.status()!=='running')return;
    const pauseController=new AbortController(),pauseTimer=setTimeout(()=>pauseController.abort(),3000);
    try{const stop=driver.nextStop(sequence,pauseController.signal);const pause=driver.pause();await abortable(Promise.all([stop,pause]),pauseController.signal);}catch{/* Keep cancellation bounded even if the adapter cannot pause. */}finally{clearTimeout(pauseTimer);pauseController.abort();}
  }
  try {
    report();controller.signal.throwIfAborted();
    if(request.kind==='runTo'||request.kind==='runUntil'){const already=await reached(initial);if(already)return already;}
    while(stops<settings.maxSkippedStops) {
      controller.signal.throwIfAborted();
      const next=driver.nextStop(sequence,controller.signal);
      // Attach rejection handling before sending continue (which can itself fail).
      const observed=next.then(stop=>({stop}),error=>({error}));
      await abortable(driver.resume(),controller.signal);
      const event=await observed;if('error'in event)throw event.error;
      const stop=event.stop;sequence=stop.sequence;stops++;report();
      if(driver.status()==='terminated'||stop.reason==='terminated')return result('terminated','The debug session ended before the navigation target was observed.');
      if(!stop.skippable)return result('user-stop','Stopped for '+stop.reason+'. User breakpoints, exceptions and manual stops are preserved.');
      const target=await reached(stop);if(target)return target;
    }
    await pauseIfRunning();return result('limit','Reached the maximum skipped stops ('+settings.maxSkippedStops+').'+(lastPredicateError?' Last predicate error: '+lastPredicateError:''));
  }catch(error){
    controller.abort();await pauseIfRunning();
    if(request.signal.aborted)return result('cancelled',driver.status()==='terminated'?'Navigation cancelled; the debug session ended.':driver.status()==='running'?'Navigation cancelled; pause requested, but the target has not stopped. Use Pause or Stop.':'Navigation cancelled and execution paused.');
    if(timedOut)return result('timeout',driver.status()==='running'?'Navigation timed out; pause requested, but the target has not stopped. Use Pause or Stop.':'Navigation reached its time limit and paused.');
    return result('error',error instanceof Error?error.message:String(error));
  }finally{clearTimeout(timer);controller.abort();request.signal.removeEventListener('abort',abort);}
}
