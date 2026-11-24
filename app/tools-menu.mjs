import { renderAsset } from './asset-viewer.mjs';

const node = (tag, text) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};

function action(label, callback) {
  const button = node('button', label);
  button.type = 'button';
  button.addEventListener('click', callback);
  return button;
}

function mapView(host, map) {
  const image = node('canvas');
  image.width = map.width;
  image.height = map.height;
  const img = image.getContext('2d');
  const pixels = img.createImageData(map.width,map.height);
  const heights=atob(map.value);
  for (let i=0;i<heights.length;i++) {
    const elevation=heights.charCodeAt(i);
    const t=Math.sqrt(Math.max(0,elevation-map.water)/Math.max(1,255-map.water));
    pixels.data.set(elevation>map.water ? [37+196*t,103+125*t,75+150*t,255] : [12,36,72,255],4*i);
  }
  img.putImageData(pixels,0,0);

  const canvas=node('canvas');
  canvas.className='tool-map';
  canvas.setAttribute('aria-label','Terrain map. Drag to pan and use the zoom buttons to change scale.');
  const position=node('p');
  position.className='quiet';
  const baseline=map.sourceWidth+' × '+map.sourceHeight+' source samples · downsampled view';
  position.textContent=baseline;
  const controls=node('div');
  controls.className='tool-actions';
  const ctx=canvas.getContext('2d');
  let zoom=1,x=0,y=0,drag=null,box;
  function draw() {
    const w=canvas.clientWidth,h=canvas.clientHeight;
    if (!w || !h) return;
    const density=Math.min(devicePixelRatio,2);
    canvas.width=Math.round(w*density);
    canvas.height=Math.round(h*density);
    ctx.setTransform(density,0,0,density,0,0);
    const scale=Math.min(w/map.width,h/map.height)*zoom;
    box={left:(w-map.width*scale)/2+x,top:(h-map.height*scale)/2+y,width:map.width*scale,height:map.height*scale};
    ctx.drawImage(image,box.left,box.top,box.width,box.height);
  }
  const magnify = factor => { zoom=Math.min(20,Math.max(1,zoom*factor)); draw(); };
  controls.append(action('Zoom in',()=>magnify(1.25)),action('Zoom out',()=>magnify(0.8)),
    action('Reset view',()=>{ zoom=1; x=0; y=0; draw(); }));
  host.append(controls,canvas,position);
  canvas.addEventListener('pointerdown',event=>{
    if (event.button!==0) return;
    drag={x:event.clientX,y:event.clientY};
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('lostpointercapture',()=>{ drag=null; });
  canvas.addEventListener('pointerleave',()=>{ position.textContent=baseline; });
  canvas.addEventListener('pointermove',event=>{
    if (drag) {
      x+=event.clientX-drag.x;
      y+=event.clientY-drag.y;
      drag={x:event.clientX,y:event.clientY};
      draw();
    }
    if (!box) return;
    const u=(event.offsetX-box.left)/box.width,v=(event.offsetY-box.top)/box.height;
    if (u<0 || v<0 || u>=1 || v>=1) { position.textContent=baseline; return; }
    const [minX,minY,minZ,maxX,maxY,maxZ]=map.bounds;
    const sample=heights.charCodeAt(Math.floor(v*map.height)*map.width+Math.floor(u*map.width));
    position.textContent='X '+(minX+u*(maxX-minX)).toFixed(1)+' · Y '+(minY+v*(maxY-minY)).toFixed(1)+
      ' · sample elevation '+(minZ+sample/255*(maxZ-minZ)).toFixed(1)+' m';
  });
  const observer=new ResizeObserver(draw);
  observer.observe(canvas);
  draw();
  return ()=>observer.disconnect();
}

export function setupTools({ current, openPool, openFound, notify }) {
  const el=id=>document.getElementById(id);
  const menu=document.querySelector('.app-menu');
  const dialog=el('tool-dialog'), output=el('tool-output');
  const status=el('tool-status'), selected=el('tool-selected'), browse=el('tool-browse');
  let kind, source, revision=0, dispose;
  const api=(route,payload)=>window.opensix.request('/api/'+route,payload);
  function showStatus(text='',error=false) {
    status.textContent=text;
    status.hidden=!text;
    status.dataset.error=String(error);
  }
  function clearOutput() {
    dispose?.();
    dispose=null;
    output.replaceChildren();
  }
  function showDialog(title, search=false) {
    revision++;
    clearOutput();
    showStatus();
    el('tool-title').textContent=title;
    el('tool-source').hidden=search;
    el('tool-search-form').hidden=!search;
    el('tool-search-form').reset();
    el('tool-roads').checked=false;
    el('tool-road-filter').hidden=kind!=='toolNavmesh';
    browse.disabled=false;
    source=current();
    selected.disabled=!source.entry || ['archive','poolTexture','shaderRecord','gpuBvh'].includes(source.entry.kind);
    el('tool-selection').textContent=selected.disabled ? 'Select an archive entry or open a decoded file.' : source.entry.name;
    dialog.showModal();
  }
  function save(id,file) {
    return window.opensix.savePreview(id,file).then(name=>{ if (name) showStatus('Saved '+name+'.'); },
      error=>showStatus(error.message,true));
  }
  function localization(result, ticket) {
    const form=node('form'), query=node('input'), grid=node('div'), pager=node('div'), count=node('p');
    const picker=node('div');
    picker.className='path-picker';
    query.type='search';
    query.placeholder='Search by hash or text';
    query.setAttribute('aria-label','Search strings');
    query.maxLength=250;
    const find=node('button','Search');
    picker.append(query,find);
    form.append(picker);
    grid.className='tool-table tool-scroll';
    pager.className='tool-actions';
    let offset=0, pageRevision=0;
    const previous=action('Previous',()=>{ offset-=50; refresh(); });
    const next=action('Next',()=>{ offset+=50; refresh(); });
    pager.append(previous,next,count);
    output.append(form,grid,pager);
    async function refresh() {
      const page=++pageRevision;
      previous.disabled=next.disabled=true;
      try {
        const data=await api('tool-table',{id:result.id,query:query.value,offset});
        if (ticket!==revision || page!==pageRevision) return;
        const rows=data.rows.map(row=>{
          const line=node('div');
          line.append(node('code',row.hash),node('span',row.text));
          return line;
        });
        grid.replaceChildren(...rows);
        previous.disabled=offset===0;
        next.disabled=offset+50>=data.total;
        count.textContent=data.total ? (offset+1)+'–'+Math.min(data.total,offset+50)+' of '+data.total.toLocaleString() : 'No matching strings';
      } catch (error) { if (ticket===revision && page===pageRevision) showStatus(error.message,true); }
    }
    form.addEventListener('submit',event=>{ event.preventDefault(); offset=0; refresh(); });
    refresh();
  }
  async function run(path, index) {
    const ticket=++revision;
    clearOutput();
    showStatus('Reading source…');
    browse.disabled=selected.disabled=true;
    try {
      const result=await api('tool',{kind,path,index,archive:source.archive,entry:source.entry?.id,roads:el('tool-roads').checked});
      if (ticket!==revision) {
        if (result.type==='movie') await api('movie-command',{id:result.id,action:'close'});
        return;
      }
      showStatus();
      if (result.type==='heightmap') { dispose=mapView(output,result); return; }
      const select=choice=>run(path,choice);
      const onError=error=>showStatus(error.message,true);
      if (result.type!=='toolReport') {
        dispose=renderAsset(output,result,select,file=>save(result.id,file),onError);
        return;
      }
      const files=node('div');
      files.className='tool-actions';
      for (const file of result.files) {
        if (!result.mesh || !['model.glb','model.fbx'].includes(file.file)) {
          files.append(action(file.name,()=>save(result.id,file.file)));
        }
      }
      if (result.mesh) {
        // The modal uses the established 3D renderer. Its archive counterpart stays mounted.
        dispose=renderAsset(output,{...result.mesh,id:result.id},()=>{},file=>save(result.id,file),onError);
        output.append(files);
      } else {
        output.append(files);
        if (result.table) localization(result,ticket);
        else output.append(node('pre',result.value));
      }
    } catch(error) { if (ticket===revision) showStatus(error.message,true); }
    finally {
      if (ticket===revision) {
        browse.disabled=false;
        selected.disabled=!source.entry || ['archive','poolTexture','shaderRecord','gpuBvh'].includes(source.entry.kind);
      }
    }
  }

  for (const details of menu.querySelectorAll('details')) {
    const summary=details.querySelector('summary');
    summary.addEventListener('click',()=>{
      for (const other of menu.querySelectorAll('details[open]')) if (other!==details) other.open=false;
      for (const button of details.querySelectorAll('[data-archive-only]')) button.disabled=!current().archive;
    });
  }
  document.addEventListener('pointerdown',event=>{
    if (!menu.contains(event.target)) for (const details of menu.querySelectorAll('details[open]')) details.open=false;
  });
  menu.addEventListener('keydown',event=>{
    if (event.key==='Escape') {
      const details=event.target.closest('details');
      if (details?.open) { details.open=false; details.querySelector('summary').focus(); }
    }
  });
  menu.addEventListener('click',async event=>{
    const button=event.target.closest('button');
    if (!button || button.disabled) return;
    const details=button.closest('details');
    details.open=false;
    details.querySelector('summary').focus();
    kind=button.dataset.tool;
    const name=button.dataset.action;
    try {
      if (kind || name==='search') showDialog(button.textContent.replace(/…$/,''),name==='search');
      else if (name==='open') el('open').click();
      else if (name==='names') el('import-names').click();
      else if (name==='pool') await openPool();
      else if (name==='batch') {
        const {archive,query,scope,filter}=current();
        notify('Preparing extraction…');
        const result=await window.opensix.saveBatch({archive,query,scope,filter});
        notify(result ? ('Saved '+result.saved+' files to '+result.folder+'.'+(result.failed?' '+result.failed+' entries could not be extracted. See extraction-report.json.':'')) : '',Boolean(result?.failed));
      }
      else if (name==='create') {
        const folder=await window.opensix.choose('archive-files');
        if (folder) {
          const saved=await window.opensix.createArchive(folder);
          if (saved) notify('Created '+saved+'.');
        }
      }
      else {
        const saved=await window.opensix.saveReport(current().archive,name);
        if (saved) notify('Saved '+saved+'.');
      }
    } catch(error) { notify(error.message,true); }
  });
  el('tool-source').addEventListener('submit',event=>{event.preventDefault(); run();});
  browse.addEventListener('click',async()=>{
    try { const path=await window.opensix.choose('asset'); if (path && dialog.open) await run(path); }
    catch(error) { showStatus(error.message,true); }
  });
  el('tool-search-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const ticket=++revision;
    const query=el('tool-query').value;
    clearOutput();
    showStatus('Searching open archives…');
    try {
      const result=await api('workspace-search',{query});
      if (ticket!==revision) return;
      showStatus(result.total.toLocaleString()+' matches'+(result.total>result.rows.length?' · first '+result.rows.length+' shown':''));
      const list=node('div');
      list.className='tool-scroll';
      for (const row of result.rows) {
        const item=action('',()=>{ dialog.close(); openFound(row,query).catch(error=>notify(error.message,true)); });
        item.className='tool-result';
        item.append(node('span',row.entry.name),node('small',row.archiveName));
        list.append(item);
      }
      output.append(list);
    } catch(error) { if (ticket===revision) showStatus(error.message,true); }
  });
  el('close-tool').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{
    if (dialog.open) return;
    revision++;
    browse.disabled=false;
    clearOutput();
  });
}
