import {execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export function decodePng(data:unknown):Buffer {
  if (typeof data!=='string' || data.length>28_000_000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data)) throw new Error('Invalid PNG image.');
  const bytes=Buffer.from(data.slice('data:image/png;base64,'.length),'base64');
  if (bytes.length<24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid PNG signature.');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if (!width||!height||width>8192||height>8192) throw new Error('PNG dimensions must be between 1 and 8192 pixels.');
  return bytes;
}
export function clipboardCommand(platform:NodeJS.Platform,file:string):{file:string;args:string[]}[] {
  if (platform==='darwin') return [{file:'/usr/bin/osascript',args:['-e',`set the clipboard to (read (POSIX file "${file.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}") as «class PNGf»)`]}];
  if (platform==='win32') return [{file:'powershell.exe',args:['-NoProfile','-NonInteractive','-STA','-Command',`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [System.Drawing.Image]::FromFile('${file.replace(/'/g,"''")}'); try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }`]}];
  return [{file:'wl-copy',args:['--type','image/png']},{file:'xclip',args:['-selection','clipboard','-t','image/png','-i',file]}];
}
export async function copyPng(data:unknown):Promise<void> {
  const png=decodePng(data),directory=await mkdtemp(join(tmpdir(),'neurologist-copy-'));
  try {
    const file=join(directory,'figure.png');await writeFile(file,png);
    // Wayland receives PNG bytes on stdin; X11 receives the temporary file.
    // macOS and Windows use their native image clipboard APIs.
    const candidates=clipboardCommand(process.platform,file);
    let last:unknown;
    for (const command of candidates) {
      try {
        await new Promise<void>((resolve,reject) => {
          const child=execFile(command.file,command.args,{timeout:8000,maxBuffer:100000},error=>error ? reject(error) : resolve());
          if (command.file==='wl-copy') child.stdin?.end(png);
        });return;
      } catch (error) {last=error;}
    }
    throw new Error(`Image clipboard is unavailable. Use Export PNG or Export SVG instead. ${last instanceof Error ? last.message : ''}`);
  } finally {await rm(directory,{recursive:true,force:true});}
}
