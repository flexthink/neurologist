import { z } from 'zod';
import { parseDocument } from 'yaml';

export const sourceSchema = z.object({
  kind: z.enum(['definition', 'instantiation', 'configuration']),
  file: z.string().min(1), symbol: z.string().min(1)
}).strict();
export const architectureSchema = z.object({
  version: z.literal(1), title: z.string().min(1), summary: z.string(), instructions: z.string(),
  nodes: z.array(z.object({
    id: z.string().min(1), label: z.string().min(1), kind: z.string(), description: z.string(),
    parameters: z.array(z.object({name: z.string(), value: z.string()}).strict()),
    sources: z.array(sourceSchema)
  }).strict()).min(1).max(500),
  edges: z.array(z.object({id: z.string().min(1), source: z.string(), target: z.string(), label: z.string()}).strict()).max(2000)
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
