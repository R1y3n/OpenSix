
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function unwrap(reply) {
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

contextBridge.exposeInMainWorld('opensix', {
  about: () => ipcRenderer.invoke('opensix:about').then(unwrap),
  updates: {
    state: () => ipcRenderer.invoke('opensix:update-state').then(unwrap),
    check: () => ipcRenderer.invoke('opensix:update-check').then(unwrap),
    set: options => ipcRenderer.invoke('opensix:update-set', options).then(unwrap),
    open: () => ipcRenderer.invoke('opensix:update-open').then(unwrap),
    onAvailable: callback => { ipcRenderer.on('opensix:update-available', (_event, result) => callback(result)); },
  },
  request: (path, payload) => ipcRenderer.invoke('opensix:request', path, payload).then(unwrap),
  save: (archive, entry, stored, mip) => ipcRenderer.invoke('opensix:save', archive, entry, stored, mip).then(unwrap),
  choose: kind => ipcRenderer.invoke('opensix:choose',kind).then(unwrap),
  savePreview: (id,name,suggested) => ipcRenderer.invoke('opensix:save-preview',id,name,suggested).then(unwrap),
  saveReport: (archive,kind) => ipcRenderer.invoke('opensix:save-report',archive,kind).then(unwrap),
  createArchive: path => ipcRenderer.invoke('opensix:create-archive',path).then(unwrap),
  saveBatch: input => ipcRenderer.invoke('opensix:save-batch',input).then(unwrap),
  library: (route,payload) => ipcRenderer.invoke('opensix:library',route,payload).then(unwrap),
  exportModel: (archive,entry,format) => ipcRenderer.invoke('opensix:export-model',archive,entry,format).then(unwrap),
  copy: text => ipcRenderer.invoke('opensix:copy',text).then(unwrap),
  reveal: path => ipcRenderer.invoke('opensix:reveal',path).then(unwrap),
});
