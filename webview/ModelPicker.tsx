import React,{useEffect,useState} from 'react';
import type {ModelSettings,ModelSelection} from '../src/modelOptions';
import './modelPicker.css';
export function useModelSettings(post:(message:unknown)=>void,folder?:string) {
  const [state,setState]=useState<ModelSettings>({selection:{model:'',effort:''},models:[],loading:true,error:'',folder:folder??''});
  useEffect(()=>{
    const listener=(event:MessageEvent)=>{if (event.data.type==='modelSettings'&&(folder===undefined||event.data.folder===folder)) setState(event.data);};
    window.addEventListener('message',listener);post({type:'modelSettingsRequest',folder});
    return()=>window.removeEventListener('message',listener);
  },[folder]);
  return {state,change:(selection:ModelSelection)=>{setState(current=>({...current,selection}));post({type:'modelSelection',selection,folder});},refresh:()=>post({type:'modelsRefresh',folder})};
}
export type ModelPickerProps=ReturnType<typeof useModelSettings>&{disabled?:boolean};
const effortName=(value:string)=>({xhigh:'Extra high',none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',max:'Max',ultra:'Ultra'}[value]??value);
export function ModelPicker({state,change,refresh,disabled}:ModelPickerProps) {
  const [custom,setCustom]=useState(false),[customName,setCustomName]=useState('');
  const selected=state.models.find(model=>model.model===state.selection.model);
  const efforts=selected?.supportedReasoningEfforts??[];
  const selectModel=(model:string)=>{const next=state.models.find(item=>item.model===model);change({model,effort:next?.supportedReasoningEfforts.some(item=>item.reasoningEffort===state.selection.effort) ? state.selection.effort : ''});};
  return <div className="modelPicker"><div className="modelPickerRow" role="group" aria-label="Codex model settings"><select aria-label="Codex model" title="Model for the next request" value={state.selection.model} disabled={disabled} onChange={event=>{if (event.target.value==='__custom__') {setCustom(true);setCustomName(state.selection.model);}else {setCustom(false);selectModel(event.target.value);}}}><option value="">Codex default</option>{state.selection.model&&!selected&&<option value={state.selection.model}>{state.selection.model}</option>}{state.models.map(model=><option key={model.model} value={model.model}>{model.displayName||model.model}</option>)}<option value="__custom__">Custom model…</option></select><select aria-label="Reasoning effort" title={selected ? "Reasoning effort for the next request" : "Choose a model to see its supported reasoning efforts"} value={state.selection.effort} disabled={disabled||!selected} onChange={event=>change({...state.selection,effort:event.target.value})}><option value="">Default effort</option>{state.selection.effort&&!efforts.some(item=>item.reasoningEffort===state.selection.effort)&&<option value={state.selection.effort}>{effortName(state.selection.effort)}</option>}{efforts.map(item=><option key={item.reasoningEffort} value={item.reasoningEffort} title={item.description}>{effortName(item.reasoningEffort)}</option>)}</select><button type="button" className="modelRefresh" aria-label="Refresh models" title="Refresh models from Codex" disabled={disabled||state.loading} onClick={refresh}>{state.loading ? '⋯' : '↻'}</button></div>{custom&&<div className="customModel"><input aria-label="Custom model ID" maxLength={200} placeholder="Model ID" value={customName} disabled={disabled} onChange={event=>setCustomName(event.target.value)}/><button type="button" disabled={disabled||!customName.trim()} onClick={()=>{selectModel(customName.trim());setCustom(false);}}>Use</button><button type="button" onClick={()=>setCustom(false)}>Cancel</button></div>}{state.error&&<p className="modelPickerError" role="status">{state.error}</p>}</div>;
}
