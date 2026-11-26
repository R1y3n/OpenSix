# Using OpenSix

## First launch and the explorer

On the first launch OpenSix looks for `game_scarlett_master.exe` on your fixed drives and lists what it finds. Choose a folder from the list or use **Browse**. OpenSix checks the executable, saves the folder in its own data folder (`%APPDATA%OpenSix`), and opens it on every later launch. **Archive → Game folder** changes the choice. OpenSix only reads the game folder. It writes its settings and index inside `%APPDATA%OpenSix`.

The left tree shows the game folder, its `.rpf` archives, their nested archives, and the folders formed by entries whose paths are known. Click a node to open it. The list shows each file's icon, type, size and offset. Entries without a recovered path appear as their 64-bit hash in a monospaced font. A name that comes from a label stored inside a model carries a **label** badge. Entries whose hash matches a verified path show that path. Use the back, forward and up buttons (`Alt+Left`, `Alt+Right`, `Backspace`), the breadcrumb, `F5` to refresh, and `Ctrl+F` for search. Sort by clicking a column. Right-click an entry for **Preview**, **Extract file**, **Save stored bytes**, **Export model as GLB or FBX**, **Copy full path**, **Copy name** and **Copy hash**. The details pane shows the full archive path and the preview.

The first launch also builds a search index in the background. The first part walks every archive directory (about two minutes). The second part reads the system page of each model to collect the drawable labels it stores. This takes several minutes the first time and a USB hard drive is slower, and the progress shows at the bottom of the tree. The index is saved, so search is instant on later launches, and an interrupted scan resumes. **Archive → Rebuild search index** discards it. OpenSix rebuilds it automatically when an archive file changes.

## Searching the game

Type in the search box at the top. By default it searches every nested archive. Choose **This location** to search below the folder you are viewing. The search matches names, labels and hashes together:

| You type | OpenSix finds |
| --- | --- |
| `lucia` | Names and model labels that contain the text |
| `cs_jason_*fullbody*` | Wildcards. `*` matches any text and `?` one character |
| `hash:ab0d9aeda6791d76` or a full 8 or 16 digit hash | Entries with that 64-bit or 32-bit hash. A shorter prefix needs `hash:` or `0x` first |
| `ext:zdd` or `type:zft,zdr` | Entries with that extension |
| `hash:996fdba2db30cc12` | Also finds the texture pool entry with that key. A model's **Texture dependencies** list shows each material texture's key with a **Find in game** button |
| `bc7 1024x1024 peds` | Texture pool entries by format, size and pool path |

Use the chips under the heading to limit results to models, textures, animations and other types. Double-click a result to open its archive with the entry selected. Each result lists its full archive path. If a model-name scan is still running, the heading says so and more results appear as it advances. A result's name is never invented. It is either a verified path, a label stored in the model whose hash matches the entry (marked **label**), or the entry's hash.

## Characters

A character is a set of drawables whose embedded labels share a prefix, such as `cs_lucia`. Searching for a name shows the matching characters above the results. Choose **Preview and export**, or open **Assets → Characters**. The dialog lists the character's parts by slot, preselects a complete cutscene body and head when the character has one, assembles the parts on one skeleton with their textures, and shows the result in 3D. **Save GLB** and **Save FBX** write the same model. The preview and both exports carry the skeleton, skin weights, three UV layers and the base-color texture OpenSix could resolve.

Modular clothing sets such as `player_story000_00` and `player_story000_01` take their garment and face textures from the game's wardrobe catalogue, a large metadata file in `packs.rpf` that OpenSix finds by itself. When the catalogue lists several texture sets for a garment, the part gets a **Colour** choice. The default look wears one garment per body area: an outer layer such as a jacket goes over a light top (tee, tank top or bra), never over a hoodie or sweatshirt, and a full-body piece replaces top and bottom.

