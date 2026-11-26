import { renderAsset } from './asset-viewer.mjs';
import { setupTools } from './tools-menu.mjs';
import { setupCharacters } from './characters-ui.mjs';
import { VirtualList } from './virtual-list.mjs';
import { hex, icon, size } from './icons.mjs';

const el = id => document.getElementById(id);
const api = (path, payload) => window.opensix.request(path, payload);
const lib = (route, payload) => window.opensix.library(route, payload);

const state = {
  status: null,
  location: null, history: [], cursor: -1,
  items: [], rawItems: [],
  searchMode: false, searchData: null, searchRevision: 0, chips: new Set(),
  selected: null, entry: null,
  archive: null,
  sort: { key: 'name', direction: 1 },
  opened: [],
  listRevision: 0, previewRevision: 0,
  cache: new Map(),
};

function button(label, action) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', action);
  return node;
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function message(text = '', error = false, target = el('notice')) {
  target.textContent = text;
  target.dataset.error = String(error);
  target.hidden = !text;
}

const clean = text => text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
const base = name => name.slice(name.lastIndexOf('/') + 1);
const label = path => path.slice(path.lastIndexOf('/') + 1);

// ---------------------------------------------------------------- list

const columns = {
  browse: [['name', 'Name'], ['type', 'Type'], ['size', 'Size', true], ['offset', 'Offset', true]],
  search: [['name', 'Name'], ['type', 'Type'], ['size', 'Size', true], ['match', 'Match', true], ['location', 'Location']],
};

function drawHead() {
  const head = el('list-head');
  head.replaceChildren();
  for (const [key, title, numeric] of columns[state.searchMode ? 'search' : 'browse']) {
    const cell = button(title + (state.sort.key === key ? (state.sort.direction > 0 ? ' ▲' : ' ▼') : ''), () => {
      state.sort = { key, direction: state.sort.key === key ? -state.sort.direction : 1 };
      applyView();
    });
    if (numeric) cell.className = 'number';
    head.append(cell);
  }
  el('listing').dataset.mode = state.searchMode ? 'search' : 'browse';
}

const categoryOf = item => item.node === 'dir' || item.node === 'folder' ? item.node
  : item.node === 'archive' || item.node === 'pool' ? (item.node === 'pool' ? 'texture' : 'archive')
  : item.category ?? 'other';

function renderRow(row, item) {
  row.replaceChildren();
  const unresolved = (item.node === 'entry' || item.node === 'archive') && item.resolved === false;
  const name = node('span', undefined, 'cell-name' + (unresolved ? ' unresolved' : ''));
  name.append(icon(unresolved && categoryOf(item) === 'other' ? 'hash' : categoryOf(item)));
  const text = node('span', item.node === 'entry' || item.node === 'archive' ? (state.searchMode ? item.name : base(item.name)) : item.name);
  name.append(text);
  if (item.nameFromLabel) name.append(node('em', 'label', 'badge label'));
  name.title = item.fullPath ?? item.name;
  row.append(name);
  const type = node('span', item.typeLabel ?? (item.node === 'dir' || item.node === 'folder' ? 'Folder' : ''));
  type.title = item.ext ? '.' + item.ext : '';
  row.append(type);
  row.append(node('span', item.node === 'dir' || item.node === 'folder' ? (item.count ? item.count.toLocaleString() + ' items' : '') : size(item.size), 'num'));
  if (state.searchMode) {
    row.append(node('span', { name: 'name', label: 'label', hash: 'hash', type: 'type' }[item.matchedOn] ?? '', 'num'));
    const location = node('span', item.location, 'location');
    location.title = item.location;
    row.append(location);
  } else {
    row.append(node('span', item.offset !== undefined && item.offset !== null ? hex(item.offset) : item.entries ? item.entries.toLocaleString() + ' entries' : '', 'num'));
  }
}

const list = new VirtualList({
  body: el('list-body'),
  keyOf: item => item.key ?? 'd:' + item.target,
  renderRow,
  onSelect: item => selectItem(item),
  onOpen: item => activate(item),
  onContext: (item, event) => showContext(item, event),
});

function compareItems(a, b) {
  const folder = item => item.node === 'dir' || item.node === 'folder' ? 0 : 1;
  if (folder(a) !== folder(b)) return folder(a) - folder(b);
  const { key, direction } = state.sort;
  let result = 0;
  if (key === 'size') result = (a.size ?? 0) - (b.size ?? 0);
  else if (key === 'offset') result = (a.offset ?? 0) - (b.offset ?? 0);
  else if (key === 'type') result = (a.typeLabel ?? '').localeCompare(b.typeLabel ?? '');
  else if (key === 'location') result = (a.location ?? '').localeCompare(b.location ?? '');
  else if (key === 'match') result = (a.matchedOn ?? '').localeCompare(b.matchedOn ?? '');
  else {
    // Named files first, then hash-only files, each in natural order.
    const rank = item => (item.resolved === false ? 1 : 0);
    result = rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  }
  return result * direction;
}

function applyView({ keepScroll = false } = {}) {
  let items = state.rawItems;
  if (!state.searchMode) {
    const query = el('search').value.trim().toLowerCase();
    const filter = el('filter').value;
    items = items.filter(item => {
      if (item.node === 'dir' || item.node === 'folder') return !query || item.name.toLowerCase().includes(query);
      if (filter === 'resolved' && item.resolved === false) return false;
      if (filter === 'unresolved' && item.resolved !== false) return false;
      if (!query) return true;
      return [item.name, item.hash64 ?? '', item.hash32 ?? '', item.typeLabel ?? '', ...(item.modelLabels ?? [])]
        .some(value => value.toLowerCase().includes(query));
    });
  }
  items = [...items].sort(compareItems);
  state.items = items;
  drawHead();
  list.setItems(items, { keepScroll, selectKey: state.selected?.key ?? null });
  el('listing').hidden = false;
  el('list-status').textContent = state.searchMode
    ? ''
    : items.length.toLocaleString() + (items.length === state.rawItems.length ? ' items' : ' of ' + state.rawItems.length.toLocaleString() + ' items');
  if (!items.length) {
    const empty = node('div', state.searchMode ? 'No matches.' : 'This folder has no matching entries.', 'list-empty');
    el('list-status').replaceChildren(empty);
  }
}

