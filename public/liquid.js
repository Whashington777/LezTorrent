// Liquid glass: настоящая линза через SVG feDisplacementMap.
// Для каждого .glass строим карту смещения по форме скруглённого прямоугольника:
// в центре стекло чистое, у кромки (bezel) фон загибается внутрь, как в толстой линзе.
// Три канала смещаются с разной силой — лёгкая хроматическая аберрация на кромке.

const NS = 'http://www.w3.org/2000/svg'
const defs = (() => {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', 0); svg.setAttribute('height', 0)
  svg.style.cssText = 'position:absolute;pointer-events:none'
  svg.setAttribute('aria-hidden', 'true')
  const d = document.createElementNS(NS, 'defs')
  svg.append(d); document.body.prepend(svg)
  return d
})()

const smooth = t => t * t * (3 - 2 * t)

// карта смещения: R = dx, G = dy (128 = ноль)
function buildMap (w, h, radius, bezel) {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(w, h)
  const hw = w / 2, hh = h / 2
  const r = Math.min(radius, hw, hh)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + .5 - hw, py = y + .5 - hh
      // SDF скруглённого прямоугольника
      const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r)
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0)
      const outside = Math.hypot(ox, oy)
      const sd = outside + Math.min(Math.max(qx, qy), 0) - r // <0 внутри
      // нормаль наружу
      let nx, ny
      if (outside > 0) { nx = ox / outside; ny = oy / outside } else if (qx > qy) { nx = 1; ny = 0 } else { nx = 0; ny = 1 }
      nx *= Math.sign(px) || 1; ny *= Math.sign(py) || 1
      // сила: 1 на кромке → 0 к центру (профиль выпуклой линзы)
      const t = Math.min(Math.max(-sd / bezel, 0), 1)
      const k = 1 - smooth(t)
      const mag = k * k
      // смещаем выборку внутрь — фон «затягивает» к центру на кромке
      const i = (y * w + x) * 4
      img.data[i] = 128 - nx * mag * 127
      img.data[i + 1] = 128 - ny * mag * 127
      img.data[i + 2] = 128
      img.data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return c.toDataURL()
}

let uid = 0
const cache = new Map()

function makeFilter (w, h, radius, opts) {
  const bezel = Math.max(8, Math.min(opts.bezel, Math.min(w, h) / 2.2))
  const key = `${w}x${h}r${radius}b${bezel}s${opts.strength}`
  if (cache.has(key)) return cache.get(key)
  const id = 'lg' + uid++
  const map = buildMap(w, h, radius, bezel)
  const s = opts.strength
  const f = document.createElementNS(NS, 'filter')
  f.id = id
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })) f.setAttribute(k, v)
  f.innerHTML = `
    <feImage href="${map}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="${s}" xChannelSelector="R" yChannelSelector="G" result="dR"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="${s * .97}" xChannelSelector="R" yChannelSelector="G" result="dG"/>
    <feDisplacementMap in="SourceGraphic" in2="map" scale="${s * .94}" xChannelSelector="R" yChannelSelector="G" result="dB"/>
    <feColorMatrix in="dR" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>
    <feColorMatrix in="dG" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>
    <feColorMatrix in="dB" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>
    <feComposite in="r" in2="g" operator="arithmetic" k2="1" k3="1" result="rg"/>
    <feComposite in="rg" in2="b" operator="arithmetic" k2="1" k3="1" result="rgb"/>
    <feGaussianBlur in="rgb" stdDeviation="${opts.blur}"/>`
  defs.append(f)
  cache.set(key, id)
  return id
}

function apply (el) {
  const r = el.getBoundingClientRect()
  const w = Math.round(r.width), h = Math.round(r.height)
  if (w < 4 || h < 4) return
  const cs = getComputedStyle(el)
  const radius = parseFloat(cs.borderTopLeftRadius) || 0
  const opts = {
    strength: +(el.dataset.lgStrength || 70),
    bezel: +(el.dataset.lgBezel || Math.min(w, h) * .32),
    blur: +(el.dataset.lgBlur || .4),
  }
  const id = makeFilter(w, h, Math.min(radius, w / 2, h / 2), opts)
  const v = `url(#${id}) saturate(1.1) brightness(1.1)`
  if (el._lg !== v) { el.style.backdropFilter = v; el._lg = v }
}

const ro = new ResizeObserver(entries => { for (const e of entries) apply(e.target) })
const seen = new WeakSet()
function scan (root = document) {
  root.querySelectorAll?.('.glass').forEach(el => { if (!seen.has(el)) { seen.add(el); ro.observe(el); apply(el) } })
}
new MutationObserver(ms => { for (const m of ms) m.addedNodes.forEach(n => { if (n.nodeType === 1) { if (n.classList.contains('glass')) scan(n.parentNode); else scan(n) } }) })
  .observe(document.body, { childList: true, subtree: true })
scan()
