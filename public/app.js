const $ = s => document.querySelector(s)
const list = $('#list')
let data = { torrents: [], stats: {}, settings: {} }
let filter = 'all'
let focus = null
const hist = Array(48).fill(0)
const known = new Map()

const units = ['B', 'KB', 'MB', 'GB', 'TB']
function split (n) {
  if (!n) return ['0', 'KB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return [v.toFixed(i && v < 100 ? 1 : 0), units[i]]
}
const size = n => split(n).join(' ')
const speed = n => (n > 0 ? size(n) + '/s' : '0 KB/s')
function eta (ms) {
  if (ms == null) return ''
  const s = Math.round(ms / 1000)
  if (s < 60) return s + ' с'
  if (s < 3600) return Math.floor(s / 60) + ' мин'
  if (s < 86400) return Math.floor(s / 3600) + ' ч ' + Math.floor((s % 3600) / 60) + ' мин'
  return Math.floor(s / 86400) + ' д'
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const stateOf = t => (t.error ? 'error' : t.rechecking && t.status !== 'seeding' ? 'checking' : t.status)
const statusText = { checking: 'Проверка', downloading: 'Качается', seeding: 'Раздаётся', paused: 'Пауза', queued: 'В очереди', metadata: 'Ищу метаданные', error: 'Ошибка' }
const chipText = { checking: 'Проверка', downloading: 'Сейчас качается', seeding: 'Раздаётся', paused: 'На паузе', queued: 'В очереди', metadata: 'Ищу пиров', error: 'Ошибка' }
const pct = p => (p * 100).toFixed(p > 0 && p < 1 ? 1 : 0) + '%'

const ICON = {
  pause: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5.5v13l10.5-6.5z"/></svg>',
}

async function api (url, opts = {}) {
  const r = await fetch(url, { method: 'POST', ...opts })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || 'Ошибка')
  return j
}

function note (title, text, err = false) {
  const el = document.createElement('div')
  el.className = 'note glass' + (err ? ' err' : '')
  el.innerHTML = `<div class="ic"><img src="/logo.svg" alt=""></div><b>${esc(title)}</b><time>сейчас</time><span>${esc(text)}</span>`
  $('#toasts').prepend(el)
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300) }, 4000)
}

function matches (t, f = filter) {
  if (f === 'all') return true
  if (f === 'paused') return t.paused
  if (f === 'downloading') return !t.paused && t.status !== 'seeding'
  return t.status === f
}

function render () {
  const shown = data.torrents.filter(t => matches(t))
  if (!shown.find(t => t.hash === focus)) focus = (shown.find(t => t.status === 'downloading') || shown[0])?.hash ?? null

  const keep = new Set(shown.map(t => t.hash))
  for (const li of [...list.children]) if (!keep.has(li.dataset.hash)) li.remove()
  const fi = shown.findIndex(t => t.hash === focus)
  shown.forEach((t, i) => {
    let li = list.querySelector(`[data-hash="${t.hash}"]`)
    if (!li) {
      li = document.createElement('li')
      li.className = 'ly'
      li.dataset.hash = t.hash
      li.innerHTML = `<span class="ly-name"></span><div class="ly-meta"><div>
        <span class="pill glass st"></span><span class="pill glass pc"></span><span class="pill glass dim sp"></span><span class="pill glass dim et"></span>
        <button class="ly-act glass" data-a="toggle"></button><button class="ly-act glass" data-a="open" title="Открыть папку">${ICON.folder}</button>
      </div></div>`
    }
    const s = stateOf(t)
    li.dataset.s = s
    li.classList.toggle('on', t.hash === focus)
    li.style.setProperty('--p', (t.progress * 100).toFixed(2) + '%')
    const nm = li.querySelector('.ly-name'); if (nm.textContent !== t.name) { nm.textContent = t.name; nm.title = t.name }
    li.querySelector('.st').textContent = t.error || statusText[s]
    li.querySelector('.pc').textContent = pct(t.progress) + (t.length ? ' из ' + size(t.length) : '')
    li.querySelector('.sp').textContent = t.status === 'seeding' ? (t.upSpeed ? '↑ ' + speed(t.upSpeed) : '') : t.downSpeed ? '↓ ' + speed(t.downSpeed) : ''
    li.querySelector('.et').textContent = t.eta ? eta(t.eta) : ''
    const tb = li.querySelector('[data-a="toggle"]'), ic = t.paused ? ICON.play : ICON.pause
    if (tb.innerHTML !== ic) { tb.innerHTML = ic; tb.title = t.paused ? 'Продолжить' : 'Пауза' }
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null)
  })
  $('#empty').hidden = data.torrents.length > 0
  $('#count').textContent = `${String(fi + 1).padStart(2, '0')} / ${String(shown.length).padStart(2, '0')}`

  renderWidgets(shown.find(t => t.hash === focus))
  renderIsland()
}

