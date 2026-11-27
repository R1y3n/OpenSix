// Reader for the wardrobe catalogue: presets (clothing items) with states (colour variants) and kits.
// A state names a drawable and the albedo, normal and extra texture keys that the game applies to it at run time.
// The layout follows the catalogue block structure used by the texture-pool worker's reader.
const TAG_DRAWABLES = 0x4bfd27dd, BASE_STATE = 0x44e21c90;
const ROOT = 0x8dcb4cf5, PRESET = 0xf795e8ba, STATE = 0x37e52277, KIT = 0xa9d57751, MEMBER = 0x67e54cb2;
const MAX_STATES = 262144, MAX_RECORDS = 65536;

function require(condition, message = 'Invalid wardrobe catalogue layout.') {
  if (!condition) throw new Error(message);
}

const hex16 = value => value.toString(16).padStart(16, '0');

export function hasWardrobeMarkers(bytes) {
  return bytes.includes(Buffer.from('f54ccb8d', 'hex')) || bytes.includes(Buffer.from('8dcb4cf5', 'hex'));
}

export function decodeWardrobeCatalog(data) {
  require(data.length >= 96 && data.length <= 64 * 1024 * 1024, 'Not a wardrobe catalogue.');
  const u16 = at => data.readUInt16LE(at), u32 = at => data.readUInt32LE(at), u64 = at => data.readBigUInt64LE(at);
  let blocks = [];
  let rootNumber;
  if (data.toString('ascii', 0, 4) === 'PSIN') {
    // The block table starts at byte 8. The blocks follow it, and the tagged sections (LSCH, LENM, LSNS, LGID, LRSC, CHKS)
    // follow the blocks as a tag, a length and a body.
    const entries = [];
    let at = 8;
    for (;;) {
      require(at <= data.length - 16);
      if (data.subarray(at, at + 8).every(byte => byte === 0x70)) { at += 8; break; }
      require(entries.length < MAX_RECORDS && data.subarray(at + 8, at + 16).every(byte => byte === 0xaa));
      const size = u32(at + 4);
      require(size <= 64 * 1024 * 1024);
      entries.push([u32(at), size]);
      at += 16;
    }
    require((at & 15) === 0);
    for (const [type, size] of entries) {
      require(at <= data.length - size);
      blocks.push({ type, offset: at, length: size });
      at = (at + size + 15) & ~15;
    }
    const sections = [];
    for (let position = at; position + 8 <= data.length;) {
      // The big-endian length counts the eight header bytes.
      const total = data.readUInt32BE(position + 4);
      require(total >= 8 && position + total <= data.length);
      sections.push({ tag: data.toString('ascii', position, position + 4), offset: position, length: total - 8 });
      position += total;
    }
    const resource = sections.find(section => section.tag === 'LRSC');
    require(resource && resource.length >= 0x20 && data.toString('ascii', resource.offset + 8, resource.offset + 12) === '0DRP' && u32(resource.offset + 12) === 122);
    rootNumber = u32(resource.offset + 24);
  } else {
    require(u64(0) === 0n && data.toString('ascii', 16, 20) === '0DRP' && u32(20) === 122 && u64(24) === 0n && u32(36) === 0);
    const count = u16(0x4c);
    require(count > 0);
    const system = (at, size) => {
      const value = u64(at);
      require(value >= 0x50000000n && value - 0x50000000n <= BigInt(data.length));
      const start = Number(value - 0x50000000n);
      require(size >= 0 && start <= data.length - size);
      return start;
    };
    const rows = system(0x38, count * 16);
    for (let i = 0; i < count; i++) {
      const row = rows + i * 16;
      const size = u32(row + 4);
      require(size <= 64 * 1024 * 1024);
      blocks.push({ type: u32(row), offset: system(row + 8, size), length: size });
    }
    rootNumber = u32(0x20);
  }
  require(rootNumber > 0 && rootNumber <= blocks.length && blocks[rootNumber - 1].type === ROOT && blocks[rootNumber - 1].length === 192);

  const internal = (value, size, type) => {
    const number = Number(value & 0xfffffn), relative = Number(value >> 20n);
    require(number > 0 && number <= blocks.length && size >= 0);
    const block = blocks[number - 1];
    require(block.type === type && relative <= block.length && size <= block.length - relative);
    return block.offset + relative;
  };
  // A pointer into a block of any type, for pools whose type depends on their size.
  const pointer = (value, size) => {
    const number = Number(value & 0xfffffn), relative = Number(value >> 20n);
    require(number > 0 && number <= blocks.length && size >= 0);
    const block = blocks[number - 1];
    require(relative <= block.length && size <= block.length - relative);
    return block.offset + relative;
  };
  const array = (at, type, stride) => {
    const count = u32(at), capacity = u32(at + 4);
    require(count <= capacity && capacity <= MAX_STATES);
    if (!count) return { at: 0, count: 0 };
    return { at: internal(u64(at + 8), count * stride, type), count };
  };

  const root = blocks[rootNumber - 1].offset;
  const presets = new Map();
  const kits = [];
  for (const bucket of [0, 48]) {
    const list = array(root + bucket + 8, PRESET, 88);
    for (let i = 0; i < list.count; i++) {
      const at = list.at + i * 88;
      const id = u32(at);
      const values = array(at + 8, STATE, 184);
      const states = [];
      for (let j = 0; j < values.count; j++) {
        const p = values.at + j * 184;
        states.push({ id: u32(p), drawable: hex16(u64(p + 8)), albedo: hex16(u64(p + 16)), normal: hex16(u64(p + 24)), extra: hex16(u64(p + 32)) });
      }
      // Some presets list the drawables they apply to by the joaat hash of the drawable name (tag 4bfd27dd).
      const drawables = [];
      const tags = [];
      const tagCount = data.readUInt16LE(at + 56);
      if (tagCount) {
        const tagAt = pointer(u64(at + 48), tagCount * 24);
        for (let k = 0; k < tagCount; k++) {
          const tag = tagAt + k * 24;
          const key = u32(tag), count = u32(tag + 8);
          const list = [];
          if (count) {
            const values = pointer(u64(tag + 16), count * 4);
            for (let v = 0; v < count; v++) list.push(u32(values + v * 4));
          }
          tags.push({ key, values: list });
          if (key === TAG_DRAWABLES) drawables.push(...list);
        }
      }
      presets.set(id, { id, parent: u32(at + 4), category: u32(at + 24), palette: u32(at + 28),
        tints: [data[at + 32], data[at + 33], data[at + 34]], states, drawables, tags });
    }
  }
  for (const bucket of [96, 144]) {
    const list = array(root + bucket + 8, KIT, 80);
    for (let i = 0; i < list.count; i++) {
      const at = list.at + i * 80;
      const values = array(at + 56, MEMBER, 8);
      const members = [];
      for (let j = 0; j < values.count; j++) members.push({ child: u32(values.at + j * 8), state: u32(values.at + j * 8 + 4) });
      kits.push({ id: u32(at), members });
    }
  }
  return { presets, kits };
}

