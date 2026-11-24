import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { hasByteRange, readAvailableRanges } from './available-ranges.mjs';
import { buildAssetPreview, previewMeshGlb } from './asset-preview.mjs';
import { decodeStoredPayload, openArchive } from './rpf9.mjs';
import { zipOutput } from './zip-output.mjs';

const profile = JSON.parse(readFileSync(new URL('./assets/scarlett-xbox-bvh.json',import.meta.url)));
const SYSTEM_BASE = 0x50000000n, GRAPHICS_BASE = 0x60000000n;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const json = object => Buffer.from(JSON.stringify(object,null,2)+'\n');

export const isXboxBvhArchive = path => basename(path).toLowerCase() === 'core_bvh4.rpf';

function check(condition,message) {
  if (!condition) throw new Error(message);
}

function checkedSlice(data,offset,length) {
  check(Number.isSafeInteger(offset) && offset>=0 && length>=0 && offset<=data.length-length,
    'Xbox GPU BVH buffer reference exceeds its source.');
  return data.subarray(offset,offset+length);
}

function readSource(path, entries, ranges) {
  const fd = openSync(path,'r');
  try {
    const stat=fstatSync(fd);
    return entries.map(({offset,length,sha256:expected})=>{
      check(stat.isFile() && offset+length<=stat.size && (!ranges || hasByteRange(ranges,offset,length)),
        basename(path)+' is missing bytes needed by the verified Xbox GPU BVH.');
      const data=Buffer.alloc(length);
      for (let read=0;read<length;) {
        const n=readSync(fd,data,read,length-read,offset+read);
        check(n>0,'The Xbox GPU BVH source ended during the read.');
        read += n;
      }
      check(sha256(data)===expected,basename(path)+' does not match the verified Xbox GPU BVH source bytes.');
      return data;
    });
  } finally { closeSync(fd); }
}

function inflateStream(bytes, size) {
  const {buffer,engine}=inflateSync(bytes,{maxOutputLength:size,info:true});
  check(buffer.length===size && engine.bytesWritten===bytes.length,'Invalid Xbox GPU BVH zlib stream.');
  return buffer;
}

function vertexData(drawable, geometry, files) {
  const sys=drawable.subarray(0,profile.drawable.systemSize);
  const gfx=drawable.subarray(profile.drawable.systemSize);
  function pointer(offset, base=SYSTEM_BASE) {
    const n=Number(sys.readBigUInt64LE(offset)-base);
    checkedSlice(base===SYSTEM_BASE ? sys : gfx,n,1);
    return n;
  }
  const layout=profile.drawable;
  const lod=pointer(layout.drawableOffset+0x50+8*layout.lod);
  const model=pointer(pointer(lod)+8*layout.model);
  const geometryList=pointer(model+8);
  const shaders=pointer(pointer(layout.drawableOffset+16)+16);
  const u32=offset=>sys.readUInt32LE(offset);
  const stride=offset=>sys.readUInt16LE(offset);
  return profile.geometry.map((proof,index)=>{
    const prefix='geometry-'+String(index).padStart(2,'0');
    const offset=pointer(geometryList+8*proof.ordinal);
    const vertex=pointer(offset+8);
    const fvf=pointer(vertex+64);
    const binding=pointer(offset+64);
    const indices=pointer(binding);
    const shader=pointer(shaders+8*proof.shader);
    const renderBucket=sys[shader+57];
    const rawVertices=checkedSlice(gfx,pointer(vertex+24,GRAPHICS_BASE),u32(vertex+8)*stride(vertex+12));
    const rawIndices=checkedSlice(gfx,pointer(indices+24,GRAPHICS_BASE),u32(indices+8)*stride(indices+12));
    check((u32(fvf+0x138)>>>10)===proof.vertices && rawIndices.readUInt32LE(4)===proof.triangles &&
      renderBucket===proof.renderBucket,'The drawable descriptor does not match the Xbox GPU BVH geometry.');
    for (const [name,at,length] of [
      ['geometry',offset,160],['vertex',vertex,80],['vertex_format',fvf,320],['index',indices,64],
    ]) files.set(prefix+'_rage_'+name+'_descriptor.bin',checkedSlice(sys,at,length));
    files.set(prefix+'_rage_meshlet_binding.bin',checkedSlice(sys,binding,16));
    files.set(prefix+'_rage_raw_vertex.bin',rawVertices);
    files.set(prefix+'_rage_raw_meshlet_indices.bin',rawIndices);
    const out=geometry[index];
    check(out?.ordinal===proof.ordinal,'The drawable decoder changed the Xbox GPU geometry order.');
    const positions=Buffer.from(out.positions,'base64');
    const triangles=Buffer.from(out.indices,'base64');
    check(positions.length===12*proof.vertices && triangles.length===12*proof.triangles &&
      sha256(positions)===proof.positionSha256 && sha256(triangles)===proof.indexSha256,
      'The decoded vertices or triangle order differ from the verified Xbox GPU BVH.');
    const positionsFile=prefix+'_dxr_vertices_f32le.bin';
    const indicesFile=prefix+'_dxr_indices_u32le.bin';
    files.set(positionsFile,positions);
    files.set(indicesFile,triangles);
    const descriptor={
      geometryIndex:index, sourceOrdinal:proof.ordinal, shaderIndex:proof.shader, renderBucket,
      systemOffsets:{geometry:offset,vertex,fvf,binding,index:indices,shader},
      rawVertexSettings:{positionOffsetWithinGraphicsBuffer:u32(fvf),positionFormat:sys[fvf+0x104],
        packedBytesPerPosition:sys[fvf+0xd0],count:proof.vertices},
      decodedDescriptorFields:{geometryType:'TRIANGLES',vertexFormat:'R32G32B32_FLOAT',vertexStrideInBytes:12,
        indexFormat:'R32_UINT',vertexCount:proof.vertices,indexCount:proof.triangles*3},
      positionsFile,indicesFile,
    };
    return {positions,indices:triangles,descriptor};
  });
}

