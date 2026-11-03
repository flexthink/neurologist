import {ModelPicker,useModelSettings} from './ModelPicker';
import React, { useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, Background, Controls, MiniMap, Handle, Position, useNodesState, useEdgesState, ReactFlowProvider, useReactFlow, type Node, type NodeProps } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import { Logo } from './Logo';
import { Progress } from './Progress';
import { Chat } from './Chat';
import { reduceActivities, type Activity } from '../src/progress';
import type { ChatMode, ChatTurn } from '../src/chat';
import type { Architecture } from '../src/model';
import '@xyflow/react/dist/style.css';
import './style.css';

declare function acquireVsCodeApi(): {postMessage(message:unknown):void; getState():unknown; setState(state:unknown):void};
const vscode = acquireVsCodeApi();
type Layer = Node<Architecture['nodes'][number], 'layer'>;
function LayerNode({data}: NodeProps<Layer>) {
  return <article className="layer"><Handle type="target" position={Position.Left}/><div className="kind">{data.kind || 'MODULE'}</div><h3>{data.label}</h3>{data.description && <p>{data.description}</p>}<div className="parameters">{data.parameters.map((p,i) => <span key={i}><b>{p.name}</b> {p.value}</span>)}</div><div className="sources">{data.sources.map((source,i) => <button className="nodrag" key={i} title={`${source.file} → ${source.symbol}`} onClick={() => vscode.postMessage({type:'source',source})}>{source.kind} ↗</button>)}</div><Handle type="source" position={Position.Right}/></article>;
}
const nodeTypes = {layer: LayerNode};
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
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'architecture') {
        const next = message.architecture as Architecture;
        setModel(next); setError(''); setNodes(layout(next)); setEdges(next.edges);
        setTimeout(() => void flow.fitView({padding:0.2}),100);
      }
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
  function changeInstructions(value:string) {setInstructions(value);}
  function sendChat() {if (busy || error || !draft.trim() || pendingDraft.current) return; pendingDraft.current=draft.trim();vscode.postMessage({type:'chat',message:draft.trim(),mode,selected:selection});setOperationError('');}
  return <main><header><div className="brand"><Logo/><div><strong>Neurologist</strong><span className="subtitle">Architecture, connected to code</span></div></div><div className="headerActions">{model && <><button className="primary" disabled={busy||!!error} onClick={()=>vscode.postMessage({type:'present'})}>Present!</button><button aria-pressed={chatOpen} onClick={() => setChatOpen(current => !current)}>✦ Chat</button><button onClick={() => vscode.postMessage({type:'edit'})}>Edit YAML ↗</button></>}<span className="badge">{model ? `${model.nodes.length} nodes · ${model.edges.length} connections` : 'CODEBASE EXPLORER'}</span></div></header>
    <section className={`toolbar ${model ? 'diagramToolbar' : ''} ${model && descriptionCollapsed ? 'compact' : ''}`}><div className="title"><div className="titleRow"><h1>{model?.title ?? 'Understand your neural architectures'}</h1>{model && <button className="descriptionToggle" aria-label={descriptionCollapsed ? 'Expand description' : 'Collapse description'} aria-expanded={!descriptionCollapsed} aria-controls="diagramDescription" onClick={() => setDescriptionCollapsed(current => !current)}>{descriptionCollapsed ? 'Show description ⌄' : 'Hide description ⌃'}</button>}</div>{(!model || !descriptionCollapsed) && <p id="diagramDescription">{model?.summary ?? `Explore ${folder || 'your codebase'} with Codex. Trace layers, tensor shapes, and configuration back to their source.`}</p>}</div>{analysisView && !model && <div className="generate"><label htmlFor="instructions">Instructions <span>optional</span></label><textarea id="instructions" value={instructions} onChange={e => changeInstructions(e.target.value)} placeholder="Focus on the encoder. Include tensor dimensions and HyperPyYAML configuration…" disabled={busy}/><ModelPicker {...modelPicker} disabled={busy}/><button className="primary" disabled={busy || !!error} onClick={() => vscode.postMessage({type:'generate',instructions})}>{busy ? 'Analyzing with Codex…' : 'Analyze codebase →'}</button></div>}</section>
    <Progress items={activities} title={activityTitle} busy={busy} onCancel={() => vscode.postMessage({type:'cancel'})}/>
    {operationError && <div className="operationError" role="alert"><span>{operationError}</span><button aria-label="Dismiss error" onClick={() => setOperationError('')}>×</button></div>}
    {error ? <section className="error" role="alert"><h2>Check your .neuro file</h2><pre>{error}</pre><button onClick={() => vscode.postMessage({type:'edit'})}>Open YAML to fix</button></section> : model ? <div className={`workspace ${chatOpen ? 'withChat' : ''}`}><div className="canvas"><div className="search"><input aria-label="Find a layer" placeholder="Find a layer…" value={search} onChange={e => setSearch(e.target.value)}/>{search && <div className="results">{model.nodes.filter(n => `${n.label} ${n.kind}`.toLowerCase().includes(search.toLowerCase())).map(node => <button key={node.id} onClick={() => void flow.fitView({nodes:[{id:node.id}],duration:300,maxZoom:1})}>{node.label}</button>)}</div>}</div><ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodeTypes={nodeTypes} onSelectionChange={({nodes:selected}) => setSelection(selected.map(node => node.id))} fitView minZoom={0.08} maxZoom={2} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}><Background gap={24} size={1}/><Controls showInteractive={false}/><MiniMap pannable zoomable nodeColor="#55bcab"/></ReactFlow><div className="canvasHint">Scroll to zoom · Drag to explore · Follow source links to open code</div></div>{chatOpen && <Chat modelPicker={modelPicker} messages={messages} mode={mode} onMode={setMode} draft={draft} onDraft={setDraft} busy={busy} disabled={!!error} selection={selection.map(id => model.nodes.find(node => node.id===id)?.label ?? id)} onSend={sendChat} onSource={source => vscode.postMessage({type:'source',source})} onClear={() => vscode.postMessage({type:'clearChat'})} onClose={() => setChatOpen(false)}/>}</div> : <section className="welcome"><div className="orbit">◎</div><h2>From source code to a living graph</h2><p>Codex discovers models and saves readable .neuro YAML files in your workspace. Each layer carries its key parameters and links to definitions, instantiations, and configuration.</p><div className="steps"><span>01 / Explore the codebase</span><span>02 / Map the architecture</span><span>03 / Follow the connections</span></div><small>Requires the Codex CLI installed and signed in. Analysis runs in a read-only sandbox. Existing Codex account and model settings apply.</small></section>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<ReactFlowProvider><App/></ReactFlowProvider>);
