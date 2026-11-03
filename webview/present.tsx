import {ModelPicker,useModelSettings} from './ModelPicker';
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import {Logo} from './Logo';
import {Progress} from './Progress';
import {reduceActivities,type Activity} from '../src/progress';
import type {Figure,FigureTurn} from '../src/figure';
import './style.css';
import './present.css';
declare function acquireVsCodeApi():{postMessage(message:unknown):void;getState():unknown;setState(state:unknown):void};
const vscode=acquireVsCodeApi();
async function pngImage(svg:string):Promise<string> {
  const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
  try {
    const image=new Image();image.src=url;await image.decode();
    const scale=Math.min(2,8192/Math.max(image.naturalWidth,image.naturalHeight));
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(image.naturalWidth*scale);canvas.height=Math.ceil(image.naturalHeight*scale);
    const ctx=canvas.getContext('2d');if (!ctx) throw new Error('Image export is unavailable.');
    ctx.drawImage(image,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/png');
  } finally {URL.revokeObjectURL(url);}
}
function Present() {
  const modelPicker=useModelSettings(message=>vscode.postMessage(message));
  const [svg,setSvg]=useState('');
  const saved=vscode.getState() as {draft?:string}|undefined;
  const [figure,setFigure]=useState<Figure|null>(null),[source,setSource]=useState('');
  const [messages,setMessages]=useState<FigureTurn[]>([]),[draft,setDraft]=useState(saved?.draft ?? '');
  const [busy,setBusy]=useState(false),[canUndo,setCanUndo]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [activities,setActivities]=useState<Activity[]>([]),[title,setTitle]=useState('');
  const [exporting,setExporting]=useState(false);
  const [zoom,setZoom]=useState(1);
  const [panning,setPanning]=useState(false);
  const drag=useRef<{pointerId:number;x:number;y:number;left:number;top:number}|null>(null);
  const viewport=useRef<HTMLDivElement>(null),figureImage=useRef<HTMLImageElement>(null);
  const zoomRef=useRef(1);
  const pending=useRef(''),end=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const listener=(event:MessageEvent)=>{
      const message=event.data;
      if (message.type==='presentation') {
        setSvg(message.svg ?? '');
        setFigure(message.figure);setSource(message.source);setMessages(message.messages);setCanUndo(message.canUndo);
        if (pending.current && message.messages.some((turn:FigureTurn)=>turn.role==='user'&&turn.content===pending.current)) {const sent=pending.current;setDraft(current=>current.trim()===sent ? '' : current);pending.current='';}
      }
      if (message.type==='busy') setBusy(message.value);
      if (message.type==='activityReset') {setActivities([]);setTitle(message.title);setError('');setNotice('');}
      if (message.type==='activity') setActivities(current=>reduceActivities(current,message.activity));
      if (message.type==='operationError') {setError(message.message);pending.current='';}
      if (message.type==='notice') setNotice(message.message);
    };
    window.addEventListener('message',listener);vscode.postMessage({type:'ready'});return()=>window.removeEventListener('message',listener);
  },[]);
  useEffect(()=>{vscode.setState({draft});},[draft]);
  useEffect(()=>{end.current?.scrollIntoView({block:'nearest'});},[messages.length]);

  const dimensions=svg.match(/width="(\d+)" height="(\d+)"/);
  const width=Number(dimensions?.[1] ?? 320),height=Number(dimensions?.[2] ?? 200);
  function changeZoom(value:number,clientX?:number,clientY?:number) {
    const stage=viewport.current,image=figureImage.current;
    if (!stage||!image) return;
    const bounds=stage.getBoundingClientRect(),imageBounds=image.getBoundingClientRect();
    const x=clientX ?? bounds.left+stage.clientWidth/2,y=clientY ?? bounds.top+stage.clientHeight/2;
    const imageX=(x-imageBounds.left)/zoomRef.current,imageY=(y-imageBounds.top)/zoomRef.current;
    const next=Math.min(4,Math.max(0.02,value));zoomRef.current=next;setZoom(next);
    requestAnimationFrame(()=>{const after=figureImage.current?.getBoundingClientRect();if (after) {stage.scrollLeft+=after.left+imageX*next-x;stage.scrollTop+=after.top+imageY*next-y;}});
  }
  function fitFigure() {const stage=viewport.current;if (stage) changeZoom(Math.min((stage.clientWidth-56)/width,(stage.clientHeight-56)/height));}
  useEffect(()=>{zoomRef.current=1;setZoom(1);viewport.current?.scrollTo(0,0);},[svg]);
  useEffect(()=>{
    const stage=viewport.current;if (!stage) return;
    const wheel=(event:WheelEvent)=>{if (!event.ctrlKey&&!event.metaKey) return;event.preventDefault();changeZoom(zoomRef.current*(event.deltaY<0 ? 1.12 : 1/1.12),event.clientX,event.clientY);};
    stage.addEventListener('wheel',wheel,{passive:false});return()=>stage.removeEventListener('wheel',wheel);
  },[!!figure]);
  function startPan(event:React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType!=='mouse'||event.button!==0) return;
    const stage=event.currentTarget;
    event.preventDefault();stage.focus({preventScroll:true});
    drag.current={pointerId:event.pointerId,x:event.clientX,y:event.clientY,left:stage.scrollLeft,top:stage.scrollTop};
    stage.setPointerCapture(event.pointerId);setPanning(true);
  }
  function movePan(event:React.PointerEvent<HTMLDivElement>) {
    const active=drag.current;if (!active||active.pointerId!==event.pointerId) return;
    event.preventDefault();event.currentTarget.scrollLeft=active.left-(event.clientX-active.x);event.currentTarget.scrollTop=active.top-(event.clientY-active.y);
  }
  function stopPan(event:React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId!==event.pointerId) return;
    drag.current=null;setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function send() {if (busy||!draft.trim()||pending.current) return;pending.current=draft.trim();setError('');vscode.postMessage({type:'refine',message:draft.trim()});}
  async function imageAction(type:'copyImage'|'export') {
    if (!figure||busy||exporting) return;
    setExporting(true);setError('');setNotice('');
    try {vscode.postMessage({type,format:'png',png:await pngImage(svg)});}catch(error) {setError(error instanceof Error ? error.message : String(error));}finally {setExporting(false);}
  }
  return <main className="presentApp"><header><div className="brand"><Logo/><div><strong>Present!</strong><span className="subtitle">Neurologist · From architecture to figure</span></div></div><div className="headerActions"><span className="badge">{source}</span>{figure && <><button disabled={busy||!canUndo} onClick={()=>vscode.postMessage({type:'undo'})}>Undo refinement</button><button disabled={busy} onClick={()=>vscode.postMessage({type:'draft',target:figure.target})}>New draft</button></>}</div></header><Progress items={activities} title={title} busy={busy} onCancel={()=>vscode.postMessage({type:'cancel'})}/>{error && <div className="operationError" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={()=>setError('')}>×</button></div>}{notice && <div className="presentNotice" role="status">✓ {notice}</div>}{figure ? <div className="presentWorkspace"><section className="figurePanel" aria-label="Presentation figure"><div className="figureToolbar"><div><label htmlFor="figureTarget">Format</label><select id="figureTarget" value={figure.target} disabled={busy} onChange={event=>vscode.postMessage({type:'refine',target:event.target.value,message:`Adapt this figure for ${event.target.value==='paper' ? 'an academic paper' : 'a PowerPoint slide'}, keeping the same architecture, reference-inspired style, and sublayer-level detail.`})}><option value="paper">Paper figure</option><option value="slides">PowerPoint slide</option></select></div><div className="figureZoom" role="group" aria-label="Figure zoom"><button aria-label="Zoom out" disabled={zoom<=0.02} onClick={()=>changeZoom(zoomRef.current/1.25)}>−</button><output aria-label="Zoom level">{Math.round(zoom*100)}%</output><button aria-label="Zoom in" disabled={zoom>=4} onClick={()=>changeZoom(zoomRef.current*1.25)}>+</button><button onClick={()=>changeZoom(1)}>100%</button><button onClick={fitFigure}>Fit</button></div><div className="figureActions"><button className="primary" disabled={busy||exporting} onClick={()=>void imageAction('copyImage')}>{exporting ? 'Preparing image…' : 'Copy image'}</button><button disabled={busy||exporting} onClick={()=>void imageAction('export')}>Export PNG</button><button disabled={busy} onClick={()=>vscode.postMessage({type:'export',format:'svg'})}>Export SVG</button><button disabled={busy} onClick={()=>vscode.postMessage({type:'copySvg'})}>Copy SVG source</button></div></div><div className={`figureStage ${panning ? 'panning' : ''}`} ref={viewport} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={stopPan} onPointerCancel={stopPan} onLostPointerCapture={stopPan} tabIndex={0} role="region" aria-label="Scrollable figure preview"><div className="figureSurface"><img className="figureImage" ref={figureImage} draggable={false} width={Math.round(width*zoom)} height={Math.round(height*zoom)} alt={figure.title || 'Presentation diagram'} src={'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)}/></div></div>{figure.caption && <details className="figureCaptionDetails"><summary><span className="captionChevron" aria-hidden="true">▸</span> Caption</summary><p className="figureCaption">{figure.caption}</p></details>}<p className="figureFootnote">Drag to pan · Scroll to explore · Ctrl/Cmd + wheel to zoom · Copy and export always use the full figure</p></section><aside className="chatPanel presentChat" aria-label="Refine presentation"><div className="chatHeading"><div><span className="eyebrow">CLEAR FLOW. LESS CLUTTER.</span><h2>Make it yours</h2></div></div><p className="modeHint">Refine the figure for your audience. Simplify labels and parameter clutter while preserving the full computational flow.</p><div className="transcript" role="log" aria-label="Presentation conversation">{messages.map((turn,index)=><article className={`chatTurn ${turn.role}`} key={index}><div className="turnLabel">{turn.role==='user' ? 'You' : 'Neurologist'}</div><div className="turnText"><ReactMarkdown skipHtml components={{a:({children})=><span>{children}</span>,img:()=>null}}>{turn.content}</ReactMarkdown></div></article>)}{busy && <p className="chatWorking" role="status"><span className="pulse">✦</span> Polishing the big picture…</p>}<div ref={end}/></div><div className="presentSuggestions">{['Make it vertical','Use a monochrome palette','Group repeated blocks'].map(text=><button disabled={busy} key={text} onClick={()=>setDraft(text)}>{text} ↗</button>)}</div><form className="chatComposer" onSubmit={event=>{event.preventDefault();send();}}><label htmlFor="presentRequest">Refine this figure</label><textarea id="presentRequest" maxLength={12000} value={draft} onChange={event=>setDraft(event.target.value)} disabled={busy} placeholder="Keep all arrows and residual paths; hide numeric hyperparameters…" onKeyDown={event=>{if (event.key==='Enter'&&(event.metaKey||event.ctrlKey)) {event.preventDefault();send();}}}/><ModelPicker {...modelPicker} disabled={busy}/><div className="composerActions"><small>⌘ / Ctrl + Enter to send</small><button type="submit" className="primary" disabled={busy||!draft.trim()}>Refine →</button></div></form></aside></div> : <section className="presentEmpty"><div className={busy ? 'presentGlyph pulse' : 'presentGlyph'}>✧</div><h1>{busy ? 'Finding the big picture' : 'Your first presentation draft'}</h1><p>Codex turns the YAML architecture into a figure with the style and sublayer detail of Attention Is All You Need, Figure 1. Once it is ready, chat will open here to help you refine it.</p><ModelPicker {...modelPicker} disabled={busy}/>{!busy && <button className="primary" onClick={()=>vscode.postMessage({type:'draft',target:'paper'})}>Create draft</button>}</section>}</main>;
}
createRoot(document.getElementById('root')!).render(<Present/>);
