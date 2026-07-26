import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import { autoUpdater } from 'electron-updater'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn, execFile, execSync, ChildProcess } from 'node:child_process'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.join(__dirname, '..')

process.env.APP_ROOT = APP_ROOT

// Keep all app data (DB, downloaded models, audio stems, GPU runtime,
// Chromium's own caches, logs — everything Electron's default userData
// would hold) on the same drive the program is actually installed on,
// instead of always on the OS drive via %APPDATA% (which is hardcoded to
// the user profile regardless of where the app itself was installed) —
// the app can easily accumulate several GB (model weights + GPU runtime +
// episode stems) and the user wants that off the system drive whenever
// the app isn't installed there. Must run before ANY app.getPath('userData')
// call and before Chromium's profile initializes (Electron only allows
// setPath('userData', ...) prior to the 'ready' event), so this sits as
// early as possible, right after APP_ROOT. Dev runs are left on the
// default path — there's no meaningful "install drive" for an
// unpackaged checkout.
if (app.isPackaged) {
  const installDir = path.dirname(app.getPath('exe'))
  const dataDir = path.join(installDir, 'data')
  // Where every previous version kept everything (Electron's own default
  // userData) — computed independently of app.getPath('userData') itself,
  // since that's about to be redirected below.
  const legacyDataDir = path.join(app.getPath('appData'), app.getName())

  if (
    legacyDataDir !== dataDir &&
    !fs.existsSync(path.join(dataDir, 'raccoonhouse.db')) &&
    fs.existsSync(path.join(legacyDataDir, 'raccoonhouse.db'))
  ) {
    // One-time move for anyone upgrading from a version that stored
    // everything under %APPDATA%. fs.renameSync is tried first (instant,
    // no double disk usage) but Node's rename on Windows fails with EXDEV
    // across drive letters — exactly the common case here (old data on
    // C:, install typically elsewhere) — confirmed live: silently no-op'd
    // and left a fresh empty profile instead of the real data. Falls back
    // to a recursive copy + delete-the-source, which works across drives.
    try {
      fs.renameSync(legacyDataDir, dataDir)
    } catch {
      try {
        fs.cpSync(legacyDataDir, dataDir, { recursive: true })
        fs.rmSync(legacyDataDir, { recursive: true, force: true })
      } catch (err) {
        console.error('[main] Failed to migrate data dir from', legacyDataDir, 'to', dataDir, err)
      }
    }
  }

  fs.mkdirSync(dataDir, { recursive: true })
  app.setPath('userData', dataDir)
}

// Persistent file log for the main process AND the renderer (via the
// console-message forwarding below) — same logs/ directory the Python
// backend writes app.log/power_share.log into (RH_DATA_DIR is set to this
// same userData path when the backend is spawned, see startBackend()).
// Without this, every console.log/console.error in this file — and every
// console.error a React component does — went nowhere a packaged app's user
// could ever retrieve, since a packaged Electron app has no visible console.
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })
const electronLogStream = fs.createWriteStream(path.join(LOG_DIR, 'electron.log'), { flags: 'a' })

function logLine(level: 'INFO' | 'ERROR', tag: string, ...args: unknown[]) {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  const line = `${new Date().toISOString()} ${level} [${tag}] ${msg}\n`
  electronLogStream.write(line)
  if (level === 'ERROR') console.error(`[${tag}]`, ...args)
  else console.log(`[${tag}]`, ...args)
}

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
      logLine('INFO', 'main', 'Killing stale process on port', BACKEND_PORT, 'pid=', pid)
      try { execSync(`taskkill /PID ${pid} /T /F`) } catch { /* already gone */ }
    }
  } catch {
    // findstr exits non-zero when nothing matches — nothing to clean up
  }
}

