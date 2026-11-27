// Finishing an assembled ped model: skin tone for the shared body parts and a fabric colour for garments that the game
// colours at run time. The colours are baked into textures, not left as material colour factors, because many viewers
// and the FBX format show only the texture.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { previewFolder } from './asset-preview.mjs';

export const skinGroups = new Set(['hands', 'feet skin']);

export const tintableGroups = new Set(['top', 'outer', 'bottom', 'full', 'feet', 'hat', 'gloves']);

// Most clothing in the catalogue stores no colour: the game sets it at run time. These are colours to choose from.
export const fabricColours = {
  list: [
    { id: 'game', name: 'From the outfit', rgb: null },
    { id: 'natural', name: 'Natural (fabric shade)', rgb: null },
    { id: 'denim', name: 'Denim blue', rgb: [78, 104, 148] },
    { id: 'black', name: 'Black', rgb: [34, 34, 36] },
    { id: 'charcoal', name: 'Charcoal', rgb: [78, 80, 84] },
    { id: 'grey', name: 'Grey', rgb: [140, 142, 146] },
    { id: 'white', name: 'White', rgb: [226, 224, 218] },
    { id: 'navy', name: 'Navy', rgb: [38, 52, 96] },
    { id: 'brown', name: 'Brown', rgb: [96, 64, 40] },
    { id: 'tan', name: 'Tan', rgb: [176, 142, 100] },
    { id: 'olive', name: 'Olive', rgb: [88, 94, 54] },
    { id: 'red', name: 'Red', rgb: [150, 40, 38] },
  ],
  defaultFor: label => (/^(pantsjeans|shortsjeans)/.test(label) ? 'denim' : 'natural'),
};

const toLinear = value => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toSrgb = linear => {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

// ----- PNG reading and writing (8-bit, not interlaced), enough for the decoder's texture files -----
export function decodePng(buffer) {
  if (buffer.length < 33 || buffer.toString('latin1', 1, 4) !== 'PNG') throw new Error('Not a PNG file.');
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const data = [];
  for (let at = 8; at + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; color = body[9]; interlace = body[12];
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color];
  if (!channels || depth !== 8 || interlace !== 0 || !width || !height) throw new Error('Unsupported PNG layout.');
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y ? out[(y - 1) * stride + x] : 0;
      const corner = y && x >= channels ? out[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner;
        const dl = Math.abs(estimate - left), du = Math.abs(estimate - up), dc = Math.abs(estimate - corner);
        value += dl <= du && dl <= dc ? left : du <= dc ? up : corner;
      }
      out[y * stride + x] = value & 255;
    }
  }
  return { width, height, channels, data: out };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buffer => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// An opaque 8-bit RGB PNG.
export function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The typical skin colour of a face texture: the average of the middle band of its brightness range, which leaves out
// eyes, brows, lips and any dark or bright details. Returns sRGB bytes.
export function typicalColour(image) {
  const { width, height, channels, data } = image;
  const count = width * height;
  const luma = new Float32Array(count);
  const valid = new Uint8Array(count);
  const bins = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const o = i * channels;
    const [r, g, b] = channels >= 3 ? [data[o], data[o + 1], data[o + 2]] : [data[o], data[o], data[o]];
    if (channels === 4 && data[o + 3] < 128) continue;
    luma[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    valid[i] = 1;
    bins[Math.min(255, Math.round(luma[i]))]++;
    total++;
  }
  if (!total) return null;
  const quantile = fraction => { let run = 0; for (let v = 0; v < 256; v++) { run += bins[v]; if (run >= total * fraction) return v; } return 255; };
  const low = quantile(0.3), high = quantile(0.7);
  const sum = [0, 0, 0];
  let used = 0;
  for (let i = 0; i < count; i++) {
    if (!valid[i] || luma[i] < low || luma[i] > high) continue;
    const o = i * channels;
    for (let k = 0; k < 3; k++) sum[k] += channels >= 3 ? data[o + k] : data[o];
    used++;
  }
  return used ? sum.map(value => Math.round(value / used)) : null;
}

// A texture multiplied by a colour, in linear light. Returns an encoded PNG.
export function tintTexture(image, rgb) {
  const { width, height, channels, data } = image;
  const factor = rgb.map(toLinear);
  const tables = [0, 1, 2].map(k => Uint8Array.from({ length: 256 }, (_, v) => toSrgb(toLinear(v) * factor[k])));
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    for (let k = 0; k < 3; k++) out[i * 3 + k] = tables[k][data[i * channels + (channels >= 3 ? k : 0)]];
  }
  return encodePng(width, height, out);
}

// ----- tint palettes -----
// A palette is a 64 x 256 sRGB image. Each row is one colour as a dark-to-light ramp in texels 2 to 55. A garment without a
// colour texture has a shade map (green channel); its colour is the palette row of its tint at that shade.
const RAMP_START = 2, RAMP_END = 55;

export function samplePalette(palette, row, shade) {
  const y = Math.min(row, palette.height - 1);
  const x = RAMP_START + (shade * (RAMP_END - RAMP_START)) / 255;
  const x0 = Math.floor(x), f = x - x0;
  const at = column => (y * palette.width + Math.min(column, palette.width - 1)) * 4;
  const a = at(x0), b = at(x0 + 1);
  return [0, 1, 2].map(k => Math.round(palette.rgba[a + k] + (palette.rgba[b + k] - palette.rgba[a + k]) * f));
}

