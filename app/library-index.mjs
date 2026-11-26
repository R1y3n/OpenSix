// A persistent index of every archive entry under a game folder.
// Nothing here writes inside the game folder. The index lives in the OpenSix data directory.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, writeSync, appendFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';

export const INDEX_VERSION = 1;
const MAGIC = 0x5849534f; // "OSIX"
const NONE32 = 0;

export const modelExtensions = new Set(['zdr', 'zft', 'zdd']);

const hex8 = value => value.toString(16).padStart(8, '0');
export const hashHex = (hi, lo) => hex8(hi) + hex8(lo);

// ----- extension classification (only what the format audit established) -----
const categories = new Map([
  ['zdr', ['model', 'Drawable']], ['zft', ['model', 'Fragment']], ['zdd', ['model', 'Drawable dictionary']],
  ['ztd', ['texture', 'Texture dictionary']], ['ttpf', ['texture', 'Texture pool']],
  ['zcd', ['animation', 'Clip dictionary']],
  ['zbn', ['collision', 'Collision bounds']], ['zbd', ['collision', 'Bounds dictionary']],
  ['zmap', ['map', 'Map placements']], ['ztyp', ['map', 'Archetype definitions']],
  ['znv', ['map', 'Navigation mesh']],
  ['zmt', ['data', 'Metadata']], ['zscript', ['data', 'Script']], ['zdatb', ['data', 'Data']],
  ['rpf', ['archive', 'Archive']], ['awc', ['audio', 'Audio bank']], ['zad', ['audio', 'Audio data']],
  ['bk2', ['video', 'Bink video']], ['gfx', ['data', 'Scaleform movie']],
]);

const documents = new Map([
  ['xml', 'XML document'], ['meta', 'Metadata document'], ['txt', 'Text file'], ['json', 'JSON document'], ['csv', 'CSV table'],
  ['dat', 'Data file'], ['ini', 'Settings file'], ['cfg', 'Settings file'], ['xsd', 'XML schema'], ['bin', 'Binary data'],
  ['png', 'PNG image'], ['dds', 'DDS texture'], ['wav', 'WAV audio'], ['ogg', 'Ogg audio'],
]);

export function classify(ext, kind = null) {
  const key = ext?.toLowerCase();
  const found = categories.get(key);
  if (found) return { category: found[0], label: found[1] };
  if (documents.has(key)) return { category: ['png', 'dds'].includes(key) ? 'texture' : ['wav', 'ogg'].includes(key) ? 'audio' : 'data', label: documents.get(key) };
  if (!key || key === 'file') return { category: 'other', label: 'Data (unknown type)' };
  return { category: 'other', label: kind === 'file' ? key.toUpperCase() + ' file' : key + ' resource' };
}

export const searchCategories = [
  ['model', 'Models'], ['texture', 'Textures'], ['animation', 'Animations'], ['collision', 'Collision'],
  ['map', 'Maps'], ['audio', 'Audio'], ['data', 'Data'], ['other', 'Other'],
];

// ----- the in-memory index -----
export class GameIndex {
  constructor(header, columns) {
    this.header = header;
    this.archives = header.archives;
    Object.assign(this, columns);
    this.count = columns.hi.length;
    this.labels = new Map();      // row index -> { labels: string[], match: number }
    this.names = new Map();       // row index -> { path, source }
    this.extensionOf = () => null;
  }

