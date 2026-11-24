import { inflateRawSync } from 'node:zlib';
import { closeSync } from 'node:fs';
import { openVerifiedArchiveFile, readStored, streamPayload } from './rpf9.mjs';

const SHADER_STAGES = ['VS', 'PS', 'GS', 'DS', 'HS', 'CS'];
const MAX_GROUP_BYTES = 512 * 1024 * 1024;
const MAX_SHADER_BYTES = 64 * 1024 * 1024;
const SGD5 = Buffer.from('SGD5');
const DXBC = Buffer.from('DXBC');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function shaderReader(bytes) {
  let at = 0;
  function take(length) {
    check(Number.isSafeInteger(length) && length >= 0 && length <= bytes.length - at,
      'SGD5 record exceeds its source at byte ' + at + '.');
    const start = at;
    at += length;
    return bytes.subarray(start, at);
  }
  function name() {
    const raw = take(take(1)[0]);
    const literal = raw.subarray(0, -1).toString('latin1');
    check(raw.at(-1) === 0 && /^[a-z0-9_.:-]+$/i.test(literal), 'Invalid SGD5 record name.');
    return literal;
  }
  return {
    get offset() { return at; },
    get remaining() { return bytes.length - at; },
    take, name,
    u32: () => take(4).readUInt32LE(),
  };
}

function readReflection(reader, minimum, sizeFor) {
  const length = reader.u32();
  check(length >= minimum, 'Invalid SGD5 reflection size.');
  const table = reader.take(length);
  check(table.readUInt16LE(6) === length && sizeFor(table, length), 'SGD5 reflection counts disagree.');
}

function readMember(reader, stage, ordinal) {
  const offset = reader.offset;
  const name = reader.name();
  const waveSize = reader.take(1)[0];
  const length = reader.u32();
  const marker = reader.offset;
  check(length > 12, 'Invalid SGD5 shader wrapper length.');
  const wrapped = reader.take(length);
  const size = wrapped.readUInt32LE(8);
  check(wrapped.readUInt32LE() === 0x000ddce7 && wrapped.readUInt32LE(4) === length &&
    size >= 32 && size <= MAX_SHADER_BYTES, 'Invalid SGD5 shader wrapper.');
  const hash = reader.take(8).readBigUInt64LE().toString(16).padStart(16,'0');
  reader.take(144);
  readReflection(reader,9,(table,n)=>n===9+24*(table.readUInt16LE()+table.readUInt16LE(2)));
  return {stage,ordinal,name,offset,marker,size,stored:length-12,hash,waveSize,effects:[]};
}

function readEffect(reader, stages) {
  const offset = reader.offset;
  const name = reader.name();
  const dataBufferBytes = reader.u32();
  const links = [];
  for (const members of stages) {
    const count = reader.u32();
    check(count <= members.length, 'Invalid shader count for effect ' + name + '.');
    for (let index=0; index<count; index++) {
      const member = members[reader.u32()];
      check(member, 'Effect ' + name + ' links to a missing shader.');
      links.push(member);
    }
  }
  const metadata = reader.take(0x5c);
  const extensions = metadata.readUInt32LE(0x50);
  check(extensions <= 4, 'Invalid SGD5 effect extension count.');
  let tail = metadata.readUInt32LE(0x58);
  for (let index=0; index<extensions; index++) {
    const extension = reader.take(0x10);
    check(extension.readUInt32LE()===0 && extension.readUInt32LE(4)===0x101,
      'Invalid SGD5 effect extension.');
    tail = extension.readUInt32LE(12);
  }
  for (let continuation=0; tail>>>16; continuation++) {
    check(continuation<1024, 'Too many SGD5 effect continuations.');
    tail = reader.take(0x18).readUInt32LE(0x14);
  }
  if ((tail & 0xff00) === 0) reader.take((tail & 0xff)*0x44);
  for (const width of [0x24,4,0x18,4]) reader.take(reader.u32()*width);
  check(reader.u32()===0x80000000, 'Missing SGD5 effect reflection marker.');
  const reflectionOffset = reader.offset;
  readReflection(reader,8,(table,n)=>n>=8+24*(table.readUInt16LE()+table.readUInt16LE(2))+
    12*table.readUInt16LE(4));
  readReflection(reader,8,()=>true);
  const propertyCount = reader.take(4).readUInt16LE();
  for (let index=0; index<propertyCount; index++) {
    const size = reader.u32();
    if (size===0x80000000) reader.take(4);
    else {
      check(size>=24, 'Invalid SGD5 effect property size.');
      const property = reader.take(size);
      check(size===24+8*property[8], 'Invalid SGD5 effect property bindings.');
    }
  }
  const strings = reader.take(reader.u32());
  check(strings.at(-1)===0, 'Invalid SGD5 effect string table.');
  return {name,offset,end:reader.offset,reflectionOffset,dataBufferBytes,propertyCount,links};
}

