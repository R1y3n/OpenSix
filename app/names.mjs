
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { candidatePaths, joaatName32, murmurName64 } from './rpf9.mjs';

const MAX_NAMES = 200_000;
const verifiedScarlettNames = readFileSync(new URL('./assets/scarlett-verified-paths.txt',import.meta.url),'utf8');
const normalizePath = value => value.trim().replaceAll('\\', '/').replace(/^[a-z][a-z0-9_]*:\//i, '');

export class FilenameIndex {
  #game;
  #candidates = new Set();
  #hashes = new Map();

  constructor(game) {
    this.#game = game;
    this.addText(verifiedScarlettNames, 'Verified Scarlett archive filename', true);
    for (const path of game.pathReferences()) this.add(path, 'Executable reference');
  }

  add(value, source) {
    const path = normalizePath(value);
    if (!path || path.length > 255 || path.split('/').some(piece =>
      !piece || piece === '.' || piece === '..' || !/^[\w.@-]+$/.test(piece))) return;
    for (const spelling of new Set([path, basename(path)])) {
      const key = spelling.toLowerCase();
      if (this.#candidates.has(key) || this.#candidates.size >= MAX_NAMES) continue;
      this.#candidates.add(key);
      const extension = extname(spelling);
      this.#record(spelling, spelling, source, false);
      if (extension) this.#record(spelling.slice(0, -extension.length), spelling, source, true);
    }
  }

  #record(input, spelling, source, stem) {
    const normalized = this.#game.normalize(input);
    const hash = murmurName64(normalized);
    const candidate = { spelling, source, stem, joaat: joaatName32(normalized) };
    const bucket = this.#hashes.get(hash) ?? [];
    bucket.push(candidate);
    this.#hashes.set(hash, bucket);
  }

  addText(text, source, pathList = false) {
    if (pathList) {
      for (const line of text.split(/\r?\n/)) this.add(line, source);
    } else {
      for (const path of candidatePaths(text)) this.add(path, source);
    }
  }

  *hashKeys() {
    yield* this.#hashes.keys();
  }

  get size() { return this.#candidates.size; }

  resolve(row) {
    const suffix = this.#game.extension(row.type);
    const candidates = this.#hashes.get(row.hash64) ?? [];
    const resolved = new Map();
    for (const item of candidates) {
      if (row.hash32 && row.hash32 !== '00000000' && item.joaat !== row.hash32) continue;
      let path = item.spelling;
      const extension = extname(path).slice(1).toLowerCase();
      if (item.stem) {
        if (!suffix || (extension && suffix !== extension)) continue;
      } else if (suffix) {
        if (!extension) path += '.' + suffix;
        else if (extension !== suffix) continue;
      }
      resolved.set(path.toLowerCase(), { path, source: item.source });
    }
    if (resolved.size === 1) return resolved.values().next().value;
    return null;
  }
}

export function fallbackName(row, game) {
  const suffix = game.extension(row.type);
  return (row.hash64 ?? ('entry-' + row.id)) + (suffix ? '.' + suffix : '.bin');
}