  archiveOf(rowIndex) {
    let low = 0, high = this.archives.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.archives[middle].rowStart <= rowIndex) low = middle; else high = middle - 1;
    }
    return low;
  }

  rowIndex(archive, rowId) { return this.archives[archive].rowStart + rowId; }

  hash64(rowIndex) { return hashHex(this.hi[rowIndex], this.lo[rowIndex]); }
  hash32(rowIndex) { return this.flags[rowIndex] & 2 ? null : hex8(this.h32[rowIndex]); }
  isArchive(rowIndex) { return Boolean(this.flags[rowIndex] & 4); }

  extension(rowIndex) {
    if (this.isArchive(rowIndex)) return 'rpf';
    return this.extensionOf(this.type[rowIndex]) ?? 'bin';
  }

  // All rows whose 64-bit hash equals the given value (binary search over the sorted order).
  rowsWithHash(hi, lo) {
    const { order } = this;
    let low = 0, high = order.length;
    const before = index => {
      const row = order[index];
      return this.hi[row] < hi || (this.hi[row] === hi && this.lo[row] < lo);
    };
    while (low < high) {
      const middle = (low + high) >> 1;
      if (before(middle)) low = middle + 1; else high = middle;
    }
    const rows = [];
    for (let index = low; index < order.length; index++) {
      const row = order[index];
      if (this.hi[row] !== hi || this.lo[row] !== lo) break;
      rows.push(row);
    }
    return rows;
  }

  archiveTrail(archiveIndex) {
    const trail = [];
    for (let index = archiveIndex; index >= 0; index = this.archives[index].parent) {
      const item = this.archives[index];
      const named = item.parent < 0 ? item.rel : this.nameOf(this.rowIndex(item.parent, item.rowId))?.path ?? (item.label + '.rpf');
      trail.unshift({ archive: index, name: named });
    }
    return trail;
  }

  nameOf(rowIndex) {
    const resolved = this.names.get(rowIndex);
    if (resolved) return resolved;
    const labelled = this.labels.get(rowIndex);
    if (labelled && labelled.match >= 0) {
      return { path: labelled.labels[labelled.match] + '.' + this.extension(rowIndex), source: 'Embedded model label (64-bit hash verified)', label: true };
    }
    return null;
  }

  // Apply verified path candidates (a FilenameIndex) to every row that shares a candidate hash.
  applyNames(filenames) {
    this.names = new Map();
    for (const hash of filenames.hashKeys()) {
      const hi = parseInt(hash.slice(0, 8), 16), lo = parseInt(hash.slice(8), 16);
      for (const row of this.rowsWithHash(hi, lo)) {
        const resolved = filenames.resolve({
          hash64: hash, hash32: this.hash32(row), type: this.type[row],
        });
        if (resolved) this.names.set(row, resolved);
      }
    }
  }
}

// ----- persistence -----
function align(value, boundary) { return Math.ceil(value / boundary) * boundary; }

export function saveIndex(directory, header, columns) {
  mkdirSync(directory, { recursive: true });
  const count = columns.hi.length;
  const json = Buffer.from(JSON.stringify(header));
  const start = align(16 + json.length, 8);
  const layout = [
    ['hi', 4], ['lo', 4], ['h32', 4], ['sys', 4], ['order', 4], ['size', 8], ['type', 1], ['flags', 1],
  ];
  let total = start;
  for (const [, width] of layout) total = align(total + count * width, 8);
  const output = Buffer.alloc(total);
  output.writeUInt32LE(MAGIC, 0);
  output.writeUInt32LE(INDEX_VERSION, 4);
  output.writeUInt32LE(json.length, 8);
  output.writeUInt32LE(count, 12);
  json.copy(output, 16);
  let cursor = start;
  for (const [name, width] of layout) {
    Buffer.from(columns[name].buffer, columns[name].byteOffset, count * width).copy(output, cursor);
    cursor = align(cursor + count * width, 8);
  }
  const temporary = join(directory, 'index.bin.tmp');
  writeFileSync(temporary, output);
  renameSync(temporary, join(directory, 'index.bin'));
}

export function loadIndex(directory) {
  const path = join(directory, 'index.bin');
  if (!existsSync(path)) return null;
  const file = readFileSync(path);
  if (file.length < 16 || file.readUInt32LE(0) !== MAGIC || file.readUInt32LE(4) !== INDEX_VERSION) return null;
  const jsonLength = file.readUInt32LE(8);
  const count = file.readUInt32LE(12);
  const header = JSON.parse(file.toString('utf8', 16, 16 + jsonLength));
  let cursor = align(16 + jsonLength, 8);
  const take = (Type, width) => {
    const bytes = file.subarray(cursor, cursor + count * width);
    cursor = align(cursor + count * width, 8);
    const copy = new ArrayBuffer(bytes.length);
    new Uint8Array(copy).set(bytes);
    return new Type(copy);
  };
  const columns = {
    hi: take(Uint32Array, 4), lo: take(Uint32Array, 4), h32: take(Uint32Array, 4), sys: take(Uint32Array, 4),
    order: take(Uint32Array, 4), size: take(Float64Array, 8), type: take(Uint8Array, 1), flags: take(Uint8Array, 1),
  };
  if (cursor > file.length) return null;
  return new GameIndex(header, columns);
}