// ---------------------------------------------------------------- navigation

function drawBreadcrumb(crumbs) {
  const host = el('breadcrumb');
  host.replaceChildren();
  crumbs.forEach((crumb, index) => {
    if (index) host.append(node('span', '›', 'sep'));
    const link = button(crumb.name, () => go(crumb.id));
    link.title = crumb.name;
    if (index === crumbs.length - 1) link.setAttribute('aria-current', 'true');
    host.append(link);
  });
}

function updateNav() {
  el('nav-back').disabled = state.cursor <= 0;
  el('nav-forward').disabled = state.cursor >= state.history.length - 1;
  el('nav-up').disabled = !state.location?.parent && !state.searchMode;
}

async function load(id, refresh = false) {
  if (!refresh && state.cache.has(id)) return state.cache.get(id);
  const location = id.startsWith('open:') ? await lib('browse-opened', { id }) : await lib('browse', { id });
  state.cache.set(id, location);
  if (state.cache.size > 40) state.cache.delete(state.cache.keys().next().value);
  return location;
}

function locationItems(location) {
  const folders = location.folders.map(folder => ({ ...folder, key: 'd:' + folder.target, typeLabel: 'Folder',
    category: folder.node, size: null, name: folder.name }));
  return [...folders, ...location.items];
}

async function go(id, { push = true, selectKey = null, refresh = false } = {}) {
  const revision = ++state.listRevision;
  message();
  try {
    const location = await load(id, refresh);
    if (revision !== state.listRevision) return;
    leaveSearch(false);
    state.location = location;
    state.archive = location.archive ?? null;
    if (push) {
      state.history = state.history.slice(0, state.cursor + 1);
      if (state.history.at(-1) !== id) state.history.push(id);
      state.cursor = state.history.length - 1;
    }
    state.rawItems = locationItems(location);
    el('archive-name').textContent = location.title;
    el('archive-meta').textContent = location.summary ?? '';
    el('entry-tools').hidden = false;
    el('filter').disabled = location.node === 'pool' || location.node === 'dir';
    el('search').value = '';
    if (!selectKey) clearSelection();
    drawBreadcrumb(location.breadcrumb);
    applyView();
    if (selectKey) {
      const index = state.items.findIndex(item => item.key === selectKey);
      if (index >= 0) list.select(index);
    }
    updateNav();
    revealInTree(location);
    el('list-body').focus({ preventScroll: true });
  } catch (error) {
    if (revision === state.listRevision) message(clean(error.message), true);
  }
}

function goBack() { if (state.cursor > 0) { state.cursor--; go(state.history[state.cursor], { push: false }); } }
function goForward() { if (state.cursor < state.history.length - 1) { state.cursor++; go(state.history[state.cursor], { push: false }); } }
function goUp() {
  if (state.searchMode) { leaveSearch(true); return; }
  if (state.location?.parent) go(state.location.parent);
}

async function activate(item) {
  if (item.node === 'dir' || item.node === 'folder') return go(item.target);
  if (item.node === 'archive' || item.node === 'pool') {
    if (item.target) return go(item.target);
    return message('This archive entry cannot be opened directly. It is compressed or encrypted.', true);
  }
  if (state.searchMode) return openResultLocation(item);
  if (item.node === 'entry') { selectItem(item); el('selection').scrollIntoView?.({ block: 'start' }); }
}

// ---------------------------------------------------------------- tree

const tree = { nodes: new Map(), expanded: new Set(['fs:']) };

function treeRow(entry, depth, canExpand) {
  const row = node('button', undefined, 'tree-row');
  row.type = 'button';
  row.setAttribute('role', 'treeitem');
  row.style.setProperty('--depth', String(depth));
  row.dataset.id = entry.id;
  const twist = node('span', canExpand ? (tree.expanded.has(entry.id) ? '▾' : '▸') : '', 'twist');
  twist.addEventListener('click', event => { event.stopPropagation(); toggle(entry.id); });
  row.append(twist, icon(entry.category), node('span', entry.name, 'tree-name'));
  if (entry.count) row.append(node('small', entry.count.toLocaleString()));
  row.title = entry.name;
  row.setAttribute('aria-expanded', canExpand ? String(tree.expanded.has(entry.id)) : 'false');
  row.addEventListener('click', () => { if (canExpand && !tree.expanded.has(entry.id)) toggle(entry.id, false); go(entry.id); });
  row.addEventListener('contextmenu', event => {
    event.preventDefault();
    showContext({ node: entry.category === 'archive' ? 'archive' : 'dir', target: entry.id, name: entry.name, fullPath: entry.name, treeNode: true }, event);
  });
  return row;
}

async function treeChildren(id) {
  const cached = tree.nodes.get(id);
  if (cached) return cached;
  const location = await load(id);
  const children = [
    ...location.folders.map(folder => ({ id: folder.target, name: folder.name, category: folder.node, count: folder.count, expandable: true })),
    ...location.items.filter(item => item.target && (item.node === 'archive' || item.node === 'pool')).map(item => ({
      id: item.target, name: base(item.name), category: item.node === 'pool' ? 'texture' : 'archive', expandable: item.node === 'archive' })),
  ];
  tree.nodes.set(id, children);
  return children;
}

