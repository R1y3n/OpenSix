import { closeSync, createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GameExecutable, openArchive, decodePayload, readStored, openVerifiedArchiveFile, streamPayload } from './rpf9.mjs';
import { FilenameIndex, fallbackName } from './names.mjs';
import { hasByteRange, readAvailableRanges } from './available-ranges.mjs';
import { previewResource } from './resource-preview.mjs';
import { assetPreviewFile, buildAssetPreview, resourceKind } from './asset-preview.mjs';
import { isBink, movieCommand, movieFrame, openMovie, stopMovie } from './bink-playback.mjs';

const defaults = { executable: '', folder: '' };

const archiveExtensions = new Set(['.rpf', '.rpf9']);
const modelExtensions = new Set(['zdr','zft','zdd']);
const expectedExtents = Object.entries(JSON.parse(readFileSync(new URL('./assets/scarlett-archive-extents.json', import.meta.url),'utf8')));

let workspace = null;
let sequence = 0;

function fail(message, code = 400) {
  const error = new Error(message);
  error.status = code;
  throw error;
}

function getPath(value, extension) {
  if (typeof value !== 'string') fail('Enter a local file path.');
  const path = value.trim().replace(/^"(.*)"$/, '$1');
  if (!isAbsolute(path) || path.startsWith('\\\\') || path.startsWith('//') ||
      (extension && extname(path).toLowerCase() !== extension)) {
    fail('Enter an absolute local ' + (extension ?? 'folder') + ' path.');
  }
  return resolve(path);
}


function requireWorkspace() {
  if (!workspace) fail('Open the matching executable and an RPF9 archive first.');
  return workspace;
}

function mount(state, path, parent = null, row = null) {
  const key = 'a' + (++sequence);
  const physicalSize = parent ? parent.archive.identity[0] : statSync(path).size;
  const availableRanges = parent?.archive.availableRanges ?? readAvailableRanges(path,physicalSize);
  if (!parent) {
    const profilePath = path.toLowerCase().replaceAll('\\','/');
    const expected = expectedExtents.find(([file]) => profilePath.endsWith('/' + file))?.[1];
    if (physicalSize < (expected ?? 64) || !hasByteRange(availableRanges,0,physicalSize)) {
      fail('Archive is incomplete. Open the complete RPF9 file.');
    }
  }
  const archive = openArchive(state.game,path,
    parent ? parent.archive.start+row.offset : 0, row?.size, { availableRanges });
  if (parent) archive.name = basename(state.names.resolve(row)?.path ?? fallbackName(row, state.game));
  const info = { key, archive, parent: parent?.key ?? null, row: row?.id ?? null };
  state.archives.set(key, info);
  return info;
}

function addArchive(state, path) {
  const old = [...state.archives.values()].find(item => item.parent === null && item.archive.path === path);
  const opened = mount(state, path);
  if (old) {
    const stale = new Set([old.key]);
    for (const [key, item] of state.archives) {
      if (stale.has(item.parent)) stale.add(key);
      if (stale.has(key)) state.archives.delete(key);
    }
  }
  return opened;
}

function infoFor(key) {
  const state = requireWorkspace();
  const info = state.archives.get(key);
  if (!info) fail('Archive is no longer open.', 404);
  return { state, info };
}

function rowFor(info, input) {
  if (!/^\d+$/.test(input ?? '')) fail('Entry is missing.', 404);
  const row = info.archive.pool ? info.archive.byId.get(Number(input)) : info.archive.rows[Number(input)];
  if (!row) fail('Entry is missing.', 404);
  return row;
}

function describeArchive(info, state) {
  const { archive } = info;
  let resolved = 0;
  if (!archive.pool) for (const row of archive.rows) if (state.names.resolve(row)) resolved++;
  return {
    id: info.key, name: archive.name, path: archive.path, parent: info.parent,
    size: archive.size, entries: archive.rowCount, resolved, pool: Boolean(archive.pool),
    headerSignature: archive.headerSignature ?? null,
    sourceId: createHash('sha256').update(JSON.stringify([
      archive.path.toLowerCase(), archive.start ?? 0, archive.headerHash ?? archive.size, archive.pool ? archive.mtimeMs : null,
    ])).digest('hex').slice(0,24),
  };
}

