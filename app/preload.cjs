
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function unwrap(reply) {
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

contextBridge.exposeInMainWorld('opensix', {
  request: (path, payload) => ipcRenderer.invoke('opensix:request', path, payload).then(unwrap),
  save: (archive, entry, stored, mip) => ipcRenderer.invoke('opensix:save', archive, entry, stored, mip).then(unwrap),
  choose: kind => ipcRenderer.invoke('opensix:choose',kind).then(unwrap),
  savePreview: (id,name) => ipcRenderer.invoke('opensix:save-preview',id,name).then(unwrap),
  saveReport: (archive,kind) => ipcRenderer.invoke('opensix:save-report',archive,kind).then(unwrap),
});