function renderWidgets (t) {
  const s = t ? stateOf(t) : null
  $('#hero-chip').textContent = t ? chipText[s] : 'Пусто'
  $('#hero-name').textContent = t ? t.name : 'Пока тихо'
  $('#hero-bar').style.width = t ? t.progress * 100 + '%' : '0'
  $('#hero-left').textContent = !t ? 'Нажми на остров'
    : t.eta ? eta(t.eta)
    : t.status === 'seeding' ? 'Готово'
    : statusText[s]
  $('#hero-pct').textContent = t ? pct(t.progress) : ''

  $('#p-name').textContent = t ? t.name : '—'
  $('#p-sub').textContent = t ? (t.error || statusText[s] + (t.downSpeed ? ' · ' + speed(t.downSpeed) : '')) : ''
  $('#p-bar').style.width = t ? t.progress * 100 + '%' : '0'
  const tg = $('#p-toggle')
  const html = t?.paused ? ICON.play : ICON.pause
  if (tg.innerHTML !== html) tg.innerHTML = html
  tg.title = t?.paused ? 'Продолжить' : 'Пауза'
  document.querySelectorAll('.pbtn').forEach(b => { b.disabled = !t })

  const [v, u] = split(data.stats.downSpeed)
  $('#g-down').textContent = v; $('#g-down-u').textContent = '↓ ' + u + '/s'
  const [v2, u2] = split(data.stats.upSpeed)
  $('#g-up').textContent = v2; $('#g-up-u').textContent = '↑ ' + u2 + '/s'
  spark()
}

