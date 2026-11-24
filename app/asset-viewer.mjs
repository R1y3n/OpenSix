import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const urlFor = (id,name) => '/asset-preview/'+id+'/'+encodeURIComponent(name);
const element = (tag,text) => {
  const el = document.createElement(tag);
  if (text) el.textContent=text;
  return el;
};

function picker(parent,label,choices,index,select) {
  const field=element('label',label);
  const options=element('select');
  for (const [value,title] of choices) {
    const option=element('option',title);
    option.value=value;
    options.append(option);
  }
  options.value=String(index);
  options.addEventListener('change',()=>select(Number(options.value)));
  field.append(options);
  parent.append(field);
}

function exportButton(parent,text,name,save) {
  const button=actionButton(parent,text,async()=>{
    button.disabled=true;
    try { await save(name); }
    finally { button.disabled=false; }
  });
}

function actionButton(parent,text,invoke) {
  const button=element('button',text);
  button.type='button';
  button.addEventListener('click',invoke);
  parent.append(button);
  return button;
}

function modelViewport(parent,url,onError) {
  const viewport=element('div');
  viewport.className='model-viewport';
  parent.append(viewport);
  let renderer;
  try { renderer=new THREE.WebGLRenderer({antialias:true}); }
  catch (error) { onError(error); return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  viewport.append(renderer.domElement);
  const scene=new THREE.Scene();
  scene.background=new THREE.Color('#170f24');
  const camera=new THREE.PerspectiveCamera(38,1,0.001,10_000);
  const control=new OrbitControls(camera,renderer.domElement);
  control.enableDamping=true;
  scene.add(new THREE.HemisphereLight(0xffffff,0x645070,2.3));
  const key=new THREE.DirectionalLight(0xffe5d9,2.4);
  key.position.set(3,6,4);
  scene.add(key);
  const resize=new ResizeObserver(()=>{
    const width=viewport.clientWidth,height=viewport.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width,height,false);
    camera.aspect=width/height;
    camera.updateProjectionMatrix();
  });
  resize.observe(viewport);
  let disposed=false;
  let loaded=null;
  let mixer=null;
  let animationAction=null;
  let animationTime=null;
  let previous=0;
  function release(object) {
    object.traverse(mesh=>{
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const material of [mesh.material].flat()) {
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      }
    });
  }
  new GLTFLoader().loadAsync(url).then(gltf=>{
    if (disposed) { release(gltf.scene); return; }
    loaded=gltf.scene;
    scene.add(loaded);
    const box=new THREE.Box3().setFromObject(loaded);
    if (box.isEmpty()) throw new Error('Decoded model has no renderable geometry.');
    const sphere=box.getBoundingSphere(new THREE.Sphere());
    control.target.copy(sphere.center);
    const radius=Math.max(sphere.radius,0.001);
    camera.position.copy(sphere.center).add(new THREE.Vector3(1.45,0.85,2.7).multiplyScalar(radius));
    camera.near=radius/150;
    camera.far=radius*200;
    camera.updateProjectionMatrix();
    viewport.dataset.ready='true';
    const clip=gltf.animations[0];
    if (clip) {
      mixer=new THREE.AnimationMixer(loaded);
      const action=mixer.clipAction(clip).play();
      const play=actionButton(parent,'Play animation',()=>{
        action.paused=!action.paused;
        play.textContent=action.paused?'Play animation':'Pause animation';
      });
      const time=element('input');
      time.type='range';
      time.setAttribute('aria-label','Animation position');
      time.min='0';
      time.max=String(clip.duration);
      time.step=String(1/60);
      time.value='0';
      time.addEventListener('input',()=>{action.time=Number(time.value); mixer.update(0);});
      parent.append(time);
      animationAction=action;
      animationTime=time;
      action.paused=true;
    }
  }).catch(error=>{ if(!disposed) onError(error); });
  renderer.setAnimationLoop(now=>{
    if (mixer) {
      if (previous) mixer.update(Math.min((now-previous)/1000,0.1));
      animationTime.value=String(animationAction.time);
    }
    previous=now;
    control.update();
    renderer.render(scene,camera);
  });
  return ()=>{
    disposed=true;
    renderer.setAnimationLoop(null);
    resize.disconnect();
    control.dispose();
    mixer?.stopAllAction();
    if (loaded) release(loaded);
    renderer.dispose();
  };
}

