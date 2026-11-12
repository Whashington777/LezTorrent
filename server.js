// LezTorrent — локальный торрент-клиент: WebTorrent + HTTP API + SSE
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebTorrent from 'webtorrent'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(ROOT, 'public')
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'leztorrent')
const AUTOSTART = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'leztorrent.desktop')
const STATE_FILE = path.join(CONFIG_DIR, 'state.json')
const PORT = Number(process.env.PORT || 8642)
const HOST = '127.0.0.1'

fs.mkdirSync(CONFIG_DIR, { recursive: true })

// ---------- состояние ----------
const defaults = {
  downloadDir: path.join(os.homedir(), 'Downloads', 'Torrents'),
  downloadLimit: 0, // KB/s, 0 = без лимита
  uploadLimit: 0,
  seedRatio: 0, // остановить раздачу при рейтинге, 0 = никогда
  seedHours: 0, // остановить раздачу через N часов, 0 = никогда
  maxActive: 3, // одновременно качающихся, 0 = без ограничения
  torrentPort: 6881, // порт входящих подключений
  startPaused: false,
  notify: true,
  autostart: false,
  closeToTray: true,
  afterAll: 'none', // что сделать, когда всё докачается: none | suspend | poweroff (одноразово)
}
// torrents: infoHash -> { source, paused, queued, addedAt, name, dir, length, doneAt, deselected: [] }
let state = { settings: { ...defaults }, torrents: {} }
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } } catch {}
state.settings = { ...defaults, ...state.settings }

let saveTimer
function save () {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => fsp.writeFile(STATE_FILE, JSON.stringify(state, null, 2)).catch(console.error), 300)
}

const startedPort = state.settings.torrentPort
const client = new WebTorrent({ torrentPort: startedPort, maxConns: 150 })
client.on('error', err => console.error('[client]', err.message))
applyLimits()

function applyLimits () {
  const kb = v => (v > 0 ? v * 1024 : -1)
  client.throttleDownload(kb(state.settings.downloadLimit))
  client.throttleUpload(kb(state.settings.uploadLimit))
}

function notify (title, body) {
  if (!state.settings.notify) return
  try {
    spawn('notify-send', ['-a', 'LezTorrent', '-i', path.join(PUBLIC, 'logo.svg'), title, body], { stdio: 'ignore', detached: true })
      .on('error', () => {}).unref()
  } catch {}
}

function applyAutostart () {
  if (state.settings.autostart) {
    fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true })
    fs.writeFileSync(AUTOSTART, `[Desktop Entry]
Type=Application
Name=LezTorrent
Exec=electron ${path.join(ROOT, 'electron.cjs')} --hidden
Icon=${path.join(PUBLIC, 'logo.svg')}
X-GNOME-Autostart-enabled=true
`)
  } else {
    fs.rmSync(AUTOSTART, { force: true })
  }
}

// ---------- диск ----------
function diskFree (dir) {
  // ищем ближайшую существующую папку вверх по пути
  let d = path.resolve(dir)
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d)
  try {
    const st = fs.statfsSync(d)
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize, at: d }
  } catch { return { free: 0, total: 0, at: d } }
}

// уже лежащие на диске байты торрента не надо считать заново
function bytesOnDisk (dir, name) {
  if (!name) return 0
  let sum = 0
  const walk = p => {
    let st; try { st = fs.statSync(p) } catch { return }
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f))
    else sum += st.blocks ? st.blocks * 512 : st.size
  }
  walk(path.join(dir, name))
  return sum
}

function checkSpace (t, meta) {
  if (meta.spaceOk || !t.ready) return true
  const need = selStats(t, meta).length - bytesOnDisk(meta.dir, t.name)
  const { free } = diskFree(meta.dir)
  if (need > free) {
    meta.paused = true
    meta.error = `Не влезает: нужно ${gb(need)}, свободно ${gb(free)}`
    stopTorrent(t.infoHash)
    notify('Не хватает места', `${t.name} — ${meta.error}`)
    save()
    return false
  }
  meta.spaceOk = true
  return true
}
const gb = n => (n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0) + ' ГБ'

