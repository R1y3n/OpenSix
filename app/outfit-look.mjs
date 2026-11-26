// Choosing what a character wears from the outfits of its own wardrobe kit.
// An outfit lists every garment of a look, including alternatives of the same garment (open, closed, with a holster). The
// default look takes one garment per outfit slot. Items are { label, group, rowIndex, … } in the kit's order.
import { partItem } from './characters.mjs';

// Body helpers that are not clothes: hidden polygons, anatomy and body hair (strands the game draws from a groom).
const HIDDEN = /^invisible_|hiddenpoly|genital|eyecap|nipple|chesthair|leghair|armpithair|bodyhair/;
const isAlternative = label => /_alt_|holster/.test(label);
const family = label => partItem(label);

// Items worn by default: hidden body helpers are left out, alternatives only when a garment has no plain version, and one
// garment per slot. A full-body piece replaces the top and bottom. A top and an outer layer can be worn together.
// Items that are authored relative to a bone (a watch is relative to the wrist) and that the exporter does not place yet.
const NOT_PLACED = new Set(['watch']);

export function pickLook(items) {
  const visible = items.filter(item => !HIDDEN.test(item.label) && !NOT_PLACED.has(item.group));
  const plain = visible.filter(item => !isAlternative(item.label));
  const usable = [...plain, ...visible.filter(item => isAlternative(item.label) && !plain.some(other => family(other.label) === family(item.label)))];
  const bySlot = new Map();
  for (const item of usable) if (!bySlot.has(item.group)) bySlot.set(item.group, item);
  if (bySlot.has('full')) { bySlot.delete('top'); bySlot.delete('bottom'); }
  return [...bySlot.values()];
}

// The garments an outfit is known by, as a sorted string: outfits with the same one are variants of one look.
export function signature(items) {
  return [...new Set(pickLook(items).map(item => family(item.label)))].sort().join('|');
}

// A short description for a list: the main garments in body order.
export function describeOutfit(items) {
  const look = new Map(pickLook(items).map(item => [item.group, item]));
  const words = ['full', 'outer', 'top', 'bottom', 'feet', 'hat'].map(group => look.get(group)).filter(Boolean).map(item => family(item.label));
  return words.length ? words.join(' · ') : 'body only';
}

// A dressed look: a full-body piece, or a top (or outer layer) with a bottom and shoes.
function isDressed(items) {
  const slots = new Set(pickLook(items).map(item => item.group));
  return slots.has('full') || ((slots.has('top') || slots.has('outer')) && slots.has('bottom') && slots.has('feet'));
}

// The outfit to show first: among the dressed looks, the one the game defines most often (the largest group of outfits with
// the same garments), and the first of that group in the kit. Some outfits are only underwear or swimwear.
export function defaultOutfitId(outfits) {
  const groups = new Map();
  const dressed = outfits.filter(outfit => isDressed(outfit.items));
  for (const outfit of dressed.length ? dressed : outfits) {
    const key = signature(outfit.items);
    (groups.get(key) ?? groups.set(key, []).get(key)).push(outfit);
  }
  let best = null;
  for (const group of groups.values()) if (!best || group.length > best.length) best = group;
  return best?.[0]?.id ?? null;
}
