import React from 'react';
import type {DebugViewState} from '../src/debugModel';

type IconName='run'|'entry'|'stop'|'continue'|'next'|'stepIn'|'stepOut'|'pause'|'leap'|'escapeLoop'|'cancel';
const paths:Record<IconName,React.ReactNode>={
  run:<path d="m6 3 11 9-11 9Z"/>,
  entry:<><path d="M13 3H5v18h14V9l-6-6Z M13 3v6h6"/><path d="m9 12-3 3 3 3m6-6 3 3-3 3"/></>,
  stop:<rect x="5" y="5" width="14" height="14" rx="1"/>,
  continue:<><path d="M4 4v16m5-16 11 8-11 8Z"/></>,
  next:<><path d="M4 11a8 8 0 0 1 16 0m-4-3 4 3 3-4"/><circle cx="12" cy="18" r="1.5"/></>,
  stepIn:<><path d="M12 3v12m-4-4 4 4 4-4"/><circle cx="12" cy="20" r="1.5"/></>,
  stepOut:<><path d="M12 15V3m-4 4 4-4 4 4"/><circle cx="12" cy="20" r="1.5"/></>,
  pause:<><path d="M8 4v16m8-16v16"/></>,
  leap:<><path d="m3 5 8 7-8 7m9-14 8 7-8 7m9-14v14"/></>,
  escapeLoop:<><path d="M16 16a7 7 0 1 1-1-10M3 5v5h5m6 2h7m-4-4 4 4-4 4"/></>,
  cancel:<path d="m6 6 12 12M6 18 18 6"/>
};
export function DebugIcon({name}:{name:IconName}){return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;}
export function DebugToolbar({state,post}:{state:DebugViewState;post:(message:unknown)=>void}){
  const active=['starting','running','stopped'].includes(state.status);
  function action(name:IconName,label:string,disabled:boolean,onClick:()=>void,description=label,showLabel=false){return <button type="button" aria-label={label} title={description} disabled={disabled} onClick={onClick} className={'debugTool '+(showLabel?'withLabel ':'')+name}><DebugIcon name={name}/>{showLabel&&<span>{label}</span>}</button>;}
  return <div className="debugToolbar" role="toolbar" aria-label="Debugger controls" onKeyDown={event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(index<0)return;event.preventDefault();
    buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length]?.focus();
  }}>
    <div className="debugToolGroup" role="group" aria-label="Debug session">
      {action('run','Run debug',state.busy||!state.entry||active,()=>post({type:'debugRun'}),'Run the prepared scenario',true)}
      {action('entry','Entry script ↗',!state.entry,()=>post({type:'debugEntry'}),'Open the scenario entry script')}
      {action('stop','Stop',!active,()=>post({type:'debugStop'}),'Stop the debug session')}
    </div>
    <div className="debugToolGroup" role="group" aria-label="Step through code">
      {(['continue','next','stepIn','stepOut','pause'] as const).map((command,index)=>action(command,['Continue','Step over','Step into','Step out','Pause'][index],state.busy||(command==='pause'?state.status!=='running':state.status!=='stopped'),()=>post({type:'debugCommand',command})))}
    </div>
    <div className="debugToolGroup" role="group" aria-label="Navigate graph">
      {action('leap','Leap',state.busy||state.status!=='stopped',()=>post({type:'debugCommand',command:'leap'}),'Continue until execution reaches a different graph node',true)}
      {action('escapeLoop','Escape loop',state.busy||state.status!=='stopped'||!state.detectedLoop?.length,()=>post({type:'debugCommand',command:'escapeLoop'}),'Continue until execution leaves the detected repeating loop',true)}
    </div>
    {state.busy&&action('cancel',state.navigation?'Cancel navigation':'Cancel AI',false,()=>post({type:state.navigation?'debugCancelNavigation':'debugCancel'}),'Cancel the current operation',true)}
    <span className="debugToolbarStatus" role="status" title={state.reason||state.status}><i className={'statusDot '+state.status}/>{state.busy?'Working':state.status}{state.status==='stopped'&&state.reason?' · '+state.reason:''}</span>
  </div>;
}