function verifyLeaves(bvh, geometry) {
  const leaves=bvh.readUInt32LE(12);
  const leafOffset=bvh.readUInt32LE(0x34);
  const seen=geometry.map(g=>new Uint8Array(g.indices.length/12));
  let triangles=0, pairedLeaves=0;
  for (let base=0;base<leaves;base+=2048) {
    const count=Math.min(2048,leaves-base);
    const block=checkedSlice(bvh,leafOffset+(base/2048)*0x20000,count*10);
    for (let i=0;i<count;i++) {
      const group=block.readUIntLE(i*3,3);
      const a=block.readUIntLE(count*4+i*3,3);
      const b=block.readUIntLE(count*7+i*3,3);
      const target=seen[group];
      check(target,'Xbox GPU BVH leaf references an unknown geometry group.');
      for (const index of b===0xffffff ? [a] : [a,b]) {
        check(target[index]===0,'Xbox GPU BVH leaf references an invalid or repeated triangle.');
        target[index]=1;
        triangles++;
      }
      if (b===0xffffff) continue;
      const indices=geometry[group].indices;
      const vertex=(tri,k)=>indices.readUInt32LE(tri*12+k*4);
      const first=new Set([0,1,2].map(k=>vertex(a,k)));
      const shared=new Set([0,1,2].map(k=>vertex(b,k)).filter(v=>first.has(v)));
      check(shared.size===2,'An Xbox GPU BVH leaf pair does not share its expected mesh edge.');
      pairedLeaves++;
    }
  }
  check(seen.every(group=>group.every(value=>value===1)),'Xbox GPU BVH leaves do not cover all source triangles.');
  return {geometryGroups:geometry.length,triangles,leaves,pairedLeaves};
}

