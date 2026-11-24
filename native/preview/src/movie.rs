use anyhow::{ensure, Context, Result};
use bink2::{Container, Decoder, VideoFrame};
use serde_json::{json, Value};
use std::{ffi::OsString, fs::{self, File}, io::{self, BufRead, BufWriter, Read, Seek, SeekFrom, Write}, path::Path,
    sync::mpsc::{self, RecvTimeoutError}, thread, time::{Duration, Instant}};

const MOVIE_LIMIT: u64 = 512 * 1024 * 1024;
const DISPLAY_WIDTH: usize = 640;
const DISPLAY_HEIGHT: usize = 1080;
const HEADER: u32 = 0x50504652;
const FRAME: u32 = 0x4d415246;
const STATUS: u32 = 0x54415453;

fn bounded_container(bytes: &[u8]) -> Result<Container<'_>> {
    let file = Container::parse(bytes)?;
    let h = &file.header;
    ensure!(u64::from(h.width) * u64::from(h.height) <= 3840 * 2160 && h.fps_num > 0 && h.fps_den > 0,
        "The source exceeds the built-in Bink preview limits");
    Ok(file)
}

fn packet(out: &mut impl Write, fields: &[u32]) -> io::Result<()> {
    for value in fields { out.write_all(&value.to_le_bytes())?; }
    Ok(())
}

fn pixels(frame: &VideoFrame, width: usize, height: usize, output: &mut [u8]) {
    let (sw, sh) = (frame.width as usize, frame.height as usize);
    let chroma_width = sw.div_ceil(2);
    let quantize = |v: i32| v.clamp(0,255) as u8;
    for row in 0..height {
        let y = row * sh / height;
        for column in 0..width {
            let x = column * sw / width;
            let source = y * sw + x;
            let chroma = y / 2 * chroma_width + x / 2;
            let luma = i32::from(frame.y[source]);
            let uv = i32::from(frame.u[chroma]) - 128;
            let vv = i32::from(frame.v[chroma]) - 128;
            let offset = (row * width + column) * 4;
            // The existing desktop protocol carries BGRA.
            output[offset..offset+4].copy_from_slice(&[quantize(luma+(454*uv+128)/256),
                quantize(luma-(88*uv+183*vv+128)/256), quantize(luma+(359*vv+128)/256),
                frame.alpha.as_ref().map_or(255,|plane| plane[source])]);
        }
    }
}

fn show(decoder: &mut Decoder, file: &Container, frame: usize, playing: bool, size: (usize,usize),
    raster: &mut [u8], out: &mut impl Write) -> Result<()> {
    let source = file.frame(frame)?;
    let image = decoder.decode(source.video, source.keyframe)?;
    pixels(&image,size.0,size.1,raster);
    packet(out,&[FRAME,(frame+1) as u32,raster.len() as u32,playing as u32])?;
    out.write_all(raster)?;
    out.flush()?;
    Ok(())
}

fn status(out: &mut impl Write, frame: usize, playing: bool, ended: bool) -> io::Result<()> {
    packet(out,&[STATUS,(frame+1) as u32,playing as u32,ended as u32])?;
    out.flush()
}

