import { execFile } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { keepLocalExport } from './asset-preview.mjs';

const execute=promisify(execFile);
export const gta5Formats=new Map([['convertYmap','ymap'],['convertYdr','ydr'],['convertYbn','ybn'],
  ['convertYtd','ytd'],['convertYtyp','ytyp']]);

function mapInput(data) {
  if (!Array.isArray(data.entities) || data.entities.length===0) throw new Error('There are no placements to convert.');
  if (!Object.hasOwn(data,'name_hash')) return data;
  const entities=data.entities.map((row,index)=>{
    if (!Number.isInteger(row.archetype) || row.archetype<0 || row.archetype>0xffffffff ||
        !Array.isArray(row.position) || row.position.length!==3 || !row.position.every(Number.isFinite) ||
        !Array.isArray(row.rotation) || row.rotation.length!==4 || !row.rotation.every(Number.isFinite) ||
        ![row.scale_xy,row.scale_z].every(value=>Number.isFinite(value)&&value>0)) {
      throw new Error('Invalid transform in placement '+(index+1)+'.');
    }
    return {archetype_name:'0x'+row.archetype.toString(16),position:row.position,rotation:row.rotation,
      scale_xy:row.scale_xy,scale_z:row.scale_z,guid:index+1,lod_dist:Math.max(1,row.lod?.lod_dist??150),
      tint_value:Number.isInteger(row.tint_row) ? row.tint_row : 0};
  });
  return {name:'opensix_'+(data.name_hash>>>0).toString(16),exported_by:'OpenSix',entities};
}

export function convertGta5(kind, inputPath, map) {
  const format=gta5Formats.get(kind);
  if (!format) throw new Error('Unknown GTA V format.');
  const ext=extname(inputPath).toLowerCase();
  const want={ymap:'.json',ytyp:'.json',ydr:'.obj',ybn:'.obj',ytd:'.dds'}[format];
  if (!map && ext!==want) throw new Error('Choose a decoded '+want+' file.');
  const local=process.resourcesPath && join(process.resourcesPath,'6ixpack.exe');
  const worker=local && existsSync(local) ? local : fileURLToPath(new URL('./worker/6ixpack.exe',import.meta.url));
  return keepLocalExport([inputPath],async folder=>{
    let input=inputPath;
    if (format==='ymap') {
      input=join(folder,'placements.json');
      writeFileSync(input,JSON.stringify(mapInput(map)));
    } else if (format==='ytd') {
      input=join(folder,'dds');
      mkdirSync(input);
      copyFileSync(inputPath,join(input,basename(inputPath)));
    }
    const file='converted.'+format;
    const output=join(folder,file);
    try {
      await execute(worker,['--threads','4','convert',format,input,output],{
        cwd:folder,windowsHide:true,timeout:180_000,maxBuffer:1024*1024,
      });
    } catch(error) { throw new Error(error.stderr?.trim() || error.message); }
    const length=statSync(output).size;
    const head=Buffer.alloc(16);
    const fd=openSync(output,'r');
    try { if (readSync(fd,head,0,16,0)!==16 || head.toString('ascii',0,4)!=='RSC7' || length<=16) {
      throw new Error('The converter did not produce a GTA V RSC7 resource.');
    } } finally { closeSync(fd); }
    const details={format:format.toUpperCase(),bytes:length,version:head.readUInt32LE(4),
      ...(format==='ymap' ? {placements:map.entities.length,archetypeHashesPreserved:true} : {})};
    return {type:'toolReport',title:'GTA V '+format.toUpperCase(),value:JSON.stringify(details,null,2),
      files:[{file,name:'Save '+format.toUpperCase()}]};
  });
}
