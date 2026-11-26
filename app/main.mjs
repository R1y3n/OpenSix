
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, protocol, session, shell } from 'electron';
import { appendFileSync, constants as fsConstants, copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dispatch, describeEntry, prepareArchiveReport, prepareExport, prepareNewArchive, preparePreviewExport, scanEntries } from './workspace.mjs';
import { assetPreviewFile, clearAssetPreviews } from './asset-preview.mjs';
import { withFbxExport } from './fbx-export.mjs';
import { runCli } from './cli.mjs';
import { stopMovie } from './bink-playback.mjs';
import { Library } from './library.mjs';
import { createUpdateService } from './update-service.mjs';
import { RELEASES_API } from './updates.mjs';

const APP_URL = 'opensix://app/';
const bundle = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/explorer.css', ['explorer.css', 'text/css; charset=utf-8']],
  ['/ui.mjs', ['assets/ui.bundle.mjs', 'text/javascript; charset=utf-8']],
]);
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const exporting = new Set();
let window;

protocol.registerSchemesAsPrivileged([{ scheme: 'opensix', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);

nativeTheme.themeSource = 'dark';
// Settings and the search index live beside the executable's profile, never in the game folder.
app.setPath('userData', process.env.OPENSIX_DATA_DIR || join(app.getPath('appData'), 'OpenSix'));
let library = null;
let libraryReady = Promise.resolve();
let updates = null;
app.setAppUserModelId('local.opensix.desktop');
app.commandLine.appendSwitch('disable-background-networking');

function response(request) {
  const url = new URL(request.url);
  const preview = url.host==='app' && request.method==='GET' &&
    url.pathname.match(/^\/asset-preview\/([a-f0-9]{32})\/([\w.-]+)$/);
  if (preview) {
    const asset = assetPreviewFile(preview[1],preview[2]);
    if (!asset) return new Response(null,{status:404});
    const length=statSync(asset.path).size;
    const headers={'Content-Type':asset.mime,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff'};
    const range=request.headers.get('range')?.match(/^bytes=(\d+)-(\d*)$/);
    if (!range) return new Response(Readable.toWeb(createReadStream(asset.path)),{
      headers:{...headers,'Content-Length':String(length)}});
    const start=Number(range[1]),end=Math.min(range[2] ? Number(range[2]) : length-1,length-1);
    if (start>end) return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+length}});
    return new Response(Readable.toWeb(createReadStream(asset.path,{start,end})),{status:206,headers:{...headers,
      'Content-Length':String(end-start+1), 'Content-Range':'bytes '+start+'-'+end+'/'+length}});
  }
  const file = url.host === 'app' && request.method === 'GET' ? files.get(url.pathname) : undefined;
  if (!file) return new Response(null, { status: 404 });
  return new Response(readFileSync(join(bundle, file[0])), { headers: {
    'Content-Type': file[1], 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff',
  } });
}

function trusted(event) {
  return window && event.sender === window.webContents && event.senderFrame?.url === APP_URL;
}