// ---------- действие после загрузки всего ----------
let afterTimer = null, wasDownloading = false
function afterAllCheck () {
  const downloading = Object.values(state.torrents).some(m => !m.paused && !m.doneAt)
  const act = state.settings.afterAll
  if (wasDownloading && !downloading && act !== 'none' && !afterTimer) {
    notify('Всё скачано', act === 'poweroff' ? 'Выключаю компьютер через минуту' : 'Усыпляю компьютер через минуту')
    afterTimer = setTimeout(() => {
      afterTimer = null
      if (state.settings.afterAll !== act) return // передумали
      state.settings.afterAll = 'none' // одноразово
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
      spawn('systemctl', [act], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    }, 60e3)
  }
  if (downloading && afterTimer) { clearTimeout(afterTimer); afterTimer = null }
  wasDownloading = downloading
}

// ---------- работа с торрентами ----------
const running = hash => client.torrents.find(t => t.infoHash === hash)

function applySelection (t, meta) {
  if (!t.ready) return
  const off = new Set(meta.deselected || [])
  if (!off.size) { t.select(0, t.pieces.length - 1, false); return }
  t.deselect(0, t.pieces.length - 1, false)
  t.files.forEach((f, i) => (off.has(i) ? f.deselect() : f.select()))
}

// прогресс и готовность только по выбранным файлам
function selStats (t, meta) {
  if (!t.ready) return { done: false, progress: t.progress || 0, length: t.length || 0 }
  const off = new Set(meta.deselected || [])
  if (!off.size) return { done: t.done, progress: t.progress || 0, length: t.length }
  let len = 0, got = 0, done = true
  t.files.forEach((f, i) => {
    if (off.has(i)) return
    len += f.length; got += f.downloaded
    if (f.progress < 1) done = false
  })
  return { done, progress: len ? got / len : 1, length: len }
}

function markDone (t, meta) {
  if (meta.doneAt) return
  meta.doneAt = Date.now()
  if (meta.rechecking) { meta.rechecking = false; notify('Проверено', `${t.name} — всё целое`) } else notify('Скачано', t.name)
  save()
}

function startTorrent (hash) {
  const meta = state.torrents[hash]
  if (!meta || running(hash)) return
  const src = meta.source.startsWith('magnet:') ? meta.source : Buffer.from(meta.source, 'base64')
  fs.mkdirSync(meta.dir, { recursive: true })
  const t = client.add(src, { path: meta.dir })
  t.on('error', err => { meta.error = err.message; save() })
  t.on('metadata', () => { meta.name = t.name; meta.length = t.length; save() })
  t.on('ready', () => { applySelection(t, meta); checkSpace(t, meta) })
  t.on('done', () => { markDone(t, meta); schedule() })
}

function stopTorrent (hash) {
  const t = running(hash)
  return t ? new Promise(r => t.destroy({ destroyStore: false }, r)) : Promise.resolve()
}

// Планировщик: лимиты раздачи + очередь загрузок
function schedule () {
  const s = state.settings
  const now = Date.now()

  // 0. готовность частично выбранных торрентов (WebTorrent сам её не видит)
  for (const [hash, meta] of Object.entries(state.torrents)) {
    const t = running(hash)
    if (t && !meta.doneAt && selStats(t, meta).done) markDone(t, meta)
  }

  // 1. остановка раздачи по рейтингу / времени
  for (const [hash, meta] of Object.entries(state.torrents)) {
    const t = running(hash)
    if (!t || !t.ready || meta.paused || !meta.doneAt) continue
    const ratio = meta.length ? (meta.uploadedBase || 0) + t.uploaded / meta.length : 0
    const byRatio = s.seedRatio > 0 && ratio >= s.seedRatio
    const byTime = s.seedHours > 0 && now - meta.doneAt >= s.seedHours * 3600e3
    if (byRatio || byTime) {
      meta.paused = true
      meta.seedStopped = true
      meta.uploadedBase = ratio
      stopTorrent(hash)
      notify('Раздача остановлена', `${meta.name} · ${byRatio ? 'рейтинг ' + ratio.toFixed(2) : s.seedHours + ' ч'}`)
    }
  }

  // 2. очередь: недокачанные, не на паузе, по времени добавления
  const pending = Object.entries(state.torrents)
    .filter(([, m]) => !m.paused && !m.doneAt)
    .sort((a, b) => a[1].addedAt - b[1].addedAt)
  const limit = s.maxActive > 0 ? s.maxActive : Infinity
  pending.forEach(([hash, meta], i) => {
    const allowed = i < limit
    meta.queued = !allowed
    if (allowed) startTorrent(hash)
    else if (running(hash)) stopTorrent(hash)
  })

  // 3. докачанные и не на паузе — раздаются
  for (const [hash, meta] of Object.entries(state.torrents)) if (!meta.paused && meta.doneAt) startTorrent(hash)
  save()
}
setInterval(() => { schedule(); afterAllCheck() }, 5000)

function parseHash (src) {
  const m = src.match(/xt=urn:btih:([a-z0-9]+)/i)
  if (!m) throw new Error('Неверная magnet-ссылка')
  let h = m[1]
  if (h.length === 32) h = base32ToHex(h)
  return h.toLowerCase()
}

function base32ToHex (s) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of s.toUpperCase()) bits += a.indexOf(c).toString(2).padStart(5, '0')
  let hex = ''
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

