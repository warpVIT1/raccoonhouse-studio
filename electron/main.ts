import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn, execFile, execSync, ChildProcess } from 'node:child_process'
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

// If a previous run's backend was ever orphaned (e.g. the Electron parent
// was killed via Task Manager, or crashed hard enough to skip both
// window-all-closed and before-quit), it keeps squatting on BACKEND_PORT
// forever — every later launch of the app would then silently talk to that
// stale, possibly much-older process instead of spawning its own, with no
// visible sign anything is wrong (confirmed live: a backend from hours
// earlier in the day kept answering requests through several app restarts
// and even a version upgrade, since the port was never freed). Clear
// anything already listening there before spawning our own.
function killAnyoneOnBackendPort() {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano | findstr :${BACKEND_PORT} | findstr LISTENING`, { encoding: 'utf-8' })
    const pids = new Set(
      out.split('\n').map((line) => line.trim().split(/\s+/).pop()).filter((pid): pid is string => !!pid && /^\d+$/.test(pid))
    )
    for (const pid of pids) {
      console.log('[main] Killing stale process on port', BACKEND_PORT, 'pid=', pid)
      try { execSync(`taskkill /PID ${pid} /T /F`) } catch { /* already gone */ }
    }
  } catch {
    // findstr exits non-zero when nothing matches — nothing to clean up
  }
}

function startBackend() {
  killAnyoneOnBackendPort()
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

  // Checking happens automatically (launch + every 4h), but downloading is a
  // deliberate click from the update dialog (see UpdateDialog.tsx) — not
  // silent/automatic — so the person actually sees the changelog before
  // committing to it. Installing itself, once downloaded, IS silent (no NSIS
  // wizard window) either via the dialog's button or automatically the next
  // time the app quits normally.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', {
    version: info.version,
    releaseNotes: formatReleaseNotes(info.releaseNotes),
  }))
  autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'))
  autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err.message }))
  autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', {
    version: info.version,
    releaseNotes: formatReleaseNotes(info.releaseNotes),
  }))

  const check = () => autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed', err))
  check()
  // Nobody has to remember to click "Перевірити зараз" — this keeps checking
  // in the background for as long as the app stays open.
  setInterval(check, AUTO_CHECK_INTERVAL_MS)
}

function formatReleaseNotes(notes: string | { version: string; note: string | null }[] | null | undefined): string {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  return notes.map((n) => n.note || '').filter(Boolean).join('\n\n')
}

ipcMain.handle('update:check', () => {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch((err) => console.error('[updater] check failed', err))
})

ipcMain.handle('update:download', () => {
  autoUpdater.downloadUpdate().catch((err) => sendUpdateStatus('error', { message: err.message }))
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
