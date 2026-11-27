// Group embedded drawable labels into assemblable characters.
// The grouping rules follow the naming scheme found in the game's own drawable labels:
// `<character prefix>_<item>_<fit>_...` where a fit tag looks like `mr1` or `fr1`.
// Nothing here invents names: every prefix and part comes from a label stored inside a drawable.

export const isFit = token => token.length === 3 && (token[0] === 'm' || token[0] === 'f') &&
  /[a-z]/.test(token[1]) && /[0-9]/.test(token[2]);

export function isAnimal(name) {
  return name.length > 4 && name.startsWith('cr') && /[a-z]/.test(name[2]) && name[3] === '_';
}

export function outfitPrefix(name) {
  const tokens = name.split('_');
  if (['char', 'fchar', 's01'].includes(tokens[0]) || isAnimal(name)) return null;
  const at = tokens.findIndex(isFit);
  if (at < 3) return null;
  return tokens.slice(0, at - 1).join('_');
}

const slots = [
  ['hair', 'hair'], ['beard', 'beard'], ['brows', 'brows'], ['lashes', 'lashes'], ['eyes', 'eyes'], ['teeth', 'teeth'],
  ['bodyupper', 'body upper'], ['bodylower', 'body lower'], ['fullbody', 'full'], ['dress', 'full'], ['jumpsuit', 'full'],
  ['overalls', 'full'], ['jacket', 'outer'], ['coat', 'outer'], ['blazer', 'outer'], ['cardigan', 'outer'],
  ['tshirt', 'top'], ['shirt', 'top'], ['sweatshirt', 'top'], ['hoodie', 'top'], ['tanktop', 'top'], ['blouse', 'top'],
  ['bra', 'top'], ['pants', 'bottom'], ['shorts', 'bottom'], ['skirt', 'bottom'], ['undies', 'bottom'],
  ['leggings', 'bottom'], ['boots', 'feet'], ['shoes', 'feet'], ['sneakers', 'feet'], ['sandals', 'feet'],
  ['heels', 'feet'], ['piercing', 'piercing'],
];
const accessories = [
  ['hat', 'hat'], ['cap', 'hat'], ['helmet', 'hat'], ['beanie', 'hat'], ['sunglasses', 'glasses'], ['glasses', 'glasses'],
  ['backpack', 'bag'], ['bag', 'bag'], ['watch', 'watch'], ['necklace', 'neck'], ['chain', 'neck'], ['earring', 'ears'],
  ['glove', 'gloves'], ['mask', 'mask'], ['bracelet', 'wrist'], ['anklet', 'ankle'],
];

const longest = (table, item) => table.filter(([word]) => item.startsWith(word))
  .reduce((best, entry) => (!best || entry[0].length > best[0].length ? entry : best), null)?.[1] ?? null;

// `bra` is a slot word, but bracelets are not bras.
function slotOf(item) { return item === 'head' ? 'head' : item.startsWith('bracelet') ? null : longest(slots, item); }

// Parts of one character prefix, grouped by outfit slot. The default look is one part per slot.
export function outfitOptions(parts, prefix) {
  const start = prefix + '_';
  const byName = new Map();
  for (const part of parts) {
    const name = part.name;
    if (!name.startsWith(start) || outfitPrefix(name) !== prefix) continue;
    const previous = byName.get(name);
    // One entry per name: the largest copy is the highest detail level.
    if (!previous || part.size > previous.size || (part.size === previous.size && part.rowIndex < previous.rowIndex)) byName.set(name, part);
  }
  const options = [];
  const chosen = new Map();
  for (const [name, part] of [...byName].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (['_cull', '_fp', 'eyecap', 'tattooprojection'].some(word => name.includes(word))) continue;
    const rest = name.slice(start.length);
    const item = rest.split('_')[0];
    const optional = name.includes('_alt_') || name.includes('holster');
    const slot = slotOf(item);
    let group;
    if (slot === 'head' && name.includes('_eyes')) group = 'head eyes';
    else if (slot === 'head' && name.includes('_earring')) group = 'head earring';
    else if (slot) group = slot;
    else group = longest(accessories, item) ?? item;
    if (!optional && slot && !chosen.has(group)) chosen.set(group, part.rowIndex);
    options.push({ ...part, group, label: rest, default: false });
  }
  // One garment per body area: a full-body piece replaces top and bottom, and an outer layer replaces the top under it
  // (two stacked garments overlap and show through each other).
  if (chosen.has('full')) { chosen.delete('top'); chosen.delete('bottom'); }
  if (chosen.has('outer')) chosen.delete('top');
  for (const option of options) option.default = chosen.get(option.group) === option.rowIndex;
  return options;
}

