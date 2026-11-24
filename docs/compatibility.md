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
| Bink / Bink 2 | Play and seek in supported movies with the local helper. |
| 0DRP v122 and PSIN | Inspect structure and section information and save JSON reports. |
| MHIU, PNG, JPEG, GIF, WebP, WAV, Ogg | Preview supported heightmaps, images, and audio inside an archive. |

## Known limits

- OpenSix reads archives in place. Archive editing, replacement, and repacking are outside the current feature set.
- Paths are verified against the archive hashes. Two names in the local `common.rpf` audit, slots 243 and 316, remain unresolved. Their heightmap payloads can still be previewed and extracted.
- Texture and material coverage varies by asset. Some variants have no renderable preview, and some TTPF layouts expose a reduced mip chain.
- Model assembly uses the parts and texture sources you open. Wheel placement and wardrobe albedo and normal overrides are supported where the data can be resolved. Wardrobe palettes and some authored materials still need more coverage.
- Supported XMA2 and Bink playback need their local helpers. The [usage guide](usage.md) lists the files and where to put them.