function spark () {
  const c = $('#spark'), ctx = c.getContext('2d')
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight
  if (!w) return
  if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h)
  const max = Math.max(...hist, 1), step = w / (hist.length - 1)
  ctx.beginPath()
  hist.forEach((v, i) => { const x = i * step, y = h - 2 - (v / max) * (h - 4); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke()
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath()
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(255,255,255,.22)'); g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g; ctx.fill()
}

function renderIsland () {
  const down = data.stats.downSpeed || 0
  const live = down > 0
  const isl = $('#island')
  isl.classList.toggle('live', live)
  $('#island-text').textContent = data.afterPending ? 'Выключаюсь через минуту' : live ? '↓ ' + speed(down) : 'Добавить'
  const anyPaused = data.torrents.some(t => t.paused)
  const ab = $('#all-toggle')
  ab.textContent = anyPaused ? 'Продолжить всё' : 'Пауза всё'
  ab.dataset.mode = anyPaused ? 'resume' : 'pause'
  ab.hidden = !data.torrents.length
  const max = Math.max(...hist, 1)
  document.querySelectorAll('#eq i').forEach((b, i) => {
    const lvl = live ? 0.25 + Math.min(1, down / max) * (0.4 + 0.6 * Math.abs(Math.sin(Date.now() / 300 + i * 1.7))) : 0.25
    b.style.transform = `scaleY(${lvl.toFixed(2)})`
  })
}

function notifyChanges () {
  for (const t of data.torrents) {
    const prev = known.get(t.hash)
    if (prev && prev !== 'seeding' && t.status === 'seeding') note('Загрузка завершена', t.name)
    known.set(t.hash, t.status)
  }
}

function scrollToFocus (smooth = true) {
  const li = list.querySelector('.ly.on')
  if (!li) return
  const box = list.getBoundingClientRect()
  const top = list.scrollTop + li.getBoundingClientRect().top - box.top - box.height * 0.32 + 40
  list.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
}

let first = true
function connect () {
  const es = new EventSource('/api/events')
  es.onmessage = e => {
    data = JSON.parse(e.data)
    hist.push(data.stats.downSpeed || 0); hist.shift()
    notifyChanges()
    const before = focus
    render()
    if (first || before !== focus) { scrollToFocus(!first); first = false }
    depth()
  }
  es.onerror = () => { es.close(); setTimeout(connect, 1500) }
}
connect()

function setFocus (hash) {
  if (!hash || hash === focus) return
  focus = hash
  render()
  scrollToFocus()
}

list.addEventListener('click', e => {
  const li = e.target.closest('.ly'); if (!li) return
  const b = e.target.closest('[data-a]')
  if (b && li.dataset.hash === focus) return act(b.dataset.a)
  setFocus(li.dataset.hash)
})

function depth () {
  const box = list.getBoundingClientRect(), anchor = box.top + box.height * 0.32
  for (const li of list.children) {
    const r = li.getBoundingClientRect()
    const d = Math.abs(r.top + Math.min(r.height, 80) / 2 - anchor) / 90
    li.style.setProperty('--d', d.toFixed(2))
  }
}
let depthRaf = 0
list.addEventListener('scroll', () => { cancelAnimationFrame(depthRaf); depthRaf = requestAnimationFrame(depth) }, { passive: true })
addEventListener('resize', depth)

let wheelLock = 0
list.addEventListener('wheel', e => {
  e.preventDefault()
  if (Date.now() < wheelLock || Math.abs(e.deltaY) < 4) return
  wheelLock = Date.now() + 180
  move(e.deltaY > 0 ? 1 : -1)
}, { passive: false })

function move (dir) {
  const items = [...list.children]
  const i = items.findIndex(li => li.dataset.hash === focus)
  const next = items[Math.max(0, Math.min(items.length - 1, i + dir))]
  if (next) setFocus(next.dataset.hash)
}

document.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]') || e.target.matches('input')) return
  if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(1) }
  if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(-1) }
  if (e.key === ' ' && focus) { e.preventDefault(); act('toggle') }
  if (e.key === 'Delete' && focus) act('remove')
})

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return
  filter = b.dataset.f
  document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('on', x === b))
  focus = null
  render(); scrollToFocus(false)
})

$('#all-toggle').onclick = async () => {
  const mode = $('#all-toggle').dataset.mode || 'pause'
  try { await api('/api/all/' + mode); note(mode === 'pause' ? 'Всё на паузе' : 'Всё продолжено', mode === 'pause' ? 'Канал свободен — можно играть' : 'Качаем дальше') } catch (err) { note('Ошибка', err.message, true) }
}

$('#files-recheck').onclick = async () => {
  if (!filesHash) return
  $('#files').close('cancel')
  try { await api(`/api/torrent/${filesHash}/recheck`); note('Перепроверка', 'Сверяю все куски с хешами') } catch (err) { note('Ошибка', err.message, true) }
}

$('#player').addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (b) act(b.dataset.a) })

async function act (a) {
  const t = data.torrents.find(t => t.hash === focus); if (!t) return
  if (a === 'remove') return askRemove(t)
  if (a === 'files') return showFiles(t)
  if (a === 'toggle') a = t.paused ? 'resume' : 'pause'
  try { await api(`/api/torrent/${t.hash}/${a}`) } catch (err) { note('Ошибка', err.message, true) }
}

