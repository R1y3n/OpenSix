use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use sixng_core::{cloth, drawable, gltf, groom, meta7a, navmesh, pso, ptfx, resource::Resource, scriptdoc, text, timecycle};
use std::{fmt::Write, fs, path::Path};

fn report(out: &Path, title: &str, data: Value, extra: &[(&str, &str)]) -> Result<Value> {
    let bytes = serde_json::to_vec_pretty(&data)?;
    fs::write(out.join("report.json"), &bytes)?;
    let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(32 * 1024)]);
    let mut files = vec![json!({"name":"Save JSON", "file":"report.json"})];
    files.extend(extra.iter().map(|(name, file)| json!({"name":name,"file":file})));
    Ok(json!({"type":"toolReport","title":title,"value":preview,"files":files}))
}

fn csv_field(value: &str) -> String {
    // Quoting alone does not suppress formulas when a spreadsheet opens a CSV.
    let literal = value.trim_start().starts_with(['=', '+', '-', '@']);
    format!("\"{}{}\"", if literal { "'" } else { "" }, value.replace('"', "\"\""))
}

pub fn unpaged(kind: &str, data: &[u8], out: &Path) -> Result<Value> {
    match kind {
        "toolText" => {
            ensure!(text::is_text_table(data), "Choose a decoded 0DRP localization table");
            let strings = text::parse(data)?;
            ensure!(!strings.is_empty(), "The localization table has no strings");
            let mut csv = String::from("Hash,Text\r\n");
            let rows: Vec<_> = strings.iter().map(|(hash, value)| {
                let hash = format!("0x{hash:08x}");
                let _ = write!(csv, "{hash},{}\r\n", csv_field(value));
                json!({"hash":hash,"text":value})
            }).collect();
            fs::write(out.join("strings.csv"), csv)?;
            let mut result = report(out, "Localization table", json!({"rows":rows}), &[("Save CSV", "strings.csv")])?;
            result["table"] = json!({"count":rows.len(),"columns":["hash","text"]});
            Ok(result)
        }
        "toolPso" | "toolHandling" | "toolScript" => {
            let data = pso::parse(data).context("Choose a decoded PSIN resource")?;
            let meta = data.meta();
            if kind == "toolHandling" {
                let mut records = Vec::new();
                for (&hash, structure) in &data.structs {
                    let has = |field| structure.members.iter().any(|member| member.hash == field);
                    if has(pso::HANDLING_NAME) && has(pso::HANDLING_COMPONENTS) {
                        records.extend(meta.objects(hash).into_iter().filter_map(|offset| meta.object(hash, offset, 0)));
                    }
                }
                ensure!(!records.is_empty(), "This PSIN resource has no vehicle handling records");
                return report(out, "Vehicle handling", json!({"count":records.len(),"records":records}), &[]);
            }
            if kind == "toolScript" {
                let decoded = data.to_json();
                let doc = scriptdoc::document(&decoded).context("This PSIN has no supported script document")?;
                let (xml, _) = scriptdoc::to_xml(doc).context("The script document could not be serialized")?;
                fs::write(out.join("script.xml"), xml)?;
                return report(out, "Script document", doc.clone(), &[("Save XML", "script.xml")]);
            }
            let root = data.root_json(7).context("The PSIN root could not be decoded")?;
            report(out, "Typed PSIN", json!({"schema":meta.schema(),"root":root}), &[])
        }
        "toolTimecycle" => {
            let content = std::str::from_utf8(data)?.trim_start_matches('\u{feff}');
            let root = timecycle::parse_xml(content).context("Choose a timecycle or weather XML resource")?;
            let kind = timecycle::doc_kind(&root).context("This XML is not a recognized timecycle document")?;
            report(out, "Timecycle and weather", json!({"kind":format!("{kind:?}",),
                "document":timecycle::to_json(&root),"samples":timecycle::time_samples(&root)}), &[])
        }
        _ => bail!("Unknown standalone inspection tool"),
    }
}