// Runs a command to completion, streaming its output into electron.log as it
// happens (rather than buffering it all until exit) — venv creation and pip
// install can each take minutes, and a silent multi-minute hang with zero
// output is indistinguishable from the process being stuck.
function runCommand(cmd: string, args: string[], label: string): Promise<boolean> {
  return new Promise((resolve) => {
    logLine('INFO', label, `$ ${cmd} ${args.join(' ')}`)
    let proc: ChildProcess
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      logLine('ERROR', label, 'failed to spawn:', err)
      resolve(false)
      return
    }
    proc.stdout?.on('data', (d) => logLine('INFO', label, d.toString().trim()))
    proc.stderr?.on('data', (d) => logLine('INFO', label, d.toString().trim()))
    proc.on('error', (err) => {
      logLine('ERROR', label, 'failed to spawn:', err)
      resolve(false)
    })
    proc.on('exit', (code) => {
      if (code !== 0) logLine('ERROR', label, `exited with code ${code}`)
      resolve(code === 0)
    })
  })
}

// torch/torchvision/onnxruntime-gpu in requirements.txt are cp312-specific
// wheels — a venv built off some OTHER Python minor version (e.g. whatever a
// machine happens to have, like the 3.14 seen on this very machine's PATH)
// would either fail to install these at all, or pick incompatible fallback
// wheels. Keep in sync with whatever backend/requirements.txt's wheels are
// actually built for (confirmed live: this project's own .venv runs 3.12.10).
const REQUIRED_PYTHON_MAJOR_MINOR = '3.12'
const REQUIRED_PYTHON_FULL_VERSION = '3.12.10'
const PYTHON_INSTALLER_URL =
  `https://www.python.org/ftp/python/${REQUIRED_PYTHON_FULL_VERSION}/python-${REQUIRED_PYTHON_FULL_VERSION}-amd64.exe`

