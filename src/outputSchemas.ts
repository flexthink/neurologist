import {executionAnchorSchema} from './debugModel';
import {z} from 'zod';
import {architectureSchema,demoSchema,demoOperationSchema} from './model';
import {chatResponseSchema} from './chat';

// Codex structured output requires every object property to be required.
// Keep authoring schemas permissive: existing .neuro files need no demos,
// and manually authored demo fields may still use their documented defaults.
const [focus,point,explain,highlight,dim,add,remove]=demoOperationSchema.options;
// A plain union emits anyOf; discriminatedUnion emits oneOf, rejected by Codex.
const operations=z.union([
  focus,point,explain,
  highlight.extend({nodes:highlight.shape.nodes.unwrap(),edges:highlight.shape.edges.unwrap()}),
  dim.extend({nodes:dim.shape.nodes.unwrap(),edges:dim.shape.edges.unwrap()}),
  add.extend({nodes:add.shape.nodes.unwrap(),edges:add.shape.edges.unwrap()}),
  remove.extend({nodes:remove.shape.nodes.unwrap(),edges:remove.shape.edges.unwrap()})
]);
const demoOutputSchema=demoSchema.extend({
  description:z.string(),
  steps:z.array(demoSchema.shape.steps.element.extend({
    duration:z.number().int().min(1),
    operations:z.array(operations)
  })).min(1)
});
export const architectureOutputSchema=architectureSchema.extend({demos:z.array(demoOutputSchema),execution:z.array(executionAnchorSchema).max(1000)});
export const analysisOutputSchema=z.object({architectures:z.array(architectureOutputSchema).max(20)}).strict();
export const chatOutputSchema=chatResponseSchema.extend({architecture:architectureOutputSchema.nullable()});
export const demoOutputInstructions='For structured output, always include demos (use [] when there are none). Preserve existing demos when revising unless asked to change them. Do not invent walkthroughs unless requested. Within demos use an empty description when absent, duration=3000 when unspecified, and empty nodes/edges arrays for optional operation collections. Also include execution (use [] if unresolved). Each execution anchor maps node to a workspace-relative file and qualified forward or invocation symbol, kind=forward/invocation and statement (a unique literal source snippet inside the symbol, or empty for function entry). Never use stored line numbers. Preserve existing execution anchors where valid. Existing source diagrams may omit demos and execution entirely.';
