import type {Architecture, Demo} from './model';

export const DEFAULT_STEP_DURATION = 3000;
type Operation = Demo['steps'][number]['operations'][number];
export type Presentation = {focus?:string; points:string[]; explanations:{target:string;text:string}[]; highlightedNodes:string[]; highlightedEdges:string[]; dimmedNodes:string[]; dimmedEdges:string[]};
export type DemoState = {graph:Architecture; presentation:Presentation; diagnostics:string[]};

/** Replay from an immutable source; no navigation history or editor state is involved. */
export function computeDemoStep(source:Architecture, demo:Demo, step:number):DemoState {
  const graph = structuredClone(source);
  const diagnostics:string[] = [];
  const presentation:Presentation = {points:[],explanations:[],highlightedNodes:[],highlightedEdges:[],dimmedNodes:[],dimmedEdges:[]};
  const exists = (id:string) => graph.nodes.some(n => n.id===id) || graph.edges.some(e => e.id===id);
  const check = (id:string, kind:'node'|'edge', index:number) => {
    const found = kind==='node' ? graph.nodes.some(n=>n.id===id) : graph.edges.some(e=>e.id===id);
    if (!found) diagnostics.push(`Step ${index+1}: ${kind} “${id}” does not exist.`);
    return found;
  };
  const persistent = (op:Operation,index:number) => {
    if (op.type==='add') {
      for (const node of op.nodes ?? []) {if (exists(node.id)) diagnostics.push(`Step ${index+1}: “${node.id}” already exists.`); else graph.nodes.push(structuredClone(node));}
      for (const edge of op.edges ?? []) {if (exists(edge.id)) diagnostics.push(`Step ${index+1}: “${edge.id}” already exists.`); else if (!graph.nodes.some(n=>n.id===edge.source) || !graph.nodes.some(n=>n.id===edge.target)) diagnostics.push(`Step ${index+1}: edge “${edge.id}” has a missing endpoint.`); else graph.edges.push(structuredClone(edge));}
    } else if (op.type==='remove') {
      for (const id of op.edges ?? []) if (check(id,'edge',index)) graph.edges = graph.edges.filter(e=>e.id!==id);
      for (const id of op.nodes ?? []) if (check(id,'node',index)) {graph.nodes = graph.nodes.filter(n=>n.id!==id); graph.edges = graph.edges.filter(e=>e.source!==id && e.target!==id);}
    }
  };
  const last = Math.min(Math.max(0,step),demo.steps.length-1);
  for (let i=0;i<=last;i++) {
    for (const op of demo.steps[i].operations) persistent(op,i);
  }
  for (const op of demo.steps[last].operations) {
    if (op.type==='focus' || op.type==='point' || op.type==='explain') {
      if (!exists(op.target)) {diagnostics.push(`Step ${last+1}: target “${op.target}” does not exist.`); continue;}
      if (op.type==='focus') presentation.focus=op.target;
      if (op.type==='point') presentation.points.push(op.target);
      if (op.type==='explain') presentation.explanations.push({target:op.target,text:op.text});
    } else if (op.type==='highlight' || op.type==='dim') {
      const nodes=(op.nodes ?? []).filter(id=>check(id,'node',last));
      const edges=(op.edges ?? []).filter(id=>check(id,'edge',last));
      if (op.type==='highlight') {presentation.highlightedNodes.push(...nodes); presentation.highlightedEdges.push(...edges);}
      else {presentation.dimmedNodes.push(...nodes); presentation.dimmedEdges.push(...edges);}
    }
  }
  return {graph,presentation,diagnostics};
}
