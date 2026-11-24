// GitHub Pages publisher. The repository token lives only in the connected client.
const utf8 = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const maxPackage = 2147483647
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

function number(value, label, max = maxPackage) {
  const n = Number(value)
  check(/^\d+$/.test(String(value)) && Number.isSafeInteger(n) && n > 0 && n <= max, `${label} inválido.`)
  return n
}

function slug(value) {
  check(typeof value === 'string' && /^[a-z\d-]{1,40}$/.test(value),
    'Use até 40 letras minúsculas, dígitos e hífens no identificador.')
  return value
}

function https(value) {
  check(typeof value === 'string' && value.length <= 512 && value.startsWith('https://') &&
    !/[^\x21-\x7e]|[\\#]/.test(value), 'O endereço do arquivo deve usar HTTPS.')
  const u = new URL(value)
  check(!u.username && !u.password && !u.port && /^[a-z0-9.-]+$/i.test(u.hostname),
    'Endereço HTTPS inválido.')
  return u
}

function base(value) {
  const u = https(String(value))
  check(!u.search && !/%|\/\.|\/\//.test(u.pathname), 'Endereço público do site inválido.')
  return u.href.replace(/\/*$/, '/')
}

function pkg(v) {
  check(digestPattern.test(v.sha256 || ''), 'SHA-256 inválido.')
  https(v.url)
  return { url: v.url, sha256: v.sha256.toLowerCase(), size: number(v.size, 'Tamanho') }
}

function game(v) {
  const item = { slug: slug(v.slug), title: field(v.title, 80, 'Título'), genre: field(v.genre, 48, 'Gênero'),
    description: field(v.description, 320, 'Descrição'), ...pkg(v) }
  if (v.cover) { https(v.cover); item.cover = v.cover }
  return item
}

function update(v) {
  return { build: number(v.build, 'Build'), ...pkg(v), notes: field(v.notes, 320, 'Notas', true) }
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
    const allowed = isGame ? ['title','genre','description','url','sha256','size','cover'] : ['build','url','sha256','size','notes']
    check(Object.keys(data).every(k => allowed.includes(k)), 'Campo desconhecido no catálogo.')
    if (isGame) result.games.push(game({ ...data, slug: name.slice(5) }))
    else result.update = update(data)
  }
  check(result.games.length <= 64, 'O catálogo comporta até 64 jogos.')
  return result
}

function writeFeed(feed) {
  const lines = ['[store]', 'schema=1']
  const section = (name, data) => {
    lines.push('', '[' + name + ']')
    for (const [key, value] of Object.entries(data)) if (value !== '') lines.push(key + '=' + value)
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
    const path = u.pathname.toLowerCase()
    const prefix = '/' + owner.toLowerCase() + '/' + repo.toLowerCase() + '/releases/download/'
    const trustedRelease = u.hostname === 'github.com' && path.startsWith(prefix) &&
      /^[^/]+\/[^/]+$/.test(path.slice(prefix.length)) && !/%2e|%2f|%5c|\/\./.test(path)
    check((u.origin === b.origin && u.pathname.startsWith(b.pathname)) || trustedRelease,
      'O arquivo precisa estar neste site ou em uma Release deste repositório.')
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
  }
  return feed
}

function b64(bytes) {
  let s = ''
  for (let at = 0; at < bytes.length; at += 16384) s += String.fromCharCode(...bytes.subarray(at, at + 16384))
  return btoa(s)
}
function fromB64(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)) }
async function hash(bytes, algorithm = 'SHA-256') {
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

function isXex(bytes) { return bytes.length >= 4 && bytes[0] === 88 && bytes[1] === 69 && bytes[2] === 88 && bytes[3] === 50 }
function isZip(bytes) { return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) && (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08) }
const crcTable = (() => { const t = new Uint32Array(256); for (let i=0;i<256;i++){ let c=i; for(let k=0;k<8;k++) c = c&1 ? (0xEDB88320 ^ (c>>>1)) : (c>>>1); t[i]=c>>>0; } return t })()
function crc32(bytes){ let c=0xFFFFFFFF; for(let i=0;i<bytes.length;i++) c = crcTable[(c^bytes[i])&0xFF] ^ (c>>>8); return (c^0xFFFFFFFF)>>>0 }
function dosDateTime(d=new Date()){ const year=Math.max(1980,d.getFullYear()); const dosTime=((d.getHours()&31)<<11)|((d.getMinutes()&63)<<5)|((Math.floor(d.getSeconds()/2))&31); const dosDate=(((year-1980)&127)<<9)|(((d.getMonth()+1)&15)<<5)|(d.getDate()&31); return {dosTime,dosDate} }
async function zipFiles(files, onProgress) {
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
  async function payload(form, forUpdate, notify) {
    const folderFiles = Array.from(form.files || []).filter(f => f && f.size >= 0)
    const hasFolder = folderFiles.length > 1 || (folderFiles.length === 1 && (folderFiles[0].webkitRelativePath || folderFiles[0].path))
    const hasSingle = Boolean(form.file)
    check((hasSingle || hasFolder) !== Boolean(form.assetId), 'Escolha um arquivo/pasta local ou um arquivo de Release.')
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
      check(f.size >= 4 && f.size <= maxDirect, 'Arquivo acima de 100 MiB para envio direto. Use uma Release do GitHub ou um pacote menor.')
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
  async function commit(start, item, asUpdate) {
    const get = feed => asUpdate ? feed.update : feed.games.find(g => g.slug === item.slug)
    const original = get(start.feed)
    let state = start
    for (let attempt = 0; attempt < 5; attempt++) {
      if (equal(get(state.feed), item)) return state.feed
      check(equal(get(state.feed), original), 'Outra publicação alterou este mesmo item. Recarregue antes de publicar.')
      const feed = { ...state.feed, games: [...state.feed.games] }
      if (asUpdate) feed.update = item
      else {
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
  async function publishGame(form) {
    const id = slug(form.slug)
    const title = field(form.title, 80, 'Título'), genre = field(form.genre, 48, 'Gênero')
    const description = field(form.description, 320, 'Descrição')
    const notify = form.onProgress || (() => {})
    const start = await current()
    const old = start.feed.games.find(g => g.slug === id)
    check(old || start.feed.games.length < 64, 'O catálogo atingiu 64 jogos.')
    let cover = old?.cover
    if (form.coverFile) {
      check(form.coverFile.size > 0 && form.coverFile.size <= maxCover, 'A capa pode ter até 2 MiB.')
      const bytes = new Uint8Array(await form.coverFile.arrayBuffer())
      const ext = imageType(bytes)
      notify('Enviando a capa…')
      cover = await storeBytes('media/' + await hash(bytes) + '.' + ext, bytes)
    }
    const p = old && !form.file && !form.assetId ? pkg(old) : await payload(form, false, notify)
    notify('Atualizando o catálogo…')
    return commit(start, game({ slug: id, title, genre, description, ...p, cover }), false)
  }
  async function publishUpdate(form) {
    const build = number(form.build, 'Build')
    const notes = field(form.notes, 320, 'Notas', true)
    const start = await current()
    check(build > (start.feed.update?.build || 0), 'Use um build maior que o já publicado.')
    const notify = form.onProgress || (() => {})
    const p = await payload(form, true, notify)
    notify('Publicando a atualização…')
    return commit(start, update({ build, notes, ...p }), true)
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
  return { listAssets, publishGame, publishUpdate, listIdeas, readIdea, submitIdea, replyIdea }
}
