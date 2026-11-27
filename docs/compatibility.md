# Compatibility

## Game build

OpenSix runs on Windows x64. Its RPF9 reader expects one GTA VI Scarlett build and checks the supplied executable before reading its format tables.

| Property | Expected value |
| --- | --- |
| Size | 120,181,760 bytes |
| SHA-256 | `e95020b2fa4a721db3df59fdecf75621730ac559d8835252f6c3b658d5a08993` |

Check a local copy with `Get-FileHash -Algorithm SHA256 -LiteralPath '<path to executable>'`. Use the executable that belongs with the archives.

## Formats

| Resource | What you can do |
| --- | --- |
| RPF9 | Open complete archives and directly stored nested archives, verify supported signed headers, extract decoded data, or save stored bytes. |
| `.zdr`, `.zft`, `.zdd` | View supported models, fragment children, dictionary members, materials, and detail levels. Export GLB or binary FBX. |
| `.zbn`, `.zbd` | Preview supported collision bounds and export the geometry. Coverage varies by bounds type. |
| `.zcd` | Inspect clip dictionaries, save JSON, and play supported clips on a compatible rig. |
| `.ztd`, `.ttpf` | Browse textures and mips, save PNG, and export DDS from supported TTPF layouts. VIctory provides additional BC5, BC6H, and BC7 coverage with its table file. |
| ADAT banks | Play and export supported Opus and PCM streams and music stems. Export XMA2 tracks or play them with FFmpeg. |
| Bink / Bink 2 | Built-in Bink 2 video playback and DCT audio track export. The local helper supports Bink 1 and synchronized audio. |
| 0DRP v122 and PSIN | Inspect structure and section information and save JSON reports. |
| MHIU, PNG, JPEG, GIF, WebP, WAV, Ogg | Preview supported heightmaps, images, and audio inside an archive. |
| Game folder explorer and search | Open the game folder, nested archives and texture pools in a tree, and search every archive entry and every texture pool entry by name, wildcard, hash, extension, format, size and embedded model label. The indexes are cached in `%APPDATA%OpenSix`. |
| Characters | Group model labels by character prefix, assemble the parts of a character on one skeleton and export GLB or FBX. A complete cutscene body and head, such as `cs_lucia` and `cs_jason`, has colour textures. |
| Tool menu | Cross-archive search and JSON index export, interactive MHIU terrain, typed PSIN, localization CSV and JSON, navigation GLB and FBX, map placement and weather reports, vehicle handling, groom and cloth OBJ, particle rules, and script XML for recognized records. |
| SGD5 shader records | Browse shader groups, members and effect links from a complete supported `shaders.rpf`. Extract decoded DXBC blocks. |
| Xbox GPU BVH | Inspect and export the verified sample tied to its matching drawable. Other BVH layouts need independent verification. |
| Unsigned RPF9 | Build a new archive from a local folder of regular files and reopen it in OpenSix. |
| GTA V resources | Convert placements to YMAP, OBJ to YDR or YBN, DDS to YTD and archetype JSON to YTYP. Target-game validation is separate from format verification. |

## Known limits

- Archive entry names are 64-bit hashes. OpenSix shows a path only when a hash matches a verified path or a model's own label. Most entries remain hash-only, and searches cannot match a name that the game data does not store.
- Texture pools have no names, so a texture is found by its key hash (the value a model material lists), its pool, format or size.
- Modular ped characters wear an outfit from their own wardrobe kit, over the shared hand and feet skin parts. Most garments store no colour texture, so their colour is the garment's tint through a ped tint palette (first tint only), and where an outfit names no tint the viewer offers a fabric colour that starts as the fabric's natural shade. The skin tone is the middle brightness band of the head texture, not a value from the game data. A watch is stored relative to the wrist bone and is not placed. Hairstyle parts are empty placeholders: the strands are in a compressed per-character groom file (.zcg with a .zcgc of 4 MB) whose format is not decoded (the .zcgc repeats the 64-bit key of its .zcg and does not follow the strand layout of the standalone grooms), and the standalone groom resources (40,019 zsm entries) are paired with drawables by name only for a few items such as eyelashes.

- Source archives open read-only. The writer creates new unsigned archives with regular file records. Signed retail repacking and resource replacement remain open.
- Paths are verified against the archive hashes. Two names in the local `common.rpf` audit, slots 243 and 316, remain unresolved after about 56 million candidate paths built from model labels, clip names, verified paths and terrain and water vocabulary. They are two `MHIU` heightmaps of about 1.2 MB with the same bounds. The executable holds one literal heightmap path (`common:/data/levels/americas/fallback_heightmap.dat`, an entry that is already named) and a generic loader that appends `.dat` to a stem it is given, so the stems of other heightmaps come from data, not from strings in the executable. The world heightmap that `americas.meta` names (`common:/data/levels/americas/heightmap.dat`) is not in any archive under its hash, and the water atlas names (`watersystemheightmap_gfb`) are texture names, not heightmaps. Their payloads can still be previewed and extracted.
- Texture and material coverage varies by asset. Some variants have no renderable preview, and some TTPF layouts expose a reduced mip chain.
- Model assembly uses the parts and texture sources you open. Wheel placement and wardrobe albedo and normal overrides are supported where the data can be resolved. Some authored materials still need more coverage.
- XMA2 playback, Bink 1 and synchronized Bink audio use the local helpers listed in the [usage guide](usage.md).