// ----- label persistence (resumable) -----
// Returns the archives whose models were scanned. The archives whose clip dictionaries were scanned are in `done.clips`.
export function loadLabels(directory, index) {
  const progressPath = join(directory, 'labels-progress.json');
  const clipsPath = join(directory, 'clips-progress.json');
  const labelsPath = join(directory, 'labels.jsonl');
  const done = new Set();
  done.clips = new Set();
  if (!existsSync(labelsPath)) return done;
  const read = path => {
    if (!existsSync(path)) return [];
    try {
      const progress = JSON.parse(readFileSync(path, 'utf8'));
      return progress.fingerprint === index.header.fingerprintHash ? progress.done : [];
    } catch { return []; }
  };
  for (const id of read(progressPath)) done.add(id);
  for (const id of read(clipsPath)) done.clips.add(id);
  if (!done.size && !done.clips.size) return done;
  for (const line of readFileSync(labelsPath, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const [rowIndex, match, labels] = JSON.parse(line);
      index.labels.set(rowIndex, { labels, match });
    } catch { /* A partial final line is ignored. */ }
  }
  return done;
}

// ----- discovery of the game folder contents -----
export function listArchiveFiles(gameDir) {
  const files = readdirSync(gameDir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && ['.rpf', '.rpf9'].includes(extname(entry.name).toLowerCase()))
    .map(entry => join(entry.parentPath ?? entry.path, entry.name));
  return files.map(path => path.slice(gameDir.length + 1).split('\\').join('/')).sort();
}

export function fingerprint(gameDir, exe) {
  const files = listArchiveFiles(gameDir).map(rel => {
    const stat = statSync(join(gameDir, rel));
    return [rel, stat.size, Math.floor(stat.mtimeMs)];
  });
  const exeStat = statSync(exe);
  const state = { exe: [exeStat.size, Math.floor(exeStat.mtimeMs)], files };
  return { files, hash: createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 32) };
}

// ----- worker pool -----
class Pool {
  constructor(size, data) {
    this.size = size;
    this.queue = [];
    this.pending = new Map();
    this.sequence = 0;
    this.idle = [];
    this.workers = Array.from({ length: size }, () => {
      const worker = new Worker(new URL('./index-worker.mjs', import.meta.url), { workerData: data });
      const state = { worker, ready: false };
      worker.on('message', message => {
        if (message.ready) { state.ready = true; this.idle.push(state); this.pump(); return; }
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        this.idle.push(state);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
        this.pump();
      });
      worker.on('error', error => {
        for (const [, pending] of this.pending) pending.reject(error);
        this.pending.clear();
      });
      return state;
    });
  }

  run(task) {
    return new Promise((resolve, reject) => { this.queue.push({ task, resolve, reject }); this.pump(); });
  }

  pump() {
    while (this.queue.length && this.idle.length) {
      const job = this.queue.shift();
      const state = this.idle.pop();
      const id = ++this.sequence;
      this.pending.set(id, job);
      state.worker.postMessage({ id, task: job.task });
    }
  }

  async close() { await Promise.all(this.workers.map(({ worker }) => worker.terminate())); }
}

export const defaultThreads = (limit = 6) => Math.max(1, Math.min(limit, availableParallelism() - 2));