async function toggle(id, rerender = true) {
  if (tree.expanded.has(id)) tree.expanded.delete(id); else tree.expanded.add(id);
  if (rerender) await drawTree();
  else await drawTree();
}

async function drawTree() {
  const host = el('tree');
  const scroll = host.scrollTop;
  const fragment = document.createDocumentFragment();
  const rootNode = { id: 'fs:', name: 'Game folder', category: 'dir', expandable: true };
  async function walk(entry, depth) {
    const expanded = tree.expanded.has(entry.id) && entry.expandable;
    fragment.append(treeRow(entry, depth, entry.expandable));
    if (!expanded) return;
    let children;
    try { children = await treeChildren(entry.id); } catch { return; }
    const shown = tree.showAll?.has(entry.id) ? children : children.slice(0, 300);
    for (const child of shown) await walk(child, depth + 1);
    if (children.length > shown.length) {
      const more = button('Show all ' + children.length.toLocaleString() + ' items', () => { (tree.showAll ??= new Set()).add(entry.id); drawTree(); });
      more.className = 'tree-more';
      fragment.append(more);
    }
  }
  await walk(rootNode, 0);
  host.replaceChildren(fragment);
  host.scrollTop = scroll;
  markTree();
}

function markTree() {
  const current = state.location?.id;
  for (const row of el('tree').querySelectorAll('.tree-row')) row.setAttribute('aria-current', String(row.dataset.id === current));
}