A modular character is dressed over the shared arms and hands (`hand_…`) and legs and feet (`feet_…`) that the game stores without a character prefix. They are listed under **Hands** and **Feet skin** and selected by default, with the variant that matches the sleeves and the bottom garment so that skin does not show through the clothes. Their skin tone comes from the head texture. Most garments in the catalogue store no colour at all, because the game sets it at run time, so those garments get a **Fabric colour** choice. **Natural** keeps the fabric's own shade map, and jeans start as denim blue. The chosen colours are baked into the exported textures, so GLB and FBX both carry them. Hair strands are not attached. The game data stores no link from a hairstyle to its strand resource, so hairstyle parts appear as the game's own empty placeholder. See [compatibility](compatibility.md).

Searching also finds clip dictionaries. Each dictionary carries its own name, the names of its clips and the animation files it uses. A dictionary's name is shown as its file name when its hash matches the entry, and its clip names are searchable.

## Top menus

Use **Archive** to change the game folder, search, open other files, import paths, and export the selected archive index. When a complete supported `shaders.rpf` is selected, **Export shader index** writes the decoded records and their searchable names and links.

**Archive → Extract matching files** uses the current search, folder and name filter. It creates a new output folder with the decoded files and a report that lists any entries the decoder could not extract.

**World**, **Assets**, and **Data** open separate tool dialogs. Select a file in the archive browser first and choose **Use selected entry**, or use **Open decoded file** to work with an extracted resource. For a resource with separate system and graphics pages, use the corresponding archive entry so OpenSix can read the layout from its directory record.

- **World** opens terrain, placement, navigation and timecycle tools. Navigation tiles can be filtered to road polygons and exported as GLB, FBX or JSON.
- **Assets** opens handling, groom, cloth and particle reports, plus audio-bank and movie playback. For Bink 2, the built-in player supports video, stepping and seeking. **Bink audio tracks** plays and saves supported DCT tracks as WAV. See below for the Bink 1 and synchronized Bink audio helper.
- **Data** opens the localization search, typed PSIN inspection and script XML extraction. Localization CSV preserves game text and quotes spreadsheet formula prefixes as literal text.

## Authoring and conversion

Open an archive with the matching executable, then choose **Archive → Create unsigned RPF9**. Pick a folder of files and a new output path. The new archive stores the files and their relative paths. Reopen it in OpenSix to browse and extract them. This writer uses ordinary file records and a path manifest for OpenSix. Retail signing and resource-aware replacement still require a validated writer for those formats.

