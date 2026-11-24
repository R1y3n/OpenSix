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

The texture-pool worker loads a BCPack library built from VIctory revision `d2a4bae1f49533ef5cb512fd1b1ba1513f2e1989`. The portable EXE includes this library and opens it automatically. A source checkout can supply the verified BCPack table file. A portable build reads the table file from beside `OpenSix.exe` or from the absolute path in `OPENSIX_BCPACK_TABLES`. The table file has its own terms. See [VIctory's asset policy](https://github.com/Marvisak/VIctory/blob/d2a4bae1f49533ef5cb512fd1b1ba1513f2e1989/docs/asset-policy.md).

Use `node app/cli.mjs --help` for JSON Lines archive search and batch extraction from a source checkout.
Use `OpenSix.exe --cli search` with `--report` and an absolute path to a new output file when running from the portable launcher.

To play XMA2 streams, make FFmpeg available on `PATH` or set `OPENSIX_FFMPEG` to its absolute path. To preview Bink movies, place `Tools/bink-player.exe` from rpf9-explorer v1.3 next to the portable OpenSix executable or set `OPENSIX_BINK_PLAYER` to its absolute path. OpenSix verifies the helper's SHA-256. Bink preview frames are streamed through memory.

To build a portable Windows executable locally, run the script with `-Portable`. The result is `app/release/OpenSix.exe`. The build is unsigned unless a signing configuration is supplied.

## Component licenses

The [OpenSix license](../LICENSE) covers the original desktop app under its noncommercial terms. The bundled SixNG preview worker and texture-pool worker with the VIctory BCPack library are GPL-3.0-only. Their corresponding source is available alongside the executable on the release page. See the [SixNG source notes](../third_party/sixng/README.md) and [rpf9-explorer notices](../third_party/rpf9-explorer/NOTICE.md).

## Project layout

| Directory | Contents |
| --- | --- |
| `app/` | Desktop window, archive reader, path index, and viewers |
| `native/preview/` | Rust worker for model, texture, and audio previews |
| `native/bcpack/` | VIctory BCPack library loaded by the texture-pool worker |
| `native/fbx/` | Windows GLB-to-FBX converter with embedded textures |
| `native/texture-pools/` | Self-contained TTPF and wardrobe catalog reader |
| `third_party/sixng/` | Local SixNG changes and upstream license |
| `third_party/rpf9-explorer/` | Pinned reader changes and component notices |
| `scripts/` | Windows build entry point |

Test archive and viewer changes with local files that you can use. For portability checks, copy the built executable into an empty directory and launch it from there. Verify browsing, extraction, and the affected previews with the matching build.
