import React, {useEffect,useState} from 'react';
import type {Activity} from '../src/progress';
const icons:Record<string,string> = {command:'⌘',thinking:'✦',connection:'↗',message:'✎',plan:'☷',tool:'⌕',error:'!'};
function elapsed(ms:number) {const seconds=Math.max(0,Math.floor(ms/1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds/60)}m ${seconds%60}s`;}
export function Progress({items,title,busy,onCancel}:{items:Activity[];title:string;busy:boolean;onCancel:() => void}) {
  const [now,setNow] = useState(Date.now());
  useEffect(() => {if (!busy) return;setNow(Date.now());const timer=setInterval(() => setNow(Date.now()),1000);return () => clearInterval(timer);},[busy]);
  if (!items.length && !busy) return null;
  const last=items.at(-1), failed=items.some(item => item.state==='error'), cancelled=items.some(item => item.state==='cancelled');
  const startedAt=items[0]?.startedAt ?? now;
  const completed=items.filter(item => item.state==='complete').length;
  return <section className="activityPanel" aria-label="Exploration activity"><details open={busy || undefined}><summary className="activitySummary"><span className={busy ? 'spark pulse' : 'spark'}>{busy ? '✦' : failed ? '!' : cancelled ? 'Ⅱ' : '✓'}</span><strong>{title || 'Exploration activity'}</strong><span className="activityCount">{busy ? `${items.length} steps` : `${completed}/${items.length} steps complete`}</span><time>{elapsed((busy ? now : last?.endedAt ?? now)-startedAt)}</time><span className="disclosure">⌄</span></summary><div className="activityList">{items.map(item => <details className={`activityStep ${item.state}`} key={item.id} open={item.state === 'error' || undefined}><summary><span className={item.state === 'running' ? 'stepIcon pulse' : 'stepIcon'}>{item.state === 'complete' ? '✓' : item.state === 'cancelled' ? 'Ⅱ' : icons[item.kind] ?? '✦'}</span><span>{item.label}</span><span className="stepState">{item.state === 'running' ? 'in motion' : item.state}</span><span className="disclosure">›</span></summary><pre>{item.detail || 'Waiting for the next activity update…'}</pre></details>)}</div></details>{busy && <div className="activityFooter"><span role="status">{items.filter(item => item.state==='running').at(-1)?.label ?? 'Waiting for Codex…'}</span><button onClick={onCancel}>Cancel exploration</button></div>}</section>;
}
