# Build OpenSix

## Requirements

- Windows x64 and PowerShell 7.3 or later
- Git
- Node.js 24 and npm
- Rust for `x86_64-pc-windows-msvc` (tested with Rust 1.100.0)
- Visual Studio Build Tools with the Desktop development with C++ workload and a Windows SDK
- CMake 3.24 or later and Ninja

The first build downloads dependencies from GitHub, crates.io, and npm. You can build the app before supplying any archives.

## Build and run

From the checkout root, run the following in an x64 Visual Studio Developer PowerShell with CMake and Ninja on `PATH`.

```powershell
.\scripts\build.ps1
npm --prefix app start
```

The build checks out the pinned SixNG revision under `.deps/sixng`, applies the preview API patch, and builds the Rust worker with Cargo's lockfile. It builds the FBX converter from the pinned Assimp checkout under `.deps/assimp`, applies a fix for multi-layer UV data, and bundles the license notices. It installs the locked desktop dependencies, downloads the matching Electron runtime, and generates the viewer bundle and Windows icons.

To build a portable Windows executable locally, run the script with `-Portable`. The result is `app/release/OpenSix.exe`. Local builds are unsigned by default and are separate from the project's release artifacts.

## Project layout

| Directory | Contents |
| --- | --- |
| `app/` | Desktop window, archive reader, path index, and viewers |
| `native/preview/` | Rust worker for model, texture, and audio previews |
| `native/fbx/` | Windows GLB-to-FBX converter with embedded textures |
| `third_party/sixng/` | Local SixNG changes and upstream license |
| `scripts/` | Windows build entry point |

Test archive and viewer changes with local files that you can use. For portability checks, copy the built executable into an empty directory and launch it from there. Verify browsing, extraction, and the affected previews with the matching build.
