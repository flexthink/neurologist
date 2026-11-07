import {z} from 'zod';
import {executionAnchorSchema} from './debugModel';
/** A scenario-owned function, evaluated with real references in a stopped frame. */
export const visualizationSpecSchema=z.object({
 id:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),title:z.string().min(1).max(160),node:z.string().min(1),
 language:z.enum(['python','javascript']),code:z.string().min(1).max(100000),function:z.string().regex(/^[a-zA-Z_]\w*$/),
 context:z.array(z.object({name:z.string().regex(/^[a-zA-Z_]\w*$/),expression:z.string().min(1).max(2000)}).strict()).max(30),
 condition:z.string().max(2000),anchor:executionAnchorSchema.nullable()
}).strict();
export const savedVisualizationSchema=visualizationSpecSchema.omit({code:true}).extend({file:z.string().regex(/^\.neurologist\/debug\/[a-zA-Z0-9_-]+\.(py|cjs)$/)}).strict();
export type VisualizationSpec=z.infer<typeof visualizationSpecSchema>;
export type SavedVisualization=z.infer<typeof savedVisualizationSchema>;
export type DebugVisualization=SavedVisualization&{image?:string;error?:string;stale?:boolean;capturedAt?:string;rendering?:boolean};
export const MAX_IMAGE_BYTES=4*1024*1024;
export function pngDataUri(bytes:Uint8Array){
 if(bytes.length>MAX_IMAGE_BYTES)throw new Error('Visualization exceeds the 4 MB image limit.');
 const b=Buffer.from(bytes);if(b.length<33||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||b.toString('ascii',12,16)!=='IHDR')throw new Error('The sidecar must write a PNG image.');
 const width=b.readUInt32BE(16),height=b.readUInt32BE(20);if(!width||!height||width>4096||height>4096||width*height>16000000)throw new Error('Visualization dimensions must be at most 4096 × 4096 (16 megapixels).');
 return 'data:image/png;base64,'+b.toString('base64');
}
export function visualizationExpression(v:SavedVisualization,file:string,output:string,hit:number,scenario:string){
 const metadata={hit,scenario,node:v.node};
 if(v.language==='python'){
  const bindings=v.context.map(c=>JSON.stringify(c.name)+': ('+c.expression+')').join(',');
  // Cache each sidecar module in the debuggee; module globals can retain layer counters/context.
  const directory=file.slice(0,Math.max(file.lastIndexOf('/'),file.lastIndexOf('\\')));
  return `(__import__('sys').path.insert(0, ${JSON.stringify(directory)}) if ${JSON.stringify(directory)} not in __import__('sys').path else None, __import__('neurologist_visualization_bridge').render(${JSON.stringify(file)}, ${JSON.stringify(v.function)}, {${bindings}}, ${JSON.stringify(output)}, ${JSON.stringify(metadata)}))[1]`;
 }
 const bindings=v.context.map(c=>JSON.stringify(c.name)+': ('+c.expression+')').join(',');
 const directory=file.slice(0,Math.max(file.lastIndexOf('/'),file.lastIndexOf('\\')));
 return `require(${JSON.stringify(directory+'/neurologist_visualization_bridge.cjs')}).render(${JSON.stringify(file)},${JSON.stringify(v.function)},{${bindings}},${JSON.stringify(output)},${JSON.stringify(metadata)})`;
}
export const PYTHON_VISUALIZATION_BRIDGE=`"""Neurologist sidecars: run inside the selected debugger frame, never the extension host."""
import importlib.util
import os
import sys
_modules = {}
def render(file, function, context, output, metadata):
    stamp = os.stat(file).st_mtime_ns
    cached = _modules.get(file)
    if cached is None or cached[0] != stamp:
        spec = importlib.util.spec_from_file_location('_neuro_sidecar_' + str(len(_modules)), file)
        module = importlib.util.module_from_spec(spec)
        with open(file, "rb") as source:
            exec(compile(source.read(), file, "exec"), module.__dict__)
        _modules[file] = (stamp, module)
    module = _modules[file][1]
    context['__neurologist'] = metadata
    getattr(module, function)(context, output)
    return 'Neurologist image written'
`;

export const JAVASCRIPT_VISUALIZATION_BRIDGE=`const fs=require('node:fs');
const stamps=new Map();
exports.render=(file,name,context,output,metadata)=>{
 const stamp=fs.statSync(file).mtimeMs;
 if(stamps.get(file)!==stamp){delete require.cache[require.resolve(file)];stamps.set(file,stamp);}
 const sidecar=require(file);context.__neurologist=metadata;
 const result=sidecar[name](context,output);
 if(result&&typeof result.then==='function')throw new Error('Visualization functions must be synchronous.');
 return 'Neurologist image written';
};
`;