const ZERO = '0000000000000000';

// Every state that names a drawable, with values inherited from parent presets where the state leaves them empty.
export function drawableVariants(catalog) {
  const byDrawable = new Map();
  for (const preset of catalog.presets.values()) {
    for (const state of preset.states) {
      let drawable = state.drawable, albedo = state.albedo, normal = state.normal, extra = state.extra;
      const seen = new Set([preset.id]);
      for (let current = catalog.presets.get(preset.parent), depth = 0; current && depth < 64 && !seen.has(current.id); current = catalog.presets.get(current.parent), depth++) {
        seen.add(current.id);
        const inherited = current.states.find(candidate => candidate.id === state.id);
        if (inherited) {
          if (drawable === ZERO) drawable = inherited.drawable;
          if (albedo === ZERO) albedo = inherited.albedo;
          if (normal === ZERO) normal = inherited.normal;
          if (extra === ZERO) extra = inherited.extra;
        }
        if (!current.parent) break;
      }
      if (drawable === ZERO) continue;
      const list = byDrawable.get(drawable) ?? byDrawable.set(drawable, []).get(drawable);
      list.push({ preset: preset.id, state: state.id, albedo, normal, extra, palette: preset.palette, tints: preset.tints });
    }
  }
  return byDrawable;
}

// State values of a preset with inheritance from its parents.
function effectiveState(catalog, preset, stateId) {
  let result = null;
  const seen = new Set();
  for (let current = preset, depth = 0; current && depth < 64 && !seen.has(current.id); current = catalog.presets.get(current.parent), depth++) {
    seen.add(current.id);
    const state = current.states.find(candidate => candidate.id === stateId);
    if (state) {
      result ??= { drawable: ZERO, albedo: ZERO, normal: ZERO, extra: ZERO };
      for (const key of ['drawable', 'albedo', 'normal', 'extra']) if (result[key] === ZERO) result[key] = state[key];
    }
    if (!current.parent) break;
  }
  return result;
}

