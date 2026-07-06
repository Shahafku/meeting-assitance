import { contextBridge, ipcRenderer } from 'electron'
import type { CopilotApi, CopilotEvent } from '../shared/api'
import type { StartSessionInput } from '../shared/types'

const api: CopilotApi = {
  listPresets: () => ipcRenderer.invoke('presets:list'),
  startSession: (input: StartSessionInput) => ipcRenderer.invoke('session:start', input),
  endSession: () => ipcRenderer.invoke('session:end'),
  getCurrentSession: () => ipcRenderer.invoke('session:current'),
  summon: () => ipcRenderer.invoke('summon'),
  rateSuggestion: (id, rating) => ipcRenderer.invoke('suggestion:rate', id, rating),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  getSessionDetail: (id) => ipcRenderer.invoke('session:detail', id),
  deleteSession: (id) => ipcRenderer.invoke('session:delete', id),
  pickContextFiles: () => ipcRenderer.invoke('context:pick-files'),
  sendAudioChunk: (buf) => ipcRenderer.send('audio:chunk', buf),
  onEvent: (cb: (evt: CopilotEvent) => void) => {
    const listener = (_e: unknown, payload: CopilotEvent) => cb(payload)
    ipcRenderer.on('copilot:event', listener)
    return () => ipcRenderer.removeListener('copilot:event', listener)
  }
}

contextBridge.exposeInMainWorld('copilot', api)