function handle(channel, run) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!trusted(event)) throw new Error('Invalid application window.');
      return { ok: true, value: await run(...args) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

function matchesSource(path, source) {
  if (resolve(path).toLowerCase() === resolve(source).toLowerCase()) return true;
  if (!existsSync(path) || !existsSync(source)) return false;
  const dest = statSync(path);
  const original = statSync(source);
  return realpathSync(path).toLowerCase() === realpathSync(source).toLowerCase() ||
    (dest.ino !== 0 && dest.ino === original.ino && dest.dev === original.dev);
}

async function save(archive, entry, stored, mip) {
  const file=await prepareExport(archive,entry,stored,mip);
  return saveFile(file,mip!==undefined ? 'Save DDS mip chain' : stored ? 'Save stored bytes' : 'Extract file');
}

// A suggested file name keeps the asset's own name in the save dialog.
const suggestion = (suggested, extension) => {
  if (typeof suggested !== 'string') return undefined;
  const stem = suggested.replace(/\.[^.]*$/, '').replace(/[^\w.@-]+/g, '_').slice(0, 120);
  return stem ? stem + extension : undefined;
};

async function savePreview(id, name, suggested) {
  if (name === 'model.fbx') {
    return withFbxExport(preparePreviewExport(id, 'model.glb'), file =>
      saveFile(file, 'Export FBX', [{ name: 'Autodesk FBX', extensions: ['fbx'] }], suggestion(suggested, '.fbx')));
  }
  const file = preparePreviewExport(id, name);
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  return saveFile(file, 'Export decoded asset', undefined, name.startsWith('model.') ? suggestion(suggested, extension) : undefined);
}

const workspaceEntryName = (archive, entry) => {
  try { return describeEntry(archive, entry).name.split('/').at(-1); } catch { return undefined; }
};

async function exportModel(archive, entry, format) {
  if (!['glb', 'fbx'].includes(format)) throw new Error('Choose GLB or FBX.');
  const preview = await dispatch('/api/preview?' + new URLSearchParams({ archive, entry: String(entry) }));
  if (preview?.type !== 'model') throw new Error(preview?.note || 'This entry has no model to export.');
  return savePreview(preview.id, format === 'fbx' ? 'model.fbx' : 'model.glb', workspaceEntryName(archive, entry));
}

async function saveFile(file, title, filters, suggested) {
  // Automated checks set OPENSIX_TEST_SAVE_DIR to write exports without the native dialog.
  const testDirectory = process.env.OPENSIX_TEST_SAVE_DIR;
  if (testDirectory && isAbsolute(testDirectory)) return saveTo(file, join(testDirectory, suggested ?? file.name));
  const picked = await dialog.showSaveDialog(window, {
    title,
    defaultPath: join(app.getPath('downloads'), suggested ?? file.name),
    filters,
    properties: ['showOverwriteConfirmation'],
  });
  if (picked.canceled || !picked.filePath) return null;
  return saveTo(file,picked.filePath);
}

async function saveTo(file,destination) {
  if (!isAbsolute(destination) || destination.startsWith('\\\\') ||
      file.sources.some(source => matchesSource(destination, source))) {
    throw new Error('Choose a local destination other than an open archive or the game executable.');
  }
  const key = resolve(destination).toLowerCase();
  if (exporting.has(key)) throw new Error('An extraction is already writing this file.');
  exporting.add(key);
  const temp = join(dirname(destination), '.opensix-' + randomBytes(12).toString('hex') + '.tmp');
  try {
    const input = file.read();
    const writer = createWriteStream(temp, { flags: 'wx' });
    let bytes = 0;
    const limit = new Transform({
      transform(part, _encoding, done) {
        bytes += part.length;
        if (bytes > file.length) done(new Error('The decoded file exceeds its archive entry size.'));
        else done(null,part);
      },
    });
    await pipeline(Buffer.isBuffer(input) ? [input] : input, limit, writer);
    if (statSync(temp).size !== file.length) throw new Error('The file ended before all bytes were written.');
    await file.verify();
    if (file.sources.some(source => matchesSource(destination, source))) {
      throw new Error('The destination now points to an open archive or the game executable.');
    }
    if (file.mustBeNew) {
      try { linkSync(temp,destination); }
      catch(error) {
        if (!['ENOSYS','ENOTSUP','EPERM','EACCES'].includes(error.code)) throw error;
        copyFileSync(temp,destination,fsConstants.COPYFILE_EXCL);
      }
    } else renameSync(temp, destination);
    return basename(destination);
  } finally {
    exporting.delete(key);
    rmSync(temp, { force: true });
  }
}

async function saveBatch({archive,query,scope,filter,ids}) {
  let rows;
  if (Array.isArray(ids)) {
    if (!ids.length || ids.length>20000 || ids.some(id=>!Number.isSafeInteger(id))) throw new Error('Invalid selection.');
    const wanted=new Set(ids);
    rows=[...scanEntries(archive,'',{scope:'',filter:'all'})].filter(row=>wanted.has(row.id));
  } else {
    if (typeof query!=='string' || typeof scope!=='string' || !['all','resolved','unresolved'].includes(filter)) {
      throw new Error('Invalid extraction filter.');
    }
    rows=[...scanEntries(archive,query,{scope,filter})];
  }
  if (!rows.length) throw new Error('No entries match the current filter.');
  const testDirectory=process.env.OPENSIX_TEST_SAVE_DIR;
  const picked=testDirectory && isAbsolute(testDirectory) ? {canceled:false,filePaths:[testDirectory]}
    : await dialog.showOpenDialog(window,{title:'Choose where to extract '+rows.length+' matching entries',
      properties:['openDirectory','createDirectory']});
  if (picked.canceled || !picked.filePaths[0]) return null;
  const target=realpathSync(picked.filePaths[0]);
  if (!isAbsolute(target) || target.startsWith('\\\\')) throw new Error('Choose a local extraction folder.');
  const folder=mkdtempSync(join(target,'OpenSix-'));
  const result={saved:0,failed:0,folder};
  const entries=[];
  for (const row of rows) {
    try {
      const file=await prepareExport(archive,row.id,false);
      const output=await saveTo({...file,mustBeNew:true},join(folder,row.id+'-'+file.name));
      entries.push({id:row.id,archivePath:row.name,output,bytes:file.length});
      result.saved++;
    } catch(error) {
      entries.push({id:row.id,archivePath:row.name,error:error.message});
      result.failed++;
    }
  }
  writeFileSync(join(folder,'extraction-report.json'),JSON.stringify(entries,null,2)+'\n',{flag:'wx'});
  return result;
}

async function choosePath(kind) {
  const choices = {
    executable: { title:'Choose the matching Scarlett executable', properties:['openFile'],
      filters:[{name:'Windows executables',extensions:['exe']}] },
    archive: { title:'Open RPF9 archive', properties:['openFile'],
      filters:[{name:'RPF9 archives',extensions:['rpf','rpf9']}] },
    pool: { title:'Open texture pool', properties:['openFile'], filters:[{name:'Texture pools',extensions:['ttpf']}] },
    folder: { title:'Open folder of RPF9 archives', properties:['openDirectory'] },
    'game-folder': { title:'Choose the GTA VI game folder (contains game_scarlett_master.exe)', properties:['openDirectory'] },
    asset: { title:'Choose a decoded resource or media file', properties:['openFile'] },
    'archive-files': { title:'Choose files for a new unsigned RPF9', properties:['openDirectory'] },
  };
  if (!Object.hasOwn(choices,kind)) throw new Error('Invalid file picker.');
  const result = await dialog.showOpenDialog(window,choices[kind]);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

export async function createWindow(show = true) {
  window = new BrowserWindow({
    title: 'OpenSix ' + app.getVersion(),
    width: 1360,
    height: 870,
    minWidth: 790,
    minHeight: 560,
    show: false,
    backgroundColor: '#100d1c',
    icon: join(bundle, 'assets', 'window.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(bundle, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.removeMenu();
  // The page title is just "OpenSix"; keep the version in the window title.
  window.on('page-title-updated', event => event.preventDefault());
  window.once('closed',()=>stopMovie());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== APP_URL) event.preventDefault();
  });
  if (show) window.once('ready-to-show', () => window.show());
  await window.loadURL(APP_URL);
  return window;
}

// The update check is the only thing in OpenSix that uses the network. It runs here, not in the page, in its own
// in-memory session that can reach GitHub's release API and nothing else. The page stays blocked from the network.
function createUpdates() {
  // Tests can point the check at a local server on this PC. Nothing else overrides the address.
  const override = /^http:\/\/127\.0\.0\.1:\d{2,5}\//.test(process.env.OPENSIX_UPDATE_URL ?? '') ? process.env.OPENSIX_UPDATE_URL : undefined;
  const updateSession = session.fromPartition('opensix-updates');
  updateSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) =>
    callback({ cancel: !(details.url.startsWith(RELEASES_API) || (override && details.url.startsWith(override))) }));
  updateSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  // A fixed language, so the request does not carry the PC's language settings.
  updateSession.setUserAgent('OpenSix/' + app.getVersion(), 'en-US');
  return createUpdateService({
    current: app.getVersion(),
    fetchImpl: (address, init) => updateSession.fetch(address, init),
    url: override,
    preferences: () => library.preferences(),
    savePreferences: patch => library.savePreferences(patch),
    // Tests set OPENSIX_TEST_OPEN_LOG to record the address instead of starting a browser.
    openExternal: address => (process.env.OPENSIX_TEST_OPEN_LOG ? appendFileSync(process.env.OPENSIX_TEST_OPEN_LOG, address + '\n') : shell.openExternal(address)),
    notify: result => window?.webContents.send('opensix:update-available', result),
    // The upstream release feed only publishes the Windows EXE, so do not
    // offer that download from the native Linux build.
    automatic: process.platform === 'win32' && (app.isPackaged || Boolean(override)) && !process.env.OPENSIX_NO_UPDATE_CHECK,
  });
}

