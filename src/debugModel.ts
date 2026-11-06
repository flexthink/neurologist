import {z} from 'zod';
export const executionAnchorSchema=z.object({node:z.string().min(1),file:z.string().min(1),symbol:z.string().min(1),kind:z.enum(['forward','invocation']),statement:z.string().default('')}).strict();
export type ExecutionAnchor=z.infer<typeof executionAnchorSchema>;
export const watchSchema=z.object({id:z.string().min(1).max(100),node:z.string().min(1),expression:z.string().min(1).max(2000)}).strict();
export type DebugWatch=z.infer<typeof watchSchema>&{value?:string;error?:string;stale?:boolean};
export const debugPlanSchema=z.object({reply:z.string().min(1).max(16000),entry:z.object({language:z.enum(['python','javascript']),code:z.string().min(1).max(100000),args:z.array(z.string()).max(100)}).strict().nullable(),anchors:z.array(executionAnchorSchema).max(1000),watches:z.array(watchSchema).max(100)}).strict();
export type DebugPlan=z.infer<typeof debugPlanSchema>;
export const debugActionSchema=z.object({command:z.enum(['evaluate','continue','next','stepIn','stepOut','pause','scopes','variables','stackTrace','watch','unwatch']),expression:z.string().max(4000),node:z.string().max(200),reference:z.number().int().min(0),frame:z.number().int().min(0)}).strict();
export const debugReplySchema=z.object({reply:z.string().min(1).max(16000),action:debugActionSchema.nullable()}).strict();
export type DebugAction=z.infer<typeof debugActionSchema>;
export interface DebugFrame {id:number;name:string;line:number;source?:{path?:string;name?:string};}
export interface ResolvedAnchor extends ExecutionAnchor {path:string;line:number;endLine:number;}
export const DEFAULT_DEBUG_INSTRUCTIONS='Mock or synthesize everything that can reasonably be mocked without defeating the debugging question. Prefer deterministic synthetic inputs with shapes, dtypes and valid ranges grounded in the real code/configuration, and randomly initialized or untrained model weights. Stub datasets, remote APIs, network/storage services, logging, metrics and expensive peripheral preprocessing where practical. Keep the actual module implementations and forward/invocation path under investigation real by default; replace a target only when explicitly requested. Do not require real datasets, checkpoints or a trained model unless the scenario explicitly needs them or a dependency cannot meaningfully be mocked. Do not download, install packages or train a model. State what is mocked and how synthetic inputs are constructed; never present synthetic data, weights or inferred runtime values as real observations. Ask for clarification only when an essential code/configuration fact cannot be determined and blocks even a mocked run. Follow the user’s customized instructions and scenario when they request a different mocking policy.';
export interface DebugViewState {
  status:'idle'|'prepared'|'starting'|'running'|'stopped'|'terminated';activeNodes:string[];watches:DebugWatch[];
  stack:DebugFrame[];frameId?:number;reason:string;diagnostics:string[];entry?:string;
  instructions:string;
  messages:{role:'user'|'assistant'|'tool';content:string}[];busy:boolean;
}
export const emptyDebugState=():DebugViewState=>({status:'idle',activeNodes:[],watches:[],stack:[],reason:'',diagnostics:[],instructions:DEFAULT_DEBUG_INSTRUCTIONS,messages:[],busy:false});

/** Resolve qualified Python functions by indentation; never silently pick a same-name method. */
export function resolvePythonAnchor(text:string,symbol:string,statement=''):{line:number;endLine:number}|undefined {
  const lines=text.split(/\r?\n/),stack:{name:string;indent:number}[]=[],matches:{start:number;body:number;end:number;indent:number}[]=[];
  for (let i=0;i<lines.length;i++) {
    const match=lines[i].match(/^(\s*)(?:async\s+)?(class|def)\s+(\w+)\b/);if (!match) continue;
    const indent=match[1].replace(/\t/g,'    ').length;while (stack.length&&stack.at(-1)!.indent>=indent) stack.pop();
    const qualified=[...stack.map(item=>item.name),match[3]].join('.');
    if (qualified===symbol || (!symbol.includes('.')&&match[3]===symbol)) {
      let headerEnd=i,balance=0,colon=-1;
      for(;headerEnd<lines.length;headerEnd++){
        const code=lines[headerEnd].replace(/(["'])(?:\\.|(?!\1).)*?\1/g,'').split('#')[0];
        for(let c=0;c<code.length;c++){if('([{'.includes(code[c]))balance++;if(')]}'.includes(code[c]))balance--;if(code[c]===':'&&balance===0){colon=c;break;}}
        if(colon>=0)break;
      }
      if(headerEnd>=lines.length)continue;
      const inline=lines[headerEnd].slice(lines[headerEnd].lastIndexOf(':')+1).trim();
      const body=inline?headerEnd:headerEnd+1;
      let end=headerEnd+1;while(end<lines.length){const content=lines[end].trim(),leading=(lines[end].match(/^\s*/)?.[0]??'').replace(/\t/g,'    ').length;if(content&&!content.startsWith('#')&&leading<=indent)break;end++;}
      matches.push({start:i,body,end,indent});
    }
    stack.push({name:match[3],indent});
  }
  if (matches.length!==1) return;
  const {start,body:bodyStart,end}=matches[0];
  if (statement) {const hits=lines.slice(start,end).flatMap((line,index)=>line.includes(statement)?[start+index+1]:[]);return hits.length===1?{line:hits[0],endLine:end}:undefined;}
  // Let the adapter move a function's first body line to its next executable statement.
  let body=bodyStart;while (body<end&&(!lines[body].trim()||lines[body].trimStart().startsWith('#'))) body++;
  return {line:Math.min(body+1,end),endLine:end};
}