function addAddressDescriptors(files, system, geometry, verification) {
  const geometryFile='dxr_geometry_descriptors_template.bin';
  const buildFile='dxr_build_descriptor_template.bin';
  const records=Buffer.alloc(56*geometry.length);
  const build=Buffer.alloc(48);
  build.writeUInt32LE(1,8);
  build.writeUInt32LE(geometry.length,16);
  const binding=(offset,field,addressSpace,target,byteOffset=0)=>({offset,field,addressSpace,target,byteOffset});
  const relocations=geometry.map(({descriptor},index)=>{
    const base=56*index;
    records.writeUInt32LE(42,base+16);
    records.writeUInt32LE(6,base+20);
    records.writeUInt32LE(descriptor.decodedDescriptorFields.indexCount,base+24);
    records.writeUInt32LE(descriptor.decodedDescriptorFields.vertexCount,base+28);
    records.writeBigUInt64LE(12n,base+48);
    return {geometry:index,base,fields:[
      binding(base+8,'Transform3x4','GPU VA','core_bvh4_transform_3x4_f32le.bin'),
      binding(base+32,'IndexBuffer','GPU VA',descriptor.indicesFile),
      binding(base+40,'VertexBuffer.StartAddress','GPU VA',descriptor.positionsFile),
    ]};
  });
  files.set(geometryFile,records);
  files.set(buildFile,build);
  files.set('cpu_gpu_address_bindings.json',json({
    purpose:'Relocatable replay descriptors. Zero address slots must be populated by the loader. Runtime flags are unobserved.',
    originalSerializedPointers:[8,24,32,40,48,56].map(offset=>{
      const value=system.readBigUInt64LE(offset);
      const gpu=value>=GRAPHICS_BASE;
      return {offset,value:'0x'+value.toString(16),segment:gpu?'graphics':'system',
        segmentOffset:Number(value-(gpu?GRAPHICS_BASE:SYSTEM_BASE))};
    }),
    geometryDescriptorTemplate:{file:geometryFile,stride:56,relocations},
    buildDescriptorTemplate:{file:buildFile,stride:48,relocations:[
      binding(0,'DestAccelerationStructureData','GPU VA','destination acceleration-structure allocation'),
      binding(24,'Inputs.pGeometryDescs','CPU pointer',geometryFile),
      binding(32,'SourceAccelerationStructureData','GPU VA','core_bvh4_graphics_page.bin',profile.bvhHeaderOffset),
      binding(40,'ScratchAccelerationStructureData','GPU VA','scratch allocation when required'),
    ]},
    separateRehydrateSourceArgument:{argument:5,element:0,addressSpace:'CPU-accessible alias',
      target:'core_bvh4_graphics_page.bin',byteOffset:profile.bvhHeaderOffset},
    verification,
  }));
}

function previewGlb(geometry,transform) {
  const views=[], accessors=[], blocks=[];
  let length=0;
  function accessor(bytes,componentType,type,count,min,max) {
    const bufferView=views.push({buffer:0,byteOffset:length,byteLength:bytes.length})-1;
    blocks.push(bytes);
    length+=bytes.length;
    return accessors.push({bufferView,componentType,type,count,min,max})-1;
  }
  const meshes=geometry.map(({positions,indices,descriptor})=>{
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for (let i=0;i<positions.length;i+=12) for (let axis=0;axis<3;axis++) {
      const value=positions.readFloatLE(i+axis*4);
      check(Number.isFinite(value),'The verified Xbox GPU BVH has a nonfinite vertex.');
      min[axis]=Math.min(min[axis],value); max[axis]=Math.max(max[axis],value);
    }
    return {name:'Geometry '+descriptor.geometryIndex,primitives:[{
      attributes:{POSITION:accessor(positions,5126,'VEC3',positions.length/12,min,max)},
      indices:accessor(indices,5125,'SCALAR',indices.length/4),material:0,
    }]};
  });
  const matrix=[transform[0],transform[4],transform[8],0, transform[1],transform[5],transform[9],0,
    transform[2],transform[6],transform[10],0, transform[3],transform[7],transform[11],1];
  const config=Buffer.from(JSON.stringify({
    asset:{version:'2.0',generator:'OpenSix'}, scene:0, scenes:[{nodes:[0]}],
    nodes:[{rotation:[-Math.SQRT1_2,0,0,Math.SQRT1_2],children:[1]},
      {name:profile.name,matrix,children:meshes.map((_,i)=>i+2)},...meshes.map((_,mesh)=>({mesh}))],
    meshes,materials:[{doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[0.38,0.62,0.66,1],metallicFactor:0,roughnessFactor:0.85}}],
    buffers:[{byteLength:length}],bufferViews:views,accessors,
  }));
  const padding=Buffer.alloc((4-config.length%4)%4,32);
  const header=Buffer.alloc(20), bin=Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2,4);
  header.writeUInt32LE(28+config.length+padding.length+length,8);
  header.writeUInt32LE(config.length+padding.length,12); header.write('JSON',16);
  bin.writeUInt32LE(length); bin.write('BIN\0',4);
  return Buffer.concat([header,config,padding,bin,...blocks]);
}