async function revealInTree(location) {
  // Expand every ancestor of the current location, then highlight it.
  let changed = false;
  for (const crumb of location.breadcrumb.slice(0, -1)) {
    if (!tree.expanded.has(crumb.id)) { tree.expanded.add(crumb.id); changed = true; }
  }
  if (changed || !el('tree').querySelector('.tree-row')) await drawTree(); else markTree();
  el('tree').querySelector('.tree-row[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- selection and details

let disposePreview = null;
let selectedClip = null;
const assemblyParts = [];

function clearSelection() {
  state.selected = null;
  state.entry = null;
  ++state.previewRevision;
  disposePreview?.();
  disposePreview = null;
  el('resource-preview').replaceChildren();
  el('selection-empty').hidden = false;
  el('selection').hidden = true;
}

function setProps(data) {
  const props = el('properties');
  props.replaceChildren();
  for (const [title, value, monospace] of data) {
    if (value === null || value === undefined || value === '') continue;
    const dt = node('dt', title);
    const dd = node('dd', String(value));
    if (monospace) dd.className = 'mono';
    props.append(dt, dd);
  }
}

function showBasic(item) {
  ++state.previewRevision;
  disposePreview?.();
  disposePreview = null;
  el('resource-preview').replaceChildren();
  el('resource-preview').hidden = true;
  el('preview').hidden = true;
  el('selection-empty').hidden = true;
  el('selection').hidden = false;
  el('entry-kind').textContent = item.typeLabel ?? (item.node === 'dir' ? 'Folder' : 'File');
  el('entry-name').textContent = item.name;
  el('entry-path').textContent = item.fullPath ?? '';
  setProps([['Size', item.size !== null && item.size !== undefined ? size(item.size) : null],
    ['Entries', item.entries ? item.entries.toLocaleString() : null]]);
  el('extract').hidden = true;
  el('stored').hidden = true;
  el('copy-path').hidden = false;
  el('nested').hidden = !item.target;
  el('nested').textContent = item.node === 'pool' ? 'Open texture pool' : item.node === 'dir' || item.node === 'folder' ? 'Open folder' : 'Open archive';
  el('preview-note').textContent = item.node === 'archive' || item.node === 'pool' ? 'Double-click or press Enter to open.' : '';
}

async function selectItem(item) {
  state.selected = item;
  if (item.node === 'dir' || item.node === 'folder' || item.node === 'file' || item.node === 'pool' ||
      (item.node === 'archive' && item.kind === 'localArchive')) {
    state.entry = null;
    return showBasic(item);
  }
  if (state.searchMode) return selectResult(item);
  return selectEntry(item);
}

async function selectResult(result) {
  const revision = ++state.previewRevision;
  try {
    const opened = await lib('open-result', resultTarget(result));
    if (revision !== state.previewRevision) return;
    const entry = { ...opened.entry, archiveKey: opened.key, fullPath: result.fullPath, category: result.category, typeLabel: result.typeLabel,
      node: opened.entry.kind === 'archive' ? 'archive' : 'entry', location: result.location,
      target: opened.entry.kind === 'archive' && opened.entry.nestedAvailable ? 'rpf:' + result.archiveRef + '>' + result.row : null,
      resultLocation: opened.location };
    result.resolvedEntry = entry;
    await selectEntry(entry, true);
  } catch (error) { message(clean(error.message), true); }
}

async function selectEntry(entry, fromSearch = false) {
  state.entry = entry;
  if (!fromSearch) state.selected = entry;
  const current = ++state.previewRevision;
  const archive = entry.archiveKey;
  el('selection-empty').hidden = true;
  el('selection').hidden = false;
  const pool = entry.kind === 'poolTexture';
  el('entry-kind').textContent = pool ? entry.shape : entry.nameFromLabel ? 'Name from embedded model label'
    : entry.resolved ? 'Verified path' : 'Unresolved filename (hash only)';
  el('entry-name').textContent = base(entry.name);
  el('entry-path').textContent = entry.fullPath ?? '';
  setProps([
    ['Name source', pool ? 'Texture key' : entry.nameSource ?? 'Archive hash only'],
    ['Embedded model labels', entry.modelLabels?.join(', ') || null],
    ['64-bit hash', entry.hash64 ? '0x' + entry.hash64 : null, true],
    ['32-bit hash', entry.hash32 ? '0x' + entry.hash32 : null, true],
    ['Offset', hex(entry.offset), true],
    ['Decoded size', size(entry.size)],
    ['Stored size', size(entry.stored)],
    ['Encrypted', entry.encrypted ? 'Yes' : 'No'],
    ['Chunks', entry.chunks],
  ]);
  const archiveEntry = entry.kind === 'archive';
  el('nested').hidden = !archiveEntry;
  el('nested').textContent = 'Open archive';
  el('nested').disabled = !entry.nestedAvailable;
  el('extract').hidden = false;
  el('extract').textContent = pool ? 'Save DDS' : 'Extract file';
  el('extract').disabled = pool && !entry.exportable;
  el('stored').hidden = pool;
  el('stored').disabled = false;
  el('copy-path').hidden = false;
  await loadPreview(archive, entry, current);
}

function saveDecoded(result, filename) {
  const name = state.entry?.name ? base(state.entry.name) : undefined;
  return window.opensix.savePreview(result.id, filename, name).then(saved => {
    if (saved) message('Saved ' + saved + '.');
  }).catch(error => message(clean(error.message), true));
}

async function showAssembly(endpoint, input) {
  const current = ++state.previewRevision;
  const display = el('resource-preview');
  const onError = error => { if (current === state.previewRevision) el('preview-note').textContent = error.message; };
  el('preview-note').textContent = 'Assembling selected parts…';
  try {
    const result = await api(endpoint, { ...input, clip: selectedClip });
    if (current !== state.previewRevision) return;
    disposePreview?.();
    display.replaceChildren();
    el('preview-note').textContent = result.note ?? '';
    const modelResult = { ...result, items: [], lods: [], animation: result.animation };
    disposePreview = renderAsset(display, modelResult, () => {}, filename => saveDecoded(result, filename), onError, () => {
      selectedClip = null;
      showAssembly(endpoint, input);
    });
  } catch (error) { onError(error); }
}

function assemblyControls(parent, result, archive, entry) {
  const section = document.createElement('details');
  const summary = document.createElement('summary');
  const title = () => { summary.textContent = 'Model assembly · ' + assemblyParts.length + ' selected'; };
  title();
  section.append(summary);
  const component = { archive, entry: entry.id, index: result.index, detail: result.detail };
  const add = part => {
    if (assemblyParts.length >= 32) return message('An assembly can contain up to 32 parts.', true);
    if (assemblyParts.some(other => JSON.stringify(other) === JSON.stringify(part))) return message('That drawable is already in the assembly.');
    assemblyParts.push(part);
    title();
    message('Added ' + (result.name ?? entry.name) + '.');
  };
  section.append(button('Add drawable', () => add(component)));
  const wheelInputs = [];
  for (const side of ['Front', 'Rear']) {
    const field = document.createElement('input');
    field.type = 'number';
    field.min = '0.01';
    field.max = '10';
    field.step = '0.01';
    field.placeholder = side + ' scale';
    field.setAttribute('aria-label', side + ' wheel scale');
    wheelInputs.push(field);
    section.append(field);
  }
  section.append(button('Add wheel component', () => {
    if (!assemblyParts.length) return message('Add the vehicle body first.', true);
    const wheelScale = wheelInputs.map(field => Number(field.value));
    if (wheelScale.some(scale => !Number.isFinite(scale) || scale < 0.01 || scale > 10)) {
      return message('Enter front and rear wheel scales between 0.01 and 10.', true);
    }
    add({ ...component, wheelScale });
  }), button('Preview assembly', () => {
    if (assemblyParts.length < 2) return message('Add at least two drawables.', true);
    showAssembly('/api/assembly', { parts: [...assemblyParts] });
  }), button('Clear parts', () => {
    assemblyParts.length = 0;
    title();
  }));
  parent.append(section);
}

function showResource(result) {
  const preview = el('resource-preview');
  if (result.type === 'heightmap') {
    const canvas = document.createElement('canvas');
    canvas.width = result.width;
    canvas.height = result.height;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Terrain heightmap preview');
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(result.width, result.height);
    const values = atob(result.value);
    for (let i = 0; i < values.length; i++) {
      const elevation = values.charCodeAt(i);
      const t = Math.sqrt(Math.max(0, elevation - result.water) / Math.max(1, 255 - result.water));
      const land = elevation > result.water;
      img.data[4 * i] = land ? 37 + 196 * t : 12;
      img.data[4 * i + 1] = land ? 103 + 125 * t : 36;
      img.data[4 * i + 2] = land ? 75 + 150 * t : 72;
      img.data[4 * i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    preview.append(canvas);
  } else {
    const image = result.type === 'image';
    const element = document.createElement(image ? 'img' : 'audio');
    if (image) element.alt = 'Archive image';
    else element.controls = true;
    element.src = 'data:' + result.mime + ';base64,' + result.value;
    preview.append(element);
  }
  preview.hidden = false;
  el('preview').hidden = true;
}

async function loadPreview(archive, entry, current, index = null, detail = null, slice = null) {
  disposePreview?.();
  disposePreview = null;
  const display = el('resource-preview');
  display.replaceChildren();
  display.hidden = true;
  el('preview').hidden = false;
  el('preview').textContent = '';
  el('preview-note').textContent = 'Reading preview…';
  const clip = selectedClip;
  const isModel = ['zdr', 'zdd', 'zft'].includes((entry.type ?? '').toLowerCase());
  try {
    const query = new URLSearchParams({ archive, entry: entry.id });
    if (index !== null) query.set('index', index);
    if (detail !== null) query.set('detail', detail);
    if (slice !== null) query.set('slice', slice);
    if (clip && isModel) {
      query.set('clipArchive', clip.archive);
      query.set('clipEntry', clip.entry);
      query.set('clipIndex', clip.index);
    }
    const result = await api('/api/preview?' + query);
    if (current !== state.previewRevision) {
      if (result.type === 'movie') await api('/api/movie-command', { id: result.id, action: 'close' });
      return;
    }
    if (['model', 'textures', 'bank', 'inspection', 'poolTexture', 'movie', 'wardrobe'].includes(result.type)) {
      el('preview-note').textContent = result.note ?? '';
      display.hidden = false;
      el('preview').hidden = true;
      disposePreview = renderAsset(display, result, (choice, mip, face = null) => {
        loadPreview(archive, entry, ++state.previewRevision, choice, mip, face);
      }, filename => saveDecoded(result, filename), error => { el('preview-note').textContent = error.message; }, (clip, index) => {
        selectedClip = clip ? { archive, entry: entry.id, index } : null;
        if (clip) message('Selected ' + clip.name + '. Open a skinned model to play it.');
        else loadPreview(archive, entry, ++state.previewRevision);
      }, async (action, value) => {
        if (action === 'wardrobe') return showAssembly('/api/wardrobe-assembly', { id: value.id });
        if (action === 'saveMip') {
          try {
            const saved = await window.opensix.save(archive, entry.id, false, value);
            if (saved) message('Saved ' + saved + '.');
          } catch (error) { message(clean(error.message), true); }
        }
      });
      if (isModel && result.type === 'model') assemblyControls(display, result, archive, entry);
      return;
    }
    const media = ['heightmap', 'image', 'audio'].includes(result.type);
    el('preview-note').textContent = [
      result.stored ? 'Stored bytes' : result.type === 'text' ? 'Decoded text' : media ? '' : 'Decoded bytes',
      result.truncated ? 'preview only' : '',
      result.note ?? '',
    ].filter(Boolean).join(' · ');
    if (media) showResource(result);
    else el('preview').textContent = result.value;
  } catch (error) {
    if (current === state.previewRevision) {
      el('preview-note').textContent = clean(error.message);
      if (clip && isModel) {
        display.hidden = false;
        display.append(button('Clear selected clip', () => {
          selectedClip = null;
          loadPreview(archive, entry, ++state.previewRevision, index, detail, slice);
        }));
      }
    }
  }
}

async function extract(stored) {
  const entry = state.entry;
  if (!entry) return;
  const trigger = el(stored ? 'stored' : 'extract');
  trigger.disabled = true;
  try {
    const result = await window.opensix.save(entry.archiveKey, entry.id, stored);
    if (result) message('Saved ' + result + '.');
  } catch (error) {
    message(clean(error.message), true);
  } finally {
    trigger.disabled = false;
  }
}

// ---------------------------------------------------------------- context menu

const menu = el('context-menu');
function hideContext() { menu.hidden = true; menu.replaceChildren(); }
document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) hideContext(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideContext(); });
window.addEventListener('blur', hideContext);
el('list-body').addEventListener('scroll', hideContext, { passive: true });

async function copy(text, what) {
  try { await window.opensix.copy(text); message('Copied ' + what + '.'); } catch (error) { message(clean(error.message), true); }
}

async function resolveItem(item) {
  if (item.resolvedEntry) return item.resolvedEntry;
  if (state.searchMode && item.row !== undefined) {
    const opened = await lib('open-result', resultTarget(item));
    return { ...opened.entry, archiveKey: opened.key, fullPath: item.fullPath, category: item.category, location: item.location };
  }
  return item;
}

function showContext(item, event) {
  hideContext();
  const actions = [];
  const isEntry = item.node === 'entry';
  const group = list.selectedItems().filter(other => other.node === 'entry' && other.archiveKey && !state.searchMode);
  if (group.length > 1 && group.includes(item)) {
    actions.push(['Extract ' + group.length + ' selected files…', async () => {
      try {
        message('Preparing extraction…');
        const result = await window.opensix.saveBatch({ archive: group[0].archiveKey, ids: group.map(entry => entry.id) });
        message(result ? 'Saved ' + result.saved + ' files to ' + result.folder + '.' + (result.failed ? ' ' + result.failed + ' entries could not be extracted. See extraction-report.json.' : '') : '', Boolean(result?.failed));
      } catch (error) { message(clean(error.message), true); }
    }]);
    actions.push(null);
    actions.push(['Copy ' + group.length + ' paths', () => copy(group.map(entry => entry.fullPath ?? entry.name).join('\n'), group.length + ' paths')]);
    return finishMenu(actions, event);
  }
  const open = () => activate(item);
  if (item.node === 'dir' || item.node === 'folder' || ((item.node === 'archive' || item.node === 'pool') && item.target)) {
    actions.push([item.node === 'archive' ? 'Open archive' : item.node === 'pool' ? 'Open texture pool' : 'Open', open, 'Enter']);
  }
  if (isEntry) {
    actions.push(['Preview', async () => { if (!state.searchMode) list.select(state.items.indexOf(item), { focus: true }); else await selectResult(item); }]);
    actions.push(['Extract file…', async () => {
      try { const entry = await resolveItem(item); const saved = await window.opensix.save(entry.archiveKey, entry.id, false); if (saved) message('Saved ' + saved + '.'); }
      catch (error) { message(clean(error.message), true); }
    }]);
    if (item.kind !== 'poolTexture') {
      actions.push(['Save stored bytes…', async () => {
        try { const entry = await resolveItem(item); const saved = await window.opensix.save(entry.archiveKey, entry.id, true); if (saved) message('Saved ' + saved + '.'); }
        catch (error) { message(clean(error.message), true); }
      }]);
    }
    if (item.category === 'model') {
      for (const format of ['glb', 'fbx']) {
        actions.push(['Export model as ' + format.toUpperCase() + '…', async () => {
          try {
            message('Preparing ' + format.toUpperCase() + ' export…');
            const entry = await resolveItem(item);
            const saved = await window.opensix.exportModel(entry.archiveKey, entry.id, format);
            message(saved ? 'Saved ' + saved + '.' : '');
          } catch (error) { message(clean(error.message), true); }
        }]);
      }
    }
  }
  if (state.searchMode && item.row !== undefined) actions.push(['Go to location', () => openResultLocation(item)]);
  if (item.node === 'file' || item.node === 'dir' || item.node === 'archive' && item.kind === 'localArchive') {
    const rel = item.fullPath ?? item.name;
    actions.push(['Show in Windows Explorer', () => window.opensix.reveal(rel).catch(error => message(clean(error.message), true))]);
  }
  actions.push(null);
  actions.push(['Copy full path', () => copy(item.fullPath ?? item.name, 'the path')]);
  actions.push(['Copy name', () => copy(isEntry || item.node === 'archive' ? base(item.name) : item.name, 'the name')]);
  if (item.hash64) actions.push(['Copy hash (0x' + item.hash64 + ')', () => copy(item.hash64, 'the hash')]);
  finishMenu(actions, event);
}

function finishMenu(actions, event) {
  for (const entry of actions) {
    if (!entry) { menu.append(document.createElement('hr')); continue; }
    const choice = button(entry[0], () => { hideContext(); entry[1](); });
    if (entry[2]) choice.append(node('kbd', entry[2]));
    choice.setAttribute('role', 'menuitem');
    menu.append(choice);
  }
  menu.hidden = false;
  const width = menu.offsetWidth, height = menu.offsetHeight;
  menu.style.left = Math.max(4, Math.min(event.clientX, window.innerWidth - width - 6)) + 'px';
  menu.style.top = Math.max(4, Math.min(event.clientY, window.innerHeight - height - 6)) + 'px';
  menu.querySelector('button')?.focus();
}

// ---------------------------------------------------------------- search

const chipNames = [['model', 'Models'], ['texture', 'Textures'], ['animation', 'Animations'], ['collision', 'Collision'],
  ['map', 'Maps'], ['audio', 'Audio'], ['data', 'Data'], ['other', 'Other']];

function drawChips() {
  const host = el('search-chips');
  host.replaceChildren();
  for (const [key, title] of chipNames) {
    const chip = button(title, () => {
      if (state.chips.has(key)) state.chips.delete(key); else state.chips.add(key);
      drawChips();
      runSearch();
    });
    chip.className = 'chip';
    chip.setAttribute('aria-pressed', String(state.chips.has(key)));
    host.append(chip);
  }
}

function leaveSearch(restore) {
  const was = state.searchMode;
  state.searchMode = false;
  state.searchData = null;
  el('search-chips').hidden = true;
  el('clear-search').hidden = true;
  el('search-characters')?.replaceChildren();
  el('search-characters').hidden = true;
  el('search').closest('label').hidden = false;
  el('filter').closest('label').hidden = false;
  if (was) el('global-search').value = '';
  if (was && restore && state.location) {
    state.rawItems = locationItems(state.location);
    el('archive-name').textContent = state.location.title;
    el('archive-meta').textContent = state.location.summary ?? '';
    drawBreadcrumb(state.location.breadcrumb);
    applyView();
    updateNav();
  }
}

let searchTimer;
async function runSearch() {
  const query = el('global-search').value.trim();
  if (query.length < 2 && !/^[a-z]+:/i.test(query)) {
    if (state.searchMode) leaveSearch(true);
    return;
  }
  const revision = ++state.searchRevision;
  const status = state.status;
  if (status?.index?.state !== 'ready') {
    message('The search index is still being built. Search will be available when it finishes.', false);
    return;
  }
  message();
  let scope = null;
  if (el('search-scope').value === 'here' && state.location) {
    scope = state.location.libraryArchive !== undefined && state.location.libraryArchive !== null
      ? { archive: state.location.libraryArchive }
      : state.location.node === 'dir' ? { dir: state.location.id.slice(3) } : null;
  }
  try {
    const data = await lib('search', { query, categories: [...state.chips], scope, limit: 2000 });
    if (revision !== state.searchRevision) return;
    enterSearch(query, data);
  } catch (error) { if (revision === state.searchRevision) message(clean(error.message), true); }
}

function enterSearch(query, data) {
  const first = !state.searchMode;
  state.searchMode = true;
  state.searchData = data;
  state.rawItems = data.results.map(result => ({ ...result, node: result.ext === 'rpf' ? 'archive' : 'entry', kind: 'result', target: null }));
  if (first) clearSelection();
  el('archive-name').textContent = 'Search: ' + query;
  const labelState = state.status?.labels;
  el('archive-meta').textContent = data.total.toLocaleString() + ' matches' + (data.truncated ? ' · first ' + data.results.length.toLocaleString() + ' shown' : '') +
    (labelState?.state === 'running' ? ' · model names are still being indexed, so more matches may appear' : '');
  el('search-chips').hidden = false;
  el('clear-search').hidden = false;
  el('search').closest('label').hidden = true;
  el('filter').closest('label').hidden = true;
  drawChips();
  drawSearchCharacters(data.characters ?? []);
  drawBreadcrumb([{ id: 'search', name: 'Search results' }]);
  applyView();
  updateNav();
  el('list-status').textContent = '';
}

function drawSearchCharacters(characters) {
  const host = el('search-characters');
  host.replaceChildren();
  host.hidden = !characters.length;
  for (const character of characters.slice(0, 6)) {
    const hit = node('div', undefined, 'character-hit');
    hit.append(icon('model'), node('strong', character.prefix), node('small', character.parts + ' parts · ' + character.location.join(', ')));
    hit.append(button('Preview and export', () => characterDialog.open(character.prefix, el('global-search').value)));
    host.append(hit);
  }
}

async function openResultLocation(result) {
  try {
    const opened = await lib('open-result', resultTarget(result));
    el('global-search').value = '';
    leaveSearch(false);
    await go(opened.location, { selectKey: 'e:' + opened.key + ':' + result.row });
    const index = state.items.findIndex(item => item.node !== 'dir' && item.node !== 'folder' && item.id === result.row);
    if (index >= 0) list.select(index, { focus: true });
  } catch (error) { message(clean(error.message), true); }
}

// A search result is either an archive entry or a texture pool entry.
const resultTarget = result => result.pool ? { pool: result.pool, row: result.row } : { archive: result.archive, row: result.row };

el('search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(searchTimer); runSearch(); });
el('global-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 320); });
el('global-search').addEventListener('keydown', event => { if (event.key === 'Escape') { el('global-search').value = ''; leaveSearch(true); } });
el('search-scope').addEventListener('change', runSearch);
// The model viewer asks for a texture hash to be located in the game.
document.addEventListener('opensix:find', event => {
  for (const id of ['character-dialog', 'tool-dialog']) if (el(id).open) el(id).close();
  el('search-scope').value = 'game';
  el('global-search').value = event.detail.query;
  clearTimeout(searchTimer);
  runSearch();
});
el('clear-search').addEventListener('click', () => leaveSearch(true));
el('search').addEventListener('input', () => applyView());
el('filter').addEventListener('change', () => applyView());

// ---------------------------------------------------------------- toolbar and shortcuts

el('nav-back').addEventListener('click', goBack);
el('nav-forward').addEventListener('click', goForward);
el('nav-up').addEventListener('click', goUp);
el('nav-refresh').addEventListener('click', () => { state.cache.clear(); tree.nodes.clear(); if (state.location) go(state.location.id, { push: false, refresh: true }); });
el('extract').addEventListener('click', () => extract(false));
el('stored').addEventListener('click', () => extract(true));
el('copy-path').addEventListener('click', () => { const item = state.entry ?? state.selected; if (item) copy(item.fullPath ?? item.name, 'the path'); });
el('nested').addEventListener('click', () => { const item = state.entry ?? state.selected; if (item?.target) go(item.target); });
document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key.toLowerCase() === 'f') { event.preventDefault(); el('global-search').focus(); el('global-search').select(); }
  else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); goBack(); }
  else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); goForward(); }
  else if (event.key === 'F5') { event.preventDefault(); el('nav-refresh').click(); }
  else if (event.key === 'Backspace' && event.target === el('list-body')) { event.preventDefault(); goUp(); }
});

