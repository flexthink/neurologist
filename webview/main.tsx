import {DebugToolbar} from './DebugToolbar';
import {DebugPane} from './DebugPane';
import {emptyDebugState,type DebugWatch} from '../src/debugModel';
import {ModelPicker,useModelSettings} from './ModelPicker';
import React, { useEffect, useState, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, useNodesState, useEdgesState, ReactFlowProvider, useReactFlow, BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { Logo } from './Logo';
import { Progress } from './Progress';
import { Chat,demoRequest } from './Chat';
import { reduceActivities, type Activity } from '../src/progress';
import type { ChatMode, ChatTurn } from '../src/chat';
import type { Architecture, Demo } from '../src/model';
import {computeDemoStep, DEFAULT_STEP_DURATION} from '../src/demo';
import '@xyflow/react/dist/style.css';
import './style.css';

declare function acquireVsCodeApi(): {postMessage(message:unknown):void; getState():unknown; setState(state:unknown):void};
const vscode = acquireVsCodeApi();
type LayerData = Architecture['nodes'][number] & {demoPoint?:boolean; demoText?:string[]; debugStopped?:boolean; debugWatches?:DebugWatch[]};
type Layer = Node<LayerData, 'layer'>;
function LayerNode({data}: NodeProps<Layer>) {
  return <article className="layer"><Handle type="target" position={Position.Left}/><div className="kind">{data.kind || 'MODULE'}</div><h3>{data.label}</h3>{data.description && <p>{data.description}</p>}{data.debugStopped&&<div className="debugModuleStatus">➤ Paused in this module</div>}<div className="parameters">{data.parameters.map((p,i) => <span key={i}><b>{p.name}</b> {p.value}</span>)}</div><div className="sources">{data.sources.map((source,i) => <button className="nodrag" key={i} title={`${source.file} → ${source.symbol}`} onClick={() => vscode.postMessage({type:'source',source})}>{source.kind} ↗</button>)}</div><Handle type="source" position={Position.Right}/>{!!data.debugWatches?.length&&<div className="moduleWatches" aria-label="Module watches">{data.debugWatches.map(w=><div key={w.id} className={`moduleWatch ${w.stale?'stale':''}`}><code>{w.expression}</code><pre>{w.error?'Unavailable: '+w.error:w.value??'Waiting for breakpoint'}</pre>{w.stale&&<small>stale · waiting for next stop</small>}</div>)}</div>}{data.demoPoint && <div className="demoPointer">➤</div>}{data.demoText?.map((text,i)=><div className="demoCallout" key={i}>{text}</div>)}</article>;
}
const nodeTypes = {layer: LayerNode};
function DemoEdge(props:EdgeProps) {
  const [path,x,y] = getBezierPath(props);
  const data = props.data as {point?:boolean; texts?:string[]} | undefined;
  return <><BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd}/><EdgeLabelRenderer><div className="demoEdgeLabel" style={{transform:`translate(-50%, -50%) translate(${x}px, ${y}px)`}}>{props.label && <span>{props.label}</span>}{data?.point && <div className="demoEdgePointer">➤</div>}{data?.texts?.map((text,i)=><div className="demoCallout" key={i}>{text}</div>)}</div></EdgeLabelRenderer></>;
}
const edgeTypes = {demo:DemoEdge};
function layout(model: Architecture): Layer[] {
  const graph = new dagre.graphlib.Graph().setGraph({rankdir:'LR',nodesep:65,ranksep:110}).setDefaultEdgeLabel(() => ({}));
  model.nodes.forEach(node => graph.setNode(node.id,{width:310,height:nodeHeight(node)}));
  model.edges.forEach(edge => graph.setEdge(edge.source,edge.target)); dagre.layout(graph);
  return model.nodes.map(node => {const p = graph.node(node.id); return {id:node.id,type:'layer',data:node,position:{x:p.x - 155,y:p.y - nodeHeight(node)/2}};});
}
function nodeHeight(node: Architecture['nodes'][number]) {return 130 + Math.ceil(node.description.length/36)*17 + node.parameters.length*30 + Math.ceil(node.sources.length/2)*28;}
function App() {
  const modelPicker=useModelSettings(message=>vscode.postMessage(message));
  const saved = vscode.getState() as {instructions?:string; modelTitle?:string; draft?:string; chatMode?:ChatMode; chatOpen?:boolean; activities?:Activity[]; activityTitle?:string; descriptionCollapsed?:boolean} | undefined;
  const [analysisView,setAnalysisView] = useState(document.documentElement.dataset.view==='analysis');
  const pendingDraft = useRef('');
  const [descriptionCollapsed,setDescriptionCollapsed] = useState(saved?.descriptionCollapsed ?? false);
  const [model,setModel] = useState<Architecture>();
  const [debugOpen,setDebugOpen]=useState(false),[debugState,setDebugState]=useState(emptyDebugState);
  const debugActive=['starting','running','stopped'].includes(debugState.status);

  const [folder,setFolder] = useState('');
  const [error,setError] = useState('');
  const [messages,setMessages] = useState<ChatTurn[]>([]);
  const [mode,setMode] = useState<ChatMode>(saved?.chatMode ?? 'explain');
  const [draft,setDraft] = useState(saved?.draft ?? '');
  const [chatOpen,setChatOpen] = useState(saved?.chatOpen ?? true);
  const [selection,setSelection] = useState<string[]>([]);
  const [activities,setActivities] = useState<Activity[]>((saved?.activities ?? []).map(item => item.state==='running' ? {...item,state:'cancelled',endedAt:Date.now()} : item));
  const [activityTitle,setActivityTitle] = useState(saved?.activityTitle ?? '');
  const [operationError,setOperationError] = useState('');
  const [busy,setBusy] = useState(false);
  const [instructions,setInstructions] = useState(saved?.instructions ?? '');
  const [search,setSearch] = useState('');
  const [nodes,setNodes,onNodesChange] = useNodesState<Layer>([]);
  const [edges,setEdges,onEdgesChange] = useEdgesState([] as {id:string;source:string;target:string;label:string}[]);
  const flow = useReactFlow();
  const graphNodes=useMemo(()=>nodes.map(node=>({...node,className:[node.className,debugState.activeNodes.includes(node.id)?'debugStopped':'',(debugState.navigation?.kind==='escapeLoop'?debugState.navigation.cycleNodes:(debugState.detectedLoop??[])).includes(node.id)?'debugLoop':''].filter(Boolean).join(' '),data:{...node.data,debugStopped:debugState.activeNodes.includes(node.id),debugWatches:debugState.watches.filter(w=>w.node===node.id)}})),[nodes,debugState.activeNodes,debugState.watches,debugState.detectedLoop,debugState.navigation]);
  const [demo,setDemo] = useState<{definition:Demo; source:Architecture; savedNodes:Layer[]; savedEdges:typeof edges} | null>(null);
  const [step,setStep] = useState(0);
  const [playing,setPlaying] = useState(false);
  const demoState = demo ? computeDemoStep(demo.source,demo.definition,step) : null;
  function startDemo(index:number) {
    if (!model?.demos?.[index]||debugActive||debugState.busy) return;
    const source = demo?.source ?? structuredClone(model);
    setDemo({definition:source.demos![index],source,savedNodes:demo?.savedNodes ?? structuredClone(nodes),savedEdges:demo?.savedEdges ?? structuredClone(edges)});
    setStep(0); setPlaying(false);
  }
  function exitDemo() {
    if (!demo) return;
    setNodes(demo.savedNodes); setEdges(demo.savedEdges); setDemo(null); setPlaying(false);
  }
  useEffect(() => {
    if (!demoState || !demo) return;
    const {graph,presentation:p} = demoState;
    setNodes(layout(graph).map(node=>({...node, className:[p.highlightedNodes.includes(node.id)?'demoHighlight':'',p.dimmedNodes.includes(node.id)?'demoDim':''].join(' '),data:{...node.data,demoPoint:p.points.includes(node.id),demoText:p.explanations.filter(item=>item.target===node.id).map(item=>item.text)}})));
    setEdges(graph.edges.map(edge=>({...edge,type:'demo',className:[p.highlightedEdges.includes(edge.id)?'demoHighlight':'',p.dimmedEdges.includes(edge.id)?'demoDim':''].join(' '),data:{point:p.points.includes(edge.id),texts:p.explanations.filter(item=>item.target===edge.id).map(item=>item.text)}})));
    const target = p.focus;
    if (target) {const edge=graph.edges.find(item=>item.id===target); const ids=edge ? [edge.source,edge.target] : [target]; const timer=setTimeout(()=>void flow.fitView({nodes:ids.map(id=>({id})),padding:0.5,duration:350,maxZoom:1}),50); return ()=>clearTimeout(timer);}
  },[demo,step]);
  useEffect(() => {
    if (!demo || !playing) return;
    const timer=setTimeout(()=>{if (step>=demo.definition.steps.length-1) setPlaying(false); else setStep(step+1);},demo.definition.steps[step].duration ?? DEFAULT_STEP_DURATION);
    return ()=>clearTimeout(timer);
  },[demo,step,playing]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'architecture') {
        const next = message.architecture as Architecture;
        setDemo(null); setPlaying(false); setModel(next); setError(''); setNodes(layout(next)); setEdges(next.edges);
        setTimeout(() => void flow.fitView({padding:0.2}),100);
      }
      if (message.type === 'debugOpen') {setDebugOpen(true);setChatOpen(false);}
      if (message.type === 'debugState') setDebugState(message.state);
      if (message.type === 'home') {setAnalysisView(true);setFolder(message.folder);if (typeof message.instructions==='string') setInstructions(message.instructions);}
      if (message.type === 'error') setError(message.message);
      if (message.type === 'busy') setBusy(message.value);
      if (message.type === 'chatHistory') {setMessages(message.messages);if (pendingDraft.current && message.messages.some((turn:ChatTurn) => turn.role==='user' && turn.content===pendingDraft.current)) {const sent=pendingDraft.current;setDraft(current => current.trim()===sent ? '' : current);pendingDraft.current='';}}
      if (message.type === 'activityReset') {setActivities([]);setActivityTitle(message.title);setOperationError('');}
      if (message.type === 'activity') setActivities(current => reduceActivities(current,message.activity));
      if (message.type === 'operationError') {setOperationError(message.message);pendingDraft.current='';}
    };
    window.addEventListener('message',listener); vscode.postMessage({type:'ready'});
    return () => window.removeEventListener('message',listener);
  },[]);
  useEffect(() => {vscode.setState({instructions,modelTitle:model?.title,draft,chatMode:mode,chatOpen,activities,activityTitle,descriptionCollapsed});},[instructions,model?.title,draft,mode,chatOpen,activities,activityTitle,descriptionCollapsed]);
  useEffect(() => {const timer=setTimeout(() => {void flow.fitView({padding:0.2,duration:200});},50);return () => clearTimeout(timer);},[chatOpen,descriptionCollapsed]);
  useEffect(()=>{if(debugState.status==='stopped'&&debugState.activeNodes.length)void flow.fitView({nodes:debugState.activeNodes.map(id=>({id})),padding:.5,duration:300,maxZoom:1});},[debugState.status,debugState.activeNodes.join(',')]);
  function changeInstructions(value:string) {setInstructions(value);}
  function sendChat() {if (busy || error || !draft.trim() || pendingDraft.current) return; pendingDraft.current=draft.trim();vscode.postMessage({type:'chat',message:draft.trim(),mode,selected:selection});setOperationError('');}
  return <main><header><div className="brand"><Logo/><div><strong>Neurologist</strong><span className="subtitle">Architecture, connected to code</span></div></div><div className="headerActions">{model && <>{!!model.demos?.length && !demo && <button disabled={debugActive||debugState.busy} onClick={()=>startDemo(0)}>▶ Demo</button>}<button disabled={busy||!!error||!!demo} aria-pressed={debugOpen} onClick={()=>{setDebugOpen(v=>!v);setChatOpen(false);}}>Debug</button><button disabled={busy||!!error||!!demo||debugActive} title="Create a walkthrough using chat" onClick={()=>{setChatOpen(true);setDebugOpen(false);setMode('revise');setDraft(demoRequest);}}>Create demo</button><button className="primary" disabled={busy||!!error} onClick={()=>vscode.postMessage({type:'present'})}>Present!</button><button aria-pressed={chatOpen} onClick={() => {setChatOpen(current => !current);setDebugOpen(false);}}>✦ Chat</button><button onClick={() => vscode.postMessage({type:'edit'})}>Edit YAML ↗</button></>}<span className="badge">{model ? `${model.nodes.length} nodes · ${model.edges.length} connections` : 'CODEBASE EXPLORER'}</span></div></header>
    <section className={`toolbar ${model ? 'diagramToolbar' : ''} ${model && descriptionCollapsed ? 'compact' : ''}`}><div className="title"><div className="titleRow"><h1>{model?.title ?? 'Understand your neural architectures'}</h1>{model && <button className="descriptionToggle" aria-label={descriptionCollapsed ? 'Expand description' : 'Collapse description'} aria-expanded={!descriptionCollapsed} aria-controls="diagramDescription" onClick={() => setDescriptionCollapsed(current => !current)}>{descriptionCollapsed ? 'Show description ⌄' : 'Hide description ⌃'}</button>}</div>{(!model || !descriptionCollapsed) && <p id="diagramDescription">{model?.summary ?? `Explore ${folder || 'your codebase'} with Codex. Trace layers, tensor shapes, and configuration back to their source.`}</p>}</div>{analysisView && !model && <div className="generate"><label htmlFor="instructions">Instructions <span>optional</span></label><textarea id="instructions" value={instructions} onChange={e => changeInstructions(e.target.value)} placeholder="Focus on the encoder. Include tensor dimensions and HyperPyYAML configuration…" disabled={busy}/><ModelPicker {...modelPicker} disabled={busy}/><button className="primary" disabled={busy || !!error} onClick={() => vscode.postMessage({type:'generate',instructions})}>{busy ? 'Analyzing with Codex…' : 'Analyze codebase →'}</button></div>}</section>
    {demo && <section className="demoBar" aria-label="Demo controls"><label>Demo <select aria-label="Choose demo" value={demo.source.demos!.indexOf(demo.definition)} onChange={e=>startDemo(Number(e.target.value))}>{demo.source.demos!.map((item,i)=><option value={i} key={i}>{item.name}</option>)}</select></label>{demo.definition.description && <span>{demo.definition.description}</span>}<button disabled={step===0} onClick={()=>setStep(step-1)}>Back</button><button onClick={()=>setPlaying(!playing)}>{playing?'Pause':'Play'}</button><button disabled={step===demo.definition.steps.length-1} onClick={()=>setStep(step+1)}>Forward</button><label>Step <select aria-label="Choose step" value={step} onChange={e=>setStep(Number(e.target.value))}>{demo.definition.steps.map((_,i)=><option key={i} value={i}>{i+1}</option>)}</select> / {demo.definition.steps.length}</label><button onClick={exitDemo}>Exit demo</button>{!!demoState?.diagnostics.length && <details className="demoDiagnostics"><summary>Diagnostics ({demoState.diagnostics.length})</summary>{demoState.diagnostics.map((item,i)=><div key={i}>{item}</div>)}</details>}</section>}
    <Progress items={activities} title={activityTitle} busy={busy||debugState.busy} onCancel={() => vscode.postMessage({type:debugState.busy?'debugCancel':'cancel'})}/>
    {operationError && <div className="operationError" role="alert"><span>{operationError}</span><button aria-label="Dismiss error" onClick={() => setOperationError('')}>×</button></div>}
    {error ? <section className="error" role="alert"><h2>Check your .neuro file</h2><pre>{error}</pre><button onClick={() => vscode.postMessage({type:'edit'})}>Open YAML to fix</button></section> : model ? <div className={`workspace ${chatOpen||debugOpen ? 'withChat' : ''}`}><div className="graphArea">{(debugOpen||debugActive||debugState.busy)&&<DebugToolbar state={debugState} post={message=>vscode.postMessage(message)}/>}<div className="canvas"><div className="search"><input aria-label="Find a layer" placeholder="Find a layer…" value={search} onChange={e => setSearch(e.target.value)}/>{search && <div className="results">{model.nodes.filter(n => `${n.label} ${n.kind}`.toLowerCase().includes(search.toLowerCase())).map(node => <button key={node.id} onClick={() => void flow.fitView({nodes:[{id:node.id}],duration:300,maxZoom:1})}>{node.label}</button>)}</div>}</div><ReactFlow nodes={graphNodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodesDraggable={!demo} onSelectionChange={({nodes:selected}) => setSelection(selected.map(node => node.id))} fitView minZoom={0.08} maxZoom={2} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}><Background gap={24} size={1}/><Controls showInteractive={false}/><MiniMap pannable zoomable nodeColor="#55bcab"/></ReactFlow><div className="canvasHint">Scroll to zoom · Drag to explore · Follow source links to open code</div></div></div>{debugOpen&&<DebugPane state={debugState} post={message=>vscode.postMessage(message)} onClose={()=>setDebugOpen(false)} picker={modelPicker} nodes={model.nodes} selected={selection}/>}
{chatOpen && <Chat modelPicker={modelPicker} messages={messages} mode={mode} onMode={setMode} draft={draft} onDraft={setDraft} busy={busy} disabled={!!error||debugActive||debugState.busy} selection={selection.map(id => model.nodes.find(node => node.id===id)?.label ?? id)} onSend={sendChat} onSource={source => vscode.postMessage({type:'source',source})} onClear={() => vscode.postMessage({type:'clearChat'})} onClose={() => setChatOpen(false)}/>}</div> : <section className="welcome"><div className="orbit">◎</div><h2>From source code to a living graph</h2><p>Codex discovers models and saves readable .neuro YAML files in your workspace. Each layer carries its key parameters and links to definitions, instantiations, and configuration.</p><div className="steps"><span>01 / Explore the codebase</span><span>02 / Map the architecture</span><span>03 / Follow the connections</span></div><small>Requires the Codex CLI installed and signed in. Analysis runs in a read-only sandbox. Existing Codex account and model settings apply.</small></section>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<ReactFlowProvider><App/></ReactFlowProvider>);
