# Build OpenSix

## Requirements

- Windows x64 and PowerShell 7.3 or later
- Git
- Node.js 24 and npm
- Rust for `x86_64-pc-windows-msvc` (tested with Rust 1.100.0)
- Visual Studio Build Tools with the Desktop development with C++ workload and a Windows SDK
- CMake 3.24 or later and Ninja
- .NET 10 SDK

The first build downloads dependencies from GitHub, crates.io, and npm. You can build the app before supplying any archives.

## Build and run

From the checkout root, run the following in an x64 Visual Studio Developer PowerShell with CMake and Ninja on `PATH`.

```powershell
.\scripts\build.ps1
npm --prefix app start
```

The build checks out the pinned SixNG revision under `.deps/sixng`, applies the preview API patch, and builds the Rust worker with Cargo's lockfile. It builds the FBX converter from the pinned Assimp checkout under `.deps/assimp`, applies a fix for multi-layer UV data, and bundles the license notices. It installs the locked desktop dependencies, downloads the matching Electron runtime, and generates the viewer bundle and Windows icons.

The texture-pool worker uses the pinned rpf9-explorer checkout under `.deps/rpf9-explorer`. The build publishes it as a self-contained Windows executable.

The BCPack fallback builds the GPLv3 decoder from the pinned VIctory checkout at `d2a4bae1f49533ef5cb512fd1b1ba1513f2e1989`. OpenSix checks the revision's BCPack table file before using it. Source runs read the file from the checkout. Portable runs can read it alongside `OpenSix.exe` or from the absolute path in `OPENSIX_BCPACK_TABLES`. The upstream project's asset policy identifies the table file as outside its code license, so the build includes the decoder and its license and loads the table separately.

Use `node app/cli.mjs --help` for JSON Lines archive search and batch extraction from a source checkout.
Use `OpenSix.exe --cli search` with `--report` and an absolute path to a new output file when running from the portable launcher.

To play XMA2 streams, make FFmpeg available on `PATH` or set `OPENSIX_FFMPEG` to its absolute path. To preview Bink movies, place `Tools/bink-player.exe` from rpf9-explorer v1.3 next to the portable OpenSix executable or set `OPENSIX_BINK_PLAYER` to its absolute path. OpenSix verifies the helper's SHA-256. Bink preview frames are streamed through memory.

To build a portable Windows executable locally, run the script with `-Portable`. The result is `app/release/OpenSix.exe`. Local builds are unsigned by default and are separate from the project's release artifacts.

## Project layout

| Directory | Contents |
| --- | --- |
| `app/` | Desktop window, archive reader, path index, and viewers |
| `native/preview/` | Rust worker for model, texture, and audio previews |
| `native/fbx/` | Windows GLB-to-FBX converter with embedded textures |
| `native/texture-pools/` | Self-contained TTPF and wardrobe catalog reader |
| `third_party/sixng/` | Local SixNG changes and upstream license |
| `third_party/rpf9-explorer/` | Pinned reader changes and component notices |
| `scripts/` | Windows build entry point |

Test archive and viewer changes with local files that you can use. For portability checks, copy the built executable into an empty directory and launch it from there. Verify browsing, extraction, and the affected previews with the matching build.
