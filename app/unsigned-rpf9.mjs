import { closeSync, createReadStream, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { FILE_TABLE, HASH64_TABLE, HASH32_TABLE, joaatName32, murmurName64, openVerifiedArchiveFile } from './rpf9.mjs';

const marker=Buffer.from('OS6PATH1\n');
const pathLimit=8*1024*1024;
const maxRowBytes=0xfffffffff;
const round=(n,alignment)=>Math.ceil(n/alignment)*alignment;
const identity=stat=>[stat.size,stat.mtimeMs,stat.dev,stat.ino].join(':');

function readFolder(folder, base='', files=[]) {
  for (const entry of readdirSync(folder,{withFileTypes:true})) {
    const path=join(folder,entry.name);
    const name=base+entry.name;
    if (entry.isDirectory()) readFolder(path,name+'/',files);
    else if (entry.isFile()) {
      const stat=lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('A source file changed while preparing the archive.');
      if (stat.size>maxRowBytes || /[\r\n\0]/.test(name)) throw new Error('The source file cannot be represented as an RPF9 row.');
      files.push({path,name,size:stat.size,identity:identity(stat)});
    } else throw new Error('The source folder contains a link or special file. Choose a folder of regular files.');
  }
  return files;
}

function directory(game, files, trailerBytes) {
  const columns=[[FILE_TABLE,24],[HASH64_TABLE,8],[HASH32_TABLE,4]];
  const count=files.length;
  const indexWidth=count<=255 ? 1 : count<=65535 ? 2 : 4;
  const indexStart=64+3*24;
  const tableStart=round(indexStart+count*3*indexWidth,8);
  const dirLength=round(tableStart+count*36,16);
  const bytes=Buffer.alloc(dirLength);
  bytes.write('9FPR');
  bytes.writeUInt32LE(dirLength,4);
  bytes.writeUInt32LE(dirLength,8);
  bytes.writeUInt32LE(trailerBytes,12);
  bytes.writeUInt16LE(3,0x20);
  bytes.writeUInt32LE(count,0x24);
  bytes[0x2c]=indexWidth;
  let tableOffset=0;
  for (const [column,[key,stride]] of columns.entries()) {
    const record=64+24*column;
    bytes.writeBigUInt64LE(key,record);
    bytes.writeUInt32LE(count,record+8);
    bytes.writeUInt32LE(tableOffset,record+12);
    bytes.writeUInt16LE(stride,record+16);
    tableOffset+=count*stride;
  }
  let offset=dirLength;
  const known=new Set();
  for (const [index,file] of files.entries()) {
    for (let column=0;column<3;column++) bytes.writeUIntLE(index,indexStart+(index*3+column)*indexWidth,indexWidth);
    const record=tableStart+24*index;
    const stored=round(file.size,16);
    if (!Number.isSafeInteger(offset+stored) || offset/16>0xffffffffff) throw new Error('The archive exceeds RPF9 file offsets.');
    bytes.writeBigUInt64LE(BigInt(offset/16),record);
    bytes[record+5]=0xff; // Ordinary files, not the console resource record layout.
    bytes.writeBigUInt64LE(BigInt(stored/16),record+8);
    bytes.writeBigUInt64LE(BigInt(file.size),record+16);
    offset+=stored;
    const name=game.normalize(file.name);
    const hash32=joaatName32(name), hash64=murmurName64(name);
    const pair=hash32+hash64;
    if (known.has(pair)) throw new Error('Two paths resolve to the same game name. Rename one before building.');
    known.add(pair);
    bytes.writeBigUInt64LE(BigInt('0x'+hash64),tableStart+count*24+8*index);
    bytes.writeUInt32LE(Number.parseInt(hash32,16),tableStart+count*32+4*index);
  }
  return {bytes,length:offset+trailerBytes};
}

export function prepareUnsignedRpf9(game, root, otherSources=[]) {
  const files=readFolder(realpathSync(root)).sort((a,b)=>a.name.localeCompare(b.name));
  if (!files.length || files.length>200_000) throw new Error('Choose a nonempty folder with at most 200,000 files.');
  const paths=Buffer.from(files.map(file=>file.name).join('\n')+'\n','utf8');
  if (paths.length>pathLimit) throw new Error('The path list exceeds 8 MiB.');
  const trailer=Buffer.concat([marker,paths]);
  const index=directory(game,files,trailer.length);
  function checked(file, stat) {
    if (!stat.isFile() || identity(stat)!==file.identity) throw new Error('A source file changed during archive creation.');
  }
  return { length:index.length, sources:[...otherSources,...files.map(file=>file.path)], mustBeNew:true,
    verify:()=>{ for (const file of files) checked(file,lstatSync(file.path)); },
    read:async function* () {
      yield index.bytes;
      for (const file of files) {
        const fd=openSync(file.path,'r');
        try {
          checked(file,fstatSync(fd));
          if (file.size) {
            yield* createReadStream(file.path,{fd,autoClose:false,start:0,end:file.size-1});
            const padding=round(file.size,16)-file.size;
            if (padding) yield Buffer.alloc(padding);
          }
          checked(file,fstatSync(fd));
        } finally { closeSync(fd); }
      }
      yield trailer;
    },
  };
}

export function authoredPaths(archive) {
  const size=archive.trailer;
  if (archive.headerSignature!=='unsigned' || size<marker.length || size>pathLimit+marker.length) return [];
  const fd=openVerifiedArchiveFile(archive);
  try {
    const bytes=Buffer.alloc(size);
    if (readSync(fd,bytes,0,size,archive.start+archive.size-size)!==size ||
        !bytes.subarray(0,marker.length).equals(marker)) return [];
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(marker.length)).trimEnd().split('\n');
  } catch { return []; }
  finally { closeSync(fd); }
}