// ---------------------------------------------------------------- opened (external) files and legacy dialog

function renderOpened() {
  const nav = el('archives');
  nav.replaceChildren();
  el('opened-section').hidden = !state.opened.length;
  for (const item of state.opened) {
    const row = button('', () => go('open:' + item.id));
    row.className = 'tree-row';
    row.append(icon(item.pool ? 'texture' : 'archive'), node('span', item.name, 'tree-name'), node('small', item.entries.toLocaleString()));
    row.title = item.path;
    nav.append(row);
  }
  el('import-names').disabled = !state.opened.length && state.status?.index?.state !== 'ready';
}

function rememberOpened(data) {
  const selected = data.archives.find(item => item.id === data.selected);
  if (selected && !state.opened.some(item => item.id === selected.id)) state.opened.push(selected);
  renderOpened();
  return selected;
}

el('open').addEventListener('click', () => el('open-dialog').showModal());
async function openPool() {
  const path = await window.opensix.choose('pool');
  if (!path) return;
  const data = await api('/api/open-pool', { path });
  rememberOpened(data);
  if (el('open-dialog').open) el('open-dialog').close();
  message();
  await go('open:' + data.selected);
}
el('choose-pool').addEventListener('click', async () => {
  const trigger = el('choose-pool');
  trigger.disabled = true;
  try { await openPool(); }
  catch (error) { message(clean(error.message), true, el('open-error')); }
  finally { trigger.disabled = false; }
});
for (const id of ['cancel', 'close-dialog']) el(id).addEventListener('click', () => el('open-dialog').close());
for (const [buttonId, kind, inputId] of [
  ['choose-exe', 'executable', 'exe-path'],
  ['choose-archive', 'archive', 'archive-path'],
  ['choose-folder', 'folder', 'archive-path'],
]) {
  el(buttonId).addEventListener('click', async () => {
    try {
      const value = await window.opensix.choose(kind);
      if (value) el(inputId).value = value;
    } catch (error) { message(clean(error.message), true, el('open-error')); }
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
    rememberOpened(data);
    el('open-dialog').close();
    message(data.issues.length ? data.issues.join('\n') : '', Boolean(data.issues.length));
    await go('open:' + data.selected);
  } catch (error) {
    message(clean(error.message), true, el('open-error'));
  } finally {
    openButton.disabled = false;
    openButton.textContent = 'Open';
  }
});
el('import-names').addEventListener('click', () => el('name-file').click());
el('name-file').addEventListener('change', async () => {
  const input = el('name-file');
  const file = input.files[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('Choose a path list smaller than 1 MiB.');
    await api('/api/names', { text: await file.text() });
    state.cache.clear();
    message('Imported candidate paths from ' + file.name + '. Matching entries now show verified names.');
    if (state.location) await go(state.location.id, { push: false, refresh: true });
  } catch (error) {
    message(clean(error.message), true);
  } finally {
    input.value = '';
  }
});