// Looks for an existing Python matching the required minor version — common
// python.org install locations first (fast, no subprocess), then the Python
// Launcher for Windows (`py -3.12`), which python.org's own installer sets up
// and can find a specific minor version even when it isn't what a bare
// "python" on PATH resolves to (there can be several Python versions
// installed side by side).
async function findCompatiblePython(): Promise<string | null> {
  const versionTag = REQUIRED_PYTHON_MAJOR_MINOR.replace('.', '')
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', `Python${versionTag}`, 'python.exe'),
    `C:\\Python${versionTag}\\python.exe`,
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }

  const found = await new Promise<string | null>((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn('py', [`-${REQUIRED_PYTHON_MAJOR_MINOR}`, '-c', 'import sys; print(sys.executable)'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    proc.stdout?.on('data', (d) => { out += d.toString() })
    proc.on('error', () => resolve(null))
    proc.on('exit', (code) => resolve(code === 0 ? out.trim() : null))
  })
  return found && fs.existsSync(found) ? found : null
}

// Downloads a file with electron's own net/fetch (available in this Node/
// Electron version) straight to disk — no extra dependency needed for a
// single ~25MB download.
async function downloadFile(url: string, destPath: string): Promise<boolean> {
  try {
    logLine('INFO', 'python-install', `Downloading ${url} ...`)
    const res = await fetch(url)
    if (!res.ok || !res.body) {
      logLine('ERROR', 'python-install', `Download failed: HTTP ${res.status}`)
      return false
    }
    fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
    return true
  } catch (err) {
    logLine('ERROR', 'python-install', 'Download failed:', err)
    return false
  }
}

// Downloads and silently installs the exact Python version this project
// needs if nothing matching is already on this machine. Windows-only (this
// project only ships a Windows build — see electron-builder.yml's `win:`
// target and the taskkill/netstat calls elsewhere in this file).
async function ensurePythonInstalled(): Promise<string | null> {
  const existing = await findCompatiblePython()
  if (existing) return existing

  if (process.platform !== 'win32') {
    logLine('ERROR', 'main', `No Python ${REQUIRED_PYTHON_MAJOR_MINOR} found, and auto-install is Windows-only.`)
    return null
  }

  logLine('INFO', 'main', `No Python ${REQUIRED_PYTHON_MAJOR_MINOR} install found — downloading and installing it automatically...`)
  const installerPath = path.join(app.getPath('temp'), `python-${REQUIRED_PYTHON_FULL_VERSION}-amd64.exe`)
  if (!(await downloadFile(PYTHON_INSTALLER_URL, installerPath))) return null

  logLine('INFO', 'main', 'Installing Python silently (current user only, adds the py launcher + pip, no PATH changes)...')
  const installed = await runCommand(installerPath, [
    '/quiet', 'InstallAllUsers=0', 'PrependPath=0', 'Include_launcher=1', 'Include_pip=1', 'Include_test=0',
  ], 'python-install')
  fs.rmSync(installerPath, { force: true })
  if (!installed) {
    logLine('ERROR', 'main', 'Python installer failed.')
    return null
  }

  const nowFound = await findCompatiblePython()
  if (!nowFound) {
    logLine('ERROR', 'main', 'Python installer reported success but no matching install was found afterward.')
  }
  return nowFound
}

// Creates .venv and installs backend/requirements.txt into it if .venv
// doesn't already exist — covers a fresh clone/checkout that's never been
// set up, where startBackend() used to just fall back to a bare "python"/
// "python3" off PATH (whatever that happens to resolve to, usually missing
// every dependency this project needs, or the wrong Python version entirely)
// and the backend died on its very first import with no visible explanation.
// No-op (near-instant) on every later launch once .venv exists. Returns
// whether venvPython is now usable.
async function ensureVenvAndDeps(backendDir: string, venvPython: string): Promise<boolean> {
  if (fs.existsSync(venvPython)) return true

  logLine('INFO', 'main', 'No .venv found — setting up the Python environment. ' +
    'First run only; can take several minutes and download a few GB (Python itself if missing, then torch, audio-separator, onnxruntime...).')

  const systemPython = await ensurePythonInstalled()
  if (!systemPython) {
    logLine('ERROR', 'main',
      `No usable Python ${REQUIRED_PYTHON_MAJOR_MINOR} found or installable — ` +
      'falling back to a bare system Python, which likely has none of the required packages or is the wrong version.')
    return false
  }

  const venvDir = path.join(APP_ROOT, '.venv')
  const created = await runCommand(systemPython, ['-m', 'venv', venvDir], 'venv-create')
  if (!created) {
    logLine('ERROR', 'main', `Could not create .venv with '${systemPython}'.`)
    return false
  }

  const reqFile = path.join(backendDir, 'requirements.txt')
  const installed = await runCommand(venvPython, ['-m', 'pip', 'install', '-r', reqFile], 'pip-install')
  if (!installed) {
    logLine('ERROR', 'main', 'pip install failed — the backend will likely fail to start until this is resolved.')
    return false
  }

  logLine('INFO', 'main', '.venv created and all Python dependencies installed successfully.')
  return true
}

async function startBackend() {
  killAnyoneOnBackendPort()
  const isDev = !!VITE_DEV_SERVER_URL

  let backendExe: string
  let backendArgs: string[] = []
  // Directory holding bundled binaries (ffmpeg/ffprobe) the backend needs at runtime.
  // Packaged: electron-builder copies resources/bin -> resourcesPath/bin.
  // Dev: point straight at the project's own resources/bin so behavior matches prod.
  let resourcesDir: string

  if (isDev) {
    // In dev: use the project's own .venv, not whatever bare "python"/
    // "python3" resolves to on PATH — a bare name silently picked up
    // whichever Python happened to be first on PATH, which may have none of
    // this project's dependencies installed (confirmed live: backend exited
    // immediately with "No module named 'uvicorn'").
    const backendDir = path.join(APP_ROOT, 'backend')
    const venvPython = process.platform === 'win32'
      ? path.join(APP_ROOT, '.venv', 'Scripts', 'python.exe')
      : path.join(APP_ROOT, '.venv', 'bin', 'python3')
    const venvReady = await ensureVenvAndDeps(backendDir, venvPython)
    backendExe = venvReady ? venvPython : (process.platform === 'win32' ? 'python' : 'python3')
    backendArgs = [path.join(backendDir, 'run.py'), '--port', String(BACKEND_PORT)]
    resourcesDir = path.join(APP_ROOT, 'resources', 'bin')
  } else {
    // In packaged app: use the bundled PyInstaller exe. --onedir (not
    // --onefile, see build-backend.py) puts it one level deeper, inside its
    // own app-name folder, alongside the _internal/ dir GPU runtime files
    // get downloaded into.
    const resourcesPath = process.resourcesPath
    const exeName = process.platform === 'win32' ? 'raccoonhouse-backend.exe' : 'raccoonhouse-backend'
    backendExe = path.join(resourcesPath, 'backend', 'raccoonhouse-backend', exeName)
    backendArgs = ['--port', String(BACKEND_PORT)]
    resourcesDir = path.join(resourcesPath, 'bin')
  }

  if (isDev && !fs.existsSync(path.join(APP_ROOT, 'backend', 'main.py'))) {
    logLine('INFO', 'main', 'Backend not found, skipping spawn (dev mode without backend)')
    return
  }

  if (!isDev && !fs.existsSync(backendExe)) {
    logLine('ERROR', 'main', 'Packaged backend not found:', backendExe)
    return
  }

  logLine('INFO', 'main', 'Starting backend:', backendExe, backendArgs.join(' '))
  backendProcess = spawn(backendExe, backendArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RH_DATA_DIR: app.getPath('userData'), RH_RESOURCES_DIR: resourcesDir },
  })

  // The Python backend's own stdout/stderr (uvicorn access logs, the
  // bootstrap_deps auto-install output, any uncaught startup exception) —
  // captured here too so a single electron.log has the full picture even if
  // app.log itself never got created (e.g. the crash happened before the
  // Python logging handlers were even set up).
  // uvicorn writes its own normal "INFO:"-prefixed startup/access logs to
  // stderr by default (not an error condition) — read the line's own level
  // prefix rather than trusting which stream it came in on, otherwise every
  // routine "Application startup complete" would get mislabeled ERROR here.
  const levelFromLine = (line: string): 'INFO' | 'ERROR' =>
    /^(INFO|DEBUG|WARNING)[: ]/.test(line.trim()) ? 'INFO' : 'ERROR'
  backendProcess.stdout?.on('data', (d) => logLine('INFO', 'backend', d.toString().trim()))
  backendProcess.stderr?.on('data', (d) => {
    const text = d.toString().trim()
    logLine(levelFromLine(text), 'backend', text)
  })
  backendProcess.on('exit', (code) => logLine(code === 0 ? 'INFO' : 'ERROR', 'main', 'Backend exited with code', code))
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
      // Chromium throttles timers/rAF hard in minimized/occluded windows by
      // default — that stalls live job-progress polling, the WebSocket's own
      // keep-alive, and video/waveform playback while the app sits in the
      // taskbar. This keeps the renderer running at full speed regardless.
      backgroundThrottling: false,
    },
    icon: path.join(process.env.VITE_PUBLIC!, 'icon.png'),
  })

  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toISOString())
  })

  // Every console.log/warn/error the renderer (React app) does — including
  // useApi.ts's per-request logging and every console.error added for
  // previously-silently-swallowed catch blocks — flows through here into the
  // same electron.log a packaged app's user can actually send back, instead
  // of only ever existing in a DevTools console nobody but a developer opens.
  // Chromium's console-message level: 0=verbose, 1=info, 2=warning, 3=error.
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    logLine(level >= 2 ? 'ERROR' : 'INFO', 'renderer', `${message} (${sourceId}:${line})`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    logLine('ERROR', 'renderer', 'Render process gone:', details.reason)
  })

  win.webContents.on('unresponsive', () => {
    logLine('ERROR', 'renderer', 'Window became unresponsive')
  })

  // The renderer opens export URLs (SRT/Reaper CSV — both Content-Disposition:
  // attachment) via window.open(url, '_blank'). With no handler, Electron's
  // default behavior is to create a real new BrowserWindow and navigate it to
  // that URL — the navigation resolves as a download instead of a page load,
  // so the window never gets any content and just sits there blank forever
  // (confirmed live: reported as "a white window opens and doesn't close").
  // Deny the new window and drive the download on the existing session instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    win?.webContents.downloadURL(url)
    return { action: 'deny' }
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

  const check = () => autoUpdater.checkForUpdates().catch((err) => logLine('ERROR', 'updater', 'check failed', err))
  check()
  checkForBetaAvailable()
  // Nobody has to remember to click "Перевірити зараз" — this keeps checking
  // in the background for as long as the app stays open.
  setInterval(check, AUTO_CHECK_INTERVAL_MS)
  setInterval(checkForBetaAvailable, AUTO_CHECK_INTERVAL_MS)
}