// The outfit slot of a drawable label (`cs_jason_haircaesar_mr1_000_…`, `shoescanvas_mr1_001_…`): the item word is the token
// before the fit tag, and the same slot rules as for a character's own parts apply.
export function partGroup(label) {
  const tokens = label.toLowerCase().split('_');
  const at = tokens.findIndex(isFit);
  const item = at > 0 ? tokens[at - 1] : tokens[0];
  const slot = slotOf(item);
  if (slot === 'head' && label.includes('_eyes')) return 'head eyes';
  if (slot === 'head' && label.includes('_earring')) return 'head earring';
  return slot ?? longest(accessories, item) ?? item;
}

// The item word of a label, for names in lists.
export function partItem(label) {
  const tokens = label.toLowerCase().split('_');
  const at = tokens.findIndex(isFit);
  return at > 0 ? tokens[at - 1] : tokens[0];
}

// ----- shared body skin -----
// Modular peds are dressed over shared base-body parts that carry no character prefix: `hand_<fit>_...` is the arms and
// hands, `feet_<fit>_...` the legs and feet. Garment-specific variants (`_tshirt_`, `_pants`, `_shorts`) leave out the
// skin that the garment covers, so they do not show through it.
export const fitOf = name => name.split('_').find(isFit) ?? null;

export const skinGroupNames = { hand: 'hands', feet: 'feet skin' };

export function isSkinName(name) {
  return /^(hand|feet)_[mf][a-z][0-9]_/.test(name) && !name.includes('_fp');
}

// `parts` are the skin drawables of one fit, one entry per name; `top` and `bottom` are the chosen default garments.
export function skinOptions(parts, top, bottom) {
  const options = parts.map(part => ({ ...part, group: skinGroupNames[part.name.split('_')[0]], label: part.name, default: false }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pick = (kind, preferences) => {
    const list = options.filter(option => option.name.startsWith(kind + '_'));
    for (const word of preferences) {
      const found = list.find(option => option.name.includes(word));
      if (found) return found;
    }
    return list.find(option => !option.name.includes('_cull')) ?? list[0] ?? null;
  };
  const sleeve = top?.label.split('_').find(token => ['long', 'short', 'cap', 'mid', 'non'].includes(token));
  const hands = pick('hand', sleeve && sleeve !== 'long' && sleeve !== 'non' ? ['_tshirt_', '_nude_full', '_full'] : ['_nude_full', '_full']);
  const bottomKind = bottom?.label.startsWith('shorts') ? '_shorts' : bottom?.label.startsWith('pants') ? '_pants' : null;
  const feet = pick('feet', bottomKind ? [bottomKind, '_nude_full', '_full'] : ['_nude_full', '_full']);
  for (const option of [hands, feet]) if (option) option.default = true;
  return options;
}

// A complete cutscene body and head pair ("legacy" ped parts) is the most self-contained look.
export function legacyLook(options) {
  const body = options.find(option => /^legacypedcs_/.test(option.label) && option.label.includes('_fullbody'));
  const head = options.find(option => /^legacyheadcs_/.test(option.label));
  return body && head ? [body.rowIndex, head.rowIndex] : null;
}

export function listCharacters(byPrefix) {
  const characters = [];
  for (const prefix of [...byPrefix.keys()].sort()) {
    const options = outfitOptions(byPrefix.get(prefix), prefix);
    if (!options.length) continue;
    characters.push({ prefix, parts: options.length, defaultParts: options.filter(option => option.default).length });
  }
  return characters;
}