// ---------------------------------------------------------------- setup and status

const characterDialog = setupCharacters({ lib, notify: message, navigate: id => go(id) });

function showSetup({ closable, error = '' } = {}) {
  const dialog = el('setup-dialog');
  el('close-setup').hidden = !closable;
  message(error, Boolean(error), el('setup-error'));
  const known = state.status?.gameDir ?? state.status?.savedGameDir;
  if (known) el('setup-path').value = known;
  const found = el('setup-found');
  found.replaceChildren();
  el('setup-detect').textContent = 'Looking for installed copies…';
  if (!dialog.open) dialog.showModal();
  lib('detect').then(candidates => {
    el('setup-detect').textContent = candidates.length ? 'Found on this PC:' : 'No copy was found automatically. Browse to the game folder.';
    for (const candidate of candidates) {
      const choice = button('', () => { el('setup-path').value = candidate.gameDir; useGameFolder(); });
      choice.append(node('strong', candidate.gameDir), node('small', candidate.exact ? 'Supported build' : 'Different build of the executable'));
      found.append(choice);
    }
  }).catch(() => { el('setup-detect').textContent = 'Automatic detection failed. Browse to the game folder.'; });
}

async function useGameFolder() {
  const path = el('setup-path').value.trim();
  if (!path) return message('Enter or browse to the game folder.', true, el('setup-error'));
  el('setup-use').disabled = true;
  message('Checking the game executable…', false, el('setup-error'));
  try {
    state.status = await lib('configure', { path });
    el('setup-dialog').close();
    state.cache.clear();
    tree.nodes.clear();
    tree.expanded = new Set(['fs:']);
    await start();
  } catch (error) { message(clean(error.message), true, el('setup-error')); }
  finally { el('setup-use').disabled = false; }
}
el('setup-use').addEventListener('click', useGameFolder);
el('setup-path').addEventListener('keydown', event => { if (event.key === 'Enter') useGameFolder(); });
el('setup-browse').addEventListener('click', async () => {
  try { const path = await window.opensix.choose('game-folder'); if (path) { el('setup-path').value = path; useGameFolder(); } }
  catch (error) { message(clean(error.message), true, el('setup-error')); }
});
el('close-setup').addEventListener('click', () => el('setup-dialog').close());
el('setup-dialog').addEventListener('cancel', event => { if (el('close-setup').hidden) event.preventDefault(); });

