import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseArchitecture} from '../src/model';
import {renderFigureSvg,layoutFigure,validateFigure,figurePrompt,wrapText,type Figure} from '../src/figure';
import {clipboardCommand,decodePng} from '../src/imageClipboard';
const architecture=parseArchitecture(readFileSync('examples/tiny-encoder.neuro','utf8'));
export const sampleFigure:Figure={title:'Tiny encoder',caption:'A minimal residual encoder.',showTitle:true,target:'paper',direction:'LR',palette:'teal',nodes:[{id:'input',label:'Input',subtitle:'',sourceIds:['input']},{id:'encoder',label:'Encoder',subtitle:'',sourceIds:['projection','activation']},{id:'output',label:'Output',subtitle:'',sourceIds:['output']}],edges:[{id:'a',source:'input',target:'encoder',label:''},{id:'b',source:'encoder',target:'output',label:''}]};
test('validates grouping and rejects missing blocks, duplicate IDs and invented source anchors',()=>{
  assert.equal(validateFigure(sampleFigure,architecture).nodes.length,3);
  const clone=()=>structuredClone(sampleFigure);
  const missing=clone();missing.edges[0].source='absent';assert.throws(()=>validateFigure(missing,architecture),/missing block/);
  const duplicate=clone();duplicate.nodes[1].id='input';assert.throws(()=>validateFigure(duplicate,architecture),/Duplicate figure node/);
  const invented=clone();invented.nodes[0].sourceIds=['made-up'];assert.throws(()=>validateFigure(invented,architecture),/unknown architecture node/);
});
test('renders standalone SVG with safe text, arrows, labels, and no external assets',async()=>{
  const figure=structuredClone(sampleFigure);figure.nodes[1].label='<script>alert("x")</script>';figure.edges[0].label='[B, D]';
  const svg=await renderFigureSvg(figure);
  assert.match(svg,/xmlns="http:\/\/www.w3.org\/2000\/svg"/);assert.match(svg,/&lt;script&gt;/);assert.doesNotMatch(svg,/<script|<foreignObject|href=|https:\/\//);assert.match(svg,/marker-end="url\(#arrow\)"/);assert.match(svg,/\[B, D\]/);
});
test('supports vertical layout, monochrome print, hidden titles, and self-loop connections',async()=>{
  const figure=structuredClone(sampleFigure);figure.direction='TB';figure.palette='monochrome';figure.showTitle=false;figure.edges[0].label='   ';figure.edges.push({id:'loop',source:'encoder',target:'encoder',label:'repeat'});
  const svg=await renderFigureSvg(figure);assert.match(svg,/#343434/);assert.match(svg,/repeat/);assert.doesNotMatch(svg,/font-size="24"/);assert.doesNotMatch(svg,/NaN|undefined/);
});
test('presentation prompts match the reference detail and carry refinement context without editing source',()=>{
  assert.match(figurePrompt(architecture,null,[],'','paper'),/SAME LEVEL OF DETAIL/);
  const prompt=figurePrompt(architecture,sampleFigure,[{role:'user',content:'Use fewer labels'}],'Make it vertical','slides');
  assert.match(figurePrompt(architecture,null,[],'','paper'),/Do not produce a three-to-eight-block/);
  assert.match(figurePrompt(architecture,null,[],'','paper'),/never invent attention/);
  assert.match(prompt,/PowerPoint slide/);assert.match(prompt,/Use fewer labels/);assert.match(prompt,/Make it vertical/);assert.match(prompt,/Do not modify files/);
  assert.ok(wrapText('averylongsinglelabelthatneedstobreak',12).every(line=>line.length<=12));
});
test('clipboard image input is bounded and checks PNG signature and dimensions',()=>{
  const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(1200,16);png.writeUInt32BE(800,20);
  const data=()=> 'data:image/png;base64,'+png.toString('base64');assert.equal(decodePng(data()).length,24);
  png.writeUInt32BE(10000,16);assert.throws(()=>decodePng(data()),/dimensions/);assert.throws(()=>decodePng('data:image/png;base64,AAAA'),/signature/);assert.throws(()=>decodePng('https://example.com/image.png'),/Invalid PNG/);
});
test('native clipboard commands pass file paths as data, including quotes',()=>{
  const mac=clipboardCommand('darwin','/tmp/a"b.png')[0];assert.equal(mac.file,'/usr/bin/osascript');assert.ok(mac.args[1].includes('a\\"b.png'));
  const windows=clipboardCommand('win32',"C:\\a'b.png")[0];assert.ok(windows.args.includes('-STA'));assert.ok(windows.args.at(-1)?.includes("a''b.png"));
  assert.deepEqual(clipboardCommand('linux','/tmp/a.png')[0],{file:'wl-copy',args:['--type','image/png']});
});

test('reference style renders role colors, repeat frames, circled additions and bottom-up flow',async()=>{
  const figure=JSON.parse(readFileSync('test/fixtures/transformer-style.json','utf8'));
  const source=parseArchitecture(readFileSync('examples/transformer-encoder.neuro','utf8'));
  const validated=validateFigure(figure,source),svg=await renderFigureSvg(validated);
  for (const color of ['#ffe1b9','#c3e7f4','#f8f5b9','#f9dfe0','#ddddea','#d0e8cf']) assert.ok(svg.includes(color),color);
  assert.match(svg,/data-group="encoder"/);assert.match(svg,/6×/);assert.match(svg,/<circle/);assert.match(svg,/stroke="#111"/);assert.match(svg,/Arial/);assert.doesNotMatch(svg,/NaN|undefined/);
  const input=svg.match(/data-node="inputs"[^]*?<text[^]*? y="([\d.]+)"/);
  const output=svg.match(/data-node="outputs"[^]*?<text[^]*? y="([\d.]+)"/);
  assert.ok(Number(input?.[1])>Number(output?.[1]),'Inputs must be below outputs in the reference layout');
});
test('groups reject missing, duplicated and multiply grouped blocks',()=>{
  const figure=structuredClone(sampleFigure);
  figure.groups=[{id:'frame',label:'',repeat:'',nodeIds:['missing']}];assert.throws(()=>validateFigure(figure,architecture),/missing block/);
  figure.groups=[{id:'input',label:'',repeat:'',nodeIds:['input']}];assert.throws(()=>validateFigure(figure,architecture),/Duplicate figure group/);
  figure.groups=[{id:'frame',label:'',repeat:'',nodeIds:['input','input']}];assert.throws(()=>validateFigure(figure,architecture),/one group/);
});
test('older saved figures without kinds or groups remain readable',async()=>{
  const figure=validateFigure(sampleFigure,architecture);assert.deepEqual(figure.groups,[]);assert.equal(figure.nodes[0].kind,'operation');
  assert.ok((await renderFigureSvg(figure)).startsWith('<svg'));
});

test('rejects disconnected inventories of blocks and isolated additions',async()=>{
  const figure=structuredClone(sampleFigure);figure.edges=[];
  assert.throws(()=>validateFigure(figure,architecture),/disconnected blocks/);
  await assert.rejects(()=>renderFigureSvg(figure),/disconnected blocks/);
  figure.edges=[{id:'one',source:'input',target:'encoder',label:''},{id:'self',source:'output',target:'output',label:''}];
  assert.throws(()=>validateFigure(figure,architecture),/disconnected blocks: Output/);
});
test('recovers missing connections from YAML provenance without changing the input',async()=>{
  const {recoverFigureConnections}=await import('../src/figure');
  const figure=structuredClone(sampleFigure);figure.edges=[];
  const fixed=recoverFigureConnections(figure,architecture);
  assert.equal(figure.edges.length,0);assert.equal(fixed.edges.length,2);
  assert.ok(fixed.edges.some(edge=>edge.source==='input'&&edge.target==='encoder'));
  assert.ok(fixed.edges.some(edge=>edge.source==='encoder'&&edge.target==='output'));
  assert.equal(validateFigure(fixed,architecture).nodes.length,3);
  assert.equal(recoverFigureConnections(fixed,architecture).edges.length,2);
});
test('recovery preserves source branches and does not guess connections for ambiguous sublayers',async()=>{
  const {recoverFigureConnections}=await import('../src/figure');
  const figure=JSON.parse(readFileSync('test/fixtures/transformer-style.json','utf8'));
  const source=parseArchitecture(readFileSync('examples/transformer-encoder.neuro','utf8'));
  figure.edges=[];const fixed=recoverFigureConnections(figure,source);
  assert.ok(fixed.edges.some(edge=>edge.source==='add'&&edge.target==='norm1'));
  assert.ok(fixed.edges.some(edge=>edge.source==='norm1'&&edge.target==='norm2'));
  assert.equal(fixed.edges.length,source.edges.length);
  const ambiguous=structuredClone(sampleFigure);ambiguous.edges=[];ambiguous.nodes[1].sourceIds=['input'];
  assert.throws(()=>validateFigure(recoverFigureConnections(ambiguous,architecture),architecture),/disconnected blocks/);
});
test('connectivity instruction distinguishes graph preservation from parameter minimalism',()=>{
  const prompt=figurePrompt(architecture,null,[],'','paper');
  assert.match(prompt,/NEVER means removing arrows/);assert.match(prompt,/hyperparameter inventories/);assert.match(prompt,/explicit edges/);assert.match(prompt,/every source-grounded block/);
});

function checkGeometry(figure:Figure,layout:Awaited<ReturnType<typeof layoutFigure>>) {
  const eps=0.01,box=(id:string)=>{const n=layout.nodes.get(id)!;return {l:n.x-n.width/2,r:n.x+n.width/2,t:n.y-n.height/2,b:n.y+n.height/2};};
  for (const [i,a] of figure.nodes.entries()) for (const b of figure.nodes.slice(i+1)) {
    const x=box(a.id),y=box(b.id);assert.ok(x.r<=y.l+eps||y.r<=x.l+eps||x.b<=y.t+eps||y.b<=x.t+eps,`overlap: ${a.id}, ${b.id}`);
  }
  for (const group of figure.groups??[]) for (const id of group.nodeIds) {
    const g=box(group.id),n=box(id);assert.ok(n.l>=g.l&&n.r<=g.r&&n.t>=g.t&&n.b<=g.b,'group containment');
  }
  const touches=(p:{x:number;y:number},id:string)=>{const b=box(id);return ((Math.abs(p.x-b.l)<eps||Math.abs(p.x-b.r)<eps)&&p.y>=b.t-eps&&p.y<=b.b+eps)||((Math.abs(p.y-b.t)<eps||Math.abs(p.y-b.b)<eps)&&p.x>=b.l-eps&&p.x<=b.r+eps);};
  for (const edge of figure.edges) {
    const routed=layout.edges.get(edge.id)!;assert.ok(routed,'missing edge '+edge.id);
    assert.ok(routed.sections.some(s=>touches(s.points[0],edge.source)),'source attachment '+edge.id);
    assert.ok(routed.sections.some(s=>s.arrow&&touches(s.points.at(-1)!,edge.target)),'target arrow '+edge.id);
    for (const section of routed.sections) for (let i=1;i<section.points.length;i++) {
      const a=section.points[i-1],b=section.points[i];assert.ok(Math.abs(a.x-b.x)<eps||Math.abs(a.y-b.y)<eps,'orthogonal route');
      for (const node of figure.nodes) {
        if (node.id===edge.source||node.id===edge.target) continue;
        const n=box(node.id);
        const crosses=Math.abs(a.x-b.x)<eps ? a.x>n.l+eps&&a.x<n.r-eps&&Math.max(a.y,b.y)>n.t+eps&&Math.min(a.y,b.y)<n.b-eps : a.y>n.t+eps&&a.y<n.b-eps&&Math.max(a.x,b.x)>n.l+eps&&Math.min(a.x,b.x)<n.r-eps;
        assert.ok(!crosses,`edge ${edge.id} crosses ${node.id}`);
      }
    }
  }
}
test('ELK routes grouped residual stacks without overlapping blocks or crossing unrelated blocks',async()=>{
  const figure:Figure=JSON.parse(readFileSync('test/fixtures/transformer-style.json','utf8'));
  for (const direction of ['BT','TB','LR'] as const) {figure.direction=direction;checkGeometry(figure,await layoutFigure(figure));}
});
test('ELK preserves cross-group branches, labeled edges, cycles and parallel connections',async()=>{
  const figure:Figure={...structuredClone(sampleFigure),nodes:['a','b','c','d','e','f'].map(id=>({id,label:id,subtitle:'',sourceIds:[]})),groups:[{id:'left',label:'Encoder',repeat:'6×',nodeIds:['b','c']},{id:'right',label:'Decoder',repeat:'6×',nodeIds:['d','e']}],edges:[['a','b'],['b','c'],['c','d'],['a','d'],['d','e'],['e','f'],['c','e'],['e','d'],['a','b']].map(([source,target],i)=>({id:String(i),source,target,label:i===3?'conditioning':''}))};
  const layout=await layoutFigure(figure);checkGeometry(figure,layout);
  const svg=await renderFigureSvg(figure);assert.equal((svg.match(/data-edge=/g)??[]).length,figure.edges.length);
  assert.match(svg,/conditioning/);assert.match(figurePrompt(architecture,null,[],'','paper'),/ELK.js/);
});