let filesHash = null
function showFiles (t) {
  filesHash = t.hash
  $('#files-name').textContent = t.name
  const has = t.files.length > 0
  $('#files-list').innerHTML = has
    ? t.files.map((f, i) => `<li><label class="frow">
        <input type="checkbox" class="ck" value="${i}" ${f.selected !== false ? 'checked' : ''}>
        <span class="fn" title="${esc(f.name)}">${esc(f.name.split('/').pop())}</span>
        <span class="fs">${size(f.length)}</span>
      </label><div class="line"><span style="width:${(f.progress || 0) * 100}%"></span></div></li>`).join('')
    : '<li class="fempty">Список файлов появится, когда придут метаданные</li>'
  $('#files-save').hidden = !has
  $('#files-all').hidden = !has
  $('#files').showModal()
}
$('#files-all').onclick = () => {
  const cks = [...document.querySelectorAll('#files-list .ck')]
  const all = cks.every(c => c.checked)
  cks.forEach(c => { c.checked = !all })
}
$('#files').addEventListener('close', async () => {
  if ($('#files').returnValue !== 'save' || !filesHash) return
  const selected = [...document.querySelectorAll('#files-list .ck')].filter(c => c.checked).map(c => +c.value)
  try {
    await api(`/api/torrent/${filesHash}/files`, { body: JSON.stringify({ selected }) })
    note('Файлы', `Качаю ${selected.length} ${selected.length === 1 ? 'файл' : 'файлов'}`)
  } catch (err) { note('Не сохранено', err.message, true) }
})

function askRemove (t) {
  const dlg = $('#confirm')
  $('#confirm-name').textContent = t.name
  $('#confirm-files').checked = false
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return
    try {
      await api(`/api/torrent/${t.hash}/remove?files=${$('#confirm-files').checked ? 1 : 0}`)
      note('Удалено', t.name)
    } catch (err) { note('Ошибка', err.message, true) }
  }
  dlg.showModal()
}

const gbs = n => size(n)
let picked = []

async function addMagnet (text, dir) {
  try {
    const q = dir ? '?dir=' + encodeURIComponent(dir) : ''
    const { hash } = await api('/api/add' + q, { body: text })
    note('Торрент добавлен', decodeURIComponent((text.match(/dn=([^&]+)/) || [])[1] || 'magnet').replace(/\+/g, ' '))
    setTimeout(() => setFocus(hash), 1100)
  } catch (err) { note('Не добавлено', err.message, true) }
}
async function addFiles (files, dir) {
  const q = dir ? '?dir=' + encodeURIComponent(dir) : ''
  for (const f of files) {
    try {
      const { hash } = await api('/api/add' + q, { body: await f.arrayBuffer(), headers: { 'content-type': 'application/x-bittorrent' } })
      note('Торрент добавлен', f.name.replace(/\.torrent$/i, ''))
      setTimeout(() => setFocus(hash), 1100)
    } catch (err) { note(f.name, err.message, true) }
  }
}

let spaceReq = 0
async function showSpace (el, dir, need = 0) {
  const my = ++spaceReq
  try {
    const d = await (await fetch('/api/disk?dir=' + encodeURIComponent(dir || ''))).json()
    if (my !== spaceReq && el.id === 'add-space') return
    const fits = !need || need <= d.free
    el.classList.toggle('bad', !fits)
    el.textContent = need
      ? (fits ? `Займёт ${gbs(need)} · свободно ${gbs(d.free)}` : `Не влезет: нужно ${gbs(need)}, свободно ${gbs(d.free)}`)
      : `Свободно ${gbs(d.free)} из ${gbs(d.total)}`
  } catch { el.textContent = '' }
}
const pickedNeed = () => picked.reduce((a, p) => a + (p.length || 0), 0)

function openAdd () {
  picked = []
  $('#magnet').value = ''
  $('#picked').hidden = true
  $('#add-dir').value = data.settings.downloadDir || ''
  showSpace($('#add-space'), $('#add-dir').value)
  $('#add').showModal()
}
$('#island').onclick = openAdd

