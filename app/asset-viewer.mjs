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
  const button=element('button',text);
  button.type='button';
  button.addEventListener('click',async()=>{
    button.disabled=true;
    try { await save(name); }
    finally { button.disabled=false; }
  });
  parent.append(button);
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
  }).catch(error=>{ if(!disposed) onError(error); });
  renderer.setAnimationLoop(()=>{
    control.update();
    renderer.render(scene,camera);
  });
  return ()=>{
    disposed=true;
    renderer.setAnimationLoop(null);
    resize.disconnect();
    control.dispose();
    if (loaded) release(loaded);
    renderer.dispose();
  };
}

export function renderAsset(parent,result,select,save,onError) {
  if (result.type==='model') {
    if (result.items.length) picker(parent,'Drawable',[[-1,'All drawables'],...result.items.map((item,i)=>[i,item])],result.index??-1,i=>select(i<0 ? null : i,null));
    if (result.lods.length>1) picker(parent,'Detail level',result.lods.map(n=>[n,'LOD '+n]),result.detail,n=>select(result.index,n));
    parent.append(element('p',result.triangles.toLocaleString()+' triangles'));
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
