export type ActivityState = 'running' | 'complete' | 'error' | 'cancelled';
export interface Activity {
  id: string; kind: string; label: string; detail: string; state: ActivityState;
  startedAt: number; endedAt?: number;
}
export function reduceActivities(items: Activity[], update: Activity): Activity[] {
  const index = items.findIndex(item => item.id === update.id);
  const previous = items[index];
  const next = {...update, startedAt:previous?.startedAt ?? update.startedAt, detail:update.detail.slice(-12000)};
  const result = index < 0 ? [...items,next] : items.map((item,i) => i === index ? next : item);
  let remaining = 100000;
  return result.slice(-150).reverse().map(item => {
    const detail = remaining > 0 ? item.detail.slice(-remaining) : '';
    remaining -= detail.length;
    return {...item,detail:remaining < 0 ? '' : detail};
  }).reverse();
}
export class ActivityReporter {
  private items: Activity[] = [];
  constructor(private emit: (activity:Activity) => void) {}
  update(id:string, label:string, detail = '', state:ActivityState = 'running', kind = 'step') {
    const previous = this.items.find(item => item.id === id);
    const activity:Activity = {id,kind,label,detail,state,startedAt:previous?.startedAt ?? Date.now(),...(state === 'running' ? {} : {endedAt:Date.now()})};
    this.items = reduceActivities(this.items,activity);
    this.emit(this.items.find(item => item.id === id)!);
  }
  finish(state:ActivityState) {
    for (const item of [...this.items]) if (item.state === 'running') this.update(item.id,item.label,item.detail,state,item.kind);
  }
}

// Decode complete JSONL records, even when UTF-8 chunks or records are split.
export class CodexEventStream {
  private pending = '';
  constructor(private report: ActivityReporter) {}
  push(text:string) {
    this.pending += text;
    let end:number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      this.line(this.pending.slice(0,end)); this.pending = this.pending.slice(end + 1);
    }
    if (this.pending.length > 2_000_000) {this.pending = '';this.report.update('stream-warning','An oversized activity was omitted','See the Neurologist Output channel for the full output.','complete','log');}
  }
  end() {if (this.pending.trim()) this.line(this.pending); this.pending = '';}
  private line(line:string) {
    let event:any; try {event = JSON.parse(line);} catch {return;}
    if (!event || typeof event !== 'object') return;
    if (event.type === 'thread.started') this.report.update('connect','Codex is connected','Reading the codebase with your configured model.','complete','connection');
    if (event.type === 'turn.failed' || event.type === 'error') {
      this.report.update('codex-error','A snag in the synapses',event.error?.message ?? event.message ?? JSON.stringify(event),'error','error'); return;
    }
    const item = event.item;
    if (!item || !['item.started','item.updated','item.completed'].includes(event.type)) return;
    const id = typeof item.id === 'string' ? item.id : `event-${event.type}`;
    const state:ActivityState = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0) ? 'error' : event.type === 'item.completed' ? 'complete' : 'running';
    const type = item.type;
    if (type === 'agent_message') {
      // The structured final reply is rendered elsewhere, once.
      if (typeof item.text === 'string' && !/^\s*[\[{]/.test(item.text)) this.report.update(id,'Field notes',item.text,state,'message');
    } else if (type === 'command_execution') {
      const command = String(item.command ?? '');
      const label = /\b(rg|grep|find)\b/.test(command) ? 'Following the paper trail' : /\b(cat|sed|head|tail)\b/.test(command) ? 'Peeking under the hood' : 'Exploring the codebase';
      this.report.update(id,label,[command,item.aggregated_output,typeof item.exit_code === 'number' ? `Exit code: ${item.exit_code}` : ''].filter(Boolean).join('\n\n'),state,'command');
    } else if (type === 'reasoning') {
      // Keep private reasoning out of the UI; only show an explicit public summary.
      this.report.update(id,'Connecting the dots',typeof item.summary === 'string' ? item.summary : 'Tracing architecture and configuration relationships.',state,'thinking');
    } else if (type === 'todo_list' || type === 'plan') {
      this.report.update(id,'The exploration plan',JSON.stringify(item.items ?? item.plan ?? [],null,2),state,'plan');
    } else {
      this.report.update(id,type === 'web_search' ? 'Looking for context' : 'Checking the evidence',JSON.stringify(item,null,2),state,'tool');
    }
  }
}