let dirTimer
$('#add-dir').addEventListener('input', () => {
  clearTimeout(dirTimer)
  dirTimer = setTimeout(() => showSpace($('#add-space'), $('#add-dir').value, pickedNeed()), 250)
})

$('#file').addEventListener('change', async e => {
  const files = [...e.target.files]; e.target.value = ''
  picked = []
  for (const f of files) {
    try {
      const info = await api('/api/inspect', { body: await f.arrayBuffer(), headers: { 'content-type': 'application/x-bittorrent' } })
      picked.push({ file: f, ...info })
    } catch { picked.push({ file: f, name: f.name, length: 0 }) }
  }
  const el = $('#picked')
  el.hidden = !picked.length
  el.innerHTML = picked.map(p => `<div><b>${esc(p.name || p.file.name)}</b><span>${p.length ? gbs(p.length) : ''}</span></div>`).join('')
  showSpace($('#add-space'), $('#add-dir').value, pickedNeed())
})

$('#add').addEventListener('close', () => {
  if ($('#add').returnValue !== 'ok') return
  const dir = $('#add-dir').value.trim()
  const custom = dir && dir !== data.settings.downloadDir ? dir : ''
  const v = $('#magnet').value.trim()
  if (v) addMagnet(v, custom)
  if (picked.length) addFiles(picked.map(p => p.file), custom)
})

document.addEventListener('paste', e => {
  if (e.target.matches('input')) return
  const text = e.clipboardData.getData('text').trim()
  if (text.startsWith('magnet:')) addMagnet(text)
})

let dragDepth = 0
addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#drop').classList.add('on') })
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('on') } })
addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('on')
  const files = [...e.dataTransfer.files].filter(f => f.name.endsWith('.torrent'))
  if (files.length) return addFiles(files)
  const text = e.dataTransfer.getData('text')
  if (text.startsWith('magnet:')) addMagnet(text)
})

const NUM = ['downloadLimit', 'uploadLimit', 'seedRatio', 'seedHours', 'maxActive', 'torrentPort']
const BOOL = ['startPaused', 'notify', 'autostart', 'closeToTray']
$('#open-settings').onclick = () => {
  const f = $('#settings-form'), st = data.settings
  f.elements.downloadDir.value = st.downloadDir || ''
  for (const k of NUM) f.elements[k].value = st[k] || (k === 'torrentPort' ? 6881 : '')
  for (const k of BOOL) f.elements[k].checked = !!st[k]
  for (const r of f.querySelectorAll('[name=afterAll]')) r.checked = r.value === (st.afterAll || 'none')
  showSpace($('#set-space'), st.downloadDir)
  $('#settings').showModal()
}
$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'save') return
  const f = $('#settings-form'), body = { downloadDir: f.elements.downloadDir.value }
  for (const k of NUM) body[k] = f.elements[k].value === '' ? 0 : f.elements[k].value
  for (const k of BOOL) body[k] = f.elements[k].checked
  body.afterAll = f.querySelector('[name=afterAll]:checked')?.value || 'none'
  try {
    const r = await api('/api/settings', { body: JSON.stringify(body) })
    const after = { suspend: ' · усну, когда всё скачается', poweroff: ' · выключусь, когда всё скачается' }[body.afterAll] || ''
    note('Настройки сохранены', (r.restartNeeded ? 'Новый порт заработает после перезапуска' : 'Всё применено') + after)
  } catch (err) { note('Не сохранено', err.message, true) }
})

function tick () {
  const d = new Date()
  $('#time').textContent = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
  $('#date').textContent = d.toLocaleDateString('ru', { weekday: 'short', day: 'numeric', month: 'short' }).replace('.', '')
}
tick(); setInterval(tick, 10000)

setInterval(renderIsland, 120)

if (window.native) {
  document.documentElement.classList.add('native')
  $('#wctl').hidden = false
  $('#wctl').addEventListener('click', e => { const b = e.target.closest('[data-w]'); if (b) window.native[b.dataset.w]() })
  $('.status').addEventListener('dblclick', e => { if (!e.target.closest('button')) window.native.maximize() })
}