// ----- building -----
export async function buildIndex({ gameDir, exe, directory, onProgress = () => {}, threads = defaultThreads(4), isCancelled = () => false }) {
  const { files, hash } = fingerprint(gameDir, exe);
  const pool = new Pool(threads, { exe, gameDir });
  const issues = [];
  try {
    const archives = [];
    let level = files.map(([rel]) => ({ rel, start: 0, size: null, parent: -1, rowId: -1, label: rel }));
    const results = [];
    let finished = 0;
    while (level.length) {
      if (isCancelled()) throw new Error('Indexing was cancelled.');
      const base = archives.length;
      level.forEach((job, offset) => { job.index = base + offset; archives.push(job); });
      const outputs = await Promise.all(level.map(async job => {
        try {
          const result = await pool.run({ type: 'walk', rel: job.rel, start: job.start, size: job.size });
          onProgress({ phase: 'archives', done: ++finished, total: archives.length });
          return result;
        } catch (error) {
          issues.push(job.rel + (job.parent >= 0 ? ' › entry ' + job.rowId : '') + ' · ' + error.message);
          onProgress({ phase: 'archives', done: ++finished, total: archives.length });
          return null;
        }
      }));
      const next = [];
      outputs.forEach((result, offset) => {
        const job = level[offset];
        results[job.index] = result;
        if (!result) { job.rowCount = 0; return; }
        job.rowCount = result.rowCount;
        for (const nested of result.nested) {
          const label = hashHex(result.hi[nested.rowId], result.lo[nested.rowId]);
          next.push({ rel: job.rel, start: nested.start, size: nested.size, parent: job.index, rowId: nested.rowId, label });
        }
      });
      level = next;
    }
    let count = 0;
    for (const archive of archives) { archive.rowStart = count; count += archive.rowCount ?? 0; }
    const columns = {
      hi: new Uint32Array(count), lo: new Uint32Array(count), h32: new Uint32Array(count), sys: new Uint32Array(count),
      order: new Uint32Array(count), size: new Float64Array(count), type: new Uint8Array(count), flags: new Uint8Array(count),
    };
    for (const archive of archives) {
      const result = results[archive.index];
      if (!result) continue;
      columns.hi.set(result.hi, archive.rowStart); columns.lo.set(result.lo, archive.rowStart);
      columns.h32.set(result.h32, archive.rowStart); columns.sys.set(result.sys, archive.rowStart);
      columns.size.set(result.size, archive.rowStart); columns.type.set(result.type, archive.rowStart);
      columns.flags.set(result.flags, archive.rowStart);
    }
    onProgress({ phase: 'sorting', done: 0, total: 1 });
    for (let i = 0; i < count; i++) columns.order[i] = i;
    columns.order.sort((a, b) => columns.hi[a] - columns.hi[b] || columns.lo[a] - columns.lo[b] || a - b);
    const header = {
      version: INDEX_VERSION, gameDir, builtAt: new Date().toISOString(), fingerprintHash: hash,
      fingerprint: files, issues,
      archives: archives.map(({ rel, start, size, parent, rowId, label, rowStart, rowCount }) =>
        ({ rel, start, size, parent, rowId, label, rowStart, rowCount })),
    };
    saveIndex(directory, header, columns);
    rmSync(join(directory, 'labels.jsonl'), { force: true });
    rmSync(join(directory, 'labels-progress.json'), { force: true });
    onProgress({ phase: 'done', done: 1, total: 1 });
    return loadIndex(directory);
  } finally {
    await pool.close();
  }
}

