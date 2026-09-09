import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: (options: { filters?: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke('dialog:openFile', options),
  openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
  getBackendPort: () => ipcRenderer.invoke('get:backendPort'),
  getAppVersion: () => ipcRenderer.invoke('get:appVersion'),
  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
  // Prompts for a folder and copies a local file there — see
  // electron/main.ts's fs:saveFileToChosenFolder. Returns the saved path,
  // or null if the user cancelled the folder picker.
  saveFileToChosenFolder: (sourcePath: string) => ipcRenderer.invoke('fs:saveFileToChosenFolder', sourcePath),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  platform: process.platform,

  // Telegram login — see electron/main.ts's telegram-login:open handler.
  openTelegramLogin: (code: string) => ipcRenderer.invoke('telegram-login:open', code),
  // Opens a real Telegram chat with someone by username — see electron/main.ts's telegram:open-chat handler.
  openTelegramChat: (username: string) => ipcRenderer.invoke('telegram:open-chat', username),

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // Background mode (tray) — local-only window-management preference, not
  // part of the backend's AppSettings (see electron/main.ts).
  getBackgroundMode: () => ipcRenderer.invoke('get:backgroundMode'),
  setBackgroundMode: (enabled: boolean) => ipcRenderer.invoke('set:backgroundMode', enabled),

  // Auto-update
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback: (status: Record<string, unknown>) => void) => {
    const listener = (_event: unknown, status: Record<string, unknown>) => callback(status)
    ipcRenderer.on('update:status', listener)
    return () => ipcRenderer.removeListener('update:status', listener)
  },
  onBetaAvailable: (callback: (info: Record<string, unknown>) => void) => {
    const listener = (_event: unknown, info: Record<string, unknown>) => callback(info)
    ipcRenderer.on('update:beta-available', listener)
    return () => ipcRenderer.removeListener('update:beta-available', listener)
  },
})
