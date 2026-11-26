// GitHub Pages publisher. The repository token lives only in the connected client.
const utf8 = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const maxPackage = 20 * 1024 * 1024 * 1024 // 20 GiB - multipart/Drive
const maxDirect = 100 * 1024 * 1024
const maxCover = 2 * 1024 * 1024
const maxFeed = 64 * 1024
const digestPattern = /^[a-f\d]{64}$/i
const ideaPrefix = '[Ideia] '
const chatMark = '<!-- dash:chat -->'

function check(ok, message) {
  if (!ok) throw new Error(message)
}

function field(value, bytes, label, optional = false) {
  const s = String(value ?? '').trim()
  check((optional || s.length > 0) && !/[\x00-\x1f\x7f]/.test(s) && utf8.encode(s).length <= bytes,
    `${label} deve ocupar até ${bytes} bytes em uma linha.`)
  return s
}

function number(value, label, max = maxPackage, min = 1) {
  const n = Number(value)
  check(/^\d+$/.test(String(value)) && Number.isSafeInteger(n) && n >= min && n <= max, `${label} inválido.`)
  return n
}

function slug(value) {
  check(typeof value === 'string' && /^[a-z\d-]{1,40}$/.test(value),
    'Use até 40 letras minúsculas, dígitos e hífens no identificador.')
  return value
}

