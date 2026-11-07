import React from 'react';
import {Handle,Position,type Node,type NodeProps} from '@xyflow/react';
import type {DebugVisualization} from '../src/debugVisualization';
import {DebugIcon} from './DebugToolbar';
export type VisualizationGraphNode=Node<{visual:DebugVisualization;busy:boolean;canRefresh:boolean;post:(message:unknown)=>void},'visualization'>;
export function DebugVisualizationNode({data}:NodeProps<VisualizationGraphNode>){
 const {visual:v,post}=data;
 return <article className={'visualizationCard '+(v.stale?'stale':'')} aria-label={'Visualization: '+v.title}><Handle type="target" position={Position.Top}/><div className="kind">SCENARIO VISUALIZATION</div><h3>{v.title}</h3>{v.image?<img className="nodrag" src={v.image} alt={v.title} draggable={false}/>:<div className="visualizationPlaceholder">Waiting for a matching breakpoint and available context.</div>}<div className="visualizationStatus" role="status">{v.rendering?'Rendering…':v.error?'Capture unavailable':v.image?(v.stale?'Last capture · stale':'Captured from the stopped frame'):'Not captured yet'}</div>{v.error&&<p className="visualizationError">{v.error}</p>}<div className="visualizationActions nodrag"><button disabled={data.busy||!data.canRefresh||v.rendering} aria-label="Refresh" title="Refresh from the current stopped frame" onClick={()=>post({type:'debugVisualizationRefresh',id:v.id})}>↻ Refresh</button><button disabled={data.busy} title="Open the visualization sidecar" onClick={()=>post({type:'debugVisualizationSource',id:v.id})}><DebugIcon name="entry"/> Sidecar</button><button disabled={data.busy||v.rendering} title="Remove this visualization from the scenario" aria-label={'Remove visualization '+v.title} onClick={()=>post({type:'debugVisualizationRemove',id:v.id})}>×</button></div></article>;
}
