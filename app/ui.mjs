import { renderAsset } from './asset-viewer.mjs';

const el = id => document.getElementById(id);
const model = { archives: [], active: null, selection: null, scope: '', page: 0, listRevision: 0, previewRevision: 0 };

function button(label, action) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', action);
  return node;
}

const api = (path, payload) => window.opensix.request(path, payload);

function message(text = '', error = false, target = el('notice')) {
  target.textContent = text;
  target.dataset.error = String(error);
  target.hidden = !text;
}

function size(value) {
  if (value < 1024) return value.toLocaleString() + ' B';
  if (value < 1024 ** 2) return (value / 1024).toFixed(1) + ' KiB';
  if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(1) + ' MiB';
  return (value / 1024 ** 3).toFixed(2) + ' GiB';
}

function label(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function hex(value) {
  return '0x' + value.toString(16).toUpperCase();
}

function freshState(archive) {
  model.active = archive;
  model.scope = '';
  model.page = 0;
  el('search').value = '';
  el('filter').value = 'all';
  clearSelection();
}

function renderArchives() {
  const nav = el('archives');
  nav.replaceChildren();
  if (!model.archives.length) {
    const empty = document.createElement('p');
    empty.className = 'quiet';
    empty.textContent = 'No archives open';
    nav.append(empty);
  }
  for (const archive of model.archives) {
    const item = button('', () => {
      freshState(archive.id);
      message();
      renderArchives();
      loadList();
    });
    item.setAttribute('aria-current', String(archive.id === model.active));
    const name = document.createElement('span');
    name.className = 'nav-name';
    name.textContent = (archive.parent ? '↳ ' : '') + archive.name;
    item.title = archive.path;
    const count = document.createElement('small');
    count.textContent = archive.entries.toLocaleString();
    item.append(name, count);
    nav.append(item);
  }
  el('import-names').disabled = !model.archives.length;
}

function renderFolders(folders) {
  const nav = el('folders');
  nav.replaceChildren();
  el('folders-section').hidden = !folders.length;
  if (!folders.length) return;
  for (const path of ['', ...folders]) {
    const item = button('', () => {
      model.scope = path;
      model.page = 0;
      clearSelection();
      loadList();
    });
    item.setAttribute('aria-current', String(path === model.scope));
    const name = document.createElement('span');
    name.className = 'nav-name';
    name.textContent = path || 'All paths';
    item.title = path || 'All paths';
    item.append(name);
    nav.append(item);
  }
}

function clearSelection() {
  model.selection = null;
  ++model.previewRevision;
  disposePreview?.();
  disposePreview = null;
  el('resource-preview').replaceChildren();
  el('selection-empty').hidden = false;
  el('selection').hidden = true;
}

function renderRows(rows) {
  const tbody = el('rows');
  tbody.replaceChildren();
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = 'No entries match the current view.';
    row.append(cell);
    tbody.append(row);
    return;
  }
  for (const entry of rows) {
    const row = document.createElement('tr');
    row.dataset.entry = entry.id;
    row.setAttribute('aria-selected', String(model.selection?.id === entry.id));
    const name = document.createElement('td');
    const item = button('', () => selectEntry(entry));
    item.className = 'file-name' + (entry.resolved ? '' : ' unresolved');
    item.title = entry.name;
    const glyph = document.createElement('span');
    glyph.className = 'file-glyph' + (entry.kind === 'archive' ? ' archive' : '');
    glyph.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = model.scope && entry.name.startsWith(model.scope + '/')
      ? entry.name.slice(model.scope.length + 1) : entry.name;
    item.append(glyph, text);
    item.addEventListener('dblclick', () => entry.kind === 'archive' && openNested(entry));
    name.append(item);
    row.append(name);
    for (const [content, numeric] of [[entry.type, false], [size(entry.size), true], [hex(entry.offset), true]]) {
      const cell = document.createElement('td');
      if (numeric) cell.className = 'number';
      cell.textContent = content;
      row.append(cell);
    }
    tbody.append(row);
  }
}