export function indexSgd5(bytes) {
  const reader = shaderReader(bytes);
  const groups = [];
  while (reader.remaining) {
    const offset = reader.offset;
    check(reader.take(4).equals(SGD5), 'Missing SGD5 group signature.');
    const hash = reader.take(8).readBigUInt64LE().toString(16).padStart(16,'0');
    const descriptorCount = reader.u32();
    check(descriptorCount <= 100_000,'Invalid SGD5 group descriptor count.');
    for (let index=0; index<descriptorCount; index++) {
      const length = reader.u32();
      check(length>=24,'Invalid SGD5 group descriptor size.');
      const descriptor = reader.take(length);
      check(length===24+8*descriptor.readUInt16LE(8),'Invalid SGD5 group descriptor entries.');
    }
    readReflection(reader,9,(table,n)=>n===9+24*(table.readUInt16LE()+table.readUInt16LE(2)));
    const stages = SHADER_STAGES.map(stage=>{
      const count=reader.u32();
      check(count<=100_000,'Invalid SGD5 '+stage+' array count.');
      return Array.from({length:count},(_,ordinal)=>readMember(reader,stage,ordinal));
    });
    const count = reader.u32();
    check(count<=100_000,'Invalid SGD5 effect count.');
    const effects = Array.from({length:count},(_,ordinal)=>{
      const effect = readEffect(reader,stages);
      effect.ordinal = ordinal;
      for (const member of new Set(effect.links)) member.effects.push(effect.name);
      return effect;
    });
    const trailer = reader.take(reader.remaining===5 ? 5 : 10);
    check(trailer.readUInt32LE()<=1 && trailer.subarray(4).every(byte=>byte===0),
      'Invalid SGD5 group trailer.');
    groups.push({hash,offset,end:reader.offset,descriptorCount,stages,effects});
  }
  return groups;
}

export function decodeShaderMember(packed, member) {
  const {buffer,engine} = inflateRawSync(packed,{maxOutputLength:member.size,info:true});
  check(engine.bytesWritten===member.stored && buffer.length===member.size &&
    buffer.subarray(0,4).equals(DXBC) && buffer.readUInt32LE(20)===1 &&
    buffer.readUInt32LE(24)===buffer.length,'Invalid decoded DXBC shader.');
  const count = buffer.readUInt32LE(28);
  const indexEnd = 32+count*4;
  check(count>0 && count<=256 && indexEnd<=buffer.length,'Invalid DXBC part count.');
  const sections = [];
  for (let index=0; index<count; index++) {
    const start=buffer.readUInt32LE(32+index*4);
    check(start%4===0 && start>=indexEnd && start<=buffer.length-8,'Invalid DXBC part offset.');
    const end=start+8+buffer.readUInt32LE(start+4);
    const tag=buffer.toString('latin1',start,start+4);
    check(end<=buffer.length && /^[ -~]{4}$/.test(tag),'Invalid DXBC part.');
    sections.push({start,end,tag});
  }
  sections.sort((left,right)=>left.start-right.start);
  check(sections.every((part,i)=>!i || sections[i-1].end<=part.start),'Overlapping DXBC parts.');
  return {buffer,parts:sections.map(section=>section.tag)};
}

function directRow(row) {
  return !row.crypto && !row.chunks && row.size<=row.stored;
}

