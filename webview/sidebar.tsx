import {ModelPicker,useModelSettings} from './ModelPicker';
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Logo} from './Logo';
import './sidebar.css';
declare function acquireVsCodeApi():{postMessage(message:unknown):void;getState():unknown;setState(state:unknown):void};
const vscode=acquireVsCodeApi();
export function Sidebar() {
  const saved=vscode.getState() as {instructions?:string;folder?:string} | undefined;
  const [instructions,setInstructions]=useState(saved?.instructions ?? '');
  const [folder,setFolder]=useState(saved?.folder ?? '');
  const modelPicker=useModelSettings(message=>vscode.postMessage(message),folder);
  const [folders,setFolders]=useState<{uri:string;name:string}[]>([]);
  const [error,setError]=useState('');
  useEffect(() => {
    const listener=(event:MessageEvent) => {
      if (event.data.type==='folders') {
        const next=event.data.folders;setFolders(next);
        setFolder(current => next.some((item:{uri:string}) => item.uri===current) ? current : next[0]?.uri ?? '');
      }
      if (event.data.type==='error'||event.data.type==='operationError') setError(event.data.message);
    };
    window.addEventListener('message',listener);vscode.postMessage({type:'ready'});
    return () => window.removeEventListener('message',listener);
  },[]);
  useEffect(() => {vscode.setState({instructions,folder});},[instructions,folder]);
  return <main><div className="sidebarBrand"><Logo/><div><strong>Neurologist</strong><span>Follow the neural pathways.</span></div></div><p className="intro">Turn source and configuration into an architecture you can explore.</p><form onSubmit={event => {event.preventDefault();setError('');vscode.postMessage({type:'analyze',instructions,folder});}}>{folders.length>1 && <><label htmlFor="workspace">Codebase</label><select id="workspace" value={folder} onChange={event => setFolder(event.target.value)}>{folders.map(item => <option key={item.uri} value={item.uri}>{item.name}</option>)}</select></>}<label htmlFor="sidebarInstructions">Instructions <span>optional</span></label><textarea id="sidebarInstructions" maxLength={12000} placeholder="Focus on the encoder. Follow HyperPyYAML configuration…" value={instructions} onChange={event => setInstructions(event.target.value)}/><ModelPicker {...modelPicker} disabled={!folder}/><button type="submit" disabled={!folder}>Analyze codebase →</button></form>{!folders.length && <p className="hint">Open a codebase folder to get started.</p>}{error && <p className="error" role="alert">{error}</p>}<p className="hint">Progress opens in an editor tab. Pick a diagram below to explore or chat.</p></main>;
}
createRoot(document.getElementById('root')!).render(<Sidebar/>);
