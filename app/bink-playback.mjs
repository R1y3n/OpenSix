import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseHelperHash='1c0d56b22ed2600c9bf76fe1efc2463eaa19cd24015f665f2cec1f9d5b6a697e';
let playback;

export function isBink(header) {
  return ['KB2','BIK'].includes(header?.toString('ascii',0,3));
}

export function stopMovie(id) {
  if (!playback || (id && id!==playback.id)) return;
  const current=playback;
  playback=null;
  current.child.kill();
}

export async function openMovie(path, offset, length) {
  const portable=process.env.PORTABLE_EXECUTABLE_DIR;
  const external=[process.env.OPENSIX_BINK_PLAYER,portable && join(portable,'bink-player.exe')]
    .find(path=>path && isAbsolute(path) && existsSync(path));
  const magic=Buffer.alloc(3);
  const fd=openSync(path,'r');
  try {
    if (readSync(fd,magic,0,magic.length,offset)!==3 || !isBink(magic)) throw new Error('Choose a complete Bink movie.');
  } finally { closeSync(fd); }
  if (!external && magic.toString('ascii')==='BIK') {
    throw new Error('Bink 1 playback needs the rpf9-explorer v1.3 bink-player.exe beside OpenSix.exe.');
  }
  if (external && createHash('sha256').update(readFileSync(external)).digest('hex')!==releaseHelperHash) {
    throw new Error('The Bink player does not match the verified rpf9-explorer v1.3 helper.');
  }
  const builtIn=process.resourcesPath && existsSync(join(process.resourcesPath,'opensix-preview.exe'))
    ? join(process.resourcesPath,'opensix-preview.exe') : fileURLToPath(new URL('./worker/opensix-preview.exe',import.meta.url));
  const source=[path,String(offset),String(length)];
  stopMovie();
  const child=spawn(external ?? builtIn,external ? [...source,'640'] : ['--bink-play',...source],{windowsHide:true});
  const state={child,id:randomBytes(16).toString('hex'),version:0,number:1,playing:false,ended:false};
  playback=state;
  return new Promise((resolve,reject)=>{
    let ready=false;
    let stderr='';
    let queue=Buffer.alloc(0);
    // A frame spans multiple chunks. Fill its buffer once and retain only the latest frame.
    let frame=null;
    let received=0;
    const timer=setTimeout(()=>fail('The Bink player did not return a frame.'),15_000);
    const fail=message=>{
      clearTimeout(timer);
      state.error=message;
      child.kill();
      if (!ready) reject(new Error(message));
    };
    child.stdin.on('error',()=>{});
    child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-2048);});
    child.on('error',error=>fail(error.message));
    child.on('close',()=>{
      clearTimeout(timer);
      if (playback===state) fail(stderr.trim() || 'The Bink player closed.');
      else if (!ready) reject(new Error('The Bink preview closed.'));
    });
    child.stdout.on('data',chunk=>{
      queue=queue.length ? Buffer.concat([queue,chunk]) : chunk;
      if (!state.header) {
        if (queue.length<44) return;
        const [magic,protocol,width,height,sourceWidth,sourceHeight,frames,rate,divisor,tracks,audio]=
          Array.from({length:11},(_,i)=>queue.readUInt32LE(i*4));
        if (magic!==0x50504652 || protocol!==1 || !width || width>640 ||
            !height || height>1080 || !frames || !rate || !divisor) return fail('Invalid Bink player header.');
        state.header={width,height,sourceWidth,sourceHeight,frames,fps:rate/divisor,tracks,audio:Boolean(audio)};
        queue=queue.subarray(44);
      }
      while (queue.length) {
        if (!frame) {
          if (queue.length<16) return;
          const [magic,number,value,flag]=Array.from({length:4},(_,i)=>queue.readUInt32LE(i*4));
          if (number<1 || number>state.header.frames) return fail('Invalid Bink frame index.');
          queue=queue.subarray(16);
          if (magic===0x54415453) {
            Object.assign(state,{number,playing:Boolean(value),ended:Boolean(flag)});
            continue;
          }
          if (magic!==0x4d415246 || value!==state.header.width*state.header.height*4) {
            return fail('Invalid Bink frame packet.');
          }
          frame={number,playing:Boolean(flag),pixels:Buffer.allocUnsafe(value)};
          received=0;
        }
        const copied=queue.copy(frame.pixels,received);
        received+=copied;
        queue=queue.subarray(copied);
        if (received!==frame.pixels.length) return;
        for (let i=0;i<received;i+=4) {
          const blue=frame.pixels[i];
          frame.pixels[i]=frame.pixels[i+2];
          frame.pixels[i+2]=blue;
        }
        state.pixels=frame.pixels;
        state.number=frame.number;
        state.playing=frame.playing;
        if (frame.number<state.header.frames) state.ended=false;
        state.version++;
        frame=null;
        if (!ready) {
          ready=true;
          clearTimeout(timer);
          resolve({type:'movie',id:state.id,...state.header});
        }
      }
    });
  });
}

export function movieFrame(id,version) {
  if (playback?.id!==id) throw new Error('The Bink preview closed.');
  const {pixels,...state}=playback;
  if (state.error) throw new Error(state.error);
  return {version:state.version,number:state.number,playing:state.playing,ended:state.ended,
    pixels:version===state.version ? null : new Uint8Array(pixels)};
}

export function movieCommand(id,action,value) {
  if (action==='close') { stopMovie(id); return; }
  if (playback?.id!==id || playback.error) throw new Error('The Bink preview closed.');
  const commands={play:'PLAY',pause:'PAUSE',step:'STEP',seek:'SEEK',volume:'VOLUME',loop:'LOOP'};
  if (!Object.hasOwn(commands,action)) throw new Error('Unknown Bink player command.');
  const needsValue=['seek','volume','loop'].includes(action);
  const validRange={seek:[1,playback.header.frames],volume:[0,100],loop:[0,1]};
  if (needsValue && (!Number.isInteger(value) || value<validRange[action][0] || value>validRange[action][1])) {
    throw new Error('Invalid Bink player command value.');
  }
  playback.child.stdin.write(commands[action]+(needsValue ? ' '+value : '')+'\n');
}