pub fn resource(kind: &str, asset: &Resource, name: &str, roads: bool, out: &Path) -> Result<Value> {
    match kind {
        "toolNavmesh" => {
            let mesh = navmesh::decode(asset).context("Choose a GTA VI navigation mesh tile")?;
            let road_count = mesh.polys.iter().filter(|(flags,_)| flags & navmesh::ROAD != 0).count();
            let glb = mesh.glb(name, roads, json!({"areaId":mesh.area_id})).context("No polygons match this navigation filter")?;
            fs::write(out.join("model.glb"), glb)?;
            let data = json!({"areaId":mesh.area_id,"bounds":mesh.bbox,"roadPolygons":road_count,
                "vertices":mesh.vertices,"polygons":mesh.polys});
            let mut result = report(out, "Navigation mesh", data, &[("Save GLB", "model.glb"),("Save FBX", "model.fbx")])?;
            let triangles: usize = mesh.polys.iter().filter(|(flags,_)| !roads || flags & navmesh::ROAD != 0)
                .map(|(_, indices)| indices.len()-2).sum();
            result["mesh"] = json!({"type":"model","items":[],"lods":[],"triangles":triangles,"file":"model.glb"});
            Ok(result)
        }
        "toolMap" => {
            let map = meta7a::map_file(asset,&Default::default()).context("Choose a decoded map placement resource")?;
            report(out, "Map placements", serde_json::to_value(map)?, &[])
        }
        "toolGroom" => {
            let groom = groom::parse(asset)?;
            ensure!(groom.points_per_strand>1 && groom.points.len()==groom.strands*groom.points_per_strand,
                "The groom has no complete guide strands");
            ensure!(groom.points.iter().flatten().all(|value|value.is_finite()),"The groom has non-finite guide coordinates");
            let mut bundle=Vec::with_capacity(16+asset.sys.len()+asset.gfx.len());
            bundle.extend_from_slice(b"OS6GRM01");
            bundle.extend_from_slice(&u32::try_from(asset.sys.len())?.to_le_bytes());
            bundle.extend_from_slice(&u32::try_from(asset.gfx.len())?.to_le_bytes());
            bundle.extend_from_slice(&asset.sys);
            bundle.extend_from_slice(&asset.gfx);
            fs::write(out.join("guides.osgroom"),bundle)?;
            let mut obj = String::from("# OpenSix groom guides. Source axes and units.\n");
            for [x,y,z] in &groom.points { writeln!(obj,"v {x} {y} {z}")?; }
            for start in (0..groom.points.len()).step_by(groom.points_per_strand) {
                obj.push('l');
                for index in start..start+groom.points_per_strand { write!(obj," {}",index+1)?; }
                obj.push('\n');
            }
            fs::write(out.join("guides.obj"),obj)?;
            let mut result=report(out,"Hair and fur guides",json!({"strands":groom.strands,"pointsPerStrand":groom.points_per_strand,
                "points":groom.points,"roots":groom.roots,"lengths":groom.lengths,"boneHashes":groom.bones,
                "bounds":groom.root_box,"rootUv":groom.root_uv,"strandsPerTriangle":groom.tri_counts,
                "width":groom.width,"taper":groom.taper}),&[("Save guide OBJ","guides.obj"),("Save groom bundle","guides.osgroom")])?;
            if groom.points.len()<=250_000 {
                let (positions,normals,uvs,indices)=groom.ribbons((groom.width*0.5).max(0.0004));
                let triangles=indices.len()/3;
                let prim=gltf::TriPrim{name:"Guide ribbons".into(),positions,normals:Some(normals),tangents:None,uvs:vec![uvs],
                    colors:None,tint:None,indices,material:Some(0),joints:None,weights:None,joints1:None,weights1:None};
                let group=gltf::NodeGroup{name:"Strand guides".into(),prims:vec![prim]};
                let material=gltf::Material{name:"Guide display".into(),base_color_uri:None,normal_uri:None,
                    gltf:json!({"doubleSided":true,"emissiveFactor":[0.12,0.55,0.42],"pbrMetallicRoughness":{
                        "baseColorFactor":[0.25,0.75,0.62,1.0],"metallicFactor":0.0,"roughnessFactor":1.0}}),extras:Value::Null};
                fs::write(out.join("model.glb"),gltf::mesh_glb(name,&[group],&[material],&[],json!({"guideCount":groom.strands})))?;
                result["mesh"]=json!({"type":"model","items":[],"lods":[],"triangles":triangles,"file":"model.glb"});
            }
            Ok(result)
        }
        "toolCloth" => {
            let cloth = cloth::parse(asset,&Default::default())?;
            ensure!(!cloth.sets.is_empty(),"The cloth has no constraint sets");
            let mut obj = String::from("# OpenSix cloth constraints. Source axes and units.\n");
            let mut vertex = 1;
            let mut sets = Vec::new();
            for (index, set) in cloth.sets.iter().enumerate() {
                writeln!(obj,"g set_{}",index+1)?;
                for [x,y,z,_] in &set.particles { writeln!(obj,"v {x} {y} {z}")?; }
                let mut edges = Vec::new();
                for edge in &set.edges {
                    writeln!(obj,"l {} {}",vertex+usize::from(edge.a),vertex+usize::from(edge.b))?;
                    edges.push(json!({"a":edge.a,"b":edge.b,"rest":edge.rest,"stiffness":edge.k,"flags":edge.flags}));
                }
                vertex+=set.particles.len();
                sets.push(json!({"particles":set.particles,"edges":edges}));
            }
            fs::write(out.join("constraints.obj"),obj)?;
            report(out,"Cloth constraints",json!({"soft":cloth.soft,"sets":sets}),&[("Save constraint OBJ","constraints.obj")])
        }
        "toolParticles" => {
            let info = drawable::describe(asset);
            ensure!(ptfx::is_ptfx(&info),"Choose a supported GTA VI particle dictionary");
            let dictionary = ptfx::describe(name,(asset.sys.len()+asset.gfx.len()) as u64,&info);
            let rules = ptfx::rules(asset,&info).context("The particle dictionary has no decoded rules")?;
            report(out,"Particle effects",json!({"dictionary":dictionary,"rules":rules,"keyframes":ptfx::keyframes(asset,&info)}),&[])
        }
        _ => bail!("Unknown resource inspection tool"),
    }
}
