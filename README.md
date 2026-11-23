<h1><img src="app/icon.svg" alt="" width="66" align="middle"> OpenSix</h1>

OpenSix is a Windows desktop utility for browsing and extracting RPF9 archives from a supported Grand Theft Auto VI Scarlett development build. Open an archive, follow its nested archives, and inspect entries without launching the game. OpenSix opens archive files read-only.

![OpenSix showing the contents of a sample RPF9 archive and a heightmap preview](docs/images/archive-browser.png)

*Archive browser and heightmap viewer with a synthetic RPF9 sample.*

## Archive browser

- Open one RPF9 archive or scan a local folder for archives. Navigate into nested archives directly from the file list.
- Search entries by path or hash. OpenSix looks for filenames in local files and accepts a plain-text path list. Entries without a verified name stay accessible by hash.
- Extract a decoded file or save its stored bytes for inspection.
- Preview supported drawable models, fragments, and drawable dictionaries in 3D, with GLB export. Browse supported texture dictionaries and export PNGs.
- Play supported Opus and PCM audio bank streams and export tracks. Inspect text, hex, common image formats, and supported heightmaps alongside the archive directory.

## Compatibility

| Component | Current support |
| --- | --- |
| OpenSix | Windows x64 |
| Game build | One known GTA VI build for Xbox Series X\|S (Scarlett). OpenSix checks the executable's SHA-256 before opening an archive. |
| Archives | RPF9 and supported nested RPF9 entries. Archive replacement and repacking are unavailable. |
| Models | Supported `.zdr` drawables, `.zft` fragments, and `.zdd` drawable dictionaries. Geometry and material coverage varies by asset. |
| Textures | Supported `.ztd` texture dictionaries and mip levels. |
| Audio | Recognized ADAT banks. Opus and PCM playback for supported streams. XMA2 export is available for supported streams. |

Other builds, archive revisions, and resource variants require separate verification. Incomplete archives may fail to open. Any path names OpenSix cannot verify stay listed by hash. See the [compatibility notes](docs/compatibility.md) for the executable fingerprint and preview limits.

## Getting started

This is a source release. Build OpenSix on Windows using the [build instructions](docs/build.md). Bring your own local archive and compatible executable files.

1. Start the desktop app and select **Open archive**.
2. Browse to the matching Scarlett executable, then choose an RPF9 file or a folder of archives.
3. Select an entry to inspect its metadata and preview. Use **Open nested archive** when the entry contains an archive.
4. Choose **Extract file** to save decoded data. Choose **Save stored bytes** to keep the archive representation.

To match additional names, use **Import paths** with one candidate path per line. OpenSix checks candidates against the available archive hashes before displaying a resolved path.

## Development

See [Build OpenSix](docs/build.md) for the pinned decoder and Windows toolchain. [Contributing](CONTRIBUTING.md) describes what to include in a format or compatibility report.

The native preview worker uses [SixNG](https://github.com/holdmysocks/SixNG). The desktop app uses [Electron](https://www.electronjs.org/) and [Three.js](https://threejs.org/). The archive workflow takes its cues from [OpenIV](https://openiv.com/).

## Licensing

OpenSix's own source is publicly viewable. The copyright holder reserves the rights to that code. Third-party components remain under their respective licenses. SixNG and the modifications to SixNG are covered by [GPL-3.0-only](third_party/sixng/COPYING).

OpenSix is an independent project. Grand Theft Auto and Rockstar Games are marks of their respective owners.
