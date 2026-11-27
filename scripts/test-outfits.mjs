// Tests for outfit selection, slot rules, kit expansion and tint palettes. Run: node --test scripts/test-outfits.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { partGroup, partItem } from '../app/characters.mjs';
import { defaultOutfitId, describeOutfit, pickLook, signature } from '../app/outfit-look.mjs';
import { DEFAULT_TINT_PALETTE, expandKit, outfitRoots, wornState } from '../app/wardrobe-catalog.mjs';
import { decodePng, encodePng, samplePalette, tintWithPalette } from '../app/ped-finish.mjs';

const item = (label, rowIndex = 1) => ({ label, group: partGroup(label), rowIndex });

test('slot words come from the token before the fit tag', () => {
  assert.equal(partItem('cs_jason_haircaesar_mr1_000_straight_l02_non_sf_n_full'), 'haircaesar');
  assert.equal(partGroup('cs_jason_haircaesar_mr1_000_straight_l02_non_sf_n_full'), 'hair');
  assert.equal(partGroup('shoescanvas_mr1_001_low_fh_full'), 'feet');
  assert.equal(partGroup('shortscargo_mr1_001_regular_mw_long_full'), 'bottom');
  assert.equal(partGroup('tshirtcrewneck_mr1_012_regular_cc_un_short_full'), 'top');
  assert.equal(partGroup('s01_watchsports_mr1_000_regular_ws00_full'), 'watch');
  assert.equal(partGroup('head_mr1_cau_000_m_eyes'), 'head eyes');
});

test('a bracelet is not a bra', () => {
  assert.equal(partGroup('braceletchain_fr1_004_small_ws00_full'), 'wrist');
  assert.equal(partGroup('brabalcony_fr1_000_regular_ws00_full'), 'top');
  assert.equal(partGroup('brasports_fr1_000_regular_ws00_full'), 'top');
});

test('the look takes one garment per slot, skipping helpers and alternatives', () => {
  const look = pickLook([
    item('invisible_brabalcony_fr1_000_regular_ws00_full', 1), item('hiddenpoly_fr1_001_regular_ws00_full', 2),
    item('tshirtcrewneck_mr1_012_regular_cc_un_short_alt_00', 3), item('tshirtcrewneck_mr1_012_regular_cc_un_short_full', 4),
    item('pantsjeans_mr1_014_slim_mw_long_holsterright_alt_00', 5), item('pantsjeans_mr1_014_slim_mw_long_full', 6),
    item('shoessneakers_mr1_018_low_fh_full', 7), item('s01_watchsports_mr1_000_regular_ws00_full', 8),
    item('chesthairfull_mr1_003_curly_regular_full', 9), item('hatcapcasual_mr1_008_regular_ws00_full', 10),
  ]).map(entry => entry.rowIndex);
  assert.deepEqual(look, [4, 6, 7, 10]);
});

test('an alternative is worn when a garment has no plain version', () => {
  const look = pickLook([item('pantsjeans_mr1_014_slim_mw_long_alt_00', 1)]);
  assert.equal(look.length, 1);
});

test('a full-body piece replaces the top and bottom', () => {
  const look = pickLook([item('tshirtcrewneck_mr1_012_regular_cc_un_short_full', 1), item('pantsjeans_mr1_014_slim_mw_long_full', 2), item('dressmini_fr1_000_slim_high_full', 3)]);
  assert.deepEqual(look.map(entry => entry.rowIndex), [3]);
});

test('outfits are described by their main garments', () => {
  assert.equal(describeOutfit([item('tshirtcrewneck_mr1_012_regular_cc_un_short_full'), item('shortscargo_mr1_001_regular_mw_long_full'), item('shoescanvas_mr1_001_low_fh_full')]),
    'tshirtcrewneck · shortscargo · shoescanvas');
  assert.equal(describeOutfit([item('beardstubble_mr1_000_straight_l02_m_full')]), 'body only');
});

test('the default outfit is a dressed look that the game defines most often', () => {
  const dressed = [item('tshirtcrewneck_mr1_012_regular_cc_un_short_full'), item('shortscargo_mr1_001_regular_mw_long_full'), item('shoescanvas_mr1_001_low_fh_full')];
  const underwear = [item('undiesboxers_mr1_000_compression_lw_full'), item('hairflow_mr1_000_wavy_l05_non_non_m_full')];
  const outfits = [
    { id: 1, items: underwear }, { id: 2, items: underwear }, { id: 3, items: underwear },
    { id: 4, items: [item('hoodiepullover_mr1_000_regular_cc_un_long_full'), item('pantscargo_mr1_000_regular_mw_long_full'), item('shoescanvas_mr1_001_low_fh_full')] },
    { id: 5, items: dressed }, { id: 6, items: dressed },
  ];
  assert.equal(defaultOutfitId(outfits), 5, 'the repeated dressed look, not the repeated underwear');
  assert.equal(signature(dressed), 'shoescanvas|shortscargo|tshirtcrewneck');
  assert.equal(defaultOutfitId([{ id: 9, items: underwear }]), 9, 'with no dressed look, any outfit');
  assert.equal(defaultOutfitId([]), null);
});