pub fn play(args: Vec<OsString>) -> Result<()> {
    let path = args.first().context("Missing Bink source path")?;
    let number = |index| -> Result<u64> { Ok(args.get(index).and_then(|v: &OsString| v.to_str()).context("Missing Bink source extent")?.parse()?) };
    let (offset,length)=(number(1)?,number(2)?);
    ensure!((48..=MOVIE_LIMIT).contains(&length),"The built-in player opens Bink 2 movies up to 512 MiB");
    let mut original=File::open(path)?;
    ensure!(offset.checked_add(length).is_some_and(|end| end<=original.metadata().map(|m|m.len()).unwrap_or(0)),
        "The movie extends beyond the local source");
    original.seek(SeekFrom::Start(offset))?;
    let mut data=vec![0;length as usize];
    original.read_exact(&mut data)?;
    let file=bounded_container(&data)?;
    let h=&file.header;
    let scale=(DISPLAY_WIDTH as f64/f64::from(h.width)).min(DISPLAY_HEIGHT as f64/f64::from(h.height)).min(1.0);
    let size=((f64::from(h.width)*scale).round().max(1.0) as usize,(f64::from(h.height)*scale).round().max(1.0) as usize);
    let mut raster=vec![0;size.0*size.1*4];
    let mut out=BufWriter::new(io::stdout().lock());
    packet(&mut out,&[HEADER,1,size.0 as u32,size.1 as u32,h.width,h.height,h.num_frames,h.fps_num,h.fps_den,h.audio_tracks.len() as u32,0])?;
    let mut decoder=Decoder::new(h)?;
    let mut current=0;
    let mut playing=false;
    let mut looping=false;
    show(&mut decoder,&file,current,playing,size,&mut raster,&mut out)?;
    let (send,commands)=mpsc::sync_channel(32);
    thread::spawn(move || {
        for line in io::stdin().lock().lines().map_while(std::result::Result::ok) {
            if send.send(line).is_err() { break; }
        }
    });
    let interval=Duration::from_secs_f64((f64::from(h.fps_den)/f64::from(h.fps_num)).clamp(1.0/240.0,1.0));
    let mut deadline=Instant::now()+interval;
    loop {
        let input=if playing { commands.recv_timeout(deadline.saturating_duration_since(Instant::now())) }
            else { commands.recv().map_err(|_|RecvTimeoutError::Disconnected) };
        let (action,value)=match &input {
            Ok(line)=>line.split_once(' ').unwrap_or((line.as_str(),"")),
            Err(RecvTimeoutError::Timeout)=>("TICK",""),
            Err(RecvTimeoutError::Disconnected)=>break,
        };
        let mut target=current;
        match action {
            "PLAY"=>{ playing=true; deadline=Instant::now()+interval; if current+1==file.num_frames() { target=0; } }
            "PAUSE"=>playing=false,
            "STEP"=>{ playing=false; target=(current+1).min(file.num_frames()-1); }
            "SEEK"=>{ playing=false; target=value.parse::<usize>()?.saturating_sub(1).min(file.num_frames()-1); }
            "LOOP"=>{ looping=value=="1"; continue; }
            "VOLUME"=>continue,
            "TICK"=>{
                if current+1<file.num_frames() { target=current+1; }
                else if looping { target=0; }
                else { playing=false; }
                deadline=Instant::now()+interval;
            }
            _=>continue,
        }
        if target!=current {
            if target != current+1 {
                decoder=Decoder::new(h)?;
                let start=h.frames[..=target].iter().rposition(|frame|frame.keyframe).unwrap_or(0);
                for index in start..target {
                    let packet=file.frame(index)?;
                    decoder.decode(packet.video,packet.keyframe)?;
                }
            }
            current=target;
            show(&mut decoder,&file,current,playing,size,&mut raster,&mut out)?;
            if playing { deadline=Instant::now()+interval; }
        } else { status(&mut out,current,playing,!playing&&current+1==file.num_frames())?; }
    }
    Ok(())
}

pub fn tracks(data: &[u8], index: Option<usize>, out: &Path) -> Result<Value> {
    let file=bounded_container(data)?;
    let tracks=&file.header.audio_tracks;
    ensure!(!tracks.is_empty(),"This Bink movie has no audio tracks");
    let index=index.or_else(||tracks.iter().position(|track|track.is_dct())).unwrap_or(0);
    let track=tracks.get(index).context("Bink audio track is missing")?;
    let items:Vec<_>=tracks.iter().map(|track|json!({"id":format!("{:08x}",track.id),
        "seconds":f64::from(file.header.num_frames)*f64::from(file.header.fps_den)/f64::from(file.header.fps_num),
        "channels":if track.is_stereo() {2} else {1},"codec":if track.is_dct() {"Bink DCT"} else {"Bink RDFT"},
        "exportable":track.is_dct()})).collect();
    if !track.is_dct() { return Ok(json!({"type":"bank","items":items,"index":index,"tracks":[],"note":"Bink RDFT is unavailable in the built-in decoder."})); }
    ensure!(f64::from(file.header.num_frames)*f64::from(file.header.fps_den)/f64::from(file.header.fps_num)<=900.0,
        "The audio track exceeds the built-in WAV export limit");
    let (pcm,rate,channels)=bink2::decode_track(&file,index)?;
    ensure!(!pcm.is_empty(),"No PCM samples in the selected Bink track");
    let length=u32::try_from(pcm.len()*2)?;
    let alignment=channels*2;
    let mut wav=BufWriter::new(fs::File::create(out.join("track.wav"))?);
    wav.write_all(b"RIFF")?;
    packet(&mut wav,&[length.checked_add(36).context("Audio too large for WAV")?])?;
    wav.write_all(b"WAVEfmt ")?;
    packet(&mut wav,&[16])?;
    wav.write_all(&1u16.to_le_bytes())?;
    wav.write_all(&channels.to_le_bytes())?;
    packet(&mut wav,&[rate,rate*u32::from(alignment)])?;
    wav.write_all(&alignment.to_le_bytes())?;
    wav.write_all(&16u16.to_le_bytes())?;
    wav.write_all(b"data")?;
    packet(&mut wav,&[length])?;
    for sample in pcm { wav.write_all(&sample.to_le_bytes())?; }
    wav.flush()?;
    Ok(json!({"type":"bank","items":items,"index":index,"tracks":[{"name":"Bink PCM","file":"track.wav","playable":true}]}))
}