async function addTorrent (src, dir) {
  let hash, source, name = null
  if (Buffer.isBuffer(src)) {
    const { default: parseTorrent } = await import('parse-torrent')
    const parsed = await parseTorrent(src)
    hash = parsed.infoHash
    name = parsed.name || null
    source = src.toString('base64')
  } else {
    hash = parseHash(src.trim())
    source = src.trim()
    const dn = source.match(/[?&]dn=([^&]+)/)
    if (dn) try { name = decodeURIComponent(dn[1].replace(/\+/g, ' ')) } catch {}
  }
  if (state.torrents[hash]) throw new Error('Этот торрент уже добавлен')
  state.torrents[hash] = {
    source, paused: !!state.settings.startPaused, addedAt: Date.now(),
    dir: dir ? path.resolve(dir.replace(/^~/, os.homedir())) : state.settings.downloadDir, name, deselected: [],
  }
  schedule()
  return hash
}

function snapshot () {
  const list = Object.entries(state.torrents).map(([hash, meta]) => {
    const t = running(hash)
    const off = new Set(meta.deselected || [])
    const base = {
      hash, name: t?.name || meta.name || hash, paused: meta.paused, addedAt: meta.addedAt,
      dir: meta.dir, error: meta.error || null, length: t?.length || meta.length || 0,
      seedStopped: !!meta.seedStopped, rechecking: !!meta.rechecking,
    }
    if (!t) {
      return {
        ...base, status: meta.paused ? 'paused' : 'queued',
        progress: meta.doneAt ? 1 : (meta.progress || 0), downloaded: 0, downSpeed: 0, upSpeed: 0, peers: 0, eta: null,
        files: (meta.files || []).map((f, i) => ({ ...f, selected: !off.has(i) })),
      }
    }
    const st = selStats(t, meta)
    const progress = st.progress
    meta.progress = progress
    const files = (t.files || []).map((f, i) => ({ name: f.path, length: f.length, progress: f.progress, selected: !off.has(i) }))
    if (files.length) meta.files = files.map(({ name, length }) => ({ name, length, progress: 0 }))
    return {
      ...base,
      status: !t.ready ? 'metadata' : st.done ? 'seeding' : 'downloading',
      length: st.length || base.length,
      progress, downloaded: t.downloaded, uploaded: t.uploaded, ratio: t.ratio,
      downSpeed: t.downloadSpeed, upSpeed: t.uploadSpeed, peers: t.numPeers,
      eta: st.done || !t.downloadSpeed ? null : (st.length * (1 - progress)) / t.downloadSpeed * 1000,
      files,
    }
  }).sort((a, b) => b.addedAt - a.addedAt)
  return {
    torrents: list,
    stats: { downSpeed: client.downloadSpeed, upSpeed: client.uploadSpeed, ratio: client.ratio },
    settings: state.settings,
    restartNeeded: state.settings.torrentPort !== startedPort,
    disk: diskFree(state.settings.downloadDir),
    afterPending: !!afterTimer,
  }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }

