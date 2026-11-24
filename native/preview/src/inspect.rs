use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use sixng_core::{anim, pso};
use std::{fs, path::Path};

fn u16_at(bytes: &[u8], offset: usize) -> usize {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap()) as usize
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

fn span(bytes: &[u8], pointer: u64, length: usize) -> Option<usize> {
    let start = usize::try_from(pointer.checked_sub(0x5000_0000)?).ok()?;
    (start.checked_add(length)? <= bytes.len()).then_some(start)
}

// 0DRP block and root-field inspection adapted with permission from
// breadbbbb/rpf9-explorer, Core/RageResourceMetadata.cs, revision af54933.
pub fn metadata(system: &[u8], output: &Path) -> Result<Value> {
    ensure!(system.len() >= 80 && system.get(16..20) == Some(b"0DRP") && u32_at(system, 20) == 122,
        "Unsupported RAGE metadata header");
    let block_count = u16_at(system, 76);
    let structure_count = u16_at(system, 72);
    let root = u32_at(system, 32) as usize;
    ensure!((1..=block_count).contains(&root), "Metadata root is outside the block table");
    let block_offset = span(system, u64_at(system, 56), block_count * 16).context("Invalid metadata block table")?;
    let mut blocks = Vec::with_capacity(block_count);
    for index in 0..block_count {
        let row = block_offset + index * 16;
        let size = u32_at(system, row + 4) as usize;
        let offset = span(system, u64_at(system, row + 8), size).context("Metadata block exceeds the system page")?;
        blocks.push((u32_at(system, row), offset, size));
    }

    let (root_type, root_offset, root_size) = blocks[root - 1];
    let mut root_fields = Vec::new();
    if structure_count != 0 {
        let schema = span(system, u64_at(system, 40), structure_count * 32).context("Invalid metadata schema table")?;
        for row in (schema..schema + structure_count * 32).step_by(32) {
            if u32_at(system, row) != root_type { continue; }
            let stride = u32_at(system, row + 24) as usize;
            ensure!(stride != 0 && stride <= root_size, "Invalid metadata root structure size");
            let count = u16_at(system, row + 30);
            if count == 0 { break; }
            let descriptors = span(system, u64_at(system, row + 16), count * 16).context("Invalid metadata fields")?;
            for field in (descriptors..descriptors + count * 16).step_by(16) {
                let hash = u32_at(system, field);
                if hash == 0x100 { continue; }
                let offset = u32_at(system, field + 4) as usize;
                ensure!(offset < stride, "Metadata field exceeds the root structure");
                let kind = system[field + 8];
                let mut info = json!({"hash":format!("{hash:08x}"), "offset":offset, "type":format!("{kind:02x}")});
                if kind == 0x52 && stride - offset >= 16 {
                    let position = root_offset + offset;
                    let pointer = u64_at(system, position);
                    let count = u16_at(system, position + 8);
                    let capacity = u16_at(system, position + 10);
                    let block = (pointer & 0xfffff) as usize;
                    let offset = (pointer >> 20) as usize;
                    let target_fits = block.checked_sub(1).and_then(|index| blocks.get(index))
                        .is_some_and(|(_, _, size)| offset < *size && count <= size - offset);
                    if count <= capacity && u32_at(system, position + 12) == 0 && (target_fits || (pointer == 0 && capacity == 0)) {
                        info["array"] = json!({"count":count,"capacity":capacity,"targetBlock":block,"targetOffset":offset});
                    }
                }
                root_fields.push(info);
            }
            break;
        }
    }
    let blocks: Vec<_> = blocks.iter().enumerate().map(|(index, (kind, offset, length))| json!({
        "block": index + 1, "type":format!("{kind:08x}"), "offset":offset,"length":length
    })).collect();
    document(output, "0DRP metadata", json!({"version":122,"root":root,"structures":structure_count,"rootFields":root_fields,"blocks":blocks}))
}

pub fn psin(bytes: &[u8], output: &Path) -> Result<Value> {
    let parsed = pso::parse(bytes).context("Unrecognized PSIN metadata")?;
    let mut sections: Vec<_> = pso::sections(bytes).into_iter().map(|(tag, (offset, length))|
        (offset, length, String::from_utf8_lossy(&tag).into_owned())).collect();
    sections.sort_by_key(|section| section.0);
    let sections: Vec<_> = sections.into_iter().map(|(offset,length,tag)|json!({"tag":tag,"offset":offset,"length":length})).collect();
    document(output, "PSIN metadata", json!({"sections":sections, "root":parsed.root_json(5)}))
}

pub fn clips(bytes: &[u8], output: &Path) -> Result<Value> {
    let dictionary = anim::ClipDictionary::parse(bytes)?;
    let clips: Vec<_> = dictionary.clips.iter().map(|clip| json!({
        "name":clip.short_name(),"seconds":clip.duration,"type":clip.kind,"hash":format!("{:08x}",clip.hash),
        "animations":clip.bindings.iter().map(|binding|binding.animation).collect::<Vec<_>>(),
        "tracks":anim::all_tracks(&dictionary, clip).into_iter().map(|(bone, kind, value)|json!({
            "bone":format!("{bone:08x}"),"type":format!("{kind:08x}"),"valueType":format!("{value:?}")
        })).collect::<Vec<_>>()
    })).collect();
    let animations: Vec<_> = dictionary.animations.iter().map(|item|json!({
        "name":item.name,"frames":item.frames,"seconds":item.duration,"tracks":item.tracks.len()
    })).collect();
    let mut result = document(output, "Clip dictionary", json!({"name":dictionary.name,"clips":clips,"animations":animations}))?;
    result["clips"] = json!(dictionary.clips.iter().map(|clip| json!({"name":clip.short_name(),"type":clip.kind})).collect::<Vec<_>>());
    Ok(result)
}

fn document(output: &Path, title: &str, content: Value) -> Result<Value> {
    let file = "inspection.json";
    let bytes = serde_json::to_vec_pretty(&content)?;
    fs::write(output.join(file), &bytes)?;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(128 * 1024)]);
    let note = if bytes.len() > 128 * 1024 { format!("{title} · Download JSON for all records") } else { title.into() };
    Ok(json!({"type":"inspection","value":text,"note":note,"file":file}))
}
