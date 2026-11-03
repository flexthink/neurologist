import type {ModelSettings} from './modelSettings';
import * as vscode from 'vscode';
import {randomBytes} from 'node:crypto';
import {parseArchitecture} from './model';
import {presentFigure} from './codex';
import {renderFigureSvg,validateFigure,recoverFigureConnections,type Figure,type FigureTurn,type FigureTarget} from './figure';
import {ActivityReporter,reduceActivities,type Activity} from './progress';
import {copyPng,decodePng} from './imageClipboard';

export function registerPresent(context:vscode.ExtensionContext,output:vscode.OutputChannel,modelSettings:ModelSettings) {
  const panels=new Map<string,vscode.WebviewPanel>();
  context.subscriptions.push(vscode.commands.registerCommand('neurologist.present',async (resource?:vscode.Uri|{uri?:vscode.Uri}) => {
    try {
      const active=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      const uri=resource instanceof vscode.Uri ? resource : resource?.uri ?? (active instanceof vscode.TabInputCustom || active instanceof vscode.TabInputText ? active.uri : undefined);
      if (!uri?.path.endsWith('.neuro')) throw new Error('Open or select a .neuro diagram, then choose Present!');
      const key=uri.toString(),existing=panels.get(key);
      if (existing) {existing.reveal();return;}
      const folder=vscode.workspace.getWorkspaceFolder(uri);
      if (!folder || folder.uri.scheme!=='file') throw new Error('Present! requires a local workspace containing the .neuro file.');
      let architecture=parseArchitecture((await vscode.workspace.openTextDocument(uri)).getText());
      let svg='';
      let figure:Figure|null=null,messages:FigureTurn[]=[],versions:{figure:Figure;svg:string}[]=[];
      const storageKey='present:'+key;
      const stored=context.workspaceState.get<{figure:Figure;messages:FigureTurn[]}>(storageKey);
      if (stored) {try {figure=validateFigure(recoverFigureConnections(stored.figure,architecture),architecture);messages=stored.messages.slice(-40);}catch {/* A fresh YAML architecture needs a fresh draft. */}}
      if (figure) svg=await renderFigureSvg(figure);
      const panel=vscode.window.createWebviewPanel('neurologist.present',`Present! · ${architecture.title}`,vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true});
      panels.set(key,panel);
      const webview=panel.webview;
      const modelBinding=modelSettings.bind(webview,()=>folder);
      webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'dist')]};
      const script=webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'dist/present.js'));
      const css=webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'dist/present.css'));
      const nonce=randomBytes(24).toString('base64');
      let running=false,attempted=false,controller:AbortController|undefined;
      let activities:Activity[]=[],activityTitle='';
      const post=(message:unknown) => {void webview.postMessage(message);};
      const publish=() => post({type:'presentation',figure,svg,messages,source:architecture.title,canUndo:!!versions.length});
      const persist=() => context.workspaceState.update(storageKey,figure ? {figure,messages:messages.slice(-40)} : undefined);
      const failure=(error:unknown) => {
        const message=error instanceof Error && error.name==='AbortError' ? 'Drafting cancelled. Your previous figure is preserved.' : error instanceof Error ? error.message : String(error);
        output.appendLine('Present!: '+message);post({type:'operationError',message});
      };
      async function run(message:string,target:FigureTarget,initial:boolean) {
        if (running) throw new Error('Wait for this draft to finish, or cancel it first.');
        if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to use Codex with Present!');
        if (message.length>12000) throw new Error('Refinement requests must be at most 12,000 characters.');
        running=true;
        let source=architecture;
        try {if (initial) source=parseArchitecture((await vscode.workspace.openTextDocument(uri!)).getText());}
        catch (error) {running=false;throw error;}
        const previous=initial ? null : figure;
        const history=initial ? [] : messages.slice(-20);
        const priorMessages=messages;
        controller=new AbortController();
        const signal=controller.signal;
        activityTitle=initial ? 'Finding the big picture' : 'Polishing the presentation';activities=[];
        post({type:'activityReset',title:activityTitle});post({type:'busy',value:true});
        if (message) {messages=[...(initial ? [] : messages),{role:'user',content:message}].slice(-40) as FigureTurn[];publish();}
        const report=new ActivityReporter(activity=>{activities=reduceActivities(activities,activity);post({type:'activity',activity});});
        const config=vscode.workspace.getConfiguration('neurologist',folder!.uri);
        try {
          const response=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Neurologist: Present!',cancellable:true},async (_progress,token)=>{
            const cancellation=token.onCancellationRequested(()=>controller?.abort());
            try {return await presentFigure({cwd:folder!.uri.fsPath,executable:config.get<string>('codexPath','codex'),...modelSettings.selection(folder),signal,log:chunk=>output.append(chunk),activity:report,architecture:source,previous,history,message,target});}
            finally {cancellation.dispose();}
          });
          signal.throwIfAborted();
          report.update('validate','Figure checked','Validated blocks, connections, and the self-contained vector renderer.','complete');
          if (response.figure) {
            report.update('layout','Untangling the connections','ELK is placing blocks and routing orthogonal arrows.','running');
            const nextSvg=await renderFigureSvg(response.figure);
            signal.throwIfAborted();
            report.update('layout','Connections in place','ELK layout and SVG are ready.','complete');
            if (figure) versions.push({figure,svg});versions=versions.slice(-20);
            figure=response.figure;svg=nextSvg;architecture=source;
          }
          if (initial) messages=message ? [{role:'user',content:message}] : [];
          messages=[...messages,{role:'assistant',content:response.reply}].slice(-40) as FigureTurn[];
          await persist();publish();
          report.update('result','Ready for its close-up','Refine the figure in chat, copy the image, or export SVG/PNG.','complete');report.finish('complete');
        } catch (error) {
          if (!message) messages=priorMessages;
          report.finish(signal.aborted ? 'cancelled' : 'error');
          report.update('result',signal.aborted ? 'Drafting paused' : 'A snag on the drawing board',error instanceof Error ? error.message : String(error),signal.aborted ? 'cancelled' : 'error');
          failure(error);
        } finally {running=false;controller=undefined;post({type:'busy',value:false});}
      }
      const listener=webview.onDidReceiveMessage(async message=>{
        try {
          if (message.type==='ready') {
            publish();post({type:'busy',value:running});
            if (activities.length) {post({type:'activityReset',title:activityTitle});for (const activity of activities) post({type:'activity',activity});}
            if (!figure && !attempted) {attempted=true;await run('','paper',true);}
          }
          if (message.type==='cancel') controller?.abort();
          if (message.type==='draft') await run('',message.target==='slides' ? 'slides' : 'paper',true);
          if (message.type==='refine') {
            if (!figure) throw new Error('Create the first draft before refining it.');
            if (typeof message.message!=='string'||!message.message.trim()) throw new Error('Describe how you would like to refine the figure.');
            await run(message.message.trim(),message.target==='slides' ? 'slides' : message.target==='paper' ? 'paper' : figure.target,false);
          }
          if (message.type==='undo') {
            if (running) throw new Error('Wait for drafting to finish before undoing.');
            const previous=versions.pop();if (previous) {svg=previous.svg;figure=previous.figure;messages=[...messages,{role:'assistant',content:'Restored the previous figure.'}];await persist();publish();}
          }
          if (message.type==='copyImage') {
            if (!figure||running) throw new Error('Wait for the figure to be ready before copying.');
            await copyPng(message.png);post({type:'notice',message:'Image copied. Paste it into your slide or document.'});
          }
          if (message.type==='copySvg') {
            if (!figure||running) throw new Error('Wait for the figure to be ready before copying.');
            await vscode.env.clipboard.writeText(svg);post({type:'notice',message:'SVG source copied.'});
          }
          if (message.type==='export') {
            if (!figure||running) throw new Error('Wait for the figure to be ready before exporting.');
            const format=message.format==='png' ? 'png' : 'svg';
            const bytes=format==='png' ? decodePng(message.png) : Buffer.from(svg,'utf8');
            const base=uri!.path.split('/').at(-1)!.replace(/\.neuro$/,'');
            const destination=await vscode.window.showSaveDialog({defaultUri:vscode.Uri.joinPath(vscode.Uri.file(folder!.uri.fsPath),`${base}-present.${format}`),filters:format==='svg' ? {'SVG vector figure':['svg']} : {'PNG image':['png']}});
            if (destination) {await vscode.workspace.fs.writeFile(destination,bytes);post({type:'notice',message:`Saved ${destination.path.split('/').at(-1)}.`});}
          }
        } catch (error) {failure(error);}
      });
      panel.onDidDispose(()=>{modelBinding.dispose();controller?.abort();listener.dispose();panels.delete(key);});
      webview.html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src data: blob: ${webview.cspSource};"><link rel="stylesheet" href="${css}"></head><body><div id="root"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    } catch (error) {void vscode.window.showErrorMessage('Neurologist Present!: '+(error instanceof Error ? error.message : String(error)));}
  }));
}
