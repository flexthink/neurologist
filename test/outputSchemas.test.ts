import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {analysisOutputSchema,chatOutputSchema,architectureOutputSchema} from '../src/outputSchemas';
import {figureResponseSchema} from '../src/figure';
import {architectureSchema,parseArchitecture,validateArchitecture} from '../src/model';
import {validateChatResponse} from '../src/chat';

function assertStrictObjects(schema:any,path='$') {
  if (!schema||typeof schema!=='object') return;
  for (const keyword of ['oneOf','allOf','not','if','then','else','dependentRequired','dependentSchemas','patternProperties','unevaluatedProperties','exclusiveMinimum','exclusiveMaximum']) {
    assert.ok(!(keyword in schema),`${path}: unsupported strict-output keyword ${keyword}`);
  }
  if (schema.type==='object') {
    assert.equal(schema.additionalProperties,false,`${path}: object must be closed`);
    assert.deepEqual(new Set(schema.required??[]),new Set(Object.keys(schema.properties??{})),`${path}: all properties must be required`);
  }
  for (const [key,value] of Object.entries(schema)) {
    if (Array.isArray(value)) value.forEach((child,index)=>assertStrictObjects(child,`${path}.${key}[${index}]`));
    else if (value&&typeof value==='object') assertStrictObjects(value,`${path}.${key}`);
  }
}
test('every object in analysis, chat and Present! wire schemas satisfies strict structured output',()=>{
  for (const schema of [analysisOutputSchema,chatOutputSchema,figureResponseSchema]) assertStrictObjects(z.toJSONSchema(schema));
});
test('old diagrams without demos remain valid in YAML, chat context and revised responses',()=>{
  const old=parseArchitecture(readFileSync('examples/tiny-encoder.neuro','utf8'));
  assert.equal(old.demos,undefined);
  const original=JSON.stringify(old);
  const fileSchema=z.toJSONSchema(architectureSchema);
  assert.ok(!fileSchema.required?.includes('demos'));
  const revised=validateChatResponse({reply:'Renamed.',sources:[],architecture:{...old,title:'Updated',demos:[]}},'revise');
  assert.deepEqual(revised.architecture?.demos,[]);
  assert.equal(validateArchitecture(old).title,old.title);
  assert.equal(JSON.stringify(old),original);
});
test('wire demo operations use explicit arrays and durations while authoring defaults stay optional',()=>{
  const old=parseArchitecture(readFileSync('examples/tiny-encoder.neuro','utf8'));
  const result=architectureOutputSchema.parse({...old,execution:[],demos:[{name:'Example',description:'',steps:[{duration:3000,operations:[{type:'highlight',nodes:[old.nodes[0].id],edges:[]},{type:'add',nodes:[],edges:[]},{type:'remove',nodes:[],edges:[]}]}]}]});
  assert.equal(validateArchitecture(result).demos?.[0].steps[0].duration,3000);
  assert.doesNotThrow(()=>validateArchitecture({...old,demos:[{name:'Manual',steps:[{operations:[{type:'highlight',nodes:[old.nodes[0].id]}]}]}]}));
});

test('demo operation alternatives emit anyOf and still validate all seven operation kinds',()=>{
  const schema=z.toJSONSchema(chatOutputSchema) as any;
  const architecture=schema.properties.architecture.anyOf.find((item:any)=>item.type==='object');
  const operation=architecture.properties.demos.items.properties.steps.items.properties.operations.items;
  assert.equal(operation.anyOf.length,7);
  assert.equal(operation.oneOf,undefined);
  const old=parseArchitecture(readFileSync('examples/tiny-encoder.neuro','utf8')),target=old.nodes[0].id;
  const operations=[{type:'focus',target},{type:'point',target},{type:'explain',target,text:'Input'},
    {type:'highlight',nodes:[target],edges:[]},{type:'dim',nodes:[],edges:[]},
    {type:'add',nodes:[],edges:[]},{type:'remove',nodes:[],edges:[]}];
  assert.doesNotThrow(()=>architectureOutputSchema.parse({...old,execution:[],demos:[{name:'All operations',description:'',steps:[{duration:3000,operations}]}]}));
  assert.throws(()=>architectureOutputSchema.parse({...old,execution:[],demos:[{name:'Invalid',description:'',steps:[{duration:3000,operations:[{type:'focus',nodes:[],edges:[]}]}]}]}));
});
