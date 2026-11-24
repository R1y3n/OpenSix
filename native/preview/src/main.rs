use anyhow::{anyhow, bail, ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sixng_core::{
    anim, audio, bounds, classify::Kind, drawable, export::{self, ExportOptions, ExportedItem},
    game::ArchiveInfo, gltf, outfit, resource::Resource, scan::Entry, texture,
};
use std::{env, fs, io::Cursor, path::{Path, PathBuf}};

mod inspect;
mod tools;

#[derive(Deserialize)]
struct Request {
    kind: String,
    archive: PathBuf,
    name: String,
    system_size: Option<usize>,
    index: Option<usize>,
    detail: Option<usize>,
    clip_index: Option<usize>,
    appearance: Option<Appearance>,
    #[serde(default)]
    parts: Vec<AssemblyPart>,
}

#[derive(Deserialize)]
struct AssemblyPart {
    archive: PathBuf,
    name: String,
    system_size: usize,
    index: Option<usize>,
    detail: Option<usize>,
    wheel_scale: Option<[f32; 2]>,
    appearance: Option<Appearance>,
}

#[derive(Deserialize)]
struct Appearance {
    albedo: String,
    normal: String,
    extra: String,
    palette: String,
}

struct DrawableAsset {
    title: String,
    label: Option<String>,
    groups: Vec<gltf::NodeGroup>,
    materials: Vec<gltf::Material>,
    joints: Vec<gltf::Joint>,
    members: Vec<String>,
    lods: Vec<usize>,
    lod: usize,
    warnings: Vec<String>,
}

fn decode_drawable(archive_path: &Path, name: &str, index: Option<usize>, detail: Option<usize>,
    resource: &Resource, out: &Path) -> Result<DrawableAsset> {
    let mut info = drawable::describe(resource);
    let fragments = drawable::fragment_members(resource, &info);
    let members: Vec<String> = if fragments.is_empty() { info.members.clone() } else {
        fragments.iter().map(|(index, _)| if *index==0 { "Main drawable".into() } else { format!("Fragment child {index}") }).collect()
    };
    let member = index.map(|index| members.get(index).context("Drawable member is missing")).transpose()?;
    if let Some(index) = index {
        if let Some((_,root)) = fragments.get(index) {
            drawable::select_fragment(resource, &mut info, *root)?;
        } else if let Some(name) = member {
            drawable::select_member(resource, &mut info, name)?;
        }
    }
    ensure!(!info.geometries.is_empty(), "This drawable has no triangle geometry");
    let mut item = ExportedItem {
        id: name.into(), archive: archive_path.display().to_string(), kind: "resource".into(),
        rtype: Some("dr".into()), name: info.name.clone(), status: "ok".into(), files: vec![],
        error: None, warnings: vec![],
    };
    let archive = ArchiveInfo {
        id: archive_path.file_name().context("Archive name missing")?.to_string_lossy().into(),
        path: archive_path.into(), size: 0, container: "rpf9".into(),
    };
    let entry = Entry {
        id: name.into(), off: 0, csize: 0, usize: (resource.sys.len()+resource.gfx.len()) as u64,
        streams: vec![], kind: Kind::Resource, sub: "model".into(), ext: "glb".into(),
        name: info.name.clone(), rtype: Some("dr".into()), members: members.clone(),
    };
    let options = ExportOptions {
        out: out.to_path_buf(), png: true, dds: false, raw: false, force: true,
        skip_embedded_textures: false, body_shape: vec![], head_skin: 0, paint: None,
        tex_remap: Default::default(), ped_tints: Default::default(),
    };
    let built = export::build_drawable(&archive, &entry, resource, &info, out, member.is_some(), &options, &mut item);
    let mut groups = built.lod_groups;
    if groups.is_empty() { groups.push(Vec::new()); }
    groups[0].extend(built.part_groups);
    let lods = groups.iter().enumerate()
        .filter(|(_, groups)| groups.iter().any(|group| group.prims.iter().any(|p| !p.indices.is_empty())))
        .map(|(index, _)| index).collect::<Vec<_>>();
    let lod = detail.or_else(|| lods.first().copied()).context("No drawable LOD has triangles")?;
    ensure!(lods.contains(&lod), "Drawable LOD is missing");
    let title = info.name.clone().unwrap_or_else(|| name.into());
    Ok(DrawableAsset {title,label:info.name,groups:std::mem::take(&mut groups[lod]),
        materials:built.materials,joints:built.joints,members,lods,lod,warnings:item.warnings})
}

fn model(req: &Request, resource: &Resource, out: &Path) -> Result<Value> {
    let mut asset=decode_drawable(&req.archive,&req.name,req.index,req.detail,resource,out)?;
    if let Some(appearance)=&req.appearance { apply_appearance(&mut asset,&req.archive,appearance,out)?; }
    let DrawableAsset {title,label,mut groups,mut materials,mut joints,members,lods,lod,mut warnings} =
        asset;
    let file = "model.glb";
    let mut assembled = Vec::new();
    if !req.parts.is_empty() {
        let mounts: Vec<_> = joints.iter().enumerate().filter(|(_,joint)| export::is_wheel_mount(&joint.name))
            .map(|(index,joint)|(index,joint.name.clone(),[joint.bind[12],joint.bind[13],joint.bind[14]])).collect();
        let mut group_sets = vec![std::mem::take(&mut groups)];
        let mut skeletons = vec![std::mem::take(&mut joints)];
        for (position, part) in req.parts.iter().enumerate() {
            let data=split_resource(fs::read(out.join(format!("part-{position}.bin")))?,part.system_size)?;
            let mut decoded=decode_drawable(&part.archive,&part.name,part.index,part.detail,&data,out)
                .with_context(|| format!("Could not decode assembly part {}",part.name))?;
            if let Some(appearance)=&part.appearance {
                apply_appearance(&mut decoded,&part.archive,appearance,out)?;
            }
            let material_start=materials.len();
            for geometry in decoded.groups.iter_mut().flat_map(|group| &mut group.prims) {
                geometry.material=geometry.material.map(|i|i+material_start);
            }
            for group in &mut decoded.groups { group.name=format!("{}/{}",decoded.title,group.name); }
            if let Some(scales) = part.wheel_scale {
                ensure!(!mounts.is_empty(), "The vehicle body has no recognized wheel mounts");
                ensure!(decoded.joints.is_empty(), "Wheel meshes must be unrigged");
                ensure!(scales.iter().all(|scale| scale.is_finite() && (0.01..=10.0).contains(scale)),
                    "Enter front and rear wheel scales between 0.01 and 10");
                let part_prims: Vec<_>=decoded.groups.iter().flat_map(|group| &group.prims).collect();
                let mut placements=Vec::with_capacity(mounts.len());
                for (joint,name,translation) in &mounts {
                    let slot=&name.to_ascii_lowercase()[6..];
                    let scale=scales[usize::from(!slot.starts_with("lf") && !slot.starts_with("rf"))];
                    let mirror=slot.starts_with('r');
                    let prims=part_prims.iter().map(|geometry| mount_wheel(geometry,name,*joint as u16,*translation,scale,mirror)).collect();
                    placements.push(gltf::NodeGroup{name:format!("{name}/{}",decoded.title),prims});
                }
                group_sets[0].extend(placements);
            } else {
                group_sets.push(decoded.groups);
                skeletons.push(decoded.joints);
            }
            warnings.extend(decoded.warnings);
            materials.extend(decoded.materials);
            assembled.push(decoded.title);
        }
        ensure!(skeletons.iter().map(Vec::len).sum::<usize>()<u16::MAX as usize,"Assembly has too many bones");
        let (merged,maps)=outfit::merge_skeletons(&skeletons);
        for (set,map) in group_sets.iter_mut().zip(&maps) {
            for primitive in set.iter_mut().flat_map(|group| &mut group.prims) {
                outfit::remap_joints(primitive,map);
            }
        }
        joints=merged;
        groups=group_sets.into_iter().flatten().collect();
    }
    let triangles: usize = groups.iter().flat_map(|group| &group.prims).map(|p| p.indices.len()/3).sum();
    let texture_trace: Vec<_> = materials.iter().map(|material| json!({
        "name":material.name,"details":material.extras
    })).collect();
    let mut animations = Vec::new();
    let mut animation_report = Value::Null;
    if let Some(index) = req.clip_index {
        ensure!(!joints.is_empty(), "This drawable has no skeleton for the selected clip");
        let clip_bytes = fs::read(out.join("clip.bin"))?;
        let dictionary = anim::ClipDictionary::parse(&clip_bytes)?;
        let clip = dictionary.clips.get(index).context("Animation clip is missing")?;
        ensure!(clip.kind == 1, "This clip type has no decoded bone animation");
        let (channels, coverage) = outfit::clip_channels(&dictionary, clip, &joints);
        ensure!(!channels.is_empty(), "The clip and drawable have no compatible animated bones");
        animation_report = json!({"name":clip.short_name(), "coverage":coverage});
        animations.push(gltf::Animation { name:clip.short_name().into(), channels });
    }
    let options = gltf::GlbOptions { animations:&animations, ..Default::default() };
    let glb = gltf::mesh_glb_with(&title,&groups,&materials,&joints,
        json!({"lod":lod,"animation":animation_report,"parts":assembled}),&options);
    fs::write(out.join(file),glb)?;
    Ok(json!({"type":"model","file":file,"name":title,"items":members,"lods":lods,"detail":lod,
        "index":req.index,"triangles":triangles,"warnings":warnings,"embeddedLabel":label,
        "materials":texture_trace,"animation":animation_report,"parts":assembled,
        "wheelMounts":joints.iter().filter(|joint|export::is_wheel_mount(&joint.name)).map(|joint| &joint.name).collect::<Vec<_>>() }))
}

fn apply_appearance(asset: &mut DrawableAsset, path: &Path, appearance: &Appearance, output: &Path) -> Result<()> {
    let albedo=u64::from_str_radix(&appearance.albedo,16)?;
    let normal=u64::from_str_radix(&appearance.normal,16)?;
    if appearance.extra!="0000000000000000" || appearance.palette!="00000000" {
        asset.warnings.push(format!("{}: extra wardrobe and palette slots are listed in the kit",asset.title));
    }
    if albedo==0 && normal==0 { return Ok(()); }
    let used: std::collections::BTreeSet<_>=asset.groups.iter().flat_map(|group| &group.prims)
        .filter(|primitive| !primitive.uvs.is_empty()).filter_map(|primitive| primitive.material).collect();
    let primary: Vec<_>=used.iter().copied().filter(|&index| asset.materials[index].extras["textures"]
        .as_array().is_some_and(|textures|textures.iter().any(|item|item["param_hash"]=="c8e8c282"))).collect();
    let index=match primary.as_slice() {
        [index] => Some(*index),
        [] if used.len()==1 => used.first().copied(),
        _ => None,
    };
    let Some(index)=index else {
        asset.warnings.push(format!("{}: no unique wardrobe material with UV coordinates",asset.title));
        return Ok(());
    };
    let archive=ArchiveInfo{id:String::new(),path:path.into(),size:0,container:"rpf9".into()};
    let pools=sixng_core::ttpf::global(&export::game_root(&archive));
    let destination=output.join("textures").join("ttpf");
    let material=&mut asset.materials[index];
    for (key,field) in [(albedo,"albedo"),(normal,"normal")] {
        if key==0 {continue;}
        let entry=pools.get(key).and_then(|(store,texture)| {
            sixng_core::ttpf::write_png(store,texture,&destination).ok().map(|(image,_)|(image,store.label()))
        });
        let Some((image,store))=entry else {
            asset.warnings.push(format!("{}: wardrobe {field} {key:016x} is unavailable",asset.title));
            continue;
        };
        let uri=image.strip_prefix(output)?.to_string_lossy().replace('\\',"/");
        if field=="albedo" { material.base_color_uri=Some(uri.clone()); }
        else { material.normal_uri=Some(uri.clone()); }
        material.extras["wardrobe"][field]=json!({"key":format!("{key:016x}"),"store":store,"png":uri});
    }
    Ok(())
}

fn mount_wheel(mesh: &gltf::TriPrim, mount: &str, bone: u16, offset: [f32; 3], scale: f32, mirror: bool) -> gltf::TriPrim {
    let x = if mirror { -1.0 } else { 1.0 };
    let positions=mesh.positions.iter().map(|p|[p[0]*x*scale+offset[0],p[1]*scale+offset[1],p[2]*scale+offset[2]]).collect();
    let normals=mesh.normals.as_ref().map(|values|values.iter().map(|n|[n[0]*x,n[1],n[2]]).collect());
    let tangents=mesh.tangents.as_ref().map(|values|values.iter().map(|t|[t[0]*x,t[1],t[2],t[3]*x]).collect());
    let mut indices=mesh.indices.clone();
    if mirror { for face in indices.chunks_exact_mut(3) { face.swap(1,2); } }
    gltf::TriPrim { name:format!("{mount}/{}",mesh.name),positions,normals,tangents,indices,material:mesh.material,
        uvs:mesh.uvs.clone(), colors:mesh.colors.clone(), tint:mesh.tint.clone(),
        joints:Some(vec![[bone,0,0,0];mesh.positions.len()]), weights:Some(vec![[255,0,0,0];mesh.positions.len()]),
        joints1:None,weights1:None }
}

fn collision(req: &Request, resource: &Resource, out: &Path) -> Result<Value> {
    let bounds = bounds::decode(resource).context("Unsupported collision bounds")?;
    let triangles: usize = bounds.by_mat.values().map(|(_, indices)| indices.len() / 3).sum();
    ensure!(triangles > 0, "This collision resource has no supported geometry");

    let file = "model.glb";
    let metadata = json!({ "bounds": bounds.bbox, "stats": bounds.stats });
    fs::write(out.join(file), bounds.glb(&req.name, metadata))?;
    Ok(json!({
        "type": "model", "file": file, "items": [], "lods": [0], "detail": 0,
        "index": null, "triangles": triangles, "note": "Collision bounds"
    }))
}

fn textures(req: &Request, resource: &Resource, out: &Path) -> Result<Value> {
    let mut entries = texture::find_textures(resource);
    ensure!(!entries.is_empty(), "This dictionary has no supported texture descriptors");
    let index = req.index.unwrap_or_default();
    let mip = req.detail.unwrap_or_default() as u32;
    let items = entries.iter().enumerate().map(|(i,t)| {
        let title=if t.name.is_empty(){format!("Texture {}",i+1)}else{t.name.clone()};
        json!({"name":title,"width":t.width,"height":t.height,"mips":texture::exportable_mips(t),"format":t.format})
    }).collect::<Vec<_>>();
    let t = entries.get_mut(index).context("Texture index is missing")?;
    let decoded = (|| -> Result<(u32,u32)> {
        ensure!(mip < texture::exportable_mips(t), "Texture mip is missing");
        let (format,bytes,width,height) = if mip == 0 {
            let (format,bytes) = texture::mip0_linear(resource,t,t.height==1)?;
            (format,bytes,t.width,t.height)
        } else {
            texture::mip_linear(resource,t,mip)?
        };
        ensure!(u64::from(width)*u64::from(height)<=16_777_216,"Preview this texture at a smaller mip");
        let rgba = texture::to_rgba(format,&bytes,width,height)?;
        texture::save_png(&out.join("texture.png"),&rgba,width,height)?;
        Ok((width,height))
    })();
    let (file,width,height,note)=match decoded {
        Ok((width,height))=>(Some("texture.png"),width,height,None),
        Err(error)=>(None,t.width,t.height,Some(error.to_string())),
    };
    Ok(json!({"type":"textures","file":file,"items":items,"index":index,"detail":mip,"width":width,"height":height,"note":note}))
}

fn sound(req: &Request, data: &[u8], out: &Path) -> Result<Value> {
    let mut bank = audio::parse_header(data,0).context("Invalid GTA VI ADAT bank")?;
    ensure!(bank.size<=data.len() as u64,"Audio bank chunks exceed the asset size");
    audio::read_formats(&mut Cursor::new(data),&mut bank)?;
    let index = req.index.or_else(|| bank.streams.iter().position(audio::Stream::exportable)).unwrap_or_default();
    let stream = bank.streams.get(index).context("Audio stream is missing")?;
    let items = bank.streams.iter().map(|s| json!({
        "id":format!("{:08x}",s.id),"seconds":s.seconds(),"channels":s.channels,
        "codec":s.layout,"codecId":s.codec,"storedBytes":s.data.1,"exportable":s.exportable()
    })).collect::<Vec<_>>();
    let mut tracks = Vec::new();
    match stream.layout.as_str() {
        "blocks" => {
            let packets = audio::packets(data,stream);
            ensure!(!packets.is_empty(),"No complete Opus packets in this stream");
            fs::write(out.join("track.opus"), audio::ogg_opus(&packets,stream.frames(),"OpenSix"))?;
            tracks.push(json!({"name":"Opus","file":"track.opus","playable":true}));
        }
        "music" => {
            for (i,channel) in audio::music_channels(data,0,stream)?.into_iter().enumerate() {
                if channel.packets.is_empty(){continue;}
                let name=format!("stem-{}.opus",i+1);
                fs::write(out.join(&name),audio::ogg_opus(&channel.packets,channel.frames,"OpenSix"))?;
                tracks.push(json!({"name":format!("Stem {}",i+1),"file":name,"playable":true}));
            }
        }
        "pcm16" | "pcmf32" => {
            let bytes = audio::pcm_wav(audio::stream_data(data,stream)?,stream)?;
            fs::write(out.join("track.wav"),bytes)?;
            tracks.push(json!({"name":"PCM","file":"track.wav","playable":true}));
        }
        "xma2" => {
            let bytes=audio::xma2_riff(audio::stream_data(data,stream)?,stream)?;
            fs::write(out.join("track.xma"),bytes)?;
            tracks.push(json!({"name":"XMA2","file":"track.xma","playable":false}));
        }
        _ => {}
    }
    Ok(json!({"type":"bank","items":items,"index":index,"tracks":tracks}))
}

fn run() -> Result<Value> {
    let out = PathBuf::from(env::args_os().nth(1).ok_or_else(|| anyhow!("Missing preview directory"))?);
    let request: Request = serde_json::from_slice(&fs::read(out.join("request.json"))?)?;
    let data = fs::read(out.join("entry.bin"))?;
    if request.kind=="bank" { return sound(&request,&data,&out); }
    if request.kind=="psin" { return inspect::psin(&data,&out); }
    if matches!(request.kind.as_str(),"toolText" | "toolPso" | "toolHandling" | "toolScript" | "toolTimecycle") {
        return tools::unpaged(&request.kind,&data,&out);
    }
    let resource=split_resource(data,request.system_size.context("Missing RAGE system page size")?)?;
    if request.kind.starts_with("tool") {
        return tools::resource(&request.kind,&resource,&request.name,request.detail==Some(1),&out);
    }
    match request.kind.as_str() {
        "model" => model(&request,&resource,&out),
        "collision" => collision(&request,&resource,&out),
        "textures" => textures(&request,&resource,&out),
        "metadata" => inspect::metadata(&resource.sys,&out),
        "clips" => inspect::clips(&resource.sys,&out),
        _ => bail!("Unknown preview kind"),
    }
}

fn split_resource(mut data: Vec<u8>, size: usize) -> Result<Resource> {
    ensure!(size>0 && size<=data.len(),"Invalid RAGE resource page sizes");
    let gfx=data.split_off(size);
    Ok(Resource{sys:data,gfx,gfx_base:0})
}

fn main() -> Result<()> {
    println!("{}",run()?);
    Ok(())
}