// --- Beta channel nudge (separate from the main auto-update flow above) ---
//
// electron-updater's own "allowPrerelease" already defaults to false for a
// stable-tagged running version (no "-beta" suffix) and true for a
// prerelease-tagged one — so the MAIN update flow already does the right
// thing on its own: a stable install only ever auto-updates to a newer
// stable release, a beta install only ever auto-updates to a newer beta.
// What's missing is visibility: someone running stable never finds out a
// beta exists at all. This is a second, independent, much lighter-weight
// check straight against the GitHub Releases API (not electron-updater) that
// just surfaces "a beta is out" as a small dismissible notice — never
// auto-downloaded, never silently installed, purely opt-in via a manual
// click that opens the release page in the browser.
const GITHUB_RELEASES_API = 'https://api.github.com/repos/warpVIT1/raccoonhouse-studio/releases?per_page=10'

function parseVersionTriplet(v: string): [number, number, number] {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0]
}

// Major.minor.patch only — deliberately ignores the "-beta" suffix itself,
// since the point here is "is this beta's version LINE ahead of what I'm
// running", not a full semver prerelease-precedence comparison.
function isNewerVersion(a: string, b: string): boolean {
  const [aMaj, aMin, aPatch] = parseVersionTriplet(a)
  const [bMaj, bMin, bPatch] = parseVersionTriplet(b)
  if (aMaj !== bMaj) return aMaj > bMaj
  if (aMin !== bMin) return aMin > bMin
  return aPatch > bPatch
}