// ----- kit expansion and worn state on a small synthetic catalogue -----
const ZERO = '0000000000000000';
const state = (id, drawable = ZERO, albedo = ZERO) => ({ id, drawable, albedo, normal: ZERO, extra: ZERO });
const preset = (id, parent, states, tints = [255, 255, 255], palette = 0, drawables = []) => ({ id, parent, states, tints, palette, drawables, category: 0 });
function catalogue() {
  const presets = new Map([
    [10, preset(10, 0, [state(7, 'aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb')], [0, 0, 0])],
    [11, preset(11, 10, [], [255, 255, 255])], // inherits state and tint from 10 (unset), so no tint at all
    [12, preset(12, 0, [state(7, 'cccccccccccccccc')], [100, 0, 157], 0xa7c8d8e0)],
    [13, preset(13, 12, [], [255, 255, 255])], // inherits the tint of 12
    [14, preset(14, 0, [state(7, 'dddddddddddddddd')], [19, 19, 19], 0)], // names no palette
    [15, preset(15, 0, [], [255, 255, 255], 0, [0x1234])], // a face: lists its drawable by name hash
  ]);
  const kits = [
    { id: 100, members: [{ child: 10, state: 7 }, { child: 101, state: 0 }] },
    { id: 101, members: [{ child: 12, state: 7 }, { child: 13, state: 7 }] },
    { id: 102, members: [{ child: 14, state: 7 }, { child: 15, state: 7 }, { child: 100, state: 0 }] },
    { id: 103, members: [{ child: 999, state: 7 }] },
  ];
  return { presets, kits };
}

test('outfits are the kits that no other kit contains, and kits nest', () => {
  const catalog = catalogue();
  assert.deepEqual(outfitRoots(catalog).map(kit => kit.id), [102, 103]);
  const entries = expandKit(catalog, catalog.kits[2]).map(entry => entry.preset.id);
  assert.deepEqual(entries, [14, 15, 10, 12, 13], 'kit 102 expands kit 100, which expands kit 101');
  assert.deepEqual(expandKit(catalog, catalog.kits[3]), [], 'a member that is neither preset nor kit is ignored');
});

test('a kit that contains itself does not loop', () => {
  const catalog = catalogue();
  catalog.kits.push({ id: 200, members: [{ child: 201, state: 0 }] }, { id: 201, members: [{ child: 200, state: 0 }, { child: 10, state: 7 }] });
  assert.deepEqual(expandKit(catalog, catalog.kits.at(-2)).map(entry => entry.preset.id), [10]);
});

test('the worn state takes missing values from the parents and resolves the tint chain', () => {
  const catalog = catalogue();
  const inherited = wornState(catalog, catalog.presets.get(11), 7);
  assert.equal(inherited.drawable, 'aaaaaaaaaaaaaaaa');
  assert.equal(inherited.albedo, 'bbbbbbbbbbbbbbbb');
  assert.equal(inherited.tint, null, 'every item up the chain is unset (255 or 0)');
  const tinted = wornState(catalog, catalog.presets.get(13), 7);
  assert.deepEqual(tinted.tint, { palette: 0xa7c8d8e0, rows: [100, 0, 157], item: 12 });
  const defaulted = wornState(catalog, catalog.presets.get(14), 7);
  assert.equal(defaulted.tint.palette, DEFAULT_TINT_PALETTE, 'a tint that names no palette uses the default palette');
  const face = wornState(catalog, catalog.presets.get(15), 7);
  assert.equal(face.drawable, ZERO);
  assert.deepEqual(face.names, [0x1234], 'a preset can list its drawables by name hash');
});

// ----- tint palettes -----
function palette() {
  // 64 x 4, row r ramps its red channel from r*10 at texel 2 to r*10+53 at texel 55; green is the row, blue is 7.
  const width = 64, height = 4, rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    rgba[o] = Math.min(255, y * 10 + Math.min(Math.max(x, 2), 55) - 2); rgba[o + 1] = y; rgba[o + 2] = 7; rgba[o + 3] = 255;
  }
  return { width, height, rgba };
}

test('a palette row is sampled along its ramp at the shade', () => {
  const p = palette();
  assert.deepEqual(samplePalette(p, 1, 0), [10, 1, 7]);
  assert.deepEqual(samplePalette(p, 1, 255), [63, 1, 7]);
  assert.deepEqual(samplePalette(p, 2, 128), [47, 2, 7]);
  assert.deepEqual(samplePalette(p, 99, 0), [30, 3, 7], 'a row past the end clamps to the last row');
});

test('a shade map is coloured by the green channel and written as a PNG', () => {
  const p = palette();
  const shade = { width: 2, height: 1, channels: 4, data: Buffer.from([255, 0, 9, 128, 255, 255, 9, 128]) };
  const png = tintWithPalette(shade, p, 1);
  const back = decodePng(png);
  assert.equal(back.width, 2);
  assert.deepEqual([...back.data.subarray(0, 3)], [10, 1, 7]);
  assert.deepEqual([...back.data.subarray(3, 6)], [63, 1, 7]);
});

test('PNG files round-trip', () => {
  const rgb = Buffer.from(Array.from({ length: 3 * 4 * 3 }, (_, i) => (i * 37) & 255));
  const back = decodePng(encodePng(4, 3, rgb));
  assert.equal(back.width, 4);
  assert.equal(back.height, 3);
  assert.deepEqual([...back.data], [...rgb]);
});