async function libraryRoute(route, payload = {}) {
  if (route === 'status') return library.status();
  if (route === 'detect') return Library.detect();
  if (route === 'configure') return library.configure(payload.path);
  if (route === 'forget') { library.forget(); return library.status(); }
  if (route === 'rebuild') { library.rebuild(); return library.status(); }
  if (route === 'browse') return library.browse(payload.id);
  if (route === 'browse-opened') return library.browseOpened(payload.id);
  if (route === 'search') return library.search(payload);
  if (route === 'open-result') return library.openResult(payload);
  if (route === 'characters') return library.listCharacters(payload.query);
  if (route === 'character-parts') return library.characterParts(payload.prefix);
  if (route === 'assemble-character') return library.assembleCharacter(payload);
  throw new Error('Unknown library action.');
}

export const ready = app.whenReady().then(() => {
  library = new Library(app.getPath('userData'));
  const cli = process.argv.includes('--cli') || process.argv.includes('--version');
  const gameFlag = process.argv.findIndex(argument => argument === '--game-dir');
  const gameDir = gameFlag >= 0 ? process.argv[gameFlag + 1] : undefined;
  libraryReady = cli ? Promise.resolve() : library.init({ gameDir }).catch(() => {});
  updates = createUpdates();
  if (!cli && !process.argv.includes('--desktop-fixture')) updates.schedule();
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  protocol.handle('opensix', response);
  handle('opensix:about', () => ({
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
  }));
  handle('opensix:update-state', () => updates.state());
  handle('opensix:update-check', () => updates.check({ manual: true }));
  handle('opensix:update-set', options => updates.set(options));
  handle('opensix:update-open', () => updates.open());
  handle('opensix:request', dispatch);
  handle('opensix:save', save);
  handle('opensix:save-preview',savePreview);
  handle('opensix:save-report', (archive, kind) => saveFile(prepareArchiveReport(archive, kind), 'Save archive index',
    [{name:'JSON',extensions:['json']} ]));
  handle('opensix:create-archive', path => saveFile(prepareNewArchive(path),'Create unsigned RPF9',
    [{name:'RPF9 archive',extensions:['rpf']} ]));
  handle('opensix:save-batch',saveBatch);
  handle('opensix:choose', choosePath);
  handle('opensix:export-model', exportModel);
  handle('opensix:copy', text => {
    if (typeof text !== 'string' || text.length > 65536) throw new Error('Nothing to copy.');
    clipboard.writeText(text);
    return true;
  });
  handle('opensix:reveal', rel => {
    // Reveal a loose file or folder of the game in Explorer. Only paths inside the game folder are accepted.
    if (!library?.gameDir || typeof rel !== 'string' || /(^|[\\/])\.\.([\\/]|$)/.test(rel) || isAbsolute(rel)) throw new Error('Invalid location.');
    shell.showItemInFolder(join(library.gameDir, rel));
    return true;
  });
  handle('opensix:library', async (route, payload) => {
    await libraryReady;
    return libraryRoute(route, payload);
  });
});

const cliFlag=process.argv.indexOf('--cli');
if (cliFlag>=0) {
  ready.then(()=>runCli(process.argv.slice(cliFlag+1))).then(code=>app.exit(code));
} else if (process.argv.includes('--version')) {
  ready.then(()=>runCli(process.argv.slice(process.argv.indexOf('--version')))).then(code=>app.exit(code));
} else if (process.argv.includes('--desktop-fixture') && !app.isPackaged) {
  // The development-only harness creates the window after the same setup.
} else {
  ready.then(() => createWindow()).catch(error => {
    dialog.showErrorBox('OpenSix could not start', error.message);
    app.exit(1);
  });
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit',clearAssetPreviews);