function drawStatus(status) {
  const host = el('index-status');
  const index = status.index ?? {}, labels = status.labels ?? {};
  let text = '', value = 0, max = 1;
  if (index.state === 'building') {
    text = index.phase === 'sorting' ? 'Finishing the search index…' : 'Indexing game archives… ' + (index.done ?? 0).toLocaleString() + ' of ' + (index.total ?? 0).toLocaleString();
    value = index.done ?? 0; max = Math.max(index.total ?? 1, 1);
  } else if (index.state === 'failed') {
    text = 'Indexing failed: ' + index.error;
  } else if (labels.state === 'running') {
    text = 'Indexing model names… ' + Math.round((labels.done ?? 0) / Math.max(labels.total ?? 1, 1) * 100) + '% · ' + (labels.found ?? 0).toLocaleString() + ' named';
    value = labels.done ?? 0; max = Math.max(labels.total ?? 1, 1);
  } else if (index.state === 'ready') {
    text = (status.counts?.rows ?? 0).toLocaleString() + ' entries in ' + (status.counts?.archives ?? 0).toLocaleString() + ' archives indexed · ' +
      (status.counts?.named ?? 0) + ' paths verified · ' + (status.counts?.labelled ?? 0).toLocaleString() + ' model labels' +
      (status.textures ? ' · ' + status.textures.toLocaleString() + ' textures' : '');
    host.hidden = false;
    el('index-text').textContent = text;
    el('index-progress').hidden = true;
    return;
  }
  host.hidden = !text;
  el('index-text').textContent = text;
  el('index-progress').hidden = !(index.state === 'building' || labels.state === 'running');
  el('index-progress').max = max;
  el('index-progress').value = value;
}