// The shade map coloured through a palette row. Returns an encoded PNG.
export function tintWithPalette(image, palette, row) {
  const { width, height, channels, data } = image;
  const lut = Array.from({ length: 256 }, (_, shade) => samplePalette(palette, row, shade));
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const colour = lut[channels >= 2 ? data[i * channels + 1] : data[i * channels]];
    out[i * 3] = colour[0]; out[i * 3 + 1] = colour[1]; out[i * 3 + 2] = colour[2];
  }
  return encodePng(width, height, out);
}

// ----- GLB reading and writing -----
function readGlb(path) {
  const file = readFileSync(path);
  if (file.toString('latin1', 0, 4) !== 'glTF') throw new Error('Invalid model.');
  const length = file.readUInt32LE(12);
  const at = 20 + length;
  const binLength = file.readUInt32LE(at);
  return { json: JSON.parse(file.toString('utf8', 20, at).trimEnd()), bin: file.subarray(at + 8, at + 8 + binLength) };
}

function writeGlb(path, json, bin) {
  const text = Buffer.from(JSON.stringify(json));
  const chunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 32)]);
  const header = Buffer.alloc(20);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + chunk.length + 8 + bin.length, 8);
  header.writeUInt32LE(chunk.length, 12);
  header.write('JSON', 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.write('BIN\0', 4, 'latin1');
  writeFileSync(path, Buffer.concat([header, chunk, binHeader, bin]));
}

// Materials used by the meshes under the nodes whose name starts with `<part>/`.
function partMaterials(json, name) {
  const parent = new Map();
  json.nodes.forEach((node, index) => (node.children ?? []).forEach(child => parent.set(child, index)));
  const prefix = name.toLowerCase() + '/';
  const found = new Set();
  json.nodes.forEach((node, index) => {
    if (node.mesh === undefined) return;
    for (let at = index; at !== undefined; at = parent.get(at)) {
      if ((json.nodes[at].name ?? '').toLowerCase().startsWith(prefix)) {
        for (const primitive of json.meshes[node.mesh].primitives) if (primitive.material !== undefined) found.add(primitive.material);
        break;
      }
    }
  });
  return [...found];
}

function readInside(folder, name) {
  const path = resolve(folder, name);
  const inside = relative(folder, path);
  if (!inside || inside.startsWith('..' + sep) || inside === '..' || isAbsolute(inside)) throw new Error('Texture path exceeds the preview directory.');
  return readFileSync(path);
}

// `head`: the head's albedo key, whose texture gives the skin tone. `skin`: names of the shared arms, hands, legs and feet,
// whose materials bind no colour texture and would show flat grey. `fabrics`: [{ name, colour }] for garments to colour.
// Returns what was applied. The model is left as it was when nothing applies or the preview is gone.
export function finishAssembly(id, { head = null, skin = [], fabrics = [], palettes = null } = {}) {
  const folder = previewFolder(id);
  const applied = { skinTone: null, fabricColours: [] };
  if (!folder) return applied;
  const path = join(folder, 'model.glb');
  if (!existsSync(path)) return applied;
  let model;
  try { model = readGlb(path); } catch { return applied; }
  const { json } = model;
  const added = [];
  let size = model.bin.length;
  const addTexture = png => {
    const padding = (4 - (png.length % 4)) % 4;
    json.bufferViews.push({ buffer: 0, byteOffset: size, byteLength: png.length });
    (json.images ??= []).push({ bufferView: json.bufferViews.length - 1, mimeType: 'image/png' });
    (json.textures ??= []).push({ source: json.images.length - 1 });
    added.push(png, Buffer.alloc(padding));
    size += png.length + padding;
    return json.textures.length - 1;
  };
  const setTexture = (material, index) => {
    const pbr = material.pbrMetallicRoughness ??= {};
    pbr.baseColorTexture = { ...(pbr.baseColorTexture ?? {}), index };
    delete pbr.baseColorFactor;
  };
  let tone = null;
  if (head) {
    try { tone = typicalColour(decodePng(readInside(folder, join('textures', 'ttpf', head + '.png')))); } catch { tone = null; }
  }
  if (tone) {
    let solid = null;
    for (const name of skin) {
      for (const index of partMaterials(json, name)) {
        const material = json.materials[index];
        if (material.pbrMetallicRoughness?.baseColorTexture) continue;
        solid ??= addTexture(encodePng(4, 4, Buffer.from(Array.from({ length: 16 }, () => tone).flat())));
        setTexture(material, solid);
        applied.skinTone = tone;
      }
    }
  }
  for (const { name, colour, tint } of fabrics) {
    const choice = fabricColours.list.find(item => item.id === colour);
    // The colour the outfit gives the garment: its palette at its tint row. Tint 0 is off at 255. Only the first of the
    // three tints is applied, because how the shade map's other channels select the others is not decoded.
    const palette = colour === 'game' && tint && tint.rows[0] !== 255 ? palettes?.get(tint.palette) : null;
    if (!palette && !choice?.rgb) continue;
    for (const index of partMaterials(json, name)) {
      const material = json.materials[index];
      // A material with a colour texture keeps it: the colour is only for garments that have the shade map alone.
      const shade = material.extras?.ped_tint?.png;
      if (!shade || material.extras.wardrobe?.albedo) continue;
      try {
        const source = palette ? material.extras.ped_tint.shade_texture ?? shade : shade;
        const image = decodePng(readInside(folder, source));
        setTexture(material, addTexture(palette ? tintWithPalette(image, palette, tint.rows[0]) : tintTexture(image, choice.rgb)));
      } catch { continue; }
      applied.fabricColours.push({ part: name, colour: palette ? 'game' : choice.id });
    }
  }
  if (added.length) {
    json.buffers[0].byteLength = size;
    writeGlb(path, json, Buffer.concat([model.bin, ...added]));
  }
  return applied;
}
