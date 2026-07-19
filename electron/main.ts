import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn, execFile, ChildProcess } from 'node:child_process'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.join(__dirname, '..')

process.env.APP_ROOT = APP_ROOT

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const RENDERER_DIST = path.join(APP_ROOT, 'dist')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(APP_ROOT, 'public')
  : RENDERER_DIST

const BACKEND_PORT = 8765
let backendProcess: ChildProcess | null = null
let win: BrowserWindow | null = null

function startBackend() {
  const isDev = !!VITE_DEV_SERVER_URL

  let backendExe: string
  let backendArgs: string[] = []
  // Directory holding bundled binaries (ffmpeg/ffprobe) the backend needs at runtime.
  // Packaged: electron-builder copies resources/bin -> resourcesPath/bin.
  // Dev: point straight at the project's own resources/bin so behavior matches prod.
  let resourcesDir: string

  if (isDev) {
    // In dev: use python directly
    const backendDir = path.join(APP_ROOT, 'backend')
    const pythonExe = process.platform === 'win32' ? 'python' : 'python3'
    backendExe = pythonExe
    backendArgs = [path.join(backendDir, 'run.py'), '--port', String(BACKEND_PORT)]
    resourcesDir = path.join(APP_ROOT, 'resources', 'bin')
  } else {
    // In packaged app: use bundled PyInstaller exe
    const resourcesPath = process.resourcesPath
    const exeName = process.platform === 'win32' ? 'raccoonhouse-backend.exe' : 'raccoonhouse-backend'
    backendExe = path.join(resourcesPath, 'backend', exeName)
    backendArgs = ['--port', String(BACKEND_PORT)]
    resourcesDir = path.join(resourcesPath, 'bin')
  }

  if (isDev && !fs.existsSync(path.join(APP_ROOT, 'backend', 'main.py'))) {
    console.log('[main] Backend not found, skipping spawn (dev mode without backend)')
    return
  }

  if (!isDev && !fs.existsSync(backendExe)) {
    console.log('[main] Packaged backend not found:', backendExe)
    return
  }

  console.log('[main] Starting backend:', backendExe, backendArgs.join(' '))
  backendProcess = spawn(backendExe, backendArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RH_DATA_DIR: app.getPath('userData'), RH_RESOURCES_DIR: resourcesDir },
  })

  backendProcess.stdout?.on('data', (d) => console.log('[backend]', d.toString().trim()))
  backendProcess.stderr?.on('data', (d) => console.error('[backend]', d.toString().trim()))
  backendProcess.on('exit', (code) => console.log('[main] Backend exited with code', code))
}

function stopBackend() {
  if (!backendProcess || backendProcess.pid == null) return
  const pid = backendProcess.pid
  backendProcess = null

  if (process.platform === 'win32') {
    // Node's ChildProcess.kill() on Windows only terminates the immediate
    // process — anything the backend itself spawned (ffmpeg, a mid-encode
    // subprocess) is left running as an orphan. `taskkill /T` kills the
    // whole process tree instead, which is what actually stops everything.
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {})
  } else {
    try { process.kill(pid) } catch { /* already gone */ }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#0F0F11',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0F0F11',
      symbolColor: '#E8E8F0',
      height: 32,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    icon: path.join(process.env.VITE_PUBLIC!, 'icon.png'),
  })

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toISOString())
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// --- Auto-update (GitHub Releases) ---
function sendUpdateStatus(status: string, extra?: Record<string, unknown>) {
  win?.webContents.send('update:status', { status, ...extra })
}

const AUTO_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

function initAutoUpdater() {
  if (!app.isPackaged) return // electron-updater needs a real packaged build + app-update.yml

  // Download as soon as an update is found, and — if the user never clicks
  // "Перезапустити й встановити" themselves — install it silently the next
  // time the app closes normally, instead of requiring them to babysit an
  // installer window. Either path runs the NSIS installer with its silent
  // flag (see quitAndInstall(true, ...) below), so no installer UI ever
  // appears either way.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }))
  autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'))
  autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err.message }))
  autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info.version }))

  const check = () => autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed', err))
  check()
  // Nobody has to remember to click "Перевірити зараз" — this keeps checking
  // in the background for as long as the app stays open.
  setInterval(check, AUTO_CHECK_INTERVAL_MS)
}

ipcMain.handle('update:check', () => {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed', err))
})

ipcMain.handle('update:install', () => {
  // (isSilent, isForceRunAfter) — isSilent=true skips the NSIS installer's
  // own wizard UI entirely (runs with the standard silent-install flag), so
  // clicking this just closes the app, installs invisibly, and reopens it.
  autoUpdater.quitAndInstall(true, true)
})

// IPC Handlers
ipcMain.handle('dialog:openFile', async (_event, options) => {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    ...options,
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('dialog:openDirectory', async () => {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('get:backendPort', () => BACKEND_PORT)
ipcMain.handle('get:appVersion', () => app.getVersion())

ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
  await shell.openPath(filePath)
})

// Window controls
ipcMain.on('window:minimize', () => win?.minimize())
ipcMain.on('window:maximize', () => {
  if (win?.isMaximized()) win.unmaximize()
  else win?.maximize()
})
ipcMain.on('window:close', () => win?.close())

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})

// Safety net: covers quit paths that don't go through window-all-closed
// (e.g. Cmd+Q on macOS, or the app quitting itself for an update install).
app.on('before-quit', () => stopBackend())

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.whenReady().then(() => {
  startBackend()
  createWindow()
  initAutoUpdater()
})