**World → Export GTA V map (YMAP)** takes a decoded placement entry or a placement JSON report. It preserves archetype hashes and transforms. The target game needs the referenced archetypes and models. The **Assets** menu converts local OBJ to YDR or YBN, and DDS to YTD. **Data → Create GTA V archetypes (YTYP)** accepts an archetype JSON document using the [6to5m converter schema](https://github.com/DesignWithTommy/6to5m/blob/5d62e745bb4413d7f21923b23c713b6651728868/src/gta5/meta.rs). These tools write GTA V resources for use in a mod project.

For grooms, select the archive entry or open a `.osgroom` bundle with **Assets → Hair and fur guides**. The bundle preserves the original decoded system and graphics pages. The 3D view displays ribbons along the guide points. OBJ export stores the guides as lines.

Download [OpenSix 1.4.0](https://github.com/cyberpulse2077/OpenSix/releases/latest/download/OpenSix.exe) for Windows x64, or a native Linux x64 AppImage, deb or tar.xz from [this fork's releases](https://github.com/R1y3n/OpenSix/releases/latest). The version is in the window title and next to the name in the header, where clicking it opens **About**. It is also in the file's **Properties → Details**, and `OpenSix.exe --version --report <new local file>` writes it to a file (the portable executable does not pass console output through). Choose the game folder from the supported Scarlett build. OpenSix reads the executable in that folder to get the archive format tables, and the game stays closed.

## Archives and filenames

The explorer opens archives and nested archives as folders. Select an entry to see its size, offset, hashes, and available preview. OpenSix rejects incomplete archives. **Open archive** (and **Archive → Open other RPF9**) adds a file or folder from outside the game folder under **Opened files** in the sidebar.

Use **Archive → Import paths** with one candidate path per line. A matching path appears as a verified name. The background index reads the drawable labels stored inside models and makes them searchable. When the 64-bit hash of a label matches its entry, the entry's name is that label plus its extension, shown with a **label** badge. A label can describe an asset even when its original archive path is unknown, and those entries stay unnamed.

**Extract file** saves decoded data. **Save stored bytes** keeps the entry as it was stored in the archive.

## Models and animation

Open a drawable, fragment, or dictionary, then choose a drawable and detail level when the asset offers them. Drag to orbit and scroll to zoom. **Material and texture sources** shows the resolved texture references and any gaps. Save GLB or FBX from the preview.

For animation, open a clip dictionary and select **Use clip on a model**. Open a model with compatible bones and use the playback controls to inspect the motion. The preview reports how many bone tracks it mapped.

To combine parts, add each model in **Model assembly** and choose **Preview assembly**. For wheels, add the vehicle body first. Enter front and rear scales and add each wheel component. Open a supported wardrobe catalog and choose **Assemble wardrobe kit** when its drawable archives are open. The kit’s JSON report includes its texture and palette references.

## TTPF texture pools

Select **Open texture pool** and choose a complete `.ttpf` file. Search by key, format, or name. Choose a mip and, for supported layouts, an array slice, cube face, or volume slice. **Save DDS** keeps the chain starting at the first available source mip. When you preview a lower mip, **Save DDS from mip** exports the chain starting there. A PNG export saves the displayed image.

![OpenSix decoding a car wash image from the GTA VI UI texture pool](images/car-wash-preview.png)

The portable EXE includes VIctory’s BCPack decoder. To use it on more textures, [download the matching table file](https://github.com/Marvisak/VIctory/raw/d2a4bae1f49533ef5cb512fd1b1ba1513f2e1989/crates/victory-formats/src/bcpack-tables.bin), save it as `bcpack-tables.bin` beside `OpenSix.exe`, and open the pool as usual. OpenSix picks up the file automatically. When a source mip is unavailable, OpenSix can preview a lower mip it can verify.

## Audio and video

Select a track in a supported audio bank to listen or save it. Opus, PCM, and music stems play in the app. XMA2 can be saved as a track. For XMA2 playback, make [FFmpeg](https://ffmpeg.org/) available on `PATH` or set `OPENSIX_FFMPEG` to its absolute path.

Bink 2 movies play with the built-in decoder on both Windows and the native Linux build. For Bink 1 movies, use the `Tools/bink-player.exe` from the [rpf9-explorer v1.3 release](https://github.com/breadbbbb/rpf9-explorer/releases/tag/v1.3). Place it beside OpenSix.exe or set `OPENSIX_BINK_PLAYER` to its absolute path. OpenSix checks that it has the expected helper before starting playback.

## Batch workflows

Use `--report` with a new local file to get JSON Lines from the portable executable. Search gives you the entry ID to use for an export. `--recursive` includes nested archives, `--labels` indexes embedded model labels, and `--names` imports a path list. Leave out `--exe` for a TTPF.

```powershell
.\OpenSix.exe --cli search 'C:\Game\data.rpf' --exe 'C:\Game\game_scarlett_master.exe' --recursive --query zft --report 'C:\Exports\search.jsonl'
.\OpenSix.exe --cli export 'C:\Game\data.rpf' --exe 'C:\Game\game_scarlett_master.exe' --recursive --id '<entry-id>' --out 'C:\Exports\Models' --report 'C:\Exports\export.jsonl'
```

Add `--stored` to export the stored representation of an archive entry. Pass `--id` more than once to extract a batch.

## Updates

OpenSix checks for a newer release by itself. Each time it starts, a few seconds after the window opens, it asks GitHub's public list of releases (`api.github.com/repos/cyberpulse2077/OpenSix/releases/latest`) for the latest stable release and compares its version with the one you run. The request carries only the name `OpenSix` and its version number, with nothing about you, your PC or the game. GitHub sees your IP address, as with any web request. This is the only network request OpenSix makes. A failed check, for example when you are offline, is quiet.

When a newer release exists, a note appears at the bottom right. **Details** shows the release notes and the file's SHA-256. **Open the download page** opens the release page in your browser. **Skip this version** hides the note until a later release. OpenSix never downloads or installs a release itself.

Click the version in the header to open **About**, or choose **Archive → Check for updates**, to check now or to switch the automatic check off. The choice is saved in OpenSix's settings in `%APPDATA%OpenSix`.