async function loadList() {
  if (!model.active) return;
  const current = ++model.listRevision;
  const query = new URLSearchParams({
    archive: model.active, q: el('search').value, filter: el('filter').value, scope: model.scope,
    offset: model.page * 100,
  });
  try {
    const data = await api('/api/list?' + query);
    if (current !== model.listRevision) return;
    const archive = data.archive;
    el('breadcrumb').textContent = model.scope
      ? 'Archives / ' + archive.name + ' / ' + model.scope : 'Archives';
    el('archive-name').textContent = archive.name;
    el('archive-meta').textContent = archive.entries.toLocaleString() + ' entries · ' +
      archive.resolved.toLocaleString() + ' names resolved · ' + size(archive.size);
    if (model.selection && !data.rows.some(entry => entry.id === model.selection.id)) clearSelection();
    renderFolders(data.folders);
    renderRows(data.rows);
    el('entry-tools').hidden = false;
    el('entry-scroll').hidden = false;
    el('entry-scroll').scrollTop = 0;
    el('pager').hidden = false;
    el('page-text').textContent = data.total > 0
      ? (model.page * 100 + 1).toLocaleString() + '–' +
        Math.min(data.total, (model.page + 1) * 100).toLocaleString() + ' of ' + data.total.toLocaleString()
      : '0 entries';
    el('previous').disabled = model.page === 0;
    el('next').disabled = (model.page + 1) * 100 >= data.total;
  } catch (error) {
    if (current === model.listRevision) message(error.message, true);
  }
}

let disposePreview = null;

function showResource(result) {
  const preview = el('resource-preview');
  if (result.type === 'heightmap') {
    const canvas = document.createElement('canvas');
    canvas.width = result.width;
    canvas.height = result.height;
    canvas.setAttribute('role','img');
    canvas.setAttribute('aria-label','Terrain heightmap preview');
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(result.width,result.height);
    const values = atob(result.value);
    for (let i=0;i<values.length;i++) {
      const elevation = values.charCodeAt(i);
      const t = Math.sqrt(Math.max(0,elevation-result.water)/Math.max(1,255-result.water));
      const land = elevation>result.water;
      img.data[4*i] = land ? 37+196*t : 12;
      img.data[4*i+1] = land ? 103+125*t : 36;
      img.data[4*i+2] = land ? 75+150*t : 72;
      img.data[4*i+3] = 255;
    }
    ctx.putImageData(img,0,0);
    preview.append(canvas);
  } else {
    const image = result.type === 'image';
    const element = document.createElement(image ? 'img' : 'audio');
    if (image) element.alt = 'Archive image';
    else element.controls = true;
    element.src = 'data:'+result.mime+';base64,'+result.value;
    preview.append(element);
  }
  preview.hidden = false;
  el('preview').hidden = true;
}

async function loadPreview(archive, entry, current, index=null, detail=null) {
  disposePreview?.();
  disposePreview=null;
  const display=el('resource-preview');
  display.replaceChildren();
  display.hidden=true;
  el('preview').hidden=false;
  el('preview').textContent='';
  el('preview-note').textContent='Reading preview…';
  try {
    const query = new URLSearchParams({archive,entry:entry.id});
    if (index!==null) query.set('index',index);
    if (detail!==null) query.set('detail',detail);
    const result=await api('/api/preview?'+query);
    if (current!==model.previewRevision) return;
    if (['model','textures','bank'].includes(result.type)) {
      el('preview-note').textContent=result.note??'';
      display.hidden=false;
      el('preview').hidden=true;
      disposePreview=renderAsset(display,result,(choice,mip)=>{
        loadPreview(archive,entry,++model.previewRevision,choice,mip);
      },async filename=>{
        try {
          const saved=await window.opensix.savePreview(result.id,filename);
          if (saved) message('Saved '+saved+'.');
        } catch (error) { message(error.message,true); }
      },error=>{el('preview-note').textContent=error.message;});
      return;
    }
    const media=['heightmap','image','audio'].includes(result.type);
    el('preview-note').textContent=[
      result.stored ? 'Stored bytes' : result.type==='text' ? 'Decoded text' : media ? '' : 'Decoded bytes',
      result.truncated ? 'preview only' : '',
      result.note??'',
    ].filter(Boolean).join(' · ');
    if (media) showResource(result);
    else el('preview').textContent=result.value;
  } catch (error) {
    if (current===model.previewRevision) el('preview-note').textContent=error.message;
  }
}