function json (res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody (req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Слишком большой файл')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const sseClients = new Set()
setInterval(() => {
  if (!sseClients.size) return
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`
  for (const res of sseClients) res.write(msg)
}, 1000)

const num = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0))

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const p = url.pathname
  try {
    // простая защита от CSRF с чужих сайтов
    if (req.method !== 'GET' && req.headers.origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) {
      return json(res, 403, { error: 'forbidden' })
    }

    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }
    if (p === '/api/state') return json(res, 200, snapshot())

    if (p === '/api/add' && req.method === 'POST') {
      const body = await readBody(req)
      const isFile = (req.headers['content-type'] || '').includes('bittorrent')
      const hash = await addTorrent(isFile ? body : body.toString('utf8'), url.searchParams.get('dir'))
      return json(res, 200, { hash })
    }

    if (p === '/api/disk') return json(res, 200, diskFree((url.searchParams.get('dir') || state.settings.downloadDir).replace(/^~/, os.homedir())))

    // размер .torrent до добавления — чтобы сразу сказать, влезет ли
    if (p === '/api/inspect' && req.method === 'POST') {
      const { default: parseTorrent } = await import('parse-torrent')
      const parsed = await parseTorrent(await readBody(req))
      return json(res, 200, { name: parsed.name, length: parsed.length, files: parsed.files?.length || 0 })
    }

    const am = p.match(/^\/api\/all\/(pause|resume)$/)
    if (am && req.method === 'POST') {
      for (const [hash, meta] of Object.entries(state.torrents)) {
        if (am[1] === 'pause') { meta.paused = true; await stopTorrent(hash) } else { meta.paused = false; meta.seedStopped = false; meta.spaceOk = false; if (/^Не влезает/.test(meta.error || '')) meta.error = null }
      }
      schedule()
      return json(res, 200, { ok: true })
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString())
      const s = state.settings
      if (typeof b.downloadDir === 'string' && b.downloadDir.trim()) s.downloadDir = b.downloadDir.trim().replace(/^~/, os.homedir())
      if (b.downloadLimit !== undefined) s.downloadLimit = num(b.downloadLimit, 0, 1e7)
      if (b.uploadLimit !== undefined) s.uploadLimit = num(b.uploadLimit, 0, 1e7)
      if (b.seedRatio !== undefined) s.seedRatio = num(b.seedRatio, 0, 1000)
      if (b.seedHours !== undefined) s.seedHours = num(b.seedHours, 0, 1e5)
      if (b.maxActive !== undefined) s.maxActive = Math.round(num(b.maxActive, 0, 100))
      if (b.torrentPort !== undefined) {
        const port = Math.round(Number(b.torrentPort))
        if (!(port >= 1024 && port <= 65535)) throw new Error('Порт должен быть от 1024 до 65535')
        s.torrentPort = port
      }
      for (const k of ['startPaused', 'notify', 'autostart', 'closeToTray']) if (typeof b[k] === 'boolean') s[k] = b[k]
      if (['none', 'suspend', 'poweroff'].includes(b.afterAll)) { s.afterAll = b.afterAll; if (b.afterAll === 'none' && afterTimer) { clearTimeout(afterTimer); afterTimer = null } }
      applyLimits(); applyAutostart(); schedule()
      return json(res, 200, { settings: s, restartNeeded: s.torrentPort !== startedPort })
    }

    const fm = p.match(/^\/api\/torrent\/([a-f0-9]{40})\/files$/)
    if (fm && req.method === 'POST') {
      const meta = state.torrents[fm[1]]
      if (!meta) return json(res, 404, { error: 'Не найден' })
      const b = JSON.parse((await readBody(req)).toString())
      const total = meta.files?.length || running(fm[1])?.files?.length || 0
      const sel = new Set((b.selected || []).map(Number))
      if (total && !sel.size) throw new Error('Выбери хотя бы один файл')
      meta.deselected = Array.from({ length: total }, (_, i) => i).filter(i => !sel.has(i))
      // выбрали ранее отключённые — значит снова есть что качать
      if (meta.doneAt && meta.deselected.length < total) { meta.doneAt = null; meta.seedStopped = false }
      const t = running(fm[1])
      if (t) applySelection(t, meta)
      schedule()
      return json(res, 200, { ok: true })
    }

    const m = p.match(/^\/api\/torrent\/([a-f0-9]{40})\/(pause|resume|remove|open|recheck)$/)
    if (m && req.method === 'POST') {
      const [, hash, action] = m
      const meta = state.torrents[hash]
      if (!meta) return json(res, 404, { error: 'Не найден' })
      if (action === 'pause') { meta.paused = true; await stopTorrent(hash) }
      if (action === 'resume') { meta.paused = false; meta.error = null; meta.seedStopped = false; meta.spaceOk = false; schedule() }
      if (action === 'recheck') {
        // WebTorrent сверяет все куски с хешами при добавлении — перезапуск = полная проверка
        await stopTorrent(hash)
        meta.rechecking = !!meta.doneAt
        meta.doneAt = null; meta.progress = 0; meta.error = null; meta.paused = false
        schedule()
        startTorrent(hash)
      }
      if (action === 'open') {
        const target = meta.name ? path.join(meta.dir, meta.name) : meta.dir
        spawn('xdg-open', [fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : meta.dir], { detached: true, stdio: 'ignore' }).unref()
      }
      if (action === 'remove') {
        const withFiles = url.searchParams.get('files') === '1'
        await stopTorrent(hash)
        if (withFiles && meta.name) await fsp.rm(path.join(meta.dir, meta.name), { recursive: true, force: true })
        delete state.torrents[hash]
        schedule()
      }
      save()
      return json(res, 200, { ok: true })
    }

    // статика
    const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p))
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' })
    const data = await fsp.readFile(file).catch(() => null)
    if (!data) return json(res, 404, { error: 'not found' })
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
    res.end(data)
  } catch (err) {
    json(res, 400, { error: err.message })
  }
})

schedule()

server.listen(PORT, HOST, () => console.log(`LezTorrent → http://${HOST}:${PORT} · peer port ${startedPort}`))

const shutdown = () => { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); client.destroy(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
