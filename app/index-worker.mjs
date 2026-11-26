// Worker thread for the library indexer. It only reads game files.
import { parentPort, workerData } from 'node:worker_threads';
import { join } from 'node:path';
import { GameExecutable, murmurName64, openArchive, readSystemPage } from './rpf9.mjs';

const game = new GameExecutable(workerData.exe);
const root = workerData.gameDir;
const labelPattern = /(?:^|\x00)([a-z0-9_-]{2,160})\.\#(?:dr|ft)\x00/g;

function open(task) {
  const path = join(root, task.rel);
  return openArchive(game, path, task.start, task.size ?? undefined, {});
}

// Read one archive directory into compact columns.
function walk(task) {
  const archive = open(task);
  const count = archive.rowCount;
  const hi = new Uint32Array(count), lo = new Uint32Array(count), h32 = new Uint32Array(count);
  const type = new Uint8Array(count), sys = new Uint32Array(count), size = new Float64Array(count);
  const flags = new Uint8Array(count);
  const nested = [];
  for (const row of archive.rows) {
    const i = row.id;
    if (row.hash64) {
      hi[i] = parseInt(row.hash64.slice(0, 8), 16);
      lo[i] = parseInt(row.hash64.slice(8), 16);
    } else flags[i] |= 1;
    if (row.hash32) h32[i] = parseInt(row.hash32, 16);
    else flags[i] |= 2;
    type[i] = row.type;
    sys[i] = row.systemSize ?? 0;
    size[i] = row.size;
    if (row.kind === 'archive') {
      flags[i] |= 4;
      if (!row.crypto && !row.chunks && row.size <= row.stored) {
        nested.push({ rowId: row.id, start: archive.start + row.offset, size: row.size });
      } else flags[i] |= 8;
    }
    if (row.crypto) flags[i] |= 16;
  }
  return { rowCount: count, hi, lo, h32, type, sys, size, flags, nested, signature: archive.headerSignature };
}

// Clip dictionaries store their own name, the names of their clips and the animation files they use as plain text.
// Only lowercase tokens are taken, which leaves out the binary noise between them.
const clipToken = /[a-z0-9_@:\/.\-]{6,240}/g;
function clipNames(text) {
  const names = new Set();
  for (const [token] of text.matchAll(clipToken)) {
    if (token.startsWith('pack:/')) {
      const file = token.slice(6);
      if (/^[a-z0-9_@.\-]+\.(clip|anim)$/.test(file)) names.add(file);
    } else if (token.includes('@') && /^[a-z]/.test(token) && !token.includes(':') && !token.includes('/') && /@[a-z0-9_\-]{2,}/.test(token)) {
      names.add(token);
    }
  }
  return [...names].slice(0, 400);
}

async function labels(task) {
  const archive = open(task);
  const byId = new Map(archive.rows.map(row => [row.id, row]));
  const found = [];
  let failed = 0;
  // Read in file order. The game drive is often a spinning disk, so sequential access is much faster.
  const ordered = task.rows.map(id => byId.get(id)).filter(Boolean).sort((a, b) => a.offset - b.offset);
  for (const row of ordered) {
    const id = row.id;
    try {
      const page = await readSystemPage(game, archive, row);
      const text = page.toString('latin1');
      const names = task.mode === 'clips' ? clipNames(text) : [...new Set([...text.matchAll(labelPattern)].map(match => match[1]))];
      if (!names.length) continue;
      const match = names.findIndex(name => murmurName64(game.normalize(name)) === row.hash64);
      found.push([id, match, names]);
    } catch {
      failed++;
    }
  }
  return { found, failed, scanned: task.rows.length };
}

parentPort.on('message', async ({ id, task }) => {
  try {
    const result = task.type === 'walk' ? walk(task) : await labels(task);
    const transfer = task.type === 'walk'
      ? [result.hi.buffer, result.lo.buffer, result.h32.buffer, result.type.buffer, result.sys.buffer, result.size.buffer, result.flags.buffer]
      : [];
    parentPort.postMessage({ id, result }, transfer);
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
parentPort.postMessage({ ready: true });