// Scan model system pages for embedded drawable labels. Resumable and incremental.
export async function scanLabels({ index, exe, gameDir, directory, onProgress = () => {}, threads = defaultThreads(2), isCancelled = () => false, done = null, mode = 'models' }) {
  const clips = mode === 'clips';
  const loaded = done ?? loadLabels(directory, index);
  done = clips ? loaded.clips : loaded;
  const wanted = [];
  const modelTypes = new Set();
  const kinds = clips ? new Set(['zcd']) : modelExtensions;
  for (let type = 0; type < 256; type++) if (kinds.has(index.extensionOf(type))) modelTypes.add(type);
  index.archives.forEach((archive, archiveIndex) => {
    if (done.has(archiveIndex) || !archive.rowCount) return;
    const rows = [];
    for (let rowId = 0; rowId < archive.rowCount; rowId++) {
      const row = archive.rowStart + rowId;
      if (index.sys[row] && !index.isArchive(row) && modelTypes.has(index.type[row])) rows.push(rowId);
    }
    if (rows.length) wanted.push({ archiveIndex, archive, rows });
    else done.add(archiveIndex);
  });
  const total = wanted.reduce((sum, item) => sum + item.rows.length, 0);
  let scanned = 0, found = 0, failed = 0;
  const labelsPath = join(directory, 'labels.jsonl');
  const progressPath = join(directory, clips ? 'clips-progress.json' : 'labels-progress.json');
  let lastSave = 0;
  const save = () => writeFileSync(progressPath, JSON.stringify({ fingerprint: index.header.fingerprintHash, done: [...done] }));
  const pool = new Pool(threads, { exe, gameDir });
  try {
    onProgress({ phase: clips ? 'clips' : 'labels', done: 0, total });
    // One task per archive, in file order. The pool runs only a few at once so a spinning game drive is not thrashed.
    wanted.sort((a, b) => (a.archive.rel < b.archive.rel ? -1 : a.archive.rel > b.archive.rel ? 1 : a.archive.start - b.archive.start));
    const slices = wanted;
    const remaining = new Map(wanted.map(item => [item.archiveIndex, 1]));
    await Promise.all(slices.map(async slice => {
      if (isCancelled()) return;
      try {
        const result = await pool.run({ type: 'labels', mode, rel: slice.archive.rel, start: slice.archive.start, size: slice.archive.size, rows: slice.rows });
        const lines = [];
        for (const [rowId, match, labels] of result.found) {
          const rowIndex = slice.archive.rowStart + rowId;
          index.labels.set(rowIndex, { labels, match });
          lines.push(JSON.stringify([rowIndex, match, labels]));
          found++;
        }
        if (lines.length) appendFileSync(labelsPath, lines.join('\n') + '\n');
        failed += result.failed;
        scanned += slice.rows.length;
        const left = remaining.get(slice.archiveIndex) - 1;
        remaining.set(slice.archiveIndex, left);
        if (!left) done.add(slice.archiveIndex);
      } catch {
        failed += slice.rows.length;
        scanned += slice.rows.length;
      }
      onProgress({ phase: clips ? 'clips' : 'labels', done: scanned, total, found, failed });
      if (Date.now() - lastSave > 5000) { lastSave = Date.now(); save(); }
    }));
    save();
    return { scanned, found, failed, complete: !isCancelled() };
  } finally {
    await pool.close();
  }
}

// ----- texture pool index -----
// Every texture of every .ttpf under the game folder, keyed by the 64-bit hash that model materials reference.
const TEXTURE_MAGIC = 0x58455454; // "TTEX"

export function listPoolFiles(gameDir) {
  const files = readdirSync(gameDir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.ttpf')
    .map(entry => join(entry.parentPath ?? entry.path, entry.name));
  return files.map(path => path.slice(gameDir.length + 1).split('\\').join('/')).sort();
}

export function poolFingerprint(gameDir) {
  const files = listPoolFiles(gameDir).map(rel => {
    const stat = statSync(join(gameDir, rel));
    return [rel, stat.size, Math.floor(stat.mtimeMs)];
  });
  return { files, hash: createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 32) };
}

export class TextureIndex {
  constructor(header, columns) {
    this.header = header;
    this.pools = header.pools;
    this.formats = header.formats;
    Object.assign(this, columns);
    this.count = columns.hi.length;
  }

  hash(row) { return hashHex(this.hi[row], this.lo[row]); }
  nameHash(row) { return hashHex(this.nhi[row], this.nlo[row]); }
  poolName(row) {
    const id = this.rowId[row];
    return 'texture_' + String(id).padStart(6, '0') + '_' + this.nameHash(row).toUpperCase() + '.dds';
  }
}