function movieViewport(parent,result,onError) {
  const canvas=element('canvas');
  canvas.width=result.width;
  canvas.height=result.height;
  canvas.setAttribute('aria-label','Bink video');
  const context=canvas.getContext('2d');
  const controls=element('div');
  const send=(action,value)=>window.opensix.request('/api/movie-command',{id:result.id,action,value}).catch(onError);
  let version=0, playing=false, disposed=false, timer;
  const play=actionButton(controls,'Play',()=>send(playing?'pause':'play'));
  actionButton(controls,'Next frame',()=>send('step'));
  const seek=element('input');
  seek.type='range';
  seek.setAttribute('aria-label','Video frame');
  seek.min='1';
  seek.max=String(result.frames);
  seek.value='1';
  seek.addEventListener('change',()=>send('seek',Number(seek.value)));
  const loop=element('input');
  loop.type='checkbox';
  loop.addEventListener('change',()=>send('loop',Number(loop.checked)));
  const loopLabel=element('label','Loop');
  loopLabel.prepend(loop);
  controls.append(seek,loopLabel);
  if (result.audio) {
    const volume=element('input');
    volume.type='range';
    volume.setAttribute('aria-label','Volume');
    volume.min='0';
    volume.max='100';
    volume.value='60';
    volume.addEventListener('change',()=>send('volume',Number(volume.value)));
    controls.append(volume);
  }
  parent.append(canvas,controls,element('p',result.sourceWidth+' × '+result.sourceHeight+' · '+result.fps.toFixed(2)+' FPS'));
  async function update() {
    try {
      const next=await window.opensix.request('/api/movie-frame',{id:result.id,version});
      if (disposed) return;
      if (next.pixels) {
        const image=new ImageData(new Uint8ClampedArray(next.pixels),result.width,result.height);
        context.putImageData(image,0,0);
      }
      version=next.version;
      playing=next.playing;
      play.textContent=playing?'Pause':'Play';
      if (!seek.matches(':active')) seek.value=String(next.number);
      timer=setTimeout(update,playing ? 25 : 100);
    } catch (error) { if (!disposed) onError(error); }
  }
  update();
  return ()=>{ disposed=true; clearTimeout(timer); send('close'); };
}