async function readShaderRow(game, archive, row) {
  if (directRow(row)) {
    return readStored(archive,row,4).equals(SGD5) ? readStored(archive,row,row.size) : null;
  }
  const source = streamPayload(game,archive,row);
  const chunks = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.length;
    if (length>=4 && length-chunk.length<4 &&
        !Buffer.concat(chunks,length).subarray(0,4).equals(SGD5)) return null;
    check(length<=row.size,'SGD5 archive row exceeds its declared size.');
  }
  check(length===row.size,'Incomplete SGD5 archive row.');
  return length>=4 ? Buffer.concat(chunks,length) : null;
}

const ordinalName = ordinal => String(ordinal).padStart(5,'0');
function linkedMember(member) {
  return {stage:member.stage, ordinal:member.ordinal, name:member.name, path:member.path};
}

function groupEntries(archive,row,bytes,group) {
  const direct = directRow(row);
  const root = 'shader-groups/' + group.hash;
  const groups = [];
  const members = group.stages.flat();
  function readSource(offset,length) {
    if (direct) return readStored(archive,{offset:row.offset+offset,stored:length});
    closeSync(openVerifiedArchiveFile(archive));
    return bytes.subarray(offset,offset+length);
  }
  for (const member of members) {
    member.path = root+'/members/'+member.stage+'/'+ordinalName(member.ordinal)+'-'+member.name.replaceAll(':','_')+'.dxbc';
    const packed = () => readSource(member.marker+12,member.stored);
    groups.push({name:member.path,type:'DXBC',hash:member.hash,size:member.size,stored:member.stored,
      offset:direct ? row.offset+member.offset : row.offset,keywords:[member.name,...member.effects],packed,
      read:()=>decodeShaderMember(packed(),member).buffer,
      preview() {
        const decoded=decodeShaderMember(packed(),member);
        return {type:'text',value:JSON.stringify({
          group:group.hash, ...linkedMember(member), sgaHash:member.hash,
          decodedBytes:member.size, dxbcParts:decoded.parts, effects:member.effects,
        },null,2),note:'Verified DXBC shader'};
      }});
  }
  function jsonEntry(name,offset,end,document,keywords=[]) {
    const json = JSON.stringify(document,null,2) + '\n';
    const data = Buffer.from(json);
    groups.push({name,type:'JSON',hash:null,size:data.length,stored:end-offset,
      offset:direct ? row.offset+offset : row.offset,keywords,read:()=>data,
      packed:()=>readSource(offset,end-offset),
      preview:()=>({type:'text',value:json.slice(0,16384),truncated:json.length>16384})});
  }
  for (const effect of group.effects) {
    effect.path=root+'/effects/'+ordinalName(effect.ordinal)+'-'+effect.name.replaceAll(':','_')+'.json';
    jsonEntry(effect.path,effect.offset,effect.end,{
      group:group.hash, name:effect.name, ordinal:effect.ordinal, sourceEntry:row.id,
      decodedOffset:effect.offset, reflectionOffset:effect.reflectionOffset,
      dataBufferBytes:effect.dataBufferBytes, propertyCount:effect.propertyCount,
      members:effect.links.map(linkedMember),
    },[effect.name]);
  }
  jsonEntry(root+'/group-index.json',group.offset,group.end,{
    group:group.hash, sourceEntry:row.id, descriptors:group.descriptorCount,
    memberCount:members.length, effectCount:group.effects.length,
    stages:Object.fromEntries(group.stages.map((stage,i)=>[SHADER_STAGES[i],stage.length])),
    effects:group.effects.map(effect=>({name:effect.name,ordinal:effect.ordinal,
      path:effect.path,
      members:effect.links.map(linkedMember)})),
    members:members.map(member=>({...linkedMember(member),sgaHash:member.hash,decodedBytes:member.size,effects:member.effects})),
  });
  return groups;
}

export async function indexShaderRows(game, archive) {
  const entries = [];
  for (const row of archive.rows) {
    if (row.kind!=='file' || row.size<16 || row.size>MAX_GROUP_BYTES) continue;
    const bytes = await readShaderRow(game,archive,row);
    if (!bytes) continue;
    for (const group of indexSgd5(bytes)) {
      for (const entry of groupEntries(archive,row,directRow(row) ? null : bytes,group)) entries.push(entry);
    }
  }
  return entries;
}