async function checkForBetaAvailable() {
  if (!app.isPackaged) return
  const currentVersion = app.getVersion()
  if (/-\w/.test(currentVersion)) return // already running a beta — the main channel above already covers newer betas
  try {
    const resp = await fetch(GITHUB_RELEASES_API)
    if (!resp.ok) return
    const releases = (await resp.json()) as Array<{ tag_name: string; prerelease: boolean; html_url: string; body: string | null }>
    const beta = releases.find((r) => r.prerelease)
    if (!beta) return
    const betaVersion = beta.tag_name.replace(/^v/, '')
    if (isNewerVersion(betaVersion, currentVersion)) {
      win?.webContents.send('update:beta-available', {
        version: betaVersion,
        url: beta.html_url,
        notes: beta.body || '',
      })
    }
  } catch (err) {
    // Non-fatal by design — worst case, nobody sees the beta nudge this cycle.
    logLine('INFO', 'updater', 'beta check failed (non-fatal)', err)
  }
}

function formatReleaseNotes(notes: string | { version: string; note: string | null }[] | null | undefined): string {
  if (!notes) return ''
  if (typeof notes === 'string') return notes
  return notes.map((n) => n.note || '').filter(Boolean).join('\n\n')
}

ipcMain.handle('update:check', () => {
  if (!app.isPackaged) return
  autoUpdater.checkForUpdates().catch((err) => logLine('ERROR', 'updater', 'check failed', err))
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

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  if (!/^https:\/\/github\.com\//.test(url)) return // only ever used for the beta-release-page link above
  await shell.openExternal(url)
})

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

// Catch-all so a truly unexpected failure in the main process itself (not
// the backend, not the renderer) still lands in electron.log instead of
// only flashing past in a terminal window nobody's watching, or crashing
// silently in a packaged build.
process.on('uncaughtException', (err) => logLine('ERROR', 'main', 'Uncaught exception:', err))
process.on('unhandledRejection', (reason) => logLine('ERROR', 'main', 'Unhandled rejection:', reason))

app.whenReady().then(() => {
  // The app has its own custom title bar (frame: false) and no menu bar is
  // ever shown — but Electron's default application menu is still created
  // otherwise, and its Edit role (Undo/Copy/Paste bound to Ctrl+Z/C/V) eats
  // those accelerators before they reach the renderer's own keydown
  // handlers, silently breaking the subtitle grid's undo/copy/paste.
  Menu.setApplicationMenu(null)
  // Deliberately not awaited: a first-ever run with no .venv can take several
  // minutes (venv create + pip install, see ensureVenvAndDeps) — the window
  // opens immediately either way, same as before, and the renderer's own
  // WebSocket reconnect loop already tolerates the backend taking a while to
  // come up (it just keeps showing "not connected" until it does).
  startBackend().catch((err) => logLine('ERROR', 'main', 'startBackend() crashed:', err))
  createWindow()
  initAutoUpdater()
})
