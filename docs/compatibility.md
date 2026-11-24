# Compatibility

## Executable

The current RPF9 reader expects one GTA VI Scarlett build. OpenSix checks the executable's file size and SHA-256 before reading its format tables. It reads the executable as data.

| Property | Expected value |
| --- | --- |
| Size | 120,181,760 bytes |
| SHA-256 | `e95020b2fa4a721db3df59fdecf75621730ac559d8835252f6c3b658d5a08993` |

To check a local copy in PowerShell, run `Get-FileHash -Algorithm SHA256 -LiteralPath '<path to executable>'`. Use the executable that belongs with the archives you are opening.

## Archive and preview limits

- Archive mounting checks the directory, entry bounds, expected minimum size for known archives, and allocated ranges when Windows reports them. A directory with missing payload bytes is insufficient.
- Filename matching uses available local path references and user-supplied candidates. The original name of every entry may not be recoverable. Hashes remain visible in the entry details and are searchable in the file list.
- The 3D viewer handles supported drawable resource variants, including supported LODs and some dictionary members. Material and texture coverage varies. Some drawable variants fail to produce renderable geometry.
- Supported `.zbn` collision bounds can be viewed in 3D and exported to GLB. `.zbd` variants still need sample coverage.
- Model previews can be exported as GLB or binary FBX. FBX embeds textures available in the preview and uses FBX material properties.
- Texture dictionaries expose supported textures and mip levels. Some descriptors and encodings cannot be decoded.
- Supported Opus and PCM streams play in the app. XMA2 has raw track export. Audio support varies by bank layout and codec.
- Some entries can only be saved as stored bytes when their compression or cipher is unsupported.
- The screenshot uses a generated RPF9 archive with synthetic data.
