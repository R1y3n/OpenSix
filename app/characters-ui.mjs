// The Characters dialog: pick a character found in the game's model labels, choose its parts,
// preview the assembled and textured model, and export GLB or FBX.
import { renderAsset } from './asset-viewer.mjs';

const el = id => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};

export function setupCharacters({ lib, notify, navigate }) {
  const dialog = el('character-dialog');
  const list = el('character-list');
  const partsHost = el('character-parts');
  const previewHost = el('character-preview');
  const status = el('character-status');
  let current = null;       // { prefix, data }
  let dispose = null;
  let ticket = 0;

  function say(text = '', error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
    status.hidden = !text;
  }

  function clearPreview() {
    dispose?.();
    dispose = null;
    previewHost.replaceChildren();
  }

  async function loadList(query = '') {
    const current = ++ticket;
    list.replaceChildren(node('p', 'Loading characters…', 'quiet'));
    try {
      const characters = await lib('characters', { query });
      if (current !== ticket) return;
      list.replaceChildren();
      if (!characters.length) {
        list.append(node('p', 'No characters match. Model names are still being indexed, so more may appear.', 'quiet'));
        return;
      }
      for (const character of characters.slice(0, 400)) {
        const item = node('button');
        item.type = 'button';
        item.setAttribute('role', 'option');
        item.dataset.prefix = character.prefix;
        item.append(node('span', character.prefix), node('small', character.parts + ' parts'));
        item.title = character.location.join('\n');
        item.addEventListener('click', () => choose(character.prefix));
        list.append(item);
      }
    } catch (error) { if (current === ticket) say(error.message, true); }
  }

  async function choose(prefix) {
    say();
    clearPreview();
    for (const item of list.children) item.setAttribute('aria-selected', String(item.dataset?.prefix === prefix));
    partsHost.replaceChildren(node('p', 'Reading parts…', 'quiet'));
    try {
      const data = await lib('character-parts', { prefix });
      current = { prefix, data };
      drawParts();
    } catch (error) { partsHost.replaceChildren(); say(error.message, true); }
  }

  function drawParts() {
    const { prefix, data } = current;
    partsHost.replaceChildren();
    partsHost.append(node('h3', prefix));
    const locations = [...new Set(data.parts.map(part => part.location))];
    partsHost.append(node('p', 'Stored in ' + locations.join(', '), 'quiet'));
    if (data.legacy) partsHost.append(node('p', 'This character has a complete cutscene body and head. They are selected by default.', 'quiet'));
    const groups = new Map();
    for (const part of data.parts) (groups.get(part.group) ?? groups.set(part.group, []).get(part.group)).push(part);
    for (const [group, parts] of groups) {
      const section = node('div', undefined, 'part-group');
      section.append(node('h4', group));
      for (const part of parts) {
        const row = node('label', undefined, 'part-row');
        const box = node('input');
        box.type = 'checkbox';
        box.checked = part.default;
        box.dataset.rowIndex = String(part.rowIndex);
        row.append(box, node('span', part.name, 'mono'), node('small', part.copies > 1 ? part.copies + ' detail levels' : ''));
        if (part.variants > 1) {
          // The wardrobe catalogue lists several texture sets (colours) for this garment.
          const choice = node('select');
          choice.setAttribute('aria-label', 'Texture set for ' + part.label);
          choice.dataset.rowIndex = String(part.rowIndex);
          for (let i = 0; i < part.variants; i++) choice.append(new Option('Colour ' + (i + 1) + ' of ' + part.variants, String(i)));
          row.append(choice);
        } else if (part.variants === 1) row.append(node('small', 'textured'));
        row.title = part.location + '/' + part.name;
        section.append(row);
      }
      partsHost.append(section);
    }
    const actions = node('div', undefined, 'character-actions');
    const preview = node('button', 'Preview assembled character');
    preview.type = 'button';
    preview.classList.add('primary');
    preview.addEventListener('click', () => assemble(preview));
    actions.append(preview);
    const archives = [...new Map(data.parts.map(part => [part.ref, part.location])).entries()];
    for (const [ref, location] of archives.slice(0, 3)) {
      const show = node('button', 'Show ' + location.split('/').at(-1) + ' in the explorer');
      show.type = 'button';
      show.addEventListener('click', () => { dialog.close(); navigate?.('rpf:' + ref); });
      actions.append(show);
    }
    partsHost.append(actions);
  }

  function selectedRows() {
    return [...partsHost.querySelectorAll('input[type=checkbox]:checked')].map(box => Number(box.dataset.rowIndex));
  }

  async function assemble(trigger) {
    const rows = selectedRows();
    if (!rows.length) return say('Choose at least one part.', true);
    trigger.disabled = true;
    clearPreview();
    say('Assembling ' + rows.length + ' parts and resolving their textures…');
    const mine = ++ticket;
    try {
      const variants = {};
      for (const choice of partsHost.querySelectorAll('select[data-row-index]')) variants[choice.dataset.rowIndex] = Number(choice.value);
      const output = await lib('assemble-character', { prefix: current.prefix, rows, variants });
      if (mine !== ticket) return;
      say();
      let result = output.result;
      let save;
      if (output.single) {
        const preview = await window.opensix.request('/api/preview?' + new URLSearchParams({ archive: output.single.archive, entry: String(output.single.entry) }));
        result = preview;
      }
      save = filename => window.opensix.savePreview(result.id, filename, current.prefix).then(name => { if (name) say('Saved ' + name + '.'); },
        error => say(error.message, true));
      const meta = node('p', result.triangles?.toLocaleString() + ' triangles from ' + (output.parts?.length ?? 1) + ' parts', 'quiet');
      previewHost.append(meta);
      dispose = renderAsset(previewHost, { ...result, items: [], lods: [] }, () => {}, save, error => say(error.message, true), () => {}, () => {});
    } catch (error) { say(error.message, true); }
    finally { trigger.disabled = false; }
  }

  let typing;
  el('character-query').addEventListener('input', event => {
    clearTimeout(typing);
    typing = setTimeout(() => loadList(event.target.value), 200);
  });
  el('close-character').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearPreview(); ticket++; });

  return {
    async open(prefix = null, query = '') {
      el('character-query').value = query;
      say();
      clearPreview();
      partsHost.replaceChildren();
      dialog.showModal();
      await loadList(query);
      if (prefix) await choose(prefix);
    },
  };
}