let lastRevision = -1;
async function poll() {
  try {
    const status = await lib('status');
    const wasReady = state.status?.index?.state === 'ready';
    state.status = status;
    drawStatus(status);
    if (status.index?.state === 'ready' && !wasReady) {
      state.cache.clear();
      tree.nodes.clear();
      if (state.location && !state.searchMode) go(state.location.id, { push: false, refresh: true, selectKey: state.selected?.key ?? null });
    }
    if (status.revision !== lastRevision) {
      lastRevision = status.revision;
      if (state.searchMode && el('global-search').value.trim()) runSearch();
    }
  } catch { /* The main process is shutting down. */ }
  const busy = state.status?.index?.state === 'building' || state.status?.labels?.state === 'running' ||
    state.status?.textureIndex?.state === 'running';
  setTimeout(poll, busy ? 1500 : 6000);
}

async function start() {
  try {
    state.status = await lib('status');
    if (!state.status.configured) {
      showSetup({ error: state.status.error ? state.status.error + ' Choose the game folder again.' : '' });
      return;
    }
    drawStatus(state.status);
    drawChips();
    el('exe-path').value = state.status.exe ?? '';
    el('archive-path').value = state.status.gameDir ?? '';
    await go('fs:');
  } catch (error) { message(clean(error.message), true); }
}

setupTools({
  current: () => ({ archive: state.entry?.archiveKey ?? state.archive, entry: state.entry, query: el('search').value, scope: scopeOfLocation(), filter: el('filter').value }),
  openPool,
  notify: message,
  action: name => {
    if (name === 'gamefolder') { showSetup({ closable: true }); return true; }
    if (name === 'search') { el('global-search').focus(); el('global-search').select(); return true; }
    if (name === 'characters') { characterDialog.open(); return true; }
    if (name === 'reindex') {
      lib('rebuild').then(status => { state.status = status; drawStatus(status); }).catch(error => message(clean(error.message), true));
      return true;
    }
    return false;
  },
});

function scopeOfLocation() {
  const id = state.location?.id ?? '';
  const at = id.indexOf('#');
  return at >= 0 ? id.slice(at + 1) : '';
}

// Browse requests for archives opened from outside the game folder.
await start();
poll();
