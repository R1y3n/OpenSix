// The game library: the configured game folder, its search index and the explorer's folder listings.
// The game folder is only ever read. Everything OpenSix writes goes to its own data directory.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as workspace from './workspace.mjs';
import { buildIndex, buildTextureIndex, classify, defaultThreads, fingerprint, hashHex, loadIndex, loadLabels, loadTextureIndex,
  poolFingerprint, scanLabels, searchCategories } from './library-index.mjs';
import { buildAssetPreview } from './asset-preview.mjs';
import { decodeWardrobeCatalog, drawableVariants, taggedVariants } from './wardrobe-catalog.mjs';
import { joaatName32 } from './rpf9.mjs';
import { legacyLook, listCharacters, outfitOptions, outfitPrefix } from './characters.mjs';

export const EXECUTABLE_NAME = 'game_scarlett_master.exe';
const EXECUTABLE_SIZE = 120181760;
const skipFolders = new Set(['windows', 'programdata', '$recycle.bin', 'system volume information', 'node_modules',
  'appdata', 'recovery', 'perflogs', '$windows.~bt', 'config.msi', 'onedrivetemp', 'intel', 'amd', 'nvidia']);

function fail(message) { throw new Error(message); }

const posix = value => value.split('\\').join('/');

export class Library {
  constructor(dataDir) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true });
    this.settingsPath = join(dataDir, 'settings.json');
    this.settings = this.#readSettings();
    this.gameDir = null;
    this.exe = null;
    this.error = null;
    this.index = null;
    this.indexState = { state: 'none' };
    this.labelState = { state: 'idle' };
    this.textures = null;
    this.textureState = { state: 'idle' };
    this.revision = 0;
    this.cancel = false;
    this.topByRel = new Map();
    this.childByParent = new Map();
    this.corpus = null;
    this.characterCache = null;
  }

  // ----- settings -----
  #readSettings() {
    try { return JSON.parse(readFileSync(this.settingsPath, 'utf8')); } catch { return {}; }
  }

  #writeSettings() {
    const temporary = this.settingsPath + '.tmp';
    writeFileSync(temporary, JSON.stringify(this.settings, null, 2));
    renameSync(temporary, this.settingsPath);
  }

  // ----- game folder -----
  static findExecutable(path) {
    const start = resolve(path);
    if (!existsSync(start) || !statSync(start).isDirectory()) return null;
    const direct = join(start, EXECUTABLE_NAME);
    if (existsSync(direct)) return { gameDir: start, exe: direct };
    // The chosen folder may hold the game folder (one or two levels down).
    for (const first of readdirSync(start, { withFileTypes: true })) {
      if (!first.isDirectory()) continue;
      const one = join(start, first.name);
      if (existsSync(join(one, EXECUTABLE_NAME))) return { gameDir: one, exe: join(one, EXECUTABLE_NAME) };
      let inner;
      try { inner = readdirSync(one, { withFileTypes: true }); } catch { continue; }
      for (const second of inner) {
        if (second.isDirectory() && existsSync(join(one, second.name, EXECUTABLE_NAME))) {
          return { gameDir: join(one, second.name), exe: join(one, second.name, EXECUTABLE_NAME) };
        }
      }
    }
    return null;
  }

  static async detect({ budgetMs = 25000 } = {}) {
    const found = new Map();
    const deadline = Date.now() + budgetMs;
    const add = dir => {
      const exe = join(dir, EXECUTABLE_NAME);
      try {
        if (statSync(exe).size === EXECUTABLE_SIZE) found.set(dir.toLowerCase(), { gameDir: dir, exe, exact: true });
        else found.set(dir.toLowerCase(), { gameDir: dir, exe, exact: false });
      } catch { /* not a game folder */ }
    };
    for (const candidate of [process.env.OPENSIX_GAME_DIR].filter(Boolean)) {
      const located = Library.findExecutable(candidate);
      if (located) add(located.gameDir);
    }
    const drives = [];
    for (let code = 67; code <= 90; code++) {
      const root = String.fromCharCode(code) + ':\\';
      const reachable = await Promise.race([access(root).then(() => true, () => false), new Promise(done => setTimeout(() => done(false), 1500))]);
      if (reachable) drives.push(root);
    }
    for (const drive of drives) {
      const queue = [{ dir: drive, depth: 0 }];
      for (let visited = 0; queue.length && visited < 5000 && Date.now() < deadline; visited++) {
        const { dir, depth } = queue.shift();
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
        if (entries.some(entry => entry.isFile() && entry.name.toLowerCase() === EXECUTABLE_NAME)) { add(dir); continue; }
        if (depth >= 3) continue;
        for (const entry of entries) {
          if (entry.isDirectory() && !skipFolders.has(entry.name.toLowerCase()) && !entry.name.startsWith('.')) {
            queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
          }
        }
      }
    }
    return [...found.values()];
  }

  async init({ gameDir } = {}) {
    const wanted = gameDir ?? process.env.OPENSIX_GAME_DIR ?? this.settings.gameDir;
    if (!wanted) return this.status();
    try { await this.configure(wanted, { remember: false }); }
    catch (error) { this.error = error.message; }
    return this.status();
  }

  async configure(path, { remember = true } = {}) {
    const located = Library.findExecutable(path);
    if (!located) fail('That folder does not contain ' + EXECUTABLE_NAME + '. Choose the folder with the game executable and its .rpf archives.');
    if (statSync(located.exe).size !== EXECUTABLE_SIZE) fail('This ' + EXECUTABLE_NAME + ' is not the supported Scarlett build.');
    this.cancel = true;
    workspace.initWorkspace(located.exe);
    this.gameDir = located.gameDir;
    this.exe = located.exe;
    this.error = null;
    this.cancel = false;
    this.topByRel.clear();
    this.childByParent.clear();
    this.index = null;
    this.corpus = null;
    this.characterCache = null;
    workspace.setLibraryHooks({
      name: row => this.index?.nameOf(row) ?? null,
      labels: row => this.index?.labels.get(row)?.labels ?? [],
      namesChanged: () => this.refreshNames(),
    });
    if (remember) {
      this.settings.gameDir = located.gameDir;
      this.#writeSettings();
    }
    await this.#openIndex();
    return this.status();
  }

  forget() {
    this.cancel = true;
    delete this.settings.gameDir;
    this.#writeSettings();
    this.gameDir = this.exe = this.index = null;
    this.indexState = { state: 'none' };
    this.labelState = { state: 'idle' };
  }

  get indexDirectory() {
    const key = createHash('sha256').update(this.gameDir.toLowerCase()).digest('hex').slice(0, 12);
    return join(this.dataDir, 'library', key);
  }

  // ----- index lifecycle -----
  async #openIndex() {
    let loaded = null;
    try { loaded = loadIndex(this.indexDirectory); } catch { loaded = null; }
    const current = fingerprint(this.gameDir, this.exe).hash;
    if (loaded && loaded.header.fingerprintHash === current) {
      this.#attach(loaded);
      this.indexState = { state: 'ready', builtAt: loaded.header.builtAt, archives: loaded.archives.length, rows: loaded.count };
      this.#startLabels();
    } else {
      if (loaded) this.indexState = { state: 'stale' };
      this.rebuild();
    }
  }

  #attach(index) {
    const game = workspace.workspaceGame();
    index.extensionOf = type => game.extension(type);
    this.index = index;
    // Labels found by an earlier scan are searchable immediately.
    this.wardrobeCache = undefined;
    this.labelsDone = loadLabels(this.indexDirectory, index);
    this.#openTextures();
    this.topByRel.clear();
    this.childByParent.clear();
    index.archives.forEach((archive, number) => {
      if (archive.parent < 0) this.topByRel.set(archive.rel, number);
      else this.childByParent.set(archive.parent + ':' + archive.rowId, number);
    });
    this.refreshNames();
  }

  refreshNames() {
    if (!this.index) return;
    const names = workspace.workspaceNames();
    if (names) this.index.applyNames(names);
    this.#bump();
  }

  #bump() { this.revision++; this.corpus = null; this.characterCache = null; }

  // Texture pools are cheap to index (a second or so each), so they are read whenever the saved index is missing or stale.
  #openTextures() {
    const gameDir = this.gameDir;
    let loaded = null;
    try { loaded = loadTextureIndex(this.indexDirectory); } catch { loaded = null; }
    let current = null;
    try { current = poolFingerprint(gameDir).hash; } catch { current = null; }
    if (loaded && loaded.header.fingerprintHash === current) {
      this.textures = loaded;
      this.textureState = { state: 'done', found: loaded.count };
      return;
    }
    if (process.env.OPENSIX_NO_LABEL_SCAN || this.textureState.state === 'running') return;
    this.textureState = { state: 'running', done: 0, total: 0, found: 0 };
    buildTextureIndex({
      gameDir, directory: this.indexDirectory, isCancelled: () => this.cancel || this.gameDir !== gameDir,
      indexPool: path => buildAssetPreview({ kind: 'poolIndex', archive: path }),
      onProgress: progress => { if (this.gameDir === gameDir) this.textureState = { state: 'running', ...progress }; },
    }).then(index => {
      if (this.gameDir !== gameDir) return;
      this.textures = index;
      this.textureState = { state: 'done', found: index.count };
      this.#bump();
    }).catch(error => {
      if (this.gameDir === gameDir) this.textureState = { state: 'failed', error: error.message };
    });
  }

  rebuild() {
    if (this.indexState.state === 'building') return;
    const gameDir = this.gameDir, exe = this.exe;
    const directory = this.indexDirectory;
    this.indexState = { state: 'building', phase: 'archives', done: 0, total: 0 };
    this.labelState = { state: 'idle' };
    buildIndex({
      gameDir, exe, directory, threads: defaultThreads(4),
      isCancelled: () => this.cancel || this.gameDir !== gameDir,
      onProgress: progress => { if (this.gameDir === gameDir) this.indexState = { state: 'building', ...progress }; },
    }).then(index => {
      if (this.gameDir !== gameDir) return;
      this.#attach(index);
      this.indexState = { state: 'ready', builtAt: index.header.builtAt, archives: index.archives.length, rows: index.count,
        issues: index.header.issues };
      this.#startLabels();
    }).catch(error => {
      if (this.gameDir === gameDir) this.indexState = { state: 'failed', error: error.message };
    });
  }

  #startLabels() {
    if (!this.index || this.labelState.state === 'running' || process.env.OPENSIX_NO_LABEL_SCAN) return;
    const index = this.index, gameDir = this.gameDir;
    this.labelState = { state: 'running', done: 0, total: 0, found: 0 };
    let lastBump = 0;
    const run = mode => scanLabels({
      index, exe: this.exe, gameDir, directory: this.indexDirectory, threads: defaultThreads(2), done: this.labelsDone, mode,
      isCancelled: () => this.cancel || this.gameDir !== gameDir,
      onProgress: progress => {
        if (this.gameDir !== gameDir) return;
        this.labelState = { state: 'running', ...progress };
        if (Date.now() - lastBump > 1500) { lastBump = Date.now(); this.#bump(); }
      },
    });
    // Models first, then the names stored in clip dictionaries.
    run('models').then(models => run('clips').then(clips => ({
      scanned: models.scanned + clips.scanned, found: models.found + clips.found, failed: models.failed + clips.failed,
      complete: models.complete && clips.complete,
    }))).then(result => {
      if (this.gameDir !== gameDir) return;
      this.#bump();
      this.labelState = { state: result.complete ? 'done' : 'idle', ...result };
    }).catch(error => {
      if (this.gameDir === gameDir) this.labelState = { state: 'failed', error: error.message };
    });
  }

  status() {
    return {
      configured: Boolean(this.gameDir), gameDir: this.gameDir, exe: this.exe, error: this.error, savedGameDir: this.settings.gameDir ?? null,
      index: this.indexState, labels: this.labelState, textureIndex: this.textureState, revision: this.revision,
      textures: this.textures?.count ?? 0,
      counts: this.index ? { archives: this.index.archives.length, rows: this.index.count,
        named: this.index.names.size, labelled: this.index.labels.size } : null,
    };
  }

  // ----- navigation -----
  archiveRef(archiveIndex) {
    const chain = [];
    for (let at = archiveIndex; at >= 0; at = this.index.archives[at].parent) {
      const archive = this.index.archives[at];
      chain.unshift(archive.parent < 0 ? archive.rel : String(archive.rowId));
    }
    return chain.join('>');
  }

  async #mountRef(ref) {
    const [rel, ...rows] = ref.split('>');
    if (/(^|[\\/])\.\.([\\/]|$)/.test(rel) || /^[\\/]|^[a-z]:/i.test(rel)) fail('Invalid archive reference.');
    let key = await workspace.mountTopLevel(join(this.gameDir, rel));
    let archiveIndex = this.topByRel.get(rel);
    if (this.index && archiveIndex !== undefined) workspace.tagLibraryRows(key, this.index.archives[archiveIndex].rowStart);
    const chain = [{ ref: rel, name: basename(rel) }];
    let at = rel;
    for (const row of rows) {
      key = workspace.mountNestedRow(key, Number(row));
      at += '>' + row;
      archiveIndex = this.index && archiveIndex !== undefined ? this.childByParent.get(archiveIndex + ':' + row) : undefined;
      if (this.index && archiveIndex !== undefined) workspace.tagLibraryRows(key, this.index.archives[archiveIndex].rowStart);
      chain.push({ ref: at, name: workspace.archiveSummary(key).name });
    }
    return { key, archiveIndex, chain };
  }

  #crumbs(id, chain = null) {
    const crumbs = [{ id: 'fs:', name: 'Game folder' }];
    const [scheme, rest = ''] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    const [path, folder = ''] = rest.split('#');
    if (scheme === 'fs') {
      let accumulated = '';
      for (const part of path.split('/').filter(Boolean)) {
        accumulated += (accumulated ? '/' : '') + part;
        crumbs.push({ id: 'fs:' + accumulated, name: part });
      }
      return crumbs;
    }
    if (scheme === 'pool') {
      const parts = path.split('/');
      let accumulated = '';
      for (const part of parts.slice(0, -1)) { accumulated += (accumulated ? '/' : '') + part; crumbs.push({ id: 'fs:' + accumulated, name: part }); }
      crumbs.push({ id: id, name: parts.at(-1) });
      return crumbs;
    }
    const [rel] = path.split('>');
    const parts = rel.split('/');
    let accumulated = '';
    for (const part of parts.slice(0, -1)) { accumulated += (accumulated ? '/' : '') + part; crumbs.push({ id: 'fs:' + accumulated, name: part }); }
    for (const link of chain ?? [{ ref: rel, name: parts.at(-1) }]) crumbs.push({ id: 'rpf:' + link.ref, name: link.name });
    let accumulatedFolder = '';
    for (const part of folder.split('/').filter(Boolean)) {
      accumulatedFolder += (accumulatedFolder ? '/' : '') + part;
      crumbs.push({ id: 'rpf:' + path + '#' + accumulatedFolder, name: part });
    }
    return crumbs;
  }

  async browse(id) {
    if (!this.gameDir) fail('Choose the game folder first.');
    if (typeof id !== 'string') fail('Invalid location.');
    const scheme = id.slice(0, id.indexOf(':'));
    const rest = id.slice(id.indexOf(':') + 1);
    if (scheme === 'fs') return this.#browseDirectory(rest);
    if (scheme === 'rpf') return this.#browseArchive(id, rest);
    if (scheme === 'pool') return this.#browsePool(id, rest);
    fail('Unknown location.');
  }

  #safeJoin(rel) {
    if (/(^|[\\/])\.\.([\\/]|$)/.test(rel) || /^[a-z]:|^[\\/]/i.test(rel)) fail('Invalid location.');
    return rel ? join(this.gameDir, rel) : this.gameDir;
  }

  #browseDirectory(rel) {
    const dir = this.#safeJoin(rel);
    const entries = readdirSync(dir, { withFileTypes: true });
    const folders = [], items = [];
    for (const entry of entries) {
      const path = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        folders.push({ name: entry.name, path, target: 'fs:' + path, node: 'dir' });
        continue;
      }
      let stat;
      try { stat = statSync(join(dir, entry.name)); } catch { continue; }
      const ext = extname(entry.name).slice(1).toLowerCase();
      const item = { key: 'f:' + path, name: entry.name, ext, size: stat.size, fullPath: path };
      if (ext === 'rpf' || ext === 'rpf9') {
        const number = this.index ? this.topByRel.get(path) : undefined;
        Object.assign(item, { node: 'archive', kind: 'localArchive', category: 'archive', typeLabel: 'RPF9 archive', target: 'rpf:' + path,
          entries: number !== undefined ? this.index.archives[number].rowCount : null });
      } else if (ext === 'ttpf') {
        Object.assign(item, { node: 'pool', kind: 'localPool', category: 'texture', typeLabel: 'Texture pool', target: 'pool:' + path });
      } else {
        Object.assign(item, { node: 'file', kind: 'localFile', category: 'other', typeLabel: ext ? ext.toUpperCase() + ' file' : 'File', target: null });
      }
      items.push(item);
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { id: 'fs:' + rel, node: 'dir', title: rel ? basename(rel) : 'Game folder', breadcrumb: this.#crumbs('fs:' + rel),
      folders, items, archive: null, parent: rel ? 'fs:' + rel.split('/').slice(0, -1).join('/') : null,
      summary: folders.length + ' folders · ' + items.length + ' files' };
  }

  async #browseArchive(id, rest) {
    const [path, folder = ''] = rest.split('#');
    const { key, archiveIndex, chain } = await this.#mountRef(path);
    const listing = workspace.browseArchive(key, folder);
    const crumbs = this.#crumbs(id, chain);
    const base = 'rpf:' + path;
    const trail = crumbs.slice(1).map(crumb => crumb.name);
    const items = listing.entries.map(entry => this.#entryItem(entry, key, path, trail));
    const folders = listing.folders.map(item => ({ name: item.name, path: item.path, target: base + '#' + item.path, node: 'folder', count: item.count }));
    const parentPath = folder ? folder.split('/').slice(0, -1).join('/') : null;
    const parent = folder ? base + (parentPath ? '#' + parentPath : '')
      : path.includes('>') ? 'rpf:' + path.slice(0, path.lastIndexOf('>')) : 'fs:' + path.split('/').slice(0, -1).join('/');
    const info = listing.archive;
    return { id, node: 'archive', title: folder ? basename(folder) : info.name, breadcrumb: crumbs, folders, items, archive: key,
      libraryArchive: archiveIndex ?? null, parent,
      summary: info.entries.toLocaleString() + ' entries · ' + info.resolved.toLocaleString() + ' named' +
        (info.headerSignature === 'verified' ? ' · signed header' : ''),
      archiveInfo: info };
  }

  async #browsePool(id, rest) {
    const path = this.#safeJoin(rest);
    const opened = await workspace.dispatch('/api/open-pool', { path });
    const key = opened.selected;
    const listing = workspace.browseArchive(key, '');
    const trail = this.#crumbs(id).slice(1).map(crumb => crumb.name);
    const items = listing.entries.map(entry => ({
      ...entry, key: 'e:' + key + ':' + entry.id, node: 'entry', archiveKey: key, ext: 'ttpf', category: 'texture',
      typeLabel: (entry.shape ?? 'Texture') + (entry.format ? ' · ' + entry.format : ''), fullPath: trail.join('/') + '/' + entry.name,
    }));
    return { id, node: 'pool', title: basename(rest), breadcrumb: this.#crumbs(id), folders: [], items, archive: key,
      parent: 'fs:' + rest.split('/').slice(0, -1).join('/'), summary: items.length.toLocaleString() + ' textures',
      archiveInfo: listing.archive };
  }

  #entryItem(entry, key, archivePath, trail) {
    const ext = entry.kind === 'archive' ? 'rpf' : (entry.type ?? '').toLowerCase();
    const { category, label } = classify(ext, entry.kind);
    const item = { ...entry, key: 'e:' + key + ':' + entry.id, node: entry.kind === 'archive' ? 'archive' : 'entry',
      archiveKey: key, ext, category, typeLabel: label, fullPath: trail.join('/') + '/' + entry.name };
    if (entry.kind === 'archive') {
      item.target = entry.nestedAvailable ? 'rpf:' + archivePath + '>' + entry.id : null;
    }
    return item;
  }

  // Archives and texture pools opened from outside the game folder.
  browseOpened(id) {
    const [scheme, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    const [key, folder = ''] = rest.split('#');
    if (scheme !== 'open') fail('Unknown location.');
    const listing = workspace.browseArchive(key, folder);
    const info = listing.archive;
    const base = 'open:' + key;
    const trail = [info.name];
    const items = listing.entries.map(entry => info.pool
      ? { ...entry, key: 'e:' + key + ':' + entry.id, node: 'entry', archiveKey: key, ext: 'ttpf', category: 'texture',
          typeLabel: (entry.shape ?? 'Texture') + (entry.format ? ' · ' + entry.format : ''), fullPath: info.name + '/' + entry.name }
      : this.#entryItem(entry, key, '', trail));
    for (const item of items) if (item.node === 'archive') item.target = null;
    const folders = listing.folders.map(item => ({ name: item.name, path: item.path, target: base + '#' + item.path, node: 'folder', count: item.count }));
    const crumbs = [{ id: 'open:' + key, name: info.name }];
    let accumulated = '';
    for (const part of folder.split('/').filter(Boolean)) {
      accumulated += (accumulated ? '/' : '') + part;
      crumbs.push({ id: base + '#' + accumulated, name: part });
    }
    return { id, node: info.pool ? 'pool' : 'archive', title: folder ? folder.split('/').at(-1) : info.name, breadcrumb: crumbs, folders, items,
      archive: key, libraryArchive: null, parent: folder ? base + (folder.includes('/') ? '#' + folder.split('/').slice(0, -1).join('/') : '') : null,
      summary: info.entries.toLocaleString() + (info.pool ? ' textures' : ' entries') + ' · ' + info.resolved.toLocaleString() + ' named', archiveInfo: info };
  }

  // Parent chain of a library archive index, used by search results.
  trailOf(archiveIndex) {
    return this.index.archiveTrail(archiveIndex);
  }

  // ----- opening a search result -----
  async openResult({ archive, row, pool }) {
    if (typeof pool === 'string') {
      const rel = pool;
      const opened = await workspace.dispatch('/api/open-pool', { path: this.#safeJoin(rel) });
      return { key: opened.selected, entry: workspace.describeEntry(opened.selected, row), location: 'pool:' + rel };
    }
    if (!this.index) fail('The search index is not ready.');
    const ref = this.archiveRef(archive);
    const mounted = await this.#mountRef(ref);
    return { key: mounted.key, entry: workspace.describeEntry(mounted.key, row), location: 'rpf:' + ref };
  }

  // ----- search -----
  #corpus() {
    if (this.corpus) return this.corpus;
    const index = this.index;
    const rows = new Set([...index.names.keys(), ...index.labels.keys()]);
    const list = [];
    for (const row of rows) {
      const name = index.nameOf(row);
      const labels = index.labels.get(row)?.labels ?? [];
      list.push({ row, text: ((name?.path ?? '') + '\n' + labels.join('\n')).toLowerCase(), name });
    }
    this.corpus = list;
    return list;
  }

  #characters() {
    if (this.characterCache) return this.characterCache;
    const index = this.index;
    const parts = [];
    for (const [rowIndex, entry] of index.labels) {
      if (index.isArchive(rowIndex)) continue;
      for (const label of entry.labels) {
        const name = label.toLowerCase();
        if (outfitPrefix(name)) parts.push({ name, rowIndex, size: index.size[rowIndex] });
      }
    }
    const byPrefix = new Map(), counts = new Map(), copies = new Map();
    for (const part of parts) {
      const prefix = outfitPrefix(part.name);
      (byPrefix.get(prefix) ?? byPrefix.set(prefix, []).get(prefix)).push(part);
      counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
      (copies.get(part.name) ?? copies.set(part.name, []).get(part.name)).push(part.rowIndex);
    }
    this.characterCache = { byPrefix, counts, copies, list: listCharacters(byPrefix) };
    return this.characterCache;
  }

  search({ query, categories = [], scope = null, limit = 2000 } = {}) {
    if (!this.index) fail('The search index is still being built.');
    if (typeof query !== 'string' || query.length > 250) fail('Enter a search of up to 250 characters.');
    const index = this.index;
    const parsed = parseQuery(query);
    const wanted = new Set(categories);
    const inScope = scope ? scopeTest(index, scope) : null;
    const matches = new Map();
    const textTokens = parsed.text;
    const consider = (row, score, how) => {
      if (inScope && !inScope(row)) return;
      const ext = index.extension(row);
      if (parsed.ext.length && !parsed.ext.includes(ext)) return;
      if (wanted.size && !wanted.has(classify(ext).category)) return;
      const previous = matches.get(row);
      if (!previous || score < previous.score) matches.set(row, { score, how });
    };
    const hasText = textTokens.length > 0 || parsed.patterns.length > 0;
    const hashes = parsed.hashes;
    if (hasText || hashes.length) {
      for (const item of this.#corpus()) {
        const text = item.text;
        let ok = true, exact = false;
        for (const token of textTokens) if (!text.includes(token)) { ok = false; break; }
        if (ok) for (const pattern of parsed.patterns) if (!pattern.test(text)) { ok = false; break; }
        if (!ok) continue;
        if (hashes.length && !hashes.every(hash => hashMatches(index, item.row, hash))) continue;
        const name = (item.name?.path ?? '').toLowerCase();
        exact = textTokens.length === 1 && (name === textTokens[0] || name.replace(/\.[^.]+$/, '') === textTokens[0]);
        const score = exact ? 0 : name && textTokens.every(token => name.startsWith(token)) ? 1 : name && textTokens.every(token => name.includes(token)) ? 2 : 3;
        consider(item.row, score, name ? (item.name.label ? 'label' : 'name') : 'label');
      }
    }
    if (!hasText && hashes.length) {
      for (let row = 0; row < index.count; row++) {
        if (hashes.every(hash => hashMatches(index, row, hash))) consider(row, 4, 'hash');
      }
    }
    if (!hasText && !hashes.length && parsed.ext.length) {
      for (let row = 0; row < index.count; row++) consider(row, 5, 'type');
    }
    const ordered = [...matches].sort((a, b) => a[1].score - b[1].score || compareRows(index, a[0], b[0]));
    const textures = this.#searchTextures(parsed, wanted, scope, limit);
    const total = ordered.length + textures.total;
    const results = ordered.slice(0, limit).map(([row, info]) => this.#result(row, info));
    for (const texture of textures.results) if (results.length < limit) results.push(texture);
    const needle = textTokens.join('_');
    const characters = !parsed.ext.length && textTokens.length && !hashes.length
      ? this.#characters().list.filter(character => textTokens.every(token => character.prefix.includes(token)) ||
          (needle && character.prefix.includes(needle))).slice(0, 50)
      : [];
    return { total, results, truncated: total > results.length, characters: characters.map(character => ({
      ...character, location: this.#characterLocation(character.prefix) })),
    complete: this.labelState.state === 'done', categories: searchCategories };
  }

  // Texture pool entries have no names, so they match by their key hash, pool path, format and size.
  #searchTextures(parsed, wanted, scope, limit) {
    const none = { total: 0, results: [] };
    const textures = this.textures;
    if (!textures || (!parsed.text.length && !parsed.patterns.length && !parsed.hashes.length)) return none;
    if (parsed.ext.some(ext => ext !== 'dds' && ext !== 'ttpf') || (wanted.size && !wanted.has('texture'))) return none;
    if (scope && scope.archive !== undefined && scope.archive !== null) return none;
    const prefix = scope && typeof scope.dir === 'string' && scope.dir ? scope.dir + '/' : '';
    const tests = [...parsed.text.map(token => value => value.includes(token)), ...parsed.patterns.map(pattern => value => pattern.test(value))];
    // Each token is tested once per pool and per format, not once per texture.
    const poolOk = textures.pools.map(rel => (prefix ? rel.startsWith(prefix) : true));
    const poolText = textures.pools.map(rel => rel.toLowerCase());
    const formatText = textures.formats.map(format => format.toLowerCase());
    const poolHits = tests.map(test => poolText.map(test));
    const formatHits = tests.map(test => formatText.map(test));
    const dimension = parsed.text.map(token => /^(\d+)x(\d+)$/.exec(token));
    const hashes = parsed.hashes;
    const hashMatch = row => hashes.every(hash => {
      const key = textures.hash(row), name = textures.nameHash(row);
      return key.startsWith(hash) || name.startsWith(hash);
    });
    const hits = [];
    let total = 0;
    for (let row = 0; row < textures.count; row++) {
      if (!poolOk[textures.pool[row]]) continue;
      if (hashes.length && !hashMatch(row)) continue;
      let ok = true;
      for (let t = 0; t < tests.length && ok; t++) {
        const dim = t < dimension.length ? dimension[t] : null;
        ok = poolHits[t][textures.pool[row]] || formatHits[t][textures.fmt[row]] ||
          Boolean(dim && Number(dim[1]) === textures.width[row] && Number(dim[2]) === textures.height[row]);
      }
      if (!ok) continue;
      total++;
      if (hits.length < limit) hits.push(row);
    }
    return { total, results: hits.map(row => this.#textureResult(row, hashes.length ? 'hash' : 'type')) };
  }

  #textureResult(row, how) {
    const textures = this.textures;
    const rel = textures.pools[textures.pool[row]];
    const name = textures.poolName(row);
    const format = textures.formats[textures.fmt[row]];
    return {
      key: 't:' + row, pool: rel, row: textures.rowId[row], archive: null, name, resolved: false, nameFromLabel: false,
      nameSource: 'Texture pool key', labels: [], hash64: textures.hash(row), hash32: null, ext: 'dds', category: 'texture',
      typeLabel: 'Texture · ' + format + ' ' + textures.width[row] + '×' + textures.height[row], size: textures.size[row],
      matchedOn: how, location: rel, fullPath: rel + '/' + name, isTexture: true,
    };
  }

  #characterLocation(prefix) {
    const { byPrefix } = this.#characters();
    const names = new Set();
    for (const part of outfitOptions(byPrefix.get(prefix) ?? [], prefix)) names.add(this.index.archiveOf(part.rowIndex));
    return [...names].map(archive => this.index.archiveTrail(archive).map(item => item.name).join('/'));
  }

  #result(row, info) {
    const index = this.index;
    const archive = index.archiveOf(row);
    const rowId = row - index.archives[archive].rowStart;
    const name = index.nameOf(row);
    const labels = index.labels.get(row)?.labels ?? [];
    const hash64 = index.hash64(row);
    const ext = index.extension(row);
    const trail = index.archiveTrail(archive).map(item => item.name);
    const typeInfo = classify(ext);
    return {
      key: 'r:' + row, archive, row: rowId, rowIndex: row,
      name: name?.path ?? hash64 + '.' + ext, resolved: Boolean(name), nameFromLabel: Boolean(name?.label), nameSource: name?.source ?? null,
      labels, hash64, hash32: index.hash32(row), ext, category: typeInfo.category, typeLabel: typeInfo.label,
      size: index.size[row], matchedOn: info.how, location: trail.join('/'),
      fullPath: trail.join('/') + '/' + (name?.path ?? hash64 + '.' + ext), sys: index.sys[row],
      archiveRef: this.archiveRef(archive),
    };
  }

  // ----- characters -----
  listCharacters(query = '') {
    if (!this.index) fail('The search index is still being built.');
    const needle = query.toLowerCase().trim();
    return this.#characters().list.filter(character => !needle || character.prefix.includes(needle))
      .map(character => ({ ...character, location: this.#characterLocation(character.prefix) }));
  }

  // The wardrobe catalogue says which albedo and normal textures each clothing drawable wears. It is found once and cached.
  #wardrobe() { return (this.wardrobeCache ??= this.#loadWardrobe()); }

  async #loadWardrobe() {
    if (!this.index) return null;
    const cachePath = join(this.indexDirectory, 'wardrobe-location.json');
    let location = null;
    try { location = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { location = null; }
    const index = this.index;
    const read = async (ref, row, whole) => {
      const { key } = await this.#mountRef(ref);
      return whole ? workspace.readEntryBytes(key, row) : workspace.readEntryPrefix(key, row, 1024);
    };
    if (location?.fingerprint !== index.header.fingerprintHash) location = null;
    if (!location) {
      // Look through the metadata resources of the top-level archives for the catalogue's root block type.
      outer: for (const [archiveNumber, archive] of index.archives.entries()) {
        if (archive.parent >= 0) continue;
        for (let id = 0; id < archive.rowCount; id++) {
          const row = archive.rowStart + id;
          if (index.extension(row) !== 'zmt' || index.size[row] < 100000 || index.size[row] > 64 * 1024 * 1024) continue;
          let head;
          try { head = await read(this.archiveRef(archiveNumber), id, false); } catch { continue; }
          if (head.toString('ascii', 0, 4) !== 'PSIN') continue;
          let found = false;
          for (let at = 8; at + 16 <= head.length && !found; at += 16) {
            if (head.subarray(at, at + 8).every(byte => byte === 0x70)) break;
            found = head.readUInt32LE(at) === 0x8dcb4cf5;
          }
          if (found) { location = { ref: this.archiveRef(archiveNumber), row: id, fingerprint: index.header.fingerprintHash }; break outer; }
        }
      }
      if (!location) return null;
      try { writeFileSync(cachePath, JSON.stringify(location)); } catch { /* The next launch looks again. */ }
    }
    try {
      const catalog = decodeWardrobeCatalog(await read(location.ref, location.row, true));
      return { byHash: drawableVariants(catalog), byName: taggedVariants(catalog) };
    } catch {
      return null;
    }
  }

  // Texture variants for a drawable: states that name its archive hash (any detail-level copy) or list its joaat name hash.
  #variantsOf(wardrobe, name, rows) {
    if (!wardrobe) return [];
    const seen = new Set(), list = [];
    const add = variant => {
      const key = variant.albedo + variant.normal + variant.extra;
      if (!seen.has(key)) { seen.add(key); list.push(variant); }
    };
    for (const rowIndex of rows) for (const variant of wardrobe.byHash.get(this.index.hash64(rowIndex)) ?? []) add(variant);
    for (const variant of wardrobe.byName.get(parseInt(joaatName32(Buffer.from(name)), 16)) ?? []) add(variant);
    return list.slice(0, 64);
  }

  async characterParts(prefix) {
    const { byPrefix, counts, copies: copyRows } = this.#characters();
    const options = outfitOptions(byPrefix.get(prefix) ?? [], prefix);
    if (!options.length) fail('No drawable labels use the prefix ' + prefix + '.');
    const look = legacyLook(options);
    const wardrobe = await this.#wardrobe();
    const index = this.index;
    const withVariants = options.map(option => ({ option, variants: this.#variantsOf(wardrobe, option.name, copyRows.get(option.name) ?? [option.rowIndex]) }));
    // A part with no catalogue entry would render without colour, so prefer one that has an entry within its slot.
    const defaults = new Set(look ?? options.filter(option => option.default).map(option => option.rowIndex));
    if (!look) {
      for (const item of withVariants) {
        if (!defaults.has(item.option.rowIndex) || item.variants.length) continue;
        const better = withVariants.find(other => other.option.group === item.option.group && other.variants.length &&
          !other.option.label.includes('_alt_'));
        if (better) { defaults.delete(item.option.rowIndex); defaults.add(better.option.rowIndex); }
      }
    }
    return {
      prefix, legacy: Boolean(look), wardrobe: Boolean(wardrobe),
      parts: withVariants.map(({ option, variants }) => {
        const archive = index.archiveOf(option.rowIndex);
        return {
          rowIndex: option.rowIndex, archive, row: option.rowIndex - index.archives[archive].rowStart, name: option.name,
          group: option.group, label: option.label, size: option.size, default: defaults.has(option.rowIndex),
          copies: counts.get(option.name) ?? 1, variants: variants.length,
          location: index.archiveTrail(archive).map(item => item.name).join('/'), ref: this.archiveRef(archive),
        };
      }),
    };
  }

  async assembleCharacter({ prefix, rows, variants = {} }) {
    const { parts } = await this.characterParts(prefix);
    const wanted = rows?.length ? parts.filter(part => rows.includes(part.rowIndex)) : parts.filter(part => part.default);
    if (!wanted.length) fail('Choose at least one part.');
    const wardrobe = await this.#wardrobe();
    const { copies: copyRows } = this.#characters();
    const assembly = [];
    const textured = [];
    for (const part of wanted) {
      const mounted = await this.#mountRef(this.archiveRef(part.archive));
      const entry = { archive: mounted.key, entry: part.row, index: null, detail: null };
      const found = this.#variantsOf(wardrobe, part.name, copyRows.get(part.name) ?? [part.rowIndex]);
      const choice = found[Math.min(Math.max(Number(variants[part.rowIndex]) || 0, 0), Math.max(found.length - 1, 0))];
      if (choice) {
        entry.appearance = { albedo: choice.albedo, normal: choice.normal, extra: choice.extra, palette: choice.palette.toString(16).padStart(8, '0') };
        textured.push(part.name);
      }
      assembly.push(entry);
    }
    const result = await workspace.assembleParts(assembly, null);
    return { result, parts: wanted.map(part => part.name), textured };
  }
}

// ----- query parsing -----
function wildcardToPattern(token) {
  const source = token.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(source, 'i');
}

export function parseQuery(query) {
  const tokens = [...query.matchAll(/"([^"]+)"|(\S+)/g)].map(match => (match[1] ?? match[2]).toLowerCase());
  const parsed = { text: [], patterns: [], hashes: [], ext: [] };
  for (const token of tokens) {
    const prefixed = /^(ext|type):(.+)$/.exec(token);
    if (prefixed) { parsed.ext.push(...prefixed[2].split(',').map(value => value.replace(/^\./, ''))); continue; }
    const explicit = /^(?:hash:|0x)([0-9a-f]{4,16})$/.exec(token);
    if (explicit) { parsed.hashes.push(explicit[1]); continue; }
    if (/^(?=.*\d)(?:[0-9a-f]{8}|[0-9a-f]{16})$/.test(token)) { parsed.hashes.push(token); continue; }
    if (token.includes('*') || token.includes('?')) { parsed.patterns.push(wildcardToPattern(token)); continue; }
    parsed.text.push(token);
  }
  return parsed;
}

function hashMatches(index, row, prefix) {
  const hi = index.hi[row].toString(16).padStart(8, '0');
  const lo = index.lo[row].toString(16).padStart(8, '0');
  const h32 = index.flags[row] & 2 ? '' : index.h32[row].toString(16).padStart(8, '0');
  return (hi + lo).startsWith(prefix) || (h32 && h32.startsWith(prefix));
}

function compareRows(index, a, b) {
  const first = index.nameOf(a)?.path ?? '', second = index.nameOf(b)?.path ?? '';
  return first < second ? -1 : first > second ? 1 : a - b;
}

function scopeTest(index, scope) {
  if (scope.archive !== undefined && scope.archive !== null) {
    const included = new Set([scope.archive]);
    index.archives.forEach((archive, number) => { if (included.has(archive.parent)) included.add(number); });
    return row => included.has(index.archiveOf(row));
  }
  if (typeof scope.dir === 'string') {
    const prefix = scope.dir ? scope.dir + '/' : '';
    return row => index.archives[index.archiveOf(row)].rel.startsWith(prefix);
  }
  return null;
}