export function renderAsset(parent,result,select,save,onError,configureClip,arrange) {
  if (result.type==='movie') return movieViewport(parent,result,onError);
  if (result.type==='wardrobe') {
    picker(parent,'Kit',result.kits.map(kit=>[kit.index,kit.key+' · '+kit.members+' members']),
      result.index,index=>select(index,null));
    const data={selections:result.selections,warnings:result.warnings};
    parent.append(element('pre',JSON.stringify(data,null,2)));
    actionButton(parent,'Assemble wardrobe kit',()=>arrange('wardrobe',result));
    exportButton(parent,'Save JSON',result.file,save);
    return null;
  }
  if (result.type==='poolTexture') {
    if (result.mips>1) picker(parent,'Mip',Array.from({length:result.mips},(_,i)=>
      [result.baseMip+i,String(result.baseMip+i)]),result.mip,n=>select(null,n,0));
    if (result.slices>1) picker(parent,result.shape.includes('Cube') ? 'Face' : 'Slice',
      Array.from({length:result.slices},(_,i)=>[i,String(i)]),result.slice,n=>select(null,result.mip,n));
    parent.append(element('p',result.width+' × '+result.height+' · '+result.format));
    if (result.file) {
      const preview=element('img');
      preview.alt='Texture pool preview';
      preview.src=urlFor(result.id,result.file);
      parent.append(preview);
      exportButton(parent,'Save PNG',result.file,save);
    }
    return null;
  }
  if (result.type==='inspection') {
    if (result.clips?.length) {
      let index=0;
      picker(parent,'Clip',result.clips.map((clip,i)=>[i,clip.name]),index,value=>{index=value;});
      actionButton(parent,'Use clip on a model',()=>configureClip(result.clips[index],index));
    }
    parent.append(element('pre',result.value));
    exportButton(parent,'Save JSON',result.file,save);
    return null;
  }
  if (result.type==='model') {
    if (result.items.length) picker(parent,'Drawable',[[-1,'All drawables'],...result.items.map((item,i)=>[i,item])],result.index??-1,i=>select(i<0 ? null : i,null));
    if (result.lods.length>1) picker(parent,'Detail level',result.lods.map(n=>[n,'LOD '+n]),result.detail,n=>select(result.index,n));
    parent.append(element('p',result.triangles.toLocaleString()+' triangles'));
    if (result.embeddedLabel) parent.append(element('p','Embedded model label · '+result.embeddedLabel));
    if (result.materials?.length) {
      const trace=element('details');
      trace.append(element('summary','Material and texture sources'),element('pre',JSON.stringify(result.materials,null,2)));
      parent.append(trace);
    }
    if (result.animation) {
      const stats=result.animation.coverage;
      parent.append(element('p',result.animation.name+' · '+stats.channels+' channels · '+
        stats.bone_tracks_on_joints+'/'+stats.bone_tracks+' bone tracks mapped'));
      actionButton(parent,'Clear selected clip',()=>configureClip(null));
    }
    if (result.parts?.length) parent.append(element('p','Assembly parts · '+result.parts.join(', ')));
    if (result.wheelMounts?.length) parent.append(element('p','Wheel mounts · '+result.wheelMounts.join(', ')));
    if (result.warnings?.length) {
      const warnings=element('details');
      warnings.append(element('summary','Decoder messages'),element('pre',result.warnings.join('\n')));
      parent.append(warnings);
    }
    const cleanup=modelViewport(parent,urlFor(result.id,result.file),onError);
    exportButton(parent,'Save GLB',result.file,save);
    exportButton(parent,'Save FBX','model.fbx',save);
    return cleanup;
  }
  if (result.type==='textures') {
    picker(parent,'Texture',result.items.map((item,i)=>[i,item.name]),result.index,i=>select(i,0));
    const entry=result.items[result.index];
    if (entry.mips>1) picker(parent,'Mip',Array.from({length:entry.mips},(_,i)=>[i,String(i)]),result.detail,n=>select(result.index,n));
    parent.append(element('p',result.width+' × '+result.height+' · '+entry.format));
    if (result.file) {
      const image=element('img');
      image.alt=entry.name;
      image.src=urlFor(result.id,result.file);
      parent.append(image);
      exportButton(parent,'Save PNG',result.file,save);
    }
    return null;
  }
  picker(parent,'Audio stream',result.items.map((track,i)=>[i,track.id+' · '+track.codec+' · '+track.seconds.toFixed(2)+' s']),result.index,i=>select(i,null));
  for (const track of result.tracks) {
    const row=element('section');
    row.className='audio-track';
    row.append(element('p',track.name));
    if (track.playable) {
      const player=element('audio');
      player.controls=true;
      player.preload='metadata';
      player.src=urlFor(result.id,track.file);
      row.append(player);
    }
    exportButton(row,'Save '+track.file.split('.').at(-1).toUpperCase(),track.file,save);
    parent.append(row);
  }
  if (!result.tracks.length) parent.append(element('p','This stream has no decodable audio data.'));
  return null;
}
