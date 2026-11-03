import * as esbuild from 'esbuild';
const options = [
  {entryPoints:['src/extension.ts'],outfile:'dist/extension.js',bundle:true,platform:'node',format:'cjs',external:['vscode'],sourcemap:true},
  {entryPoints:['webview/main.tsx'],outfile:'dist/webview.js',bundle:true,platform:'browser',format:'iife',sourcemap:true,loader:{'.css':'css','.svg':'dataurl'}},
  {entryPoints:['webview/present.tsx'],outfile:'dist/present.js',bundle:true,platform:'browser',format:'iife',sourcemap:true,loader:{'.css':'css','.svg':'dataurl'}},
  {entryPoints:['webview/sidebar.tsx'],outfile:'dist/sidebar.js',bundle:true,platform:'browser',format:'iife',sourcemap:true,loader:{'.css':'css','.svg':'dataurl'}}
];
if(process.argv.includes('--watch')) {
  for (const option of options) { const ctx = await esbuild.context(option); await ctx.watch(); }
} else { await Promise.all(options.map(option => esbuild.build(option))); }