function describeRow(row, state) {
  if (row.pool) return { ...row, hash64:row.key, hash32:null, resolved:false, type:row.format,
    kind:'poolTexture', encrypted:false, chunks:null, nestedAvailable:false };
  const name = state.names.resolve(row);
  return {
    id: row.id, name: name?.path ?? fallbackName(row, state.game), modelLabels:row.modelLabels ?? [],
    resolved: Boolean(name), nameSource: name?.source ?? null,
    type: row.kind === 'archive' ? 'RPF9' : (name ? extname(name.path).slice(1) : '') || state.game.extension(row.type) || 'file',
    kind: row.kind, size: row.size, stored: row.stored, offset: row.offset,
    hash64: row.hash64, hash32: row.hash32, encrypted: Boolean(row.crypto),
    chunks: row.chunks?.items?.length ?? null,
    nestedAvailable: row.kind === 'archive' && !row.crypto && !row.chunks && row.size <= row.stored,
  };
}

function view(state, selected) {
  return {
    selected: selected?.key ?? null,
    archives: [...state.archives.values()].map(info => describeArchive(info, state)),
  };
}

function safeFilename(name) {
  const base = basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 190);
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  return !base || reserved.test(base) ? '_' + base : base;
}

function previewBytes(bytes) {
  const sample = bytes.subarray(0, 4096);
  if (sample.length) {
    const text = sample.toString('utf8');
    const control = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(text);
    if (!control) return { type: 'text', value: text, truncated: bytes.length > sample.length };
    if (sample[0] === 0xff && sample[1] === 0xfe) {
      return { type: 'text', value: sample.toString('utf16le', 2), truncated: bytes.length > sample.length };
    }
  }
  const lines = [];
  for (let i = 0; i < Math.min(512, sample.length); i += 16) {
    const line = sample.subarray(i, i + 16);
    const hex = [...line].map(n => n.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const text = [...line].map(n => n >= 32 && n <= 126 ? String.fromCharCode(n) : '.').join('');
    lines.push(i.toString(16).padStart(8, '0') + '  ' + hex + '  ' + text);
  }
  return { type: 'hex', value: lines.join('\n'), truncated: bytes.length > 512 };
}

function scanReferences(state, infos) {
  let bytes = 0;
  let files = 0;
  for (const { archive } of infos) {
    for (const row of archive.rows) {
      if (row.kind === 'archive' || row.size > 2 * 1024 * 1024 ||
          row.stored > 2 * 1024 * 1024 || bytes + row.size > 128 * 1024 * 1024) continue;
      try {
        const payload = decodePayload(state.game, archive, row);
        bytes += payload.length;
        files++;
        state.names.addText(payload.toString('latin1'), 'Reference in ' + archive.name);
        if (modelExtensions.has(state.game.extension(row.type))) indexModelLabels(row,payload);
        if (payload[0] === 0xff && payload[1] === 0xfe) {
          state.names.addText(payload.toString('utf16le', 2), 'Reference in ' + archive.name);
        }
      } catch {
        // Unrecognized payloads stay available as stored bytes.
      }
    }
  }
  return files;
}

function indexModelLabels(row, payload) {
  const system = payload.subarray(0,row.systemSize ?? 0).toString('latin1');
  const labels = new Set();
  for (const match of system.matchAll(/(?:^|\x00)([a-z0-9_-]{2,160})\.\#(?:dr|ft)\x00/g)) {
    labels.add(match[1]);
    if (labels.size===256) break;
  }
  row.modelLabels = [...labels];
}

async function indexArchiveModels(key) {
  const {state,info}=infoFor(key);
  if (info.archive.pool) fail('Choose an RPF9 archive to index model labels.');
  if (info.modelIndexing) fail('This archive is already indexing model labels.');
  info.modelIndexing=true;
  let indexed=0, unavailable=0;
  try {
    for (const row of info.archive.rows) {
      if (!modelExtensions.has(state.game.extension(row.type)) || !row.systemSize) continue;
      if (!Object.hasOwn(row,'modelLabels')) {
        try {
          indexModelLabels(row,decodePayload(state.game,info.archive,row));
        } catch {
          unavailable++;
        }
      }
      if (row.modelLabels?.length) indexed++;
      await new Promise(resolve=>setImmediate(resolve));
      if (workspace!==state || state.archives.get(key)!==info) fail('The selected archive closed during indexing.');
    }
    return {indexed,unavailable};
  } finally {
    info.modelIndexing=false;
  }
}

function readClip(input, state) {
  if (!input) return null;
  const info=state.archives.get(input.archive);
  if (!info || info.archive.pool) fail('The clip archive is no longer open.');
  const row=rowFor(info,String(input.entry));
  if (describeRow(row,state).type!=='zcd' || row.size>64*1024*1024 || !row.systemSize) fail('Choose a valid clip dictionary.');
  return decodePayload(state.game,info.archive,row).subarray(0,row.systemSize);
}

function assemblySource(state, item) {
  const info=state.archives.get(item?.archive);
  if (!info || info.archive.pool) fail('An assembly archive is no longer open.');
  const row=rowFor(info,String(item.entry));
  const entry=describeRow(row,state);
  if (!modelExtensions.has(entry.type.toLowerCase()) || !row.systemSize) fail('Choose a drawable for each part.');
  return {row,archive:info.archive.path,name:entry.name,source:info.archive,
    system_size:row.systemSize,index:item.index,detail:item.detail,wheel_scale:item.wheelScale,
    appearance:item.appearance};
}

async function assemble(input) {
  const state=requireWorkspace();
  const requested=input.parts;
  if (!Array.isArray(requested) || !requested.length || requested.length>32) fail('Choose up to 32 assembly parts.');
  if (requested[0]?.wheelScale!=null) fail('Choose a vehicle body before adding wheel geometry.');
  const parts=requested.map(item=>assemblySource(state,item));
  if (parts.reduce((n,part)=>n+part.row.size,0)>128*1024*1024) fail('The assembly exceeds 128 MiB of decoded resources.');
  const data=parts.map(part=>decodePayload(state.game,part.source,part.row));
  const requests=parts.map(({row,source,...request})=>request);
  const [base,...others]=requests;
  const clip=readClip(input.clip,state);
  return buildAssetPreview({...base,kind:'model',parts:others,clip_index:clip ? input.clip.index : null},data[0],clip,data.slice(1));
}

async function assembleWardrobe(input) {
  const state=requireWorkspace();
  const file=assetPreviewFile(input.id,'wardrobe.json');
  if (!file) fail('Open the wardrobe kit again before assembling it.');
  const {selections}=JSON.parse(readFileSync(file.path,'utf8'));
  const wanted=new Map();
  for (const part of selections) {
    if (part.drawable==='0000000000000000') continue;
    const appearance={albedo:part.albedo,normal:part.normal,extra:part.extra,palette:part.palette};
    const previous=wanted.get(part.drawable);
    if (previous && JSON.stringify(previous)!==JSON.stringify(appearance)) fail('Conflicting wardrobe states for '+part.drawable+'.');
    wanted.set(part.drawable,appearance);
  }
  const matches=new Map();
  for (const {key,archive} of state.archives.values()) {
    if (archive.pool) continue;
    for (const row of archive.rows) {
      if (!wanted.has(row.hash64) || !modelExtensions.has(state.game.extension(row.type))) continue;
      if (matches.has(row.hash64)) fail('Multiple open drawables have wardrobe key '+row.hash64+'.');
      matches.set(row.hash64,{archive:key,entry:row.id});
    }
  }
  const missing=[...wanted.keys()].filter(key=>!matches.has(key));
  if (missing.length) fail('Open the archives containing these wardrobe drawables. '+missing.slice(0,8).join(', '));
  const parts=[...wanted].map(([key,appearance])=>({...matches.get(key),appearance}));
  return assemble({parts,clip:input.clip});
}

export function* scanEntries(archive, search='') {
  const {state,info}=infoFor(archive);
  const query=search.trim().toLowerCase();
  for (const row of info.archive.rows) {
    const entry=describeRow(row,state);
    if (!query || matchesSearch(entry,query)) yield entry;
  }
}

function matchesSearch(entry, search) {
  return [entry.name, entry.hash64 ?? '', entry.hash32 ?? '', entry.type, entry.shape ?? '',
    ...(entry.modelLabels ?? [])].some(value=>value.toLowerCase().includes(search));
}

function verifyPool(archive) {
  const stat = statSync(archive.path);
  if (stat.size!==archive.size || stat.mtimeMs!==archive.mtimeMs || stat.ino!==archive.ino) {
    fail('The texture pool changed. Reopen it before previewing or exporting.');
  }
}

async function openPool(input) {
  const path = getPath(input.path, '.ttpf');
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 24 || !hasByteRange(readAvailableRanges(path, stat.size),0,stat.size)) {
    fail('Open a complete local texture pool.');
  }
  const archive = { path, name:basename(path), size:stat.size, mtimeMs:stat.mtimeMs, ino:stat.ino, pool:true };
  const index = await buildAssetPreview({kind:'poolIndex',archive:path});
  verifyPool(archive);
  archive.rows = index.rows.map(row=>({ ...row, pool:true }));
  archive.rowCount = archive.rows.length;
  archive.byId = new Map(archive.rows.map(row=>[row.id,row]));
  const state = workspace ?? { executable:null, game:null, archives:new Map(), names:null };
  const old = [...state.archives.values()].find(item=>item.archive.pool && item.archive.path===path);
  if (old) state.archives.delete(old.key);
  const info = { key:'a'+(++sequence), archive, parent:null, row:null };
  state.archives.set(info.key,info);
  workspace = state;
  return {...view(state,info),issues:[],scanned:0};
}


const deliver = value => value;
export function dispatch(endpoint, input) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/api/')) fail('Invalid action.');
  const url = new URL(endpoint, 'opensix://app');
  const route = url.pathname;
  const post = input !== undefined;
  if (post && (!input || typeof input !== "object")) fail("Invalid input.");
  if (!post && route === '/api/defaults') {
    return deliver({ defaults, ...(workspace ? view(workspace) : { archives: [] }) });
  }
  if (post && route === '/api/open-pool') return openPool(input);
  if (post && route === '/api/index-model-labels') return indexArchiveModels(input.archive);
  if (post && route === '/api/assembly') return assemble(input);
  if (post && route === '/api/wardrobe-assembly') return assembleWardrobe(input);
  if (post && route === '/api/movie-frame') return movieFrame(input.id,input.version);
  if (post && route === '/api/movie-command') return movieCommand(input.id,input.action,input.value);
  if (post && route === '/api/open') {
    const path = getPath(input.path);
    const executable = input.executable ? getPath(input.executable, '.exe') : workspace?.executable;
    if (!executable) fail('Enter the matching Scarlett executable path.');
    const state = workspace?.executable === executable ? workspace : {
      executable, game: new GameExecutable(executable), archives: new Map(
        [...(workspace?.archives ?? [])].filter(([,item])=>item.archive.pool)), names: null,
    };
    if (!state.names) state.names = new FilenameIndex(state.game);
    const isFolder = statSync(path).isDirectory();
    const paths = isFolder ? readdirSync(path, { withFileTypes: true, recursive: true })
      .filter(entry => entry.isFile() && archiveExtensions.has(extname(entry.name).toLowerCase()))
      .map(entry => join(entry.parentPath, entry.name)).sort() : [path];
    if (!paths.length) fail('No .rpf or .rpf9 archives were found in that folder.');
    const newlyOpened = [];
    const issues = [];
    for (const file of paths) {
      try { newlyOpened.push(addArchive(state, file)); }
      catch (error) { issues.push(basename(file) + ' · ' + error.message); }
    }
    if (!newlyOpened.length) fail(issues.join('\n'));
    for (const file of paths) state.names.add(basename(file), 'Local archive name');
    const scanned = input.indexReferences===false ? 0 : scanReferences(state, newlyOpened);
    workspace = state;
    const selected = newlyOpened.find(item => item.archive.name.toLowerCase() === 'common.rpf') ?? newlyOpened[0];
    return deliver({ ...view(state, selected), issues, scanned });
  }
  if (post && route === '/api/names') {
    const state = requireWorkspace();
    if (!state.names) fail('Open an RPF9 archive before importing paths.');
    if (typeof input.text !== 'string') fail('Provide a plain-text list of candidate paths.');
    state.names.addText(input.text, 'Imported path list', true);
    return deliver(view(state));
  }
  if (!post && route === '/api/list') {
    const { state, info } = infoFor(url.searchParams.get('archive'));
    const search = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const scope = url.searchParams.get('scope') ?? '';
    const filter = url.searchParams.get('filter') ?? 'all';
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const files = [];
    const folders = new Set();
    for (const row of info.archive.rows) {
      const entry = describeRow(row, state);
      if (entry.resolved && entry.name.includes('/')) folders.add(entry.name.slice(0, entry.name.lastIndexOf('/')));
      if (scope && (!entry.resolved || !entry.name.startsWith(scope + '/'))) continue;
      if (filter === 'resolved' && !entry.resolved || filter === 'unresolved' && entry.resolved) continue;
      if (search && !matchesSearch(entry,search)) continue;
      files.push(entry);
    }
    files.sort((a,b) => Number(b.resolved) - Number(a.resolved) || a.name.localeCompare(b.name));
    return deliver({
      archive: describeArchive(info, state), folders: [...folders].sort((a,b) => a.localeCompare(b)),
      total: files.length, rows: files.slice(offset, offset + 100),
    });
  }
  if (post && route === '/api/nested') {
    const { state, info } = infoFor(input.archive);
    const row = rowFor(info, String(input.row));
    if (row.kind !== 'archive' || row.crypto || row.chunks || row.size > row.stored) fail('This entry cannot be opened as an archive.');
    let nested = [...state.archives.values()].find(item => item.parent === info.key && item.row === row.id);
    if (!nested) nested = mount(state, info.archive.path, info, row);
    if (input.indexReferences!==false) scanReferences(state, [nested]);
    return deliver(view(state, nested));
  }
  if (!post && route === '/api/preview') return previewEntry(url);
  fail('Action is missing.', 404);
}

