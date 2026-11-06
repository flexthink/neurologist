import {executionAnchorSchema} from './debugModel';
import { z } from 'zod';
import { parseDocument } from 'yaml';

export const sourceSchema = z.object({
  kind: z.enum(['definition', 'instantiation', 'configuration']),
  file: z.string().min(1), symbol: z.string().min(1)
}).strict();
const nodeSchema = z.object({
  id: z.string().min(1), label: z.string().min(1), kind: z.string(), description: z.string(),
  parameters: z.array(z.object({name:z.string(), value:z.string()}).strict()), sources: z.array(sourceSchema)
}).strict();
const edgeSchema = z.object({id:z.string().min(1), source:z.string().min(1), target:z.string().min(1), label:z.string()}).strict();
const ids = z.array(z.string().min(1)).optional();
export const demoOperationSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('focus'), target:z.string().min(1)}).strict(),
  z.object({type:z.literal('point'), target:z.string().min(1)}).strict(),
  z.object({type:z.literal('explain'), target:z.string().min(1), text:z.string()}).strict(),
  z.object({type:z.literal('highlight'), nodes:ids, edges:ids}).strict(),
  z.object({type:z.literal('dim'), nodes:ids, edges:ids}).strict(),
  z.object({type:z.literal('add'), nodes:z.array(nodeSchema).optional(), edges:z.array(edgeSchema).optional()}).strict(),
  z.object({type:z.literal('remove'), nodes:ids, edges:ids}).strict()
]);
export const demoSchema = z.object({name:z.string().min(1), description:z.string().optional(), steps:z.array(z.object({duration:z.number().finite().positive().optional(), operations:z.array(demoOperationSchema)}).strict()).min(1)}).strict();
export type Demo = z.infer<typeof demoSchema>;
export const architectureSchema = z.object({
  version: z.literal(1), title: z.string().min(1), summary: z.string(), instructions: z.string(),
  nodes: z.array(nodeSchema).min(1).max(500),
  edges: z.array(edgeSchema).max(2000),
  demos: z.array(demoSchema).optional(),
  execution: z.array(executionAnchorSchema).max(1000).optional()
}).strict();
export type Architecture = z.infer<typeof architectureSchema>;
export type SourceLink = z.infer<typeof sourceSchema>;
export const analysisSchema = z.object({architectures: z.array(architectureSchema).max(20)}).strict();

export function validateArchitecture(value: unknown): Architecture {
  const result = architectureSchema.parse(value);
  const ids = new Set<string>();
  for (const node of result.nodes) {
    if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
    for (const link of node.sources) if (!safeRelativePath(link.file)) throw new Error(`Source path must be workspace-relative: ${link.file}`);
  }
  const edges = new Set<string>();
  for (const edge of result.edges) {
    if (edges.has(edge.id)) throw new Error(`Duplicate edge id: ${edge.id}`);
    edges.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error(`Edge ${edge.id} references a missing node`);
  }
  for (const anchor of result.execution??[]) {
    if (!ids.has(anchor.node)) throw new Error(`Execution anchor references a missing node: ${anchor.node}`);
    if (!safeRelativePath(anchor.file)) throw new Error(`Execution anchor path must be workspace-relative: ${anchor.file}`);
  }
  return result;
}
export function parseArchitecture(text: string): Architecture {
  const doc = parseDocument(text, {uniqueKeys: true});
  if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join('\n'));
  return validateArchitecture(doc.toJS({maxAliasCount: 50}));
}
export function safeRelativePath(file: string): boolean {
  return !!file && !/^(?:[a-z]+:|[\\/])/i.test(file) && !file.split(/[\\/]/).some(p => p === '..') && !file.includes('\0');
}
