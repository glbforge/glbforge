const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companion', {
  onCommand: (fn) => ipcRenderer.on('companion:cmd', (_e, msg) => fn(msg)),
  onStream: (fn) => ipcRenderer.on('companion:stream', (_e, msg) => fn(msg)),
  onDrag: (fn) => ipcRenderer.on('companion:drag', (_e, msg) => fn(msg)),
  reply: (id, ok, result, error) => ipcRenderer.send('companion:reply', { id, ok, result, error }),
  state: (patch) => ipcRenderer.send('companion:state', patch),
  event: (e) => ipcRenderer.send('companion:event', e),
  chat: (text) => ipcRenderer.invoke('companion:chat', { text }),
  dragStart: () => ipcRenderer.send('companion:drag-start'),
  dragEnd: () => ipcRenderer.invoke('companion:drag-end'),
  cursor: () => ipcRenderer.invoke('companion:cursor'),
});