async function previewEntry(url) {
    stopMovie();
    const { state, info } = infoFor(url.searchParams.get('archive'));
    const row = rowFor(info, url.searchParams.get('entry'));
    if (info.archive.pool) {
      verifyPool(info.archive);
      const detail=url.searchParams.get('detail'), slice=url.searchParams.get('slice');
      return buildAssetPreview({kind:'poolTexture',archive:info.archive.path,index:row.id,
        detail:detail===null ? null : Number(detail),slice:slice===null ? null : Number(slice)});
    }
    const extension = describeRow(row,state).type.toLowerCase();
    try {
      const header = !row.chunks && !row.crypto ? readStored(info.archive,row,24) : null;
      if (isBink(header) && row.kind!=='archive' && row.size<=row.stored && row.size>=48) {
        closeSync(openVerifiedArchiveFile(info.archive));
        return openMovie(info.archive.path,info.archive.start+row.offset,row.size);
      }
      const kindHint = resourceKind(extension,header);
      if ((row.size > 8 * 1024 * 1024 && !kindHint) || row.kind === 'archive') {
        return deliver({ ...previewBytes(readStored(info.archive, row, 512)), stored: true });
      }
      const bytes = decodePayload(state.game, info.archive, row);
      const kind = resourceKind(extension,bytes);
      if (kind) {
        const index = url.searchParams.get('index');
        const detail = url.searchParams.get('detail');
        if ((kind==='metadata' || kind==='psin') && bytes.length<=64*1024*1024 &&
            (bytes.includes(Buffer.from('f54ccb8d','hex')) || bytes.includes(Buffer.from('8dcb4cf5','hex')))) {
          const kit=await buildAssetPreview({kind:'wardrobe',archive:info.archive.path,
            index:index===null ? null : Number(index)},bytes);
          if (kit.type==='wardrobe') return kit;
        }
        const clipIndex = kind==='model' ? url.searchParams.get('clipIndex') : null;
        const clip = clipIndex===null ? null : readClip({archive:url.searchParams.get('clipArchive'),
          entry:url.searchParams.get('clipEntry')},state);
        if (kind==='model') indexModelLabels(row,bytes);
        return buildAssetPreview({kind, archive:info.archive.path, name:describeRow(row,state).name,
          system_size:row.systemSize, index:index===null ? null : Number(index),
          detail:detail===null ? null : Number(detail),clip_index:clipIndex===null ? null : Number(clipIndex)},bytes,clip);
      }
      return deliver(previewResource(bytes) ?? previewBytes(bytes));
    } catch (error) {
      return deliver({ ...previewBytes(readStored(info.archive, row, 512)), stored: true, note: error.message });
    }
}