// Face presets and any other preset that names its drawables by joaat: joaat -> the "base" texture pairs they apply.
export function taggedVariants(catalog) {
  const byName = new Map();
  for (const preset of catalog.presets.values()) {
    if (!preset.drawables.length) continue;
    const base = effectiveState(catalog, preset, BASE_STATE);
    if (!base || base.albedo === ZERO) continue;
    for (const hash of preset.drawables) {
      const list = byName.get(hash) ?? byName.set(hash, []).get(hash);
      list.push({ preset: preset.id, state: BASE_STATE, albedo: base.albedo, normal: base.normal, extra: base.extra, palette: preset.palette, tints: preset.tints });
    }
  }
  return byName;
}

// ----- outfits -----
// A character's own wardrobe kit (`<character>.zkit`) holds its outfits. A kit lists presets (garments, each with a state:
// which drawable and textures to wear) and other kits. The kits that no other kit contains are the complete outfits.
export const DEFAULT_TINT_PALETTE = 0x05317603; // joaat('ped_tint_vstation_generic'), used when the item that sets the tint names none

const unsetTint = tints => (tints[0] === 255 && tints[1] === 255 && tints[2] === 255) || (tints[0] === 0 && tints[1] === 0 && tints[2] === 0);

export function outfitRoots(catalog) {
  const byId = new Map(catalog.kits.map(kit => [kit.id, kit]));
  const inside = new Set();
  for (const kit of catalog.kits) for (const member of kit.members) if (byId.has(member.child)) inside.add(member.child);
  return catalog.kits.filter(kit => !inside.has(kit.id));
}

// Every (preset, state) of a kit, with the kits it contains expanded in place.
export function expandKit(catalog, kit, seen = new Set(), depth = 0) {
  if (seen.has(kit.id) || depth > 12) return [];
  seen.add(kit.id);
  const byId = catalog.kitsById ??= new Map(catalog.kits.map(item => [item.id, item]));
  const out = [];
  for (const member of kit.members) {
    const inner = byId.get(member.child);
    if (inner) out.push(...expandKit(catalog, inner, seen, depth + 1));
    else if (catalog.presets.has(member.child)) out.push({ preset: catalog.presets.get(member.child), state: member.state });
  }
  return out;
}

// What a preset wears in a state: the drawable (by archive hash, or by name hashes for presets that list them), its
// textures, and the tint. Values the state leaves empty come from the parent presets, as for drawableVariants.
export function wornState(catalog, preset, stateId) {
  let drawable = ZERO, albedo = ZERO, normal = ZERO, extra = ZERO;
  const seen = new Set();
  for (let current = preset, depth = 0; current && depth < 64 && !seen.has(current.id); current = catalog.presets.get(current.parent), depth++) {
    seen.add(current.id);
    const state = current.states.find(candidate => candidate.id === stateId);
    if (state) {
      if (drawable === ZERO) drawable = state.drawable;
      if (albedo === ZERO) albedo = state.albedo;
      if (normal === ZERO) normal = state.normal;
      if (extra === ZERO) extra = state.extra;
    }
    if (!current.parent) break;
  }
  // The tint comes from the first item up the chain whose bytes are neither "inherit" (255) nor "unset" (0).
  let tint = null;
  seen.clear();
  for (let current = preset, depth = 0; current && depth < 64 && !seen.has(current.id); current = catalog.presets.get(current.parent), depth++) {
    seen.add(current.id);
    if (!unsetTint(current.tints)) { tint = { palette: current.palette || DEFAULT_TINT_PALETTE, rows: [...current.tints], item: current.id }; break; }
    if (!current.parent) break;
  }
  const names = [];
  for (let current = preset, depth = 0; current && depth < 64; current = catalog.presets.get(current.parent), depth++) {
    if (current.drawables.length) { names.push(...current.drawables); break; }
    if (!current.parent) break;
  }
  return { drawable, albedo, normal, extra, tint, names };
}
