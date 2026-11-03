import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {dirname,delimiter} from 'node:path';
import {z} from 'zod';
import {resolveCodexExecutable} from './executable';

export const modelSelectionSchema=z.object({model:z.string().trim().max(200).refine(value=>!/[\r\n\0]/.test(value)),effort:z.string().regex(/^$|^[a-z][a-z0-9_-]{0,31}$/)});
export type ModelSelection=z.infer<typeof modelSelectionSchema>;
export interface CodexModel {model:string;displayName:string;defaultReasoningEffort:string;supportedReasoningEfforts:{reasoningEffort:string;description:string}[];isDefault:boolean;}
export interface ModelSettings {selection:ModelSelection;models:CodexModel[];loading:boolean;error:string;folder:string;}
const catalogEntry=z.object({model:z.string().min(1).max(200),displayName:z.string().default(''),hidden:z.boolean().default(false),defaultReasoningEffort:z.string().default(''),supportedReasoningEfforts:z.array(z.object({reasoningEffort:z.string(),description:z.string().default('')})).default([]),isDefault:z.boolean().default(false)});

/** Metadata only: initialize + model/list. Never starts a thread or model turn. */
export async function discoverModels(options:{executable:string;cwd:string;timeoutMs?:number}):Promise<CodexModel[]> {
  const executable=await resolveCodexExecutable(options.executable,{cwd:options.cwd});
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,['app-server'],{cwd:options.cwd,env:{...process.env,PATH:[process.env.PATH,dirname(executable)].filter(Boolean).join(delimiter)},shell:false,stdio:['pipe','pipe','pipe']});
    let finished=false,buffer='',bytes=0,id=1,pages=0;const models:CodexModel[]=[],cursors=new Set<string>(),decoder=new StringDecoder('utf8');
    const timer=setTimeout(()=>finish(new Error('Codex model discovery timed out. Use Codex default or retry.')),options.timeoutMs??15000);
    function finish(error?:Error) {if (finished) return;finished=true;clearTimeout(timer);child.stdin.end();child.kill();error ? reject(error) : resolve([...new Map(models.map(model=>[model.model,model])).values()]);}
    function send(message:unknown) {child.stdin.write(JSON.stringify(message)+'\n');}
    child.on('error',error=>finish(error));child.stdin.on('error',error=>finish(error));
    child.on('close',()=>finish(new Error('Codex model discovery ended before returning a catalog. Use Codex default or retry.')));
    child.stderr.on('data',()=>{}); // Drain diagnostics without exposing account/configuration details to the webview.
    child.stdout.on('data',(data:Buffer)=>{
      if (finished) return;bytes+=data.length;if (bytes>4*1024*1024) {finish(new Error('Codex model catalog exceeded the size limit.'));return;}
      buffer+=decoder.write(data);let newline:number;
      while (!finished&&(newline=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        try {
          const response=JSON.parse(line);if (response.id!==id) continue;
          if (response.error) throw new Error('Codex could not list models: '+String(response.error.message??'unknown error').slice(0,500));
          if (id===1) {send({method:'initialized',params:{}});send({id:++id,method:'model/list',params:{limit:100,includeHidden:false}});continue;}
          const page=z.object({data:z.array(catalogEntry),nextCursor:z.string().nullable().optional()}).parse(response.result);
          models.push(...page.data.filter(model=>!model.hidden));
          if (!page.nextCursor) {finish();continue;}
          if (cursors.has(page.nextCursor)||++pages>=20) throw new Error('Codex returned an invalid model catalog cursor.');
          cursors.add(page.nextCursor);send({id:++id,method:'model/list',params:{limit:100,includeHidden:false,cursor:page.nextCursor}});
        } catch (error) {finish(error instanceof Error ? error : new Error(String(error)));}
      }
    });
    send({id,method:'initialize',params:{clientInfo:{name:'neurologist',title:'Neurologist',version:'0.8.0'}}});
  });
}