function https(value) {
  const raw = String(value ?? '')
  const localHttp = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(raw)
  check(typeof value === 'string' && value.length <= 512 && (value.startsWith('https://') || localHttp) &&
    !/[^\x21-\x7e]|[\\#]/.test(value), 'O endereço do arquivo deve usar HTTPS.')
  const u = new URL(value)
  const loopback = u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  check(!u.username && !u.password && (u.protocol === 'https:' || loopback) && /^[a-z0-9.:[\]-]+$/i.test(u.hostname),
    'Endereço HTTPS inválido.')
  return u
}

function base(value) {
  const u = https(String(value))
  check(!u.search && !/%|\/\.|\/\//.test(u.pathname), 'Endereço público do site inválido.')
  return u.href.replace(/\/*$/, '/')
}

function parseParts(v, maxTotal=maxPackage) {
  const n = v.parts === '' || v.parts == null ? 0 : number(v.parts, 'Parts', 64)
  if (!n) return []
  const parts = []
  let total = 0
  for (let i = 0; i < n; i++) {
    const p = { url: v['part'+i+'_url'] || v['part'+i+'url'], sha256: (v['part'+i+'_sha256'] || v['part'+i+'sha256'] || '').toLowerCase(), size: v['part'+i+'_size'] || v['part'+i+'size'] }
    check(p.url && p.sha256 && p.size, 'Parte ' + i + ' inválida no catálogo.')
    https(p.url); check(digestPattern.test(p.sha256), 'SHA-256 da parte inválido.')
    const size = number(p.size, 'Tamanho da parte', maxTotal)
    total += size; check(total <= maxTotal, 'Pacote multipart excede o limite.')
    parts.push({ url: p.url, sha256: p.sha256, size })
  }
  return parts
}

function pkg(v) {
  check(digestPattern.test(v.sha256 || ''), 'SHA-256 inválido.')
  https(v.url)
  const out = { url: v.url, sha256: v.sha256.toLowerCase(), size: number(v.size, 'Tamanho') }
  const parts = Array.isArray(v.parts) ? v.parts : parseParts(v)
  if (parts.length) {
    out.parts = parts.map((p, i) => {
      https(p.url); check(digestPattern.test(p.sha256||''), 'SHA-256 da parte inválido.')
      return { url: p.url, sha256: String(p.sha256).toLowerCase(), size: number(p.size, 'Tamanho da parte', maxPackage) }
    })
  }
  return out
}

function game(v) {
  const item = { slug: slug(v.slug), title: field(v.title, 80, 'Título'), genre: field(v.genre, 48, 'Gênero'),
    description: field(v.description, 320, 'Descrição'), ...pkg(v) }
  if (v.cover) { https(v.cover); item.cover = v.cover }
  if (v.background) { https(v.background); item.background = v.background }
  return item
}

function update(v) {
  return { build: number(v.build, 'Build', 100, 0), ...pkg(v), notes: field(v.notes, 320, 'Notas', true) }
}

export function readFeed(text) {
  check(typeof text === 'string' && utf8.encode(text).length <= maxFeed && !text.startsWith('\uFEFF'),
    'O catálogo excedeu 64 KiB ou tem codificação incompatível.')
  const sections = new Map()
  let current
  for (const raw of text.split(/\r?\n/)) {
    check(utf8.encode(raw).length <= 1024 && !/[\r\x00-\x08\x0b-\x1f\x7f]/.test(raw), 'Linha inválida no catálogo.')
    const s = raw.trim()
    if (!s || s.startsWith(';') || s.startsWith('#')) continue
    if (s[0] === '[') {
      const match = /^\[(store|update|game:[a-z\d-]{1,40})\]$/.exec(s)
      check(match && !sections.has(match[1]) && (sections.size || match[1] === 'store'), 'Seção inválida ou duplicada.')
      current = Object.create(null)
      sections.set(match[1], current)
    } else {
      const eq = s.indexOf('=')
      const key = s.slice(0, eq).trim()
      check(current && eq > 0 && /^[a-z\d]+$/.test(key) && !Object.hasOwn(current, key), 'Campo inválido ou duplicado.')
      current[key] = s.slice(eq + 1).trim()
    }
  }
  check(sections.get('store')?.schema === '1' && Object.keys(sections.get('store')).length === 1,
    'Versão do catálogo incompatível.')
  const result = { games: [], update: null }
  for (const [name, data] of sections) {
    if (name === 'store') continue
    const isGame = name.startsWith('game:')
    const allowed = isGame ? ['title','genre','description','url','sha256','size','cover','background','parts'] : ['build','url','sha256','size','notes','parts']
    const partKey = /^part\d+_(url|sha256|size)$/
    check(Object.keys(data).every(k => allowed.includes(k) || partKey.test(k)), 'Campo desconhecido no catálogo.')
    if (isGame) result.games.push(game({ ...data, slug: name.slice(5) }))
    else result.update = update(data)
  }
  check(result.games.length <= 64, 'O catálogo comporta até 64 jogos.')
  return result
}

export function writeFeed(feed) {
  const lines = ['[store]', 'schema=1']
  const section = (name, data) => {
    lines.push('', '[' + name + ']')
    for (const [key, value] of Object.entries(data)) {
      if (value === '' || value == null) continue
      if (key === 'parts' && Array.isArray(value)) {
        if (!value.length) continue
        lines.push('parts=' + value.length)
        value.forEach((p, i) => { lines.push(`part${i}_url=${p.url}`); lines.push(`part${i}_sha256=${p.sha256}`); lines.push(`part${i}_size=${p.size}`) })
        continue
      }
      lines.push(key + '=' + value)
    }
  }
  for (const g of feed.games) {
    const { slug: id, ...rest } = game(g)
    section('game:' + id, rest)
  }
  if (feed.update) section('update', update(feed.update))
  const body = lines.join('\n') + '\n'
  readFeed(body)
  return body
}

function scope(owner, repo, publicBase) {
  const b = new URL(publicBase)
  const host = owner.toLowerCase() + '.github.io'
  check(b.hostname === host && (repo.toLowerCase() === host || b.pathname.split('/')[1]?.toLowerCase() === repo.toLowerCase()),
    'O endereço do Pages precisa pertencer a esse repositório.')
  return function checkSource(value) {
    const u = https(value)
    // Allow same-site, same-repo releases, and external public HTTPS URLs (e.g. Google Drive).
    // External URLs are user-provided public links; the dashboard downloads them directly.
    const path = u.pathname.toLowerCase()
    const prefix = '/' + owner.toLowerCase() + '/' + repo.toLowerCase() + '/releases/download/'
    const trustedRelease = u.hostname === 'github.com' && path.startsWith(prefix) &&
      /^[^/]+\/[^/]+$/.test(path.slice(prefix.length)) && !/%2e|%2f|%5c|\/\./.test(path)
    const sameSite = u.origin === b.origin && u.pathname.startsWith(b.pathname)
    check(sameSite || trustedRelease || u.protocol === 'https:', 'O arquivo precisa usar um endereço HTTPS válido.')
  }
}

export async function loadPublic(baseUrl, config = {}) {
  const publicBase = base(baseUrl)
  const response = await fetch(new URL('feed.ini', publicBase), { cache: 'no-store', credentials: 'omit' })
  check(response.ok, 'Catálogo indisponível no site (HTTP ' + response.status + ').')
  const feed = readFeed(await response.text())
  const u = new URL(publicBase)
  const checkSource = scope(config.owner || u.hostname.split('.')[0], config.repo || u.pathname.split('/')[1] || u.hostname, publicBase)
  for (const entry of [...feed.games, ...(feed.update ? [feed.update] : [])]) {
    checkSource(entry.url)
    if (entry.cover) checkSource(entry.cover)
    if (entry.background) checkSource(entry.background)
  }
  return feed
}

function b64(bytes) {
  let s = ''
  for (let at = 0; at < bytes.length; at += 16384) s += String.fromCharCode(...bytes.subarray(at, at + 16384))
  return btoa(s)
}
function fromB64(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)) }
export async function hash(bytes, algorithm = 'SHA-256') {
  const buf = await crypto.subtle.digest(algorithm, bytes)
  return Array.from(new Uint8Array(buf), n => n.toString(16).padStart(2,'0')).join('')
}
async function gitHash(bytes) {
  const head = utf8.encode('blob ' + bytes.length + '\0')
  const all = new Uint8Array(head.length + bytes.length)
  all.set(head); all.set(bytes, head.length)
  return hash(all, 'SHA-1')
}

function imageType(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let w = 0, h = 0, ext = ''
  if (bytes.length >= 33 && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a &&
      view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
    ext = 'png'; w = view.getUint32(16); h = view.getUint32(20)
  } else if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
    for (let i = 2; i < bytes.length - 3;) {
      if (bytes[i++] !== 255) break
      while (i < bytes.length && bytes[i] === 255) i++
      const marker = bytes[i++]
      if (marker === 0xda || marker === 0xd9 || i + 2 > bytes.length) break
      const len = view.getUint16(i)
      if (len < 2 || i + len > bytes.length) break
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker) && len >= 8) {
        ext = 'jpg'; h = view.getUint16(i + 3); w = view.getUint16(i + 5); break
      }
      i += len
    }
  }
  check(w > 0 && h > 0 && w <= 2048 && h <= 2048, 'Escolha uma capa PNG ou JPEG de até 2048 × 2048.')
  return ext
}

function validName(name, forUpdate) {
  const ok = /\.(xex|zip)$/i.test(name || '')
  check(ok, forUpdate
    ? 'Selecione um pacote .zip da dash completa ou um .xex.'
    : 'Selecione um .xex ou um pacote .zip do jogo.')
}

export function isXex(bytes) { return bytes.length >= 4 && bytes[0] === 88 && bytes[1] === 69 && bytes[2] === 88 && bytes[3] === 50 }
export function isZip(bytes) { return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08) }
const crcTable = (() => { const t = new Uint32Array(256); for (let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c = c&1 ? (0xEDB88320 ^ (c>>>1)) : (c>>>1); t[i]=c>>>0; } return t })()
function crc32(bytes){ let c=0xFFFFFFFF; for(let i=0;i<bytes.length;i++) c = crcTable[(c^bytes[i])&0xFF] ^ (c>>>8); return (c^0xFFFFFFFF)>>>0 }
function dosDateTime(d=new Date()){ const year=Math.max(1980,d.getFullYear()); const dosTime=((d.getHours()&31)<<11)|((d.getMinutes()&63)<<5)|((Math.floor(d.getSeconds()/2))&31); const dosDate=(((year-1980)&127)<<9)|(((d.getMonth()+1)&15)<<5)|(d.getDate()&31); return {dosTime,dosDate} }
export async function zipFiles(files, onProgress) {
  const entries = []
  let total = 0
  for (const f of files) {
    const name = String(f.path || f.name || '').replace(/\\/g,'/').replace(/^\/+/, '')
    check(name && !name.includes('..') && !name.startsWith('/') && utf8.encode(name).length <= 255, 'Nome de arquivo inválido no pacote.')
    if (name.endsWith('/')) continue
    const data = new Uint8Array(await f.arrayBuffer())
    total += data.length
    check(total <= maxDirect, 'O pacote excede o limite de 100 MiB para envio direto. Use um arquivo .zip menor ou uma Release do GitHub.')
    entries.push({ name, data, crc: crc32(data) })
  }
  check(entries.length > 0, 'Selecione ao menos um arquivo.')
  const {dosTime,dosDate} = dosDateTime()
  const localParts = []
  const centralParts = []
  let offset = 0
  for (let i=0;i<entries.length;i++) {
    const e = entries[i]
    const nameBytes = utf8.encode(e.name)
    const local = new Uint8Array(30 + nameBytes.length)
    const v = new DataView(local.buffer)
    v.setUint32(0, 0x04034b50, true); v.setUint16(4,20,true); v.setUint16(6,0,true); v.setUint16(8,0,true)
    v.setUint16(10,dosTime,true); v.setUint16(12,dosDate,true); v.setUint32(14,e.crc,true)
    v.setUint32(18,e.data.length,true); v.setUint32(22,e.data.length,true); v.setUint16(26,nameBytes.length,true); v.setUint16(28,0,true)
    local.set(nameBytes,30)
    localParts.push(local,e.data)
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0,0x02014b50,true); cv.setUint16(4,20,true); cv.setUint16(6,20,true); cv.setUint16(8,0,true); cv.setUint16(10,0,true)
    cv.setUint16(12,dosTime,true); cv.setUint16(14,dosDate,true); cv.setUint32(16,e.crc,true)
    cv.setUint32(20,e.data.length,true); cv.setUint32(24,e.data.length,true); cv.setUint16(28,nameBytes.length,true)
    cv.setUint16(30,0,true); cv.setUint16(32,0,true); cv.setUint16(34,0,true); cv.setUint16(36,0,true); cv.setUint32(38,0,true); cv.setUint32(42,offset,true)
    central.set(nameBytes,46)
    centralParts.push(central)
    offset += local.length + e.data.length
    if (onProgress && i % 10 === 0) onProgress('Empacotando arquivos... ' + (i+1) + '/' + entries.length)
  }
  const centralSize = centralParts.reduce((n,p)=>n+p.length,0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0,0x06054b50,true); ev.setUint16(4,0,true); ev.setUint16(6,0,true); ev.setUint16(8,entries.length,true); ev.setUint16(10,entries.length,true)
  ev.setUint32(12,centralSize,true); ev.setUint32(16,offset,true); ev.setUint16(20,0,true)
  const out = new Uint8Array(offset + centralSize + 22)
  let p = 0
  for (const part of [...localParts, ...centralParts, eocd]) { out.set(part,p); p += part.length }
  return out
}

const ids = /^[a-z\d_.-]{1,100}$/i
const safePath = path => path.split('/').map(encodeURIComponent).join('/')
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b)
const pageSize = 100

export async function connect({ owner, repo, branch = 'main', prefix = '', token, baseUrl }) {
  check(ids.test(owner || '') && ids.test(repo || '') && !['.','..'].includes(repo) && !['.','..'].includes(owner),
    'Informe usuário e repositório do GitHub.')
  branch = field(branch, 250, 'Branch')
  prefix = String(prefix).trim().replace(/^\/+|\/+$/g,'')
  check(!prefix || prefix.split('/').every(p => ids.test(p) && !p.startsWith('.')), 'Pasta do site inválida.')
  check(typeof token === 'string' && token.trim(), 'Informe o token de publicação.')
  token = token.trim()
  const publicBase = base(baseUrl)
  const checkSource = scope(owner, repo, publicBase)
  const apiRoot = 'https://api.github.com/repos/' + owner + '/' + repo
  async function api(route, options = {}) {
    const res = await fetch(apiRoot + route, {
      method: options.method || 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        Authorization: 'Bearer ' + token, ...(options.data ? { 'Content-Type': 'application/json' } : {}) },
      body: options.data ? JSON.stringify(options.data) : undefined
    })
    if (!res.ok) {
      const e = new Error('GitHub HTTP ' + res.status + (res.status === 401 || res.status === 403 ? '. Confira o token e as permissões de conteúdo ou Issues.' : '.'))
      e.status = res.status
      throw e
    }
    return res.json()
  }
  async function pages(route) {
    const list = []
    for (let page = 1;; page++) {
      const data = await api(route + (route.includes('?') ? '&' : '?') + 'per_page=' + pageSize + '&page=' + page)
      check(Array.isArray(data), 'Resposta inesperada do GitHub.')
      list.push(...data)
      if (data.length < pageSize) return list
    }
  }
  const repository = await api('')
  check(!repository.private && !repository.archived, 'Escolha um repositório público ativo para servir os consoles.')
  await api('/branches/' + encodeURIComponent(branch))
  const route = path => '/contents/' + safePath(prefix ? prefix + '/' + path : path)
  async function info(path) {
    try {return await api(route(path) + '?ref=' + encodeURIComponent(branch))}
    catch (e) { if (e.status === 404) return null; throw e }
  }
  async function current() {
    const file = await info('feed.ini')
    if (!file) return { feed: { games: [], update: null }, sha: null }
    check(file.type === 'file' && file.encoding === 'base64' && file.size <= maxFeed, 'feed.ini inválido no repositório.')
    const feed = readFeed(decoder.decode(fromB64(file.content)))
    for (const entry of [...feed.games, ...(feed.update ? [feed.update] : [])]) {
      checkSource(entry.url)
      if (entry.cover) checkSource(entry.cover)
    if (entry.background) checkSource(entry.background)
    }
    return { feed, sha: file.sha }
  }
  async function storeBytes(path, bytes) {
    const url = new URL(path, publicBase).href
    checkSource(url)
    const expected = await gitHash(bytes)
    const content = b64(bytes)
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await info(path)
      if (existing) { check(existing.sha === expected, 'O arquivo imutável divergiu no GitHub.'); return url }
      try {
        await api(route(path), { method: 'PUT', data: { branch, message: 'Publicar arquivo ' + path, content } })
        return url
      } catch (e) {
        if (![409,422].includes(e.status) || attempt === 3) throw e
      }
    }
  }
  async function listAssets() {
    const releases = (await pages('/releases')).filter(r => !r.draft)
    const assets = []
    for (const release of releases) {
      const items = await pages('/releases/' + number(release.id,'Release',Number.MAX_SAFE_INTEGER) + '/assets')
      for (const a of items) {
        if (a.state !== 'uploaded' || !/\.(xex|zip)$/i.test(a.name) || !Number.isInteger(a.size) || a.size <= 0 || a.size > maxPackage) continue
        checkSource(a.browser_download_url)
        const digest = /^sha256:([a-f\d]{64})$/i.exec(a.digest || '')
        assets.push({ id: a.id, name: a.name, tag: release.tag_name, size: a.size,
          sha256: digest?.[1].toLowerCase() || '', url: a.browser_download_url })
      }
    }
    return assets
  }
  function normalizeExternalUrl(raw) {
    let u = String(raw || '').trim()
    const m = u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) || u.match(/[?&]id=([a-zA-Z0-9_-]+)/)
    if (m && /drive\.google\.com/.test(u)) u = 'https://drive.google.com/uc?export=download&confirm=t&id=' + m[1]
    https(u)
    return u
  }

  async function payload(form, forUpdate, notify) {
    const folderFiles = Array.from(form.files || []).filter(f => f && f.size >= 0)
    const hasFolder = folderFiles.length > 1 || (folderFiles.length === 1 && (folderFiles[0].webkitRelativePath || folderFiles[0].path))
    const hasSingle = Boolean(form.file)
    const hasExternal = Boolean(form.externalUrl)
    const local = hasSingle || hasFolder
    check([local, Boolean(form.assetId), hasExternal].filter(Boolean).length === 1, 'Escolha arquivo/pasta local, Release ou URL externa.')
    if (form.externalUrl) {
      const url = normalizeExternalUrl(form.externalUrl)
      const sha256 = String(form.externalSha || '').trim().toLowerCase()
      check(digestPattern.test(sha256), 'Informe o SHA-256 do arquivo externo.')
      const size = number(form.externalSize, 'Tamanho', maxPackage)
      const parts = Array.isArray(form.parts) ? form.parts.map(p => ({ url: normalizeExternalUrl(p.url), sha256: String(p.sha256||'').toLowerCase(), size: number(p.size, 'Tamanho da parte', maxPackage) })) : []
      parts.forEach(p => check(digestPattern.test(p.sha256), 'SHA-256 da parte inválido.'))
      if (parts.length) check(parts.reduce((a,p)=>a+p.size,0) === size, 'Soma das partes deve ser igual ao tamanho total.')
      return parts.length ? { url, sha256, size, parts } : { url, sha256, size }
    }
    if (form.assetId) {
      const id = number(form.assetId, 'Arquivo da Release', Number.MAX_SAFE_INTEGER)
      notify('Verificando o arquivo na Release…')
      const selected = (await listAssets()).find(a => a.id === id)
      check(selected, 'O arquivo já não está em uma Release pública.')
      validName(selected.name, forUpdate)
      check(selected.sha256, 'O GitHub não informou SHA-256. Reenvie o arquivo à Release.')
      return pkg(selected)
    }

    let bytes
    let ext = '.zip'
    if (hasFolder) {
      notify('Empacotando pasta em .zip…')
      const mapped = folderFiles.map(f => ({ path: f.webkitRelativePath || f.name, arrayBuffer: () => f.arrayBuffer() }))
      bytes = await zipFiles(mapped, notify)
      ext = '.zip'
    } else {
      const f = form.file
      validName(f.name, forUpdate)
      check(f.size >= 4 && f.size <= maxDirect, 'Arquivo acima de 100 MiB para envio direto. Conecte o Google Drive para upload automático, ou use Release/URL externa.')
      notify('Lendo arquivo e calculando SHA-256…')
      bytes = new Uint8Array(await f.arrayBuffer())
      const zip = isZip(bytes)
      const xex = isXex(bytes)
      check(zip || xex, 'Envie um .xex válido ou um pacote .zip.')
      ext = zip ? '.zip' : '.xex'
      if (xex) check(bytes[0] === 88 && bytes[1] === 69 && bytes[2] === 88 && bytes[3] === 50, 'XEX2 inválido.')
    }
    check(bytes.length > 0 && bytes.length <= maxPackage, 'Pacote inválido.')
    notify('Calculando SHA-256…')
    const sha256 = await hash(bytes)
    notify('Enviando pacote ao GitHub…')
    const url = await storeBytes('media/' + sha256 + ext, bytes)
    return { url, sha256, size: bytes.length }
  }
  async function commit(start, item, asUpdate, previousSlug = '') {
    const oldSlug = previousSlug || item.slug
    const get = feed => asUpdate ? feed.update : feed.games.find(g => g.slug === oldSlug)
    const original = get(start.feed)
    let state = start
    for (let attempt = 0; attempt < 5; attempt++) {
      if (asUpdate || item.slug === oldSlug) {
        if (equal(get(state.feed), item)) return state.feed
        check(equal(get(state.feed), original), 'Outra publicação alterou este item. Recarregue antes de publicar.')
      } else {
        const currentOld = state.feed.games.find(g => g.slug === oldSlug)
        const currentTarget = state.feed.games.find(g => g.slug === item.slug)
        if (!currentOld && equal(currentTarget, item)) return state.feed
        check(equal(currentOld, original), 'Outra publicação alterou este jogo. Recarregue antes de publicar.')
        check(!currentTarget, 'Já existe um jogo com esse identificador.')
      }
      const feed = { ...state.feed, games: [...state.feed.games] }
      if (asUpdate) feed.update = item
      else {
        if (previousSlug && previousSlug !== item.slug) feed.games = feed.games.filter(g => g.slug !== previousSlug)
        const i = feed.games.findIndex(g => g.slug === item.slug)
        if (i >= 0) feed.games[i] = item
        else feed.games.unshift(item)
      }
      const content = b64(utf8.encode(writeFeed(feed)))
      try {
        await api(route('feed.ini'), { method: 'PUT', data: { branch, content,
          message: asUpdate ? 'Publicar dashboard build ' + item.build : 'Publicar jogo ' + item.slug,
          ...(state.sha ? { sha: state.sha } : {}) } })
        return feed
      } catch (e) {
        if (![409,422].includes(e.status) || attempt === 4) throw e
        state = await current()
      }
    }
  }
  async function mutateCatalog(mutate, message) {
    let state = await current()
    for (let attempt = 0; attempt < 5; attempt++) {
      const feed = { ...state.feed, games: [...state.feed.games] }
      mutate(feed)
      const content = b64(utf8.encode(writeFeed(feed)))
      try {
        await api(route('feed.ini'), { method: 'PUT', data: { branch, content, message,
          ...(state.sha ? { sha: state.sha } : {}) } })
        return feed
      } catch (e) {
        if (![409,422].includes(e.status) || attempt === 4) throw e
        state = await current()
      }
    }
  }
  async function publishGame(form) {
    const id = slug(form.slug)
    const previousSlug = form.previousSlug ? slug(form.previousSlug) : ''
    const title = field(form.title, 80, 'Título'), genre = field(form.genre, 48, 'Gênero')
    const description = field(form.description, 320, 'Descrição')
    const notify = form.onProgress || (() => {})
    const start = await current()
    const old = start.feed.games.find(g => g.slug === (previousSlug || id))
    check(!previousSlug || old, 'O jogo original não existe mais. Recarregue o catálogo.')
    check(old || start.feed.games.length < 64, 'O catálogo atingiu 64 jogos.')
    check(!previousSlug || previousSlug === id || !start.feed.games.some(g => g.slug === id),
      'Já existe um jogo com esse identificador.')
    let cover = form.removeCover ? undefined : (form.cover || old?.cover)
    if (form.coverFile) {
      check(form.coverFile.size > 0 && form.coverFile.size <= maxCover, 'A capa pode ter até 2 MiB.')
      const bytes = new Uint8Array(await form.coverFile.arrayBuffer())
      const ext = imageType(bytes)
      notify('Enviando a capa…')
      cover = await storeBytes('media/' + await hash(bytes) + '.' + ext, bytes)
    }
    let background = form.removeBackground ? undefined : (form.background || old?.background)
    if (form.backgroundFile) {
      check(form.backgroundFile.size > 0 && form.backgroundFile.size <= maxCover, 'O fundo pode ter até 2 MiB.')
      const bytes = new Uint8Array(await form.backgroundFile.arrayBuffer())
      const ext = imageType(bytes)
      notify('Enviando o fundo…')
      background = await storeBytes('media/' + await hash(bytes) + '.' + ext, bytes)
    }
    const hasFolder = Array.isArray(form.files) && form.files.length > 0
    const p = old && !form.file && !hasFolder && !form.assetId && !form.externalUrl ? pkg(old) : await payload(form, false, notify)
    notify('Atualizando o catálogo…')
    return commit(start, game({ slug: id, title, genre, description, ...p, cover, background }), false, previousSlug || id)
  }
  async function publishUpdate(form) {
    const build = number(form.build, 'Build', 100, 0)
    const notes = field(form.notes, 320, 'Notas', true)
    const start = await current()
    const old = start.feed.update
    check(build > ((old?.build ?? -1)) || (form.editing && old && build === old.build),
      'Use um build maior que o já publicado (0 a 100).')
    const notify = form.onProgress || (() => {})
    const hasFolder = Array.isArray(form.files) && form.files.length > 0
    const p = old && !form.file && !hasFolder && !form.assetId && !form.externalUrl ? pkg(old) : await payload(form, true, notify)
    notify('Publicando a atualização…')
    return commit(start, update({ build, notes, ...p }), true)
  }
  async function deleteGame(value) {
    const id = slug(value)
    return mutateCatalog(feed => {
      check(feed.games.some(g => g.slug === id), 'Jogo não encontrado.')
      feed.games = feed.games.filter(g => g.slug !== id)
    }, 'Excluir jogo ' + id)
  }
  async function deleteUpdate() {
    return mutateCatalog(feed => {
      check(feed.update, 'Não há atualização publicada.')
      feed.update = null
    }, 'Excluir atualização da dashboard')
  }
  async function replaceCatalog(next) {
    const clean = readFeed(writeFeed({ games: next.games || [], update: next.update || null }))
    let state = await current()
    for (let attempt = 0; attempt < 5; attempt++) {
      const content = b64(utf8.encode(writeFeed(clean)))
      try {
        await api(route('feed.ini'), { method: 'PUT', data: { branch, content, message: 'Importar catálogo completo',
          ...(state.sha ? { sha: state.sha } : {}) } })
        return clean
      } catch (e) {
        if (![409,422].includes(e.status) || attempt === 4) throw e
        state = await current()
      }
    }
  }

  function issueView(i) {
    return { number: i.number, title: i.title, body: i.body || '', url: i.html_url, state: i.state }
  }
  async function listIdeas() {
    return (await pages('/issues?state=all')).filter(i => !i.pull_request && i.title.startsWith(ideaPrefix)).map(issueView)
  }
  async function thread(n) {
    n = number(n, 'Número da ideia')
    const i = await api('/issues/' + n)
    check(!i.pull_request && i.title.startsWith(ideaPrefix), 'Este tópico não é uma ideia deste painel.')
    return i
  }
  async function readIdea(n) {
    const i = await thread(n)
    const comments = await pages('/issues/' + i.number + '/comments')
    return { ...issueView(i), comments: comments.map(c => ({ body: c.body || '', author: c.user?.login || '',
      type: c.user?.type || '', url: c.html_url, id: c.id })) }
  }
  function ideaBody(text, chat) {
    const body = String(text ?? '').trim()
    check(body && body.length <= 12000 && !body.includes('<!-- dash:'), 'Escreva até 12 mil caracteres de texto para a ideia.')
    return body + (chat ? '\n\n' + chatMark : '')
  }
  async function submitIdea({ title, body, chat = false }) {
    const i = await api('/issues', { method: 'POST', data: {
      title: ideaPrefix + field(title,160,'Título'), body: ideaBody(body,chat) } })
    return issueView(i)
  }
  async function replyIdea(n, body) {
    const i = await thread(n)
    const reply = await api('/issues/' + i.number + '/comments', { method: 'POST', data: { body: ideaBody(body,true) } })
    return { url: reply.html_url, id: reply.id }
  }
  return { listAssets, publishGame, publishUpdate, deleteGame, deleteUpdate, replaceCatalog, listIdeas, readIdea, submitIdea, replyIdea }
}