export async function openXboxBvh(game, executable, path) {
  const coreStat=statSync(path);
  const ranges=readAvailableRanges(path,coreStat.size);
  const source=profile.drawable;
  const levelsPath=resolve(dirname(executable),source.path);
  const levelStat=statSync(levelsPath,{throwIfNoEntry:false});
  check(levelStat?.isFile(),'Place the matching levels.rpf beside the selected Scarlett executable.');
  const levelRanges=readAvailableRanges(levelsPath,levelStat.size);
  const [systemStored,graphicsStored]=readSource(path,[profile.system,profile.graphics],ranges);
  const [,drawableStored]=readSource(levelsPath,[source.directory,source.stored],levelRanges);
  const directory=openArchive(game,levelsPath,source.directory.offset,source.directory.extent,{availableRanges:levelRanges});
  const row=directory.rows[source.row];
  check(directory.headerSignature==='verified' && directory.headerHash===source.directory.sha256 &&
    row?.hash64===source.hash64 && directory.start+row.offset===source.stored.offset &&
    row.stored===source.stored.length && row.systemSize===source.systemSize,'The matching drawable directory record failed verification.');
  const drawable=decodeStoredPayload(game,row,Buffer.from(drawableStored));
  check(sha256(drawable)===source.decodedSha256,'The matching drawable failed its decoded source hash.');
  const system=inflateStream(systemStored,profile.descriptorBytes);
  const graphics=inflateStream(graphicsStored,profile.graphicsBytes);
  const header=profile.bvhHeaderOffset;
  const bvh=checkedSlice(graphics,header,(graphics.readUInt32LE(header+4)+1)*64);
  const graphicsPage=Number(system.readBigUInt64LE(0x18)-SYSTEM_BASE);
  check(system.readBigUInt64LE(0x20)===GRAPHICS_BASE && bvh.readUInt32LE()===0x81020006 &&
    bvh.readUInt32LE(8)===profile.layoutCrc32 && system.readUInt32LE(graphicsPage)===Math.ceil((header+bvh.length)/256)*256,
    'The Xbox GPU BVH resource header does not match its graphics page.');
  const transform=checkedSlice(system,0x50,48);
  const transformValues=Array.from({length:12},(_,i)=>transform.readFloatLE(4*i));
  check(transformValues.every(Number.isFinite),'Invalid Xbox GPU BVH transform.');
  const decoded=await buildAssetPreview({kind:'gpuBvhMesh',systemSize:source.systemSize,
    drawableOffset:source.drawableOffset,index:source.model,detail:source.lod,ordinals:profile.geometry.map(g=>g.ordinal)},drawable);
  check(decoded.geometry.length===profile.geometry.length,'The matching drawable decoder returned an unexpected geometry count.');
  const files=new Map([
    ['core_bvh4_original_system.zlib',systemStored],['core_bvh4_original_graphics.zlib',graphicsStored],
    ['core_bvh4_system_descriptor.bin',system],['core_bvh4_graphics_page.bin',graphics],
    ['core_bvh4_transform_3x4_f32le.bin',transform],['native_dehydrated_blas.bin',bvh],
    ['levels_original_stored_drawable.bin',drawableStored],['levels_original_decoded_drawable.zdr',drawable],
  ]);
  const geometry=vertexData(drawable,decoded.geometry,files);
  const verification=verifyLeaves(bvh,geometry);
  addAddressDescriptors(files,system,geometry,verification);
  files.set('geometry_descriptors.json',json(geometry.map(g=>g.descriptor)));
  const glb=previewGlb(geometry,transformValues);
  files.set('matched_geometry.glb',glb);
  files.set('provenance.json',json({
    asset:profile.name, format:'Xbox GPU ray-tracing BLAS', verification,
    sources:{bvh:{archive:profile.coreArchive,system:profile.system,graphics:profile.graphics},
      drawable:{archive:source.path,directory:source.directory,row:source.row,hash64:source.hash64,payload:source.stored}},
    files:Object.fromEntries([...files].map(([name,bytes])=>[name,{bytes:bytes.length,sha256:sha256(bytes)}])),
  }));
  const bundle=zipOutput(files);
  const verify=()=>{
    readSource(path,[profile.system,profile.graphics]);
    readSource(levelsPath,[source.directory,source.stored]);
  };
  verify();
  return {complete:coreStat.size>=profile.coreLength && hasByteRange(ranges,0,coreStat.size),coreSize:coreStat.size,
    entry:{
      name:'Xbox GPU BVH/'+profile.name+'.zip',size:bundle.length,stored:graphicsStored.length,
      offset:profile.graphics.offset,hash:source.hash64,sources:[path,levelsPath],
      read:()=>bundle, packed:()=>graphicsStored,verify,
      preview:()=>previewMeshGlb(glb,{triangles:verification.triangles,embeddedLabel:profile.name,
        note:'Verified Xbox GPU BVH · '+verification.geometryGroups+' geometry groups. Extract file saves the BVH bundle.'}),
    },
  };
}
