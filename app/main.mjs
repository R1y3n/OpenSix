
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, session } from 'electron';
import { constants as fsConstants, copyFileSync, createReadStream, createWriteStream, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dispatch, prepareArchiveReport, prepareExport, prepareNewArchive, preparePreviewExport, scanEntries } from './workspace.mjs';
import { assetPreviewFile, clearAssetPreviews } from './asset-preview.mjs';
import { withFbxExport } from './fbx-export.mjs';
import { runCli } from './cli.mjs';
import { stopMovie } from './bink-playback.mjs';

const APP_URL = 'opensix://app/';
const bundle = dirname(fileURLToPath(import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/ui.mjs', ['assets/ui.bundle.mjs', 'text/javascript; charset=utf-8']],
]);
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' blob:; img-src 'self' data: blob:; media-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const exporting = new Set();
let window;

protocol.registerSchemesAsPrivileged([{ scheme: 'opensix', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);

nativeTheme.themeSource = 'dark';
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

async function savePreview(id, name) {
  if (name === 'model.fbx') {
    return withFbxExport(preparePreviewExport(id, 'model.glb'), file =>
      saveFile(file, 'Export FBX', [{ name: 'Autodesk FBX', extensions: ['fbx'] }]));
  }
  return saveFile(preparePreviewExport(id, name), 'Export decoded asset');
}

async function saveFile(file, title, filters) {
  const picked = await dialog.showSaveDialog(window, {
    title,
    defaultPath: join(app.getPath('downloads'), file.name),
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

async function saveBatch({archive,query,scope,filter}) {
  if (typeof query!=='string' || typeof scope!=='string' || !['all','resolved','unresolved'].includes(filter)) {
    throw new Error('Invalid extraction filter.');
  }
  const rows=[...scanEntries(archive,query,{scope,filter})];
  if (!rows.length) throw new Error('No entries match the current filter.');
  const picked=await dialog.showOpenDialog(window,{title:'Choose where to extract '+rows.length+' matching entries',
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
    asset: { title:'Choose a decoded resource or media file', properties:['openFile'] },
    'archive-files': { title:'Choose files for a new unsigned RPF9', properties:['openDirectory'] },
  };
  if (!Object.hasOwn(choices,kind)) throw new Error('Invalid file picker.');
  const result = await dialog.showOpenDialog(window,choices[kind]);
  return result.canceled ? null : result.filePaths[0] ?? null;
}

export async function createWindow(show = true) {
  window = new BrowserWindow({
    title: 'OpenSix',
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
  window.once('closed',()=>stopMovie());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== APP_URL) event.preventDefault();
  });
  if (show) window.once('ready-to-show', () => window.show());
  await window.loadURL(APP_URL);
  return window;
}

export const ready = app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  protocol.handle('opensix', response);
  handle('opensix:request', dispatch);
  handle('opensix:save', save);
  handle('opensix:save-preview',savePreview);
  handle('opensix:save-report', (archive, kind) => saveFile(prepareArchiveReport(archive, kind), 'Save archive index',
    [{name:'JSON',extensions:['json']} ]));
  handle('opensix:create-archive', path => saveFile(prepareNewArchive(path),'Create unsigned RPF9',
    [{name:'RPF9 archive',extensions:['rpf']} ]));
  handle('opensix:save-batch',saveBatch);
  handle('opensix:choose', choosePath);
});

const cliFlag=process.argv.indexOf('--cli');
if (cliFlag>=0) {
  ready.then(()=>runCli(process.argv.slice(cliFlag+1))).then(code=>app.exit(code));
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
