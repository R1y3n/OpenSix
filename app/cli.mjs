import { createWriteStream } from 'node:fs';
import { link, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { parseArgs } from 'node:util';
import { clearAssetPreviews } from './asset-preview.mjs';
import { dispatch, prepareExport, scanEntries } from './workspace.mjs';

const usage = 'opensix search|export <archive-or-folder> --exe <game.exe> [--query <text>] [--recursive] [--names <paths.txt>] [--labels]\n' +
  'opensix export <archive-or-folder> --out <directory> [--id <entry-id>] [--stored]\n' +
  'For an individual .ttpf file, omit --exe. Use --report <new local file> to save JSON Lines.';

async function allArchives(roots, settings) {
  const result = [...roots];
  if (!settings.recursive) return result;
  for (let index=0;index<result.length;index++) {
    const archive=result[index];
    if (archive.pool) continue;
    for (const row of scanEntries(archive.id)) {
      if (!row.nestedAvailable) continue;
      const data=await dispatch('/api/nested',{archive:archive.id,row:row.id,indexReferences:false});
      const child=data.archives.find(item=>item.id===data.selected);
      if (child && child.size<archive.size) result.push(child);
    }
  }
  return result;
}

async function exportEntry(directory, id, item, stored) {
  const file=await prepareExport(item.archive,item.row,stored);
  const target=join(directory,id+'-'+basename(file.name));
  const temporary=join(directory,'.opensix-'+randomBytes(10).toString('hex')+'.tmp');
  try {
    const bytes=file.read();
    let written=0;
    const limit=new Transform({
      transform(chunk,_encoding,done) {
        written+=chunk.length;
        if (written>file.length) done(new Error('Decoded data exceeds the entry size for '+id));
        else done(null,chunk);
      },
    });
    await pipeline(Buffer.isBuffer(bytes) ? [bytes] : bytes,limit,createWriteStream(temporary,{flags:'wx'}));
    if ((await stat(temporary)).size!==file.length) throw new Error('Incomplete export for '+id);
    await file.verify();
    // Publishing with a hard link is atomic and preserves any existing destination.
    await link(temporary,target);
    return target;
  } finally {
    await rm(temporary,{force:true});
  }
}

function writeLine(stream, line) {
  return new Promise((resolve,reject)=>stream.write(line+'\n',error=>error ? reject(error) : resolve()));
}

export async function runCli(args) {
  let report;
  const line = async value=>{
    if (report) await report.writeFile(value+'\n');
    else await writeLine(process.stdout,value);
  };
  try {
    const {values,positionals}=parseArgs({args,allowPositionals:true,options:{
      exe:{type:'string'},query:{type:'string'},recursive:{type:'boolean'},names:{type:'string'},
      out:{type:'string'},id:{type:'string',multiple:true},stored:{type:'boolean'},help:{type:'boolean'},
      report:{type:'string'},labels:{type:'boolean'},
    }});
    const [operation,source]=positionals;
    if (values.report) {
      if (!isAbsolute(values.report) || /^(?:\\\\|\/\/)/.test(values.report)) throw new Error('Choose an absolute local report path.');
      report=await open(values.report,'wx');
    }
    if (values.help) { await line(usage); return 0; }
    if (!['search','export'].includes(operation)||!source||positionals.length!==2||
        (operation==='export'&&!values.out)) throw new Error(usage);
    const data=/\.ttpf$/i.test(source)
      ? await dispatch('/api/open-pool',{path:source})
      : await dispatch('/api/open',{path:source,executable:values.exe,indexReferences:false});
    for (const issue of data.issues) await writeLine(process.stderr,issue);
    if (values.names) await dispatch('/api/names',{text:await readFile(values.names,'utf8')});
    const specified=new Set(values.id??[]);
    const entries=new Map();
    for (const archive of await allArchives(data.archives,values)) {
      if (values.labels && !archive.pool) await dispatch('/api/index-model-labels',{archive:archive.id});
      for (const row of scanEntries(archive.id,values.query)) {
        const id=archive.sourceId+'-'+row.id.toString(16);
        if (specified.size && !specified.has(id)) continue;
        entries.set(id,{archive:archive.id,row:row.id,name:row.name,type:row.type,hash:row.hash64,size:row.size,source:archive.path});
      }
    }
    for (const id of specified) if (!entries.has(id)) throw new Error('Unknown entry ID '+id);
    if (!entries.size) return 3;
    if (operation==='export') {
      if (!isAbsolute(values.out)||values.out.startsWith('\\\\')||values.out.startsWith('//')) throw new Error('Choose an absolute local output folder.');
      await mkdir(values.out,{recursive:true});
    }
    for (const [id,entry] of entries) {
      const record={id,name:entry.name,type:entry.type,hash:entry.hash,size:entry.size,source:entry.source};
      if (operation==='export') record.output=await exportEntry(values.out,id,entry,values.stored);
      await line(JSON.stringify(record));
    }
    return 0;
  } catch(error) {
    if (report) await report.writeFile(JSON.stringify({error:error.message})+'\n').catch(()=>{});
    await writeLine(process.stderr,error.message).catch(()=>{});
    return 1;
  } finally {
    clearAssetPreviews();
    await report?.close();
  }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  process.exitCode=await runCli(process.argv.slice(2));
}
