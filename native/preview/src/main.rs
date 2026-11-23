use anyhow::{anyhow, bail, ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sixng_core::{
    audio, classify::Kind, drawable, export::{self, ExportOptions, ExportedItem},
    game::ArchiveInfo, gltf, resource::Resource, scan::Entry, texture,
};
use std::{env, fs, io::Cursor, path::{Path, PathBuf}};

#[derive(Deserialize)]
struct Request {
    kind: String,
    archive: PathBuf,
    name: String,
    system_size: Option<usize>,
    index: Option<usize>,
    detail: Option<usize>,
}

fn model(req: &Request, resource: &Resource, out: &Path) -> Result<Value> {
    let mut info = drawable::describe(resource);
    let members = info.members.clone();
    let member = req.index.map(|index| members.get(index).context("Drawable member is missing")).transpose()?;
    if let Some(name) = member {
        drawable::select_member(resource, &mut info, name)?;
    }
    ensure!(!info.geometries.is_empty(), "This drawable has no triangle geometry");
    let mut item = ExportedItem {
        id: req.name.clone(), archive: req.archive.display().to_string(), kind: "resource".into(),
        rtype: Some("dr".into()), name: info.name.clone(), status: "ok".into(), files: vec![],
        error: None, warnings: vec![],
    };
    let archive = ArchiveInfo {
        id: req.archive.file_name().context("Archive name missing")?.to_string_lossy().into(),
        path: req.archive.clone(), size: 0, container: "rpf9".into(),
    };
    let entry = Entry {
        id: req.name.clone(), off: 0, csize: 0, usize: (resource.sys.len()+resource.gfx.len()) as u64,
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
    let lod = req.detail.or_else(|| lods.first().copied()).context("No drawable LOD has triangles")?;
    ensure!(lods.contains(&lod), "Drawable LOD is missing");
    let title = info.name.as_deref().unwrap_or(&req.name);
    let file = "model.glb";
    let triangles: usize = groups[lod].iter().flat_map(|group| &group.prims).map(|p| p.indices.len()/3).sum();
    let glb = gltf::mesh_glb(title,&groups[lod],&built.materials,&built.joints,json!({"lod":lod}));
    fs::write(out.join(file),glb)?;
    Ok(json!({"type":"model","file":file,"name":title,"items":members,"lods":lods,"detail":lod,
        "index":req.index,"triangles":triangles,"warnings":item.warnings}))
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
    let mut data = fs::read(out.join("entry.bin"))?;
    if request.kind=="bank" { return sound(&request,&data,&out); }
    let size=request.system_size.context("Missing RAGE system page size")?;
    if size==0 || size>data.len() { bail!("Invalid RAGE resource page sizes"); }
    let gfx=data.split_off(size);
    let resource=Resource{sys:data,gfx,gfx_base:0};
    match request.kind.as_str() {
        "model" => model(&request,&resource,&out),
        "textures" => textures(&request,&resource,&out),
        _ => bail!("Unknown preview kind"),
    }
}

fn main() -> Result<()> {
    println!("{}",run()?);
    Ok(())
}