async function selectEntry(entry) {
  model.selection = entry;
  const current = ++model.previewRevision;
  const archive = model.active;
  for (const row of el('rows').rows) row.setAttribute('aria-selected', String(Number(row.dataset.entry) === entry.id));
  el('selection-empty').hidden = true;
  el('selection').hidden = false;
  el('entry-kind').textContent = entry.resolved ? 'Verified path' : 'Unresolved filename';
  el('entry-name').textContent = label(entry.name);
  el('entry-path').textContent = entry.resolved ? entry.name : '';
  const props = el('properties');
  props.replaceChildren();
  const data = [
    ['Name source', entry.nameSource ?? 'Archive hash'],
    ['64-bit hash', entry.hash64 ? '0x' + entry.hash64 : null, true],
    ['32-bit hash', entry.hash32 ? '0x' + entry.hash32 : null, true],
    ['Offset', hex(entry.offset), true],
    ['Decoded size', size(entry.size)],
    ['Stored size', size(entry.stored)],
    ['Encrypted', entry.encrypted ? 'Yes' : 'No'],
    ['Chunks', entry.chunks],
  ];
  for (const [title, value, monospace] of data) {
    if (value === null) continue;
    const dt = document.createElement('dt');
    dt.textContent = title;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (monospace) dd.className = 'mono';
    props.append(dt, dd);
  }
  el('nested').hidden = entry.kind !== 'archive';
  el('nested').disabled = !entry.nestedAvailable;
  el('extract').disabled = false;
  el('stored').disabled = false;
  await loadPreview(archive,entry,current);
}

async function openNested(entry) {
  if (!entry) return;
  const archive = model.active;
  el('nested').disabled = true;
  try {
    const data = await api('/api/nested', { archive, row: entry.id });
    model.archives = data.archives;
    freshState(data.selected);
    message();
    renderArchives();
    await loadList();
  } catch (error) {
    message(error.message, true);
  } finally {
    el('nested').disabled = !model.selection?.nestedAvailable;
  }
}

async function extract(stored) {
  const entry = model.selection;
  if (!entry) return;
  const trigger = el(stored ? 'stored' : 'extract');
  trigger.disabled = true;
  try {
    const result = await window.opensix.save(model.active, entry.id, stored);
    if (result) message('Saved ' + result + '.');
  } catch (error) {
    message(error.message.replace(/^Error invoking remote method '(?:opensix|save):[^']+': Error: /, ''), true);
  } finally {
    trigger.disabled = false;
  }
}

function requery() {
  model.page = 0;
  loadList();
}

el('open').addEventListener('click', () => el('open-dialog').showModal());
for (const id of ['cancel', 'close-dialog']) el(id).addEventListener('click', () => el('open-dialog').close());
for (const [buttonId,kind,inputId] of [
  ['choose-exe','executable','exe-path'],
  ['choose-archive','archive','archive-path'],
  ['choose-folder','folder','archive-path'],
]) {
  el(buttonId).addEventListener('click', async () => {
    try {
      const value = await window.opensix.choose(kind);
      if (value) el(inputId).value = value;
    } catch (error) {
      message(error.message,true,el('open-error'));
    }
  });
}
el('open-form').addEventListener('submit', async event => {
  event.preventDefault();
  const openButton = el('submit');
  openButton.disabled = true;
  openButton.textContent = 'Reading directories…';
  message('', false, el('open-error'));
  try {
    const data = await api('/api/open', { executable: el('exe-path').value, path: el('archive-path').value });
    model.archives = data.archives;
    freshState(data.selected);
    renderArchives();
    el('open-dialog').close();
    message(data.issues.length ? data.issues.join('\n') : '', Boolean(data.issues.length));
    await loadList();
  } catch (error) {
    message(error.message, true, el('open-error'));
  } finally {
    openButton.disabled = false;
    openButton.textContent = 'Open';
  }
});
let searchTimer;
el('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(requery, 110);
});
el('filter').addEventListener('change', requery);
el('previous').addEventListener('click', () => { model.page--; clearSelection(); loadList(); });
el('next').addEventListener('click', () => { model.page++; clearSelection(); loadList(); });
el('nested').addEventListener('click', () => openNested(model.selection));
el('extract').addEventListener('click', () => extract(false));
el('stored').addEventListener('click', () => extract(true));
el('import-names').addEventListener('click', () => el('name-file').click());
el('name-file').addEventListener('change', async () => {
  const input = el('name-file');
  const file = input.files[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Choose a path list smaller than 1 MiB.');
    const result = await api('/api/names', { text: await file.text() });
    model.archives = result.archives;
    clearSelection();
    renderArchives();
    message('Imported candidate paths from ' + file.name + '.');
    await loadList();
  } catch (error) {
    message(error.message, true);
  } finally {
    input.value = '';
  }
});
try {
  const state = await api('/api/defaults');
  el('exe-path').value = state.defaults.executable;
  el('archive-path').value = state.defaults.folder;
  model.archives = state.archives;
  renderArchives();
  if (model.archives.length) {
    freshState(model.archives.find(item => item.name.toLowerCase() === 'common.rpf')?.id ?? model.archives[0].id);
    renderArchives();
    await loadList();
  } else if (state.defaults.executable && state.defaults.folder) {
    el('open-dialog').showModal();
  }
} catch (error) {
  message(error.message, true);
}
