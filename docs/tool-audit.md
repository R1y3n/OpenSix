# GTA VI tool audit

This compares OpenSix 1.2.0 with the catalog at revision `035c311`. The catalog supplies the project scope and upstream claims. The OpenSix column records what the Windows build exposes and where the work stops. Upstream runtime claims were reviewed as documentation. [Catalog snapshot](https://github.com/Ahmet-Dedeler/awesome-gta6-reverse-engineering/blob/035c3111188e818fe0ee347500e55cfb5f5a4c65/README.md)

The groom check recovered paired system and graphics blocks from `packs.rpf`, verified the original 16 MiB download piece, and exported 191 strands and 1,337 guide points. The script check opened a signed child archive in `script.rpf` and exported parseable XML with 17 elements. Unresolved XML tag names are retained as hashes.

## Archive and asset tools

| Project | What OpenSix covers and what remains |
| --- | --- |
| [PercyStar](https://github.com/rpatty-dev/PercyStar) | Signed RPF9 navigation, audio and Bink playback with the documented helper, typed PSIN, vehicle handling, terrain and tile-level navigation. Streaming a textured world and vehicle configuration parity remain open. |
| [Percy6Stars](https://github.com/Ahmet-Dedeler/Percy6Stars) | Windows texture, model, audio and video workflows. Linux and macOS packages and independent Bink decoding remain open. |
| [SixNG](https://github.com/holdmysocks/SixNG) | OpenSix calls the existing pinned worker for models, textures, clips, collision and newer tools for localization, grooms, cloth, particles, placements and navigation. Complete interior assembly, attachment-aware character export and a streamed world remain open. |
| [6stars](https://github.com/meetox80/6stars) | Terrain and timecycle data are readable. A world renderer with terrain LODs, interiors, vegetation and weather is a separate implementation. |
| [rpf9-explorer](https://github.com/breadbbbb/rpf9-explorer) | Shared texture and wardrobe components, previews, assemblies and export. Replacement project authoring and some authored vehicle and wardrobe materials remain open. |
| [6to5m](https://github.com/DesignWithTommy/6to5m) | Its pinned converter writes YMAP, YDR, YBN, YTD and YTYP from OpenSix. A full region export with assembled FiveM interiors, textures and gameplay validation remains open. |
| [vice-lens](https://github.com/Librett0/vice-lens) | Model, texture, audio, localization and terrain workflows. MP4 export, assembled placement views and a separate recovery scanner remain open. |
| [gta6-explorer](https://github.com/HolyRoses/gta6-explorer) | Structured RPF9 table, SGD5 members and effect links, type inspection and verified name lookup. Carving and inferred schema-name collections provide additional coverage. |
| [OpenRPF9](https://github.com/shrewbrewsh/OpenRPF9) | Text, hex, standalone TTPF, DDS and PNG, and decoded ADAT Opus export. TOC-independent recovery is a remaining workflow. |
| [Lineup](https://github.com/TheAirborneCoder/Lineup) | Wardrobe kit assembly, clip preview and guide OBJ export. A rigged character catalog and live hair rendering alongside an assembled model remain open. |
| [rpf9-extract](https://github.com/offs/rpf9-extract) | CLI listing and batch extraction, desktop archive index and typed PSIN. The tool's independent inspection output is useful for format comparisons. |
| [zeozeozeo/rpf9](https://github.com/zeozeozeo/rpf9) | OpenSix has its own build-pinned signed directory parser. The minimal Rust library provides an independent comparison for storage records. |

## Textures, audio and video

| Project | What OpenSix covers and what remains |
| --- | --- |
| [ttpf-studio](https://github.com/woreksami/ttpf-studio) | Texture browsing, mip and slice selection, PNG and DDS, and wheel placement. TTPF writing and full vehicle paint and parts authoring remain open. |
| [ttpf-viewer](https://github.com/paryzius/ttpf-viewer) | Indexed texture pools, cube faces and DDS chains. An interactive cube-map geometry viewer and some uncommon layouts remain open. |
| [bcpack-rs](https://github.com/Ahmet-Dedeler/bcpack-rs) | A pinned dependency of the native worker for BCPack entropy and BC1. OpenSix also includes VIctory's table-backed decoder. Independent testing of the remaining lossy or unsupported blocks is still needed. |
| [rage-texture](https://github.com/ifBars/rage-texture) | Both offer indexed textures, DDS and PNG. A lossless-versus-provisional batch export policy with a separate report for every texture remains open. |
| [bcpack-decoder](https://github.com/Tim0219800/bcpack-decoder) | Independent BC1 and entropy reference. Learning and validating tables from user-supplied pairs remains a separate research tool. |
| [rpf9-audio](https://github.com/jaylikesbunda/rpf9-audio) | ADAT Opus remuxing, supported PCM and XMA2 export, stems and playback. Opus-to-WAV batch conversion remains open. |
| [AWC_from_RPF9_Extractor](https://github.com/Albotterin/AWC_from_RPF9_Extractor) | Playback and saving supported audio streams. The station, song and artist catalog and a dedicated radio player remain open. |
| [SixFM](https://github.com/jaylikesbunda/SixFM) | OpenSix can listen to and export supported streams. Station scheduling, premix creation, AWC writing and verified archive replacement remain open. |
| [bink2-decoder](https://github.com/codingkoala/bink2-decoder) | Integrated Bink 2 video and DCT WAV export, both checked against real movies. Synchronized playback uses the local helper. RDFT audio and MP4 conversion remain open. |
| [gta6-video-reader](https://github.com/hoshino-114514/gta6-video-reader) | Playback overlap. MP4 and multitrack export would need independent testing across the decoder variants in the game. |
| [BK2toMP4](https://github.com/FluffyCyanNova/BK2toMP4) | Raw movie extraction and native playback are available. A batch conversion workflow is open. |

## Console and shader projects

The shader index in OpenSix reads SGD5 groups, effect links and DXBC sections. RDNA2 disassembly, SPIR-V or DXIL translation, and comparison of translated shaders against source rendering are distinct work. The projects below also make up most of the catalog's executable and renderer research. OpenSix's tools work offline on local assets.

| Project | Relevant boundary |
| --- | --- |
| Leonida and [continuation](https://github.com/ubiquitarianism/leonida) | Shader translator, content readers and a Windows Vulkan runtime. The original repository was offline in the audited snapshot. |
| [Xbox2Windows](https://github.com/R0Y00/Xbox2Windows) | Static CPU translation and desktop DXIL. No CPU translation in OpenSix. |
| [xcl](https://github.com/ivall/xcl) | Runtime library shims and shader translation. Useful comparison target for offline shader outputs. |
| [VIctory](https://github.com/Marvisak/VIctory) | BCPack is already integrated from source. The other GPU and runtime work is separate. |
| [xbox-emulator](https://github.com/omonkeyz/xbox-emulator) and [TomBox](https://github.com/drycheetah84/TomBox) | Xbox OS and D3D12 compatibility projects. Their runtime behavior has no archive-tool equivalent. |
| americas-recomp | Shader translation experiment. The pinned catalog lists its repository as offline. |
| [OpenScarlett](https://github.com/californiaAlmonds/OpenScarlett) | GPU shader lifting, codecs and runtime proxy. Decoder and shader research can be compared on local fixtures. |
| [ScarlettX](https://github.com/Freminet/ScarlettX), [XValkyrie](https://github.com/sammwyy/xvalkyrie) and [TuxBox](https://github.com/brcly/TuxBox) | Xbox title compatibility runtimes. Dependencies and executable behavior would need separate platform validation. |
| [PercyScarlett](https://github.com/rpatty-dev/PercyScarlett) | Custom-licensed runtime and shader lifter. OpenSix has no lifter. |
| [OpenCommunityEdition/OpenScarlett](https://github.com/OpenCommunityEdition/OpenScarlett) | Independently developed console DLL replacements and HLSL translation. License and validation differ from the other OpenScarlett. |
| [five-star-recomp](https://github.com/ThatRecompDev/five-star-recomp) | Archive and media overlap. Shader instructions and pipeline-cache inspection remain missing in OpenSix. |
| [AnyXboxX](https://github.com/LooperSalty/AnyXboxX) | Reference GPU interpreter and two GDK loading paths. Potential source for offline instruction cross-checks. |
| [AnyBox](https://github.com/Dark3581/AnyBox) | Relinks imports and supplies GDK libraries. This is an executable runtime workflow. |
| [G6Recomp](https://github.com/Kajcsi/G6Recomp) | Function discovery and static x64 translation. OpenSix currently reads the executable's format tables. |
| [rebox](https://github.com/puffnfresh/rebox) | Linux Xbox runtime and draw-time shader conversion. Linux compatibility needs its own delivery and tests. |
| [GTA6-BootTest](https://github.com/OnlyMoisties/GTA6-BootTest) and [scarlett-layer](https://github.com/jadeowaowa/scarlett-layer) | Native boot instrumentation and shims. Their value is compatibility testing with executable inputs. |
| [GTAVI-Recomp](https://github.com/JamesCicada/GTAVI-Recomp) and [AnyPS5](https://github.com/boykopovar/AnyPS5) | PS5 loader and GPU work. OpenSix's validated archive profile is for Scarlett. |

## Format research and visualizers

| Project | OpenSix coverage or gap |
| --- | --- |
| [GTA6-Asset-Info](https://github.com/TrinitronClient/GTA6-Asset-Info) | Broad cross-reference for worker-supported formats. OpenSix's remaining coverage includes world streaming, full material interpretation and some codecs. |
| [gta-vi-port-research](https://github.com/oguzhanozfe/gta-vi-port-research) | Reference for offline format comparisons. Porting and runtime work are separate. |
| [0x52504639](https://github.com/SentinelInteractive/0x52504639) | Header, record and trailer research. OpenSix verifies signed directory records, and the original filename table still requires its own usable cipher material. |
| [rpf9-research](https://github.com/JoshRob297/rpf9-research) | Compare record bounds and resource-derived names. Provenance and filename hash verification are separate concerns. |
| [gta6-namehash](https://github.com/tarekmania/gta6-namehash) | Schema hash reference for unresolved PSIN types. A schema hash candidate cannot establish an archive path. |
| [rage-tools-vi](https://github.com/lynxnathan/rage-tools-vi) | Additional PSIN schemas and offset manifests. OpenSix reads typed PSIN and extracts by the signed index. |
| [gta6-vr-port](https://github.com/dariulone/gta6-vr-port) | Renderer research aimed at stereo rendering. No OpenXR or VR runtime in OpenSix. |
| [RPF9-tools](https://github.com/frenzy42069/RPF9-tools) | Independent PSIN, archive, audio and movie inspection as reference for cross-checks. |
| [rage9-re](https://github.com/Ahmet-Dedeler/rage9-re) | Script document XML and animation overlap. Full animation channel and scene coverage still needs real-file comparisons. |
| [weather-study](https://github.com/Ahmet-Dedeler/weather-study) | OpenSix reads XML and authored time samples. A renderer for skies, cloud layers, ocean and lightning remains open. |
| [bink-player-mac](https://github.com/Ahmet-Dedeler/bink-player-mac) | Platform reference for playback and multitrack conversion. OpenSix ships a Windows build. |
| [PortWatch VI](https://github.com/4lwayz/portwatch-vi) | Project tracker. It supplies upstream activity information rather than game-format functionality. |
