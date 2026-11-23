import { closeSync, createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { GameExecutable, openArchive, decodePayload, readStored, openVerifiedArchiveFile, streamPayload } from './rpf9.mjs';
import { FilenameIndex, fallbackName } from './names.mjs';
import { hasByteRange, readAvailableRanges } from './available-ranges.mjs';
import { previewResource } from './resource-preview.mjs';
import { assetPreviewFile, buildAssetPreview, resourceKind } from './asset-preview.mjs';

const defaults = { executable: '', folder: '' };

const archiveExtensions = new Set(['.rpf', '.rpf9']);
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
  const row = info.archive.rows[Number(input)];
  if (!row) fail('Entry is missing.', 404);
  return row;
}

function describeArchive(info, state) {
  const { archive } = info;
  let resolved = 0;
  for (const row of archive.rows) if (state.names.resolve(row)) resolved++;
  return {
    id: info.key, name: archive.name, path: archive.path, parent: info.parent,
    size: archive.size, entries: archive.rowCount, resolved,
  };
}

function describeRow(row, state) {
  const name = state.names.resolve(row);
  return {
    id: row.id, name: name?.path ?? fallbackName(row, state.game),
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
  if (post && route === '/api/open') {
    const path = getPath(input.path);
    const executable = input.executable ? getPath(input.executable, '.exe') : workspace?.executable;
    if (!executable) fail('Enter the matching Scarlett executable path.');
    const state = workspace?.executable === executable ? workspace : {
      executable, game: new GameExecutable(executable), archives: new Map(), names: null,
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
    const scanned = scanReferences(state, newlyOpened);
    workspace = state;
    const selected = newlyOpened.find(item => item.archive.name.toLowerCase() === 'common.rpf') ?? newlyOpened[0];
    return deliver({ ...view(state, selected), issues, scanned });
  }
  if (post && route === '/api/names') {
    const state = requireWorkspace();
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
      if (search && ![entry.name, entry.hash64 ?? '', entry.hash32 ?? ''].some(x => x.toLowerCase().includes(search))) continue;
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
    scanReferences(state, [nested]);
    return deliver(view(state, nested));
  }
  if (!post && route === '/api/preview') {
    const { state, info } = infoFor(url.searchParams.get('archive'));
    const row = rowFor(info, url.searchParams.get('entry'));
    const extension = describeRow(row,state).type.toLowerCase();
    try {
      const header = !row.chunks && !row.crypto ? readStored(info.archive,row,4) : null;
      const kindHint = resourceKind(extension,header);
      if ((row.size > 8 * 1024 * 1024 && !kindHint) || row.kind === 'archive') {
        return deliver({ ...previewBytes(readStored(info.archive, row, 512)), stored: true });
      }
      const bytes = decodePayload(state.game, info.archive, row);
      const kind = resourceKind(extension,bytes);
      if (kind) {
        const index = url.searchParams.get('index');
        const detail = url.searchParams.get('detail');
        return buildAssetPreview({kind, archive:info.archive.path, name:describeRow(row,state).name,
          system_size:row.systemSize, index:index===null ? null : Number(index),
          detail:detail===null ? null : Number(detail)},bytes);
      }
      return deliver(previewResource(bytes) ?? previewBytes(bytes));
    } catch (error) {
      return deliver({ ...previewBytes(readStored(info.archive, row, 512)), stored: true, note: error.message });
    }
  }

  fail('Action is missing.', 404);
}

function inputFiles(state) {
  return [state.executable,...[...state.archives.values()].map(item=>item.archive.path)];
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

export function prepareExport(archive, entry, stored) {
  const { state, info } = infoFor(archive);
  const row = rowFor(info, String(entry));
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
