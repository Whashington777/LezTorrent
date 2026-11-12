// Отдельное окно LezTorrent: поднимает сервер, держит трей, принимает magnet-ссылки
const { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const http = require('node:http')
const fs = require('node:fs')
const { fileURLToPath } = require('node:url')

app.commandLine.appendSwitch('ozone-platform-hint', 'auto') // нативный Wayland — нужен для прозрачности в Hyprland
app.setName('LezTorrent')

const PORT = process.env.PORT || 8642
const BASE = `http://127.0.0.1:${PORT}`
let srv, win, tray
let quitting = false

// один экземпляр: повторный запуск (или клик по magnet) идёт в уже открытое окно
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0) }
app.on('second-instance', (_, argv, cwd) => { handleArgs(argv, cwd); show() })

function request (method, p, body, type = 'text/plain') {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + p, { method, headers: body ? { 'content-type': type } : {} }, r => {
      let d = ''; r.on('data', c => (d += c)); r.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({}) } })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function waitServer (n = 0) {
  return request('GET', '/api/state').catch(() => {
    if (n > 50) throw new Error('server did not start')
    return new Promise(r => setTimeout(r, 200)).then(() => waitServer(n + 1))
  })
}

// аргументы запуска: magnet-ссылки и .torrent-файлы (двойной клик в файловом менеджере)
function handleArgs (argv, cwd = process.cwd()) {
  for (let a of argv.slice(1)) {
    if (a.startsWith('magnet:')) { request('POST', '/api/add', a).catch(() => {}); continue }
    if (a.startsWith('file://')) { try { a = fileURLToPath(a) } catch { continue } }
    if (!/\.torrent$/i.test(a)) continue
    let buf
    try { buf = fs.readFileSync(path.resolve(cwd, a)) } catch { continue }
    request('POST', '/api/add', buf, 'application/x-bittorrent').catch(() => {})
  }
}

let settings = { closeToTray: true }
async function refreshSettings () {
  try { settings = (await request('GET', '/api/state')).settings || settings } catch {}
}

app.whenReady().then(async () => {
  try { await request('GET', '/api/state') } catch {
    srv = spawn(process.env.NODE || 'node', [path.join(__dirname, 'server.js')], { stdio: 'inherit', env: { ...process.env, PORT } })
    try { await waitServer() } catch { app.quit(); return }
  }
  await refreshSettings()
  setInterval(refreshSettings, 5000)
  makeTray()
  handleArgs(process.argv)
  if (!process.argv.includes('--hidden')) show()
})

function makeTray () {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'public/tray.png')).resize({ width: 22, height: 22 }))
  } catch { return }
  tray.setToolTip('LezTorrent')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть LezTorrent', click: show },
    { type: 'separator' },
    { label: 'Выйти', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('click', () => (win?.isVisible() ? win.hide() : show()))
}

function show () {
  if (win) { win.show(); win.focus(); return }
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 720, minHeight: 480,
    transparent: true, frame: false, backgroundColor: '#00000000', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
    title: 'LezTorrent', icon: path.join(__dirname, 'public/icon.png'),
  })
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.on('close', e => {
    // крестик прячет в трей, если включено и трей реально есть
    if (!quitting && settings.closeToTray && tray) { e.preventDefault(); win.hide() }
  })
  win.on('closed', () => { win = null })
  win.loadURL(BASE)
}

ipcMain.on('win', (_, a) => {
  if (!win) return
  if (a === 'min') win.minimize()
  else if (a === 'max') win.isMaximized() ? win.unmaximize() : win.maximize()
  else win.close()
})

app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => { if (!tray || !settings.closeToTray) app.quit() })
app.on('quit', () => srv?.kill('SIGTERM'))