export async function buildTextureIndex({ gameDir, directory, indexPool, onProgress = () => {}, isCancelled = () => false }) {
  const { files, hash } = poolFingerprint(gameDir);
  const formats = [];
  const chunks = [];
  let total = 0;
  for (let at = 0; at < files.length; at++) {
    if (isCancelled()) throw new Error('Indexing was cancelled.');
    const [rel] = files[at];
    let rows = [];
    try { rows = (await indexPool(join(gameDir, rel))).rows ?? []; } catch { rows = []; }
    const count = rows.length;
    const columns = {
      pool: new Uint16Array(count).fill(at), rowId: new Uint32Array(count), hi: new Uint32Array(count), lo: new Uint32Array(count),
      nhi: new Uint32Array(count), nlo: new Uint32Array(count), width: new Uint16Array(count), height: new Uint16Array(count),
      fmt: new Uint8Array(count), size: new Uint32Array(count),
    };
    rows.forEach((row, i) => {
      columns.rowId[i] = row.id;
      columns.hi[i] = parseInt(row.key.slice(0, 8), 16);
      columns.lo[i] = parseInt(row.key.slice(8), 16);
      const named = /_([0-9A-Fa-f]{16})\.dds$/.exec(row.name ?? '');
      if (named) { columns.nhi[i] = parseInt(named[1].slice(0, 8), 16); columns.nlo[i] = parseInt(named[1].slice(8), 16); }
      columns.width[i] = Math.min(row.width ?? 0, 65535);
      columns.height[i] = Math.min(row.height ?? 0, 65535);
      let format = formats.indexOf(row.format ?? '?');
      if (format < 0) format = formats.push(row.format ?? '?') - 1;
      columns.fmt[i] = format;
      columns.size[i] = Math.min(row.size ?? 0, 0xffffffff);
    });
    chunks.push(columns);
    total += count;
    onProgress({ phase: 'textures', done: at + 1, total: files.length, found: total });
  }
  const names = ['pool', 'rowId', 'hi', 'lo', 'nhi', 'nlo', 'width', 'height', 'fmt', 'size', 'order'];
  const Types = { pool: Uint16Array, rowId: Uint32Array, hi: Uint32Array, lo: Uint32Array, nhi: Uint32Array, nlo: Uint32Array,
    width: Uint16Array, height: Uint16Array, fmt: Uint8Array, size: Uint32Array, order: Uint32Array };
  const merged = {};
  for (const name of names) {
    merged[name] = new Types[name](total);
    if (name === 'order') continue;
    let at = 0;
    for (const part of chunks) { merged[name].set(part[name], at); at += part.pool.length; }
  }
  for (let i = 0; i < total; i++) merged.order[i] = i;
  merged.order.sort((a, b) => merged.hi[a] - merged.hi[b] || merged.lo[a] - merged.lo[b] || a - b);
  const header = { version: 1, builtAt: new Date().toISOString(), fingerprintHash: hash, pools: files.map(([rel]) => rel), formats };
  const json = Buffer.from(JSON.stringify(header));
  const sizes = names.map(name => merged[name].byteLength);
  const start = align(16 + json.length, 8);
  let cursor = start;
  const offsets = sizes.map(size => { const at = cursor; cursor = align(cursor + size, 8); return at; });
  const output = Buffer.alloc(cursor);
  output.writeUInt32LE(TEXTURE_MAGIC, 0);
  output.writeUInt32LE(1, 4);
  output.writeUInt32LE(json.length, 8);
  output.writeUInt32LE(total, 12);
  json.copy(output, 16);
  names.forEach((name, i) => Buffer.from(merged[name].buffer, merged[name].byteOffset, sizes[i]).copy(output, offsets[i]));
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, 'textures.bin.tmp');
  writeFileSync(temporary, output);
  renameSync(temporary, join(directory, 'textures.bin'));
  return loadTextureIndex(directory);
}

export function loadTextureIndex(directory) {
  const path = join(directory, 'textures.bin');
  if (!existsSync(path)) return null;
  const file = readFileSync(path);
  if (file.length < 16 || file.readUInt32LE(0) !== TEXTURE_MAGIC || file.readUInt32LE(4) !== 1) return null;
  const jsonLength = file.readUInt32LE(8);
  const count = file.readUInt32LE(12);
  const header = JSON.parse(file.toString('utf8', 16, 16 + jsonLength));
  let cursor = align(16 + jsonLength, 8);
  const take = (Type, width) => {
    const bytes = file.subarray(cursor, cursor + count * width);
    cursor = align(cursor + count * width, 8);
    const copy = new ArrayBuffer(bytes.length);
    new Uint8Array(copy).set(bytes);
    return new Type(copy);
  };
  const columns = {
    pool: take(Uint16Array, 2), rowId: take(Uint32Array, 4), hi: take(Uint32Array, 4), lo: take(Uint32Array, 4),
    nhi: take(Uint32Array, 4), nlo: take(Uint32Array, 4), width: take(Uint16Array, 2), height: take(Uint16Array, 2),
    fmt: take(Uint8Array, 1), size: take(Uint32Array, 4), order: take(Uint32Array, 4),
  };
  if (cursor > file.length) return null;
  return new TextureIndex(header, columns);
}
