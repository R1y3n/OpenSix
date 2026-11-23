const mediaSignature = [
  ['image/png', b=>b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))],
  ['image/jpeg', b=>b[0]===255&&b[1]===216&&b[2]===255],
  ['image/gif', b=>/^GIF8[79]a$/.test(b.toString('ascii',0,6))],
  ['image/webp', b=>b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'],
  ['audio/wav', b=>b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE'],
  ['audio/ogg', b=>b.toString('ascii',0,4)==='OggS'],
];

function previewHeights(bytes) {
  if (bytes.length<44 || bytes.readUInt16LE(4)!==1) return null;
  const width=bytes.readUInt16LE(6),height=bytes.readUInt16LE(8);
  const dataStart=44+height*8;
  if (!width || !height || dataStart>bytes.length) return null;
  const bounds=Array.from({length:6},(_,i)=>bytes.readFloatLE(12+i*4));
  if (!bounds.every(Number.isFinite) || bounds[2]>=bounds[5]) return null;
  const ratio=Math.min(1,512/width,512/height);
  const previewWidth=Math.ceil(width*ratio),previewHeight=Math.ceil(height*ratio);
  const water=Math.min(255,Math.max(0,Math.round(255*(-bounds[2])/(bounds[5]-bounds[2]))));
  const heights=Buffer.alloc(previewWidth*previewHeight,water);
  let validRows=0;
  for (let y=0;y<previewHeight;y++) {
    const sourceY=Math.floor(y*height/previewHeight);
    const record=44+sourceY*8;
    const first=bytes.readUInt16LE(record),count=bytes.readUInt16LE(record+2);
    const source=dataStart+bytes.readInt32LE(record+4)+first;
    if (!count) continue;
    if (first+count>width || source<dataStart || source+count>bytes.length) return null;
    validRows++;
    for (let x=0;x<previewWidth;x++) {
      const i=Math.floor(x*width/previewWidth)-first;
      if (i>=0&&i<count) heights[y*previewWidth+x]=bytes[source+i];
    }
  }
  if (!validRows) return null;
  return { type:'heightmap',value:heights.toString('base64'),width:previewWidth,height:previewHeight,
    water,note:'MHIU · '+width+' × '+height+' · '+bounds[2]+' to '+bounds[5]+' m',
    truncated:ratio<1 };
}

export function previewResource(bytes) {
  if (bytes.toString('ascii',0,4)==='MHIU') return previewHeights(bytes);
  for (const [mime,valid] of mediaSignature) {
    if (valid(bytes)) return { type:mime.split('/')[0], mime, value:bytes.toString('base64') };
  }
  return null;
}