function inputFiles(state) {
  return [state.executable,...[...state.archives.values()].map(item=>item.archive.path)].filter(Boolean);
}

export function preparePreviewExport(id, name) {
  const state = requireWorkspace();
  const file = assetPreviewFile(id,name);
  if (!file) fail('Open the asset preview again before exporting.');
  const original = statSync(file.path);
  const length = original.size;
  return { name, length, sources:[...inputFiles(state),file.path],
    verify:() => {
      const current=statSync(file.path);
      if (current.size!==original.size || current.mtimeMs!==original.mtimeMs || current.ino!==original.ino) {
        fail('The preview file changed during export.');
      }
    },
    read:() => createReadStream(file.path) };
}

export function prepareExport(archive, entry, stored, mip) {
  const { state, info } = infoFor(archive);
  const row = rowFor(info, String(entry));
  if (info.archive.pool) {
    verifyPool(info.archive);
    if (stored) fail('Texture pools export the selected image as DDS.');
    if (mip!==undefined && (!Number.isInteger(mip) || mip<0 || mip>31)) fail('Choose a valid source mip.');
    return buildAssetPreview({kind:'poolDds',archive:info.archive.path,index:row.id,detail:mip}).then(result=>{
      verifyPool(info.archive);
      const file=preparePreviewExport(result.id,result.file);
      const suffix=mip===undefined ? '' : '_mip'+mip;
      return {...file,name:safeFilename(row.name.replace(/\.dds$/i,''))+suffix+'.dds'};
    });
  }
  if (mip!==undefined) fail('Mip selection is available for texture pools.');
  const raw = stored === true;
  const entryInfo = describeRow(row, state);
  const name = safeFilename(entryInfo.name) + (raw ? ".stored" : "");
  const length = raw ? row.stored : row.size;
  const direct = raw || (!row.crypto && !row.chunks && row.size <= row.stored);
  return {
    name, length, sources: inputFiles(state),
    verify: () => closeSync(openVerifiedArchiveFile(info.archive)),
    read: () => direct && length > 0
      ? createReadStream(info.archive.path, { fd: openVerifiedArchiveFile(info.archive),
          start: info.archive.start + row.offset, end: info.archive.start + row.offset + length - 1 })
      : direct ? Buffer.alloc(0) : streamPayload(state.game, info.archive, row),
  };
}
