/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    VITE_DEV_SERVER_URL: string
    APP_ROOT: string
    VITE_PUBLIC: string
    RH_DATA_DIR: string
    RH_RESOURCES_DIR: string
  }
}

interface Window {
  electronAPI?: {
    openFile: (options: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
    openDirectory: () => Promise<string | null>
    getBackendPort: () => Promise<number>
    getAppVersion: () => Promise<string>
    openPath: (path: string) => Promise<void>
    platform: string
    minimize: () => void
    maximize: () => void
    close: () => void
    checkForUpdate: () => Promise<void>
    downloadUpdate: () => Promise<void>
    installUpdate: () => Promise<void>
    onUpdateStatus: (callback: (status: Record<string, unknown>) => void) => () => void
  }
}
