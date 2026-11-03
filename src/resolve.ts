// Pure fallback for languages without a document symbol provider. No saved line numbers.
export function findSymbolOffsets(text: string, symbol: string): number[] {
  const parts = symbol.split('.');
  const leaf = parts.at(-1)!;
  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`^(?:[ \\t]*(?:(?:export|default|public|private|protected|static|async)\\s+)*(?:(?:class|def|function|const|let|var|interface|type)\\s+))${escaped}\\b|^[ \\t]*(?:self\\.)?${escaped}\\s*(?::[^=\\n]+)?=(?!=)|^[ \\t]*["']?${escaped}["']?\\s*:`, 'gm');
  const hits: number[] = [];
  for (const match of text.matchAll(declaration)) hits.push(match.index! + match[0].lastIndexOf(leaf));
  return hits;
}
