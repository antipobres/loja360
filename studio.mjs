import { connect, loadPublic, readFeed, writeFeed, hash, zipFiles, isXex, isZip } from './publisher.mjs'

const $ = s => document.querySelector(s)
const $$ = s => Array.from(document.querySelectorAll(s))
const names = { inicio: 'Visão geral', biblioteca: 'Biblioteca', catalogo: 'Biblioteca', updates: 'Atualizações', ideias: 'Ideias e IA', conexao: 'Conexão' }
const settings = $('#settings-form')
const publish = $('#publish-form')
const ideaForm = $('#idea-form')
const emptyFeed = () => ({ games: [], update: null })
const LOCAL_FEED_KEY = 'cards-studio-feed-local'
const LOCAL_AT_KEY = 'cards-studio-feed-local-at'
const API_KEY = 'cards-studio-api'
const API_TOKEN_KEY = 'cards-studio-api-token'
const SYNC_KEY = 'cards-studio-sync'
const DEFAULT_LIBRARY_FOLDER = 'https://drive.google.com/drive/folders/1xNVtJi_8Rv48lANGjJBDjTBpmoZaPnvS?usp=sharing'
const DEFAULT_UPDATES_FOLDER = 'https://drive.google.com/drive/folders/1MDYFD_Q6WDB17Jn1YGVIyrOjDqpe6q8p?usp=sharing'

let feed = emptyFeed()
let client = null
let editing = ''
let editingItem = null
let copySource = null
let publication = ''
let activeThread = 0
let pending = null
let readVersion = 0
let threadVersion = 0
let threadStamp = ''
let slugEdited = false
let originalPublishUrl = ''
let githubTokenMem = ''
let api = { enabled: false, base: '', token: '', info: null }
let lastServerError = ''
let aiMessages = []

function node(tag, text, cls) {
  const n = document.createElement(tag)
  if (text != null) n.textContent = text
  if (cls) n.className = cls
  return n
}
function readJSON(key, fallback = null) {
  try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value == null ? fallback : value } catch { return fallback }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true } catch { return false }
}
function readLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_FEED_KEY) || 'null')
    if (!raw) return null
    const value = Array.isArray(raw.games) ? raw : raw.feed
    if (!value || !Array.isArray(value.games)) return null
    return { feed: value, at: Number(localStorage.getItem(LOCAL_AT_KEY) || raw.at || 0) }
  } catch { return null }
}
function saveLocal(next) {
  try { localStorage.setItem(LOCAL_FEED_KEY, JSON.stringify(next)) } catch {}
  try { localStorage.setItem(LOCAL_AT_KEY, String(Date.now())) } catch {}
}
function formatBytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB'
  if (n < 1073741824) return (n / 1048576).toFixed(2) + ' MiB'
  return (n / 1073741824).toFixed(2) + ' GiB'
}
function shortHash(value) {
  const s = String(value || '')
  return s.length > 24 ? s.slice(0, 16) + '…' + s.slice(-8) : s || '—'
}
function sourceLabel() {
  if (api.enabled) return 'Servidor'
  if (config.baseUrl) return 'GitHub Pages'
  return 'Local'
}
function sourceDescription() {
  if (api.enabled) return 'Catálogo salvo no servidor' + (api.info?.aiConfigured ? ' • IA externa ativa' : ' • IA local')
  if (client) return 'Publicando no GitHub Pages'
  if (config.baseUrl) return 'Somente leitura do GitHub Pages'
  return 'Catálogo salvo neste navegador'
}

function infer() {
  const host = location.hostname
  if (!host.endsWith('.github.io')) return {}
  const owner = host.slice(0, -10)
  const parts = new URL('.', location.href).pathname.split('/').filter(Boolean)
  return { owner, repo: parts.shift() || host, branch: 'main', prefix: parts.join('/'), baseUrl: new URL('.', location.href).href }
}
function restore() {
  try { return JSON.parse(localStorage.getItem('cards-studio-source') || 'null') || infer() } catch { return infer() }
}
let config = restore()
try { githubTokenMem = localStorage.getItem('cards-studio-token') || '' } catch {}

function validate(input) {
  const { owner, repo, branch, prefix } = input
  if (!/^[a-z\d-]+$/i.test(owner) || !/^[\w.-]+$/.test(repo) || /^\.+$/.test(repo)) throw Error('Informe a conta e o repositório do GitHub.')
  if (!branch || /[\x00-\x20]/.test(branch) || branch.includes('..')) throw Error('Revise o nome da branch.')
  if (prefix && prefix.split('/').some(p => !/^[\w.-]+$/.test(p) || /^\.+$/.test(p))) throw Error('Revise a pasta no repositório.')
  const hostname = owner.toLowerCase() + '.github.io'
  const root = repo.toLowerCase() === hostname ? '' : repo + '/'
  const expected = 'https://' + hostname + '/' + root
  const url = new URL(input.baseUrl || expected + (prefix ? prefix + '/' : ''))
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  if (url.protocol !== 'https:' || url.host !== hostname || url.username || url.password || url.search || url.hash ||
      !url.href.toLowerCase().startsWith(expected.toLowerCase()) || /[%\\]/.test(url.pathname)) throw Error('Use o endereço HTTPS do GitHub Pages deste repositório.')
  return { owner, repo, branch, prefix, baseUrl: url.href }
}
function githubBase() {
  try { return config.baseUrl ? validate(config).baseUrl : '' } catch { return '' }
}
function fillSettings() {
  if (!settings) return
  for (const k of ['owner', 'repo', 'branch', 'prefix', 'baseUrl']) {
    if (settings.elements[k]) settings.elements[k].value = config[k] || (k === 'branch' ? 'main' : '')
  }
  $$('.connection-label').forEach(x => x.textContent = client ? 'GitHub conectado' : 'Conectar GitHub')
  $$('.connectBtn').forEach(b => b.classList.toggle('connected', !!client))
  const apiUrl = $('#api-url')
  if (apiUrl) apiUrl.value = api.enabled ? api.base : (readJSON(API_KEY, '') || '')
  const apiToken = $('#api-token')
  if (apiToken) apiToken.value = ''
  updateApiStatus()
}
function updateApiStatus() {
  const el = $('#api-status')
  if (!el) return
  if (api.enabled) {
    const auth = api.info?.authRequired ? 'Protegido por chave.' : 'Sem chave de administração.'
    const ia = api.info?.aiConfigured ? 'IA externa configurada.' : 'IA local (sem AI_API_KEY no servidor).'
    el.textContent = `Conectado a ${api.base}. ${auth} ${ia}`
  } else if (lastServerError) {
    el.textContent = 'Servidor não conectado: ' + lastServerError + ' O catálogo continua salvo no navegador/GitHub.'
  } else {
    el.textContent = 'Nenhum servidor conectado. O catálogo fica salvo neste navegador; para persistir entre dispositivos, conecte um servidor Node.'
  }
}

function feedback(text = '', error = false) {
  const el = $('#feedback')
  if (!el) return
  el.textContent = text
  el.hidden = !text
  el.dataset.error = String(error)
}
function route() {
  let key = location.hash.slice(1)
  if (key === 'catalogo') key = 'biblioteca'
  if (!(key in names)) key = 'inicio'
  $$('.view').forEach(s => s.hidden = s.id !== key)
  $$('.rail nav a').forEach(a => {
    if (a.hash === '#' + key) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  })
  const crumb = $('#crumb')
  if (crumb) crumb.textContent = names[key]
  document.title = names[key] + ' • Loja 360'
  if (key === 'ideias') loadIdeas()
  window.scrollTo(0, 0)
}
function empty(title, text) {
  const wrap = node('div', null, 'empty'), art = node('span', null, 'empty-art'), icon = node('i', null, 'ico covers')
  art.setAttribute('aria-hidden', 'true'); art.append(icon)
  const content = node('div'); content.append(node('strong', title), node('p', text)); wrap.append(art, content); return wrap
}
function setCurrentImage(kind, url) {
  const box = $('#current-' + kind)
  const img = $('#current-' + kind + '-img')
  const remove = kind === 'cover' ? publish?.elements.removeCover : publish?.elements.removeBackground
  if (box) box.hidden = !url
  if (img && url) img.src = url
  if (remove) remove.checked = false
}
function listGames(target, games, editable) {
  if (!target) return
  target.replaceChildren()
  if (!games.length) {
    const filtered = editable && ($('#query')?.value?.trim() || '')
    target.append(empty(filtered ? 'Nenhum jogo encontrado' : 'Nenhum jogo publicado', filtered ? 'Tente outro título, gênero ou limpe os filtros.' : 'O primeiro jogo publicado aqui aparecerá no catálogo do Xbox.'))
    return
  }
  const grid = node('div', null, 'gamegrid')
  for (const game of games) {
    const card = node('div', null, 'gamecard'), art = node('div', game.title.substring(0, 2).toUpperCase(), 'art')
    if (game.cover) {
      const img = node('img'); img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'
      img.addEventListener('error', () => art.replaceChildren(document.createTextNode(game.title.substring(0, 2).toUpperCase())), { once: true })
      img.src = game.cover; art.replaceChildren(img)
    }
    const details = node('article')
    details.append(node('span', game.genre, 'meta'), node('h3', game.title), node('p', game.description))
    const facts = node('p', `${formatBytes(game.size)} • ${shortHash(game.sha256)}`, 'hint')
    details.append(facts)
    if (editable) {
      const actions = node('div', null, 'actions compact')
      const edit = node('button', 'Editar', 'outline'); edit.type = 'button'; edit.onclick = () => openPublish('game', game)
      const duplicate = node('button', 'Duplicar', 'outline'); duplicate.type = 'button'; duplicate.onclick = () => openPublish('game', game, true)
      const remove = node('button', 'Excluir', 'danger'); remove.type = 'button'; remove.onclick = () => deleteGame(game.slug)
      actions.append(edit, duplicate, remove)
      const open = node('a', 'Abrir arquivo', 'textlink'); open.href = game.url; open.target = '_blank'; open.rel = 'noopener noreferrer'
      actions.append(open)
      details.append(actions)
    }
    card.append(art, details); grid.append(card)
  }
  target.append(grid)
}
function populateGenres() {
  const select = $('#filter-genre')
  if (!select) return
  const current = select.value
  const genres = [...new Set(feed.games.map(g => g.genre).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  select.replaceChildren(new Option('Todos os gêneros', ''))
  for (const genre of genres) select.add(new Option(genre, genre))
  select.value = genres.includes(current) ? current : ''
}
function filteredGames() {
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const q = norm($('#query')?.value?.trim() || '')
  const genre = $('#filter-genre')?.value || ''
  let list = feed.games.filter(g => (!genre || g.genre === genre) && norm([g.title, g.genre, g.description, g.slug].join(' ')).includes(q))
  const sort = $('#sort-games')?.value || 'recent'
  if (sort === 'title') list = [...list].sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'))
  if (sort === 'size') list = [...list].sort((a, b) => Number(b.size || 0) - Number(a.size || 0))
  if (sort === 'oldest') list = [...list].reverse()
  return list
}
function draw() {
  if (!feed || !Array.isArray(feed.games)) feed = emptyFeed()
  const count = $('#game-count'); if (count) count.textContent = String(feed.games.length)
  const build = $('#build-number'); if (build) build.textContent = feed.update?.build ?? '—'
  const state = $('#source-state'); if (state) state.textContent = sourceLabel()
  const detail = $('#source-detail'); if (detail) detail.textContent = sourceDescription()
  listGames($('#recent'), feed.games.slice(0, 4), false)
  populateGenres()
  const filtered = filteredGames()
  listGames($('#catalog-list'), filtered, true)
  listGames($('#library-list'), filtered, true)
  const countLabel = $('#library-count')
  if (countLabel) countLabel.textContent = `${filtered.length} de ${feed.games.length} jogo(s) • ${sourceDescription()}`
  const update = feed.update
  const title = $('#release-title'); if (title) title.textContent = update ? 'Build ' + update.build : 'Sem build publicada'
  const notes = $('#release-notes'); if (notes) notes.textContent = update?.notes || (update ? '' : 'A primeira versão publicada aparecerá aqui.')
  const meta = $('#release-meta')
  if (meta) {
    meta.replaceChildren()
    if (update) {
      for (const [k, v] of [['Tamanho', formatBytes(update.size)], ['SHA-256', shortHash(update.sha256)]]) meta.append(node('dt', k), node('dd', v))
      const dd = node('dd')
      const link = node('a', 'Abrir arquivo da build', 'textlink'); link.href = update.url; link.target = '_blank'; link.rel = 'noopener noreferrer'
      dd.append(link); meta.append(node('dt', 'Arquivo'), dd)
    }
  }
  const editUpdate = $('#edit-update'); if (editUpdate) editUpdate.disabled = !update
  const deleteUpdate = $('#delete-update'); if (deleteUpdate) deleteUpdate.disabled = !update
  const feedLink = $('#open-feed')
  if (feedLink) { feedLink.href = feedUrl(); feedLink.textContent = api.enabled ? 'Abrir /feed.ini' : 'Abrir feed.ini' }
  updateApiStatus()
}
function feedUrl() {
  if (api.enabled) return api.base.replace(/\/+$/, '') + '/feed.ini'
  const base = githubBase()
  if (base) return base + 'feed.ini'
  try { return new URL('feed.ini', location.href).href } catch { return './feed.ini' }
}
function downloadFile(name, content, type = 'text/plain;charset=utf-8') {
  const ref = URL.createObjectURL(new Blob([content], { type }))
  const a = node('a'); a.href = ref; a.download = name; document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(ref), 1500)
}

let bakedConfig = null
async function loadBakedConfig() {
  if (bakedConfig) return bakedConfig
  const candidates = ['./site-config.json', './studio-config.json', './config.json']
  for (const url of candidates) {
    try {
      const response = await fetch(new URL(url, location.href), { cache: 'no-store', credentials: 'omit' })
      if (!response.ok) continue
      const data = await response.json()
      if (data && typeof data === 'object') { bakedConfig = data; return bakedConfig }
    } catch {}
  }
  if (window.STUDIO_CONFIG && typeof window.STUDIO_CONFIG === 'object') { bakedConfig = window.STUDIO_CONFIG; return bakedConfig }
  bakedConfig = {}
  return bakedConfig
}
function applyBakedConfig(data) {
  if (!data || typeof data !== 'object') return
  const gh = data.github && typeof data.github === 'object' ? data.github : data
  const ghToken = String(gh.token || gh.githubToken || data.token || '').trim()
  const ghConfig = {
    owner: String(gh.owner || config.owner || '').trim(),
    repo: String(gh.repo || config.repo || '').trim(),
    branch: String(gh.branch || config.branch || 'main').trim(),
    prefix: String(gh.prefix || config.prefix || '').trim(),
    baseUrl: String(gh.baseUrl || gh.baseURL || config.baseUrl || '').trim(),
  }
  if (ghConfig.owner && ghConfig.repo) {
    try { config = validate(ghConfig) } catch { config = { ...config, ...ghConfig } }
    try { localStorage.setItem('cards-studio-source', JSON.stringify(config)) } catch {}
  }
  if (ghToken) {
    githubTokenMem = ghToken
    try { localStorage.setItem('cards-studio-token', ghToken) } catch {}
  }
  const apiCfg = data.api && typeof data.api === 'object' ? data.api : {}
  const apiBase = String(apiCfg.base || apiCfg.url || data.apiBase || data.server || '').trim()
  const apiToken = String(apiCfg.token || apiCfg.adminToken || data.apiToken || '').trim()
  if (apiBase) try { localStorage.setItem(API_KEY, JSON.stringify(apiBase)) } catch { localStorage.setItem(API_KEY, apiBase) }
  if (apiToken) try { localStorage.setItem(API_TOKEN_KEY, JSON.stringify(apiToken)) } catch { localStorage.setItem(API_TOKEN_KEY, apiToken) }
}

function probeApi(base, token = '') {
  return new Promise(async (resolve, reject) => {
    const root = String(base || '').replace(/\/+$/, '')
    if (!root) return reject(new Error('Informe o endereço do servidor.'))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    try {
      const response = await fetch(root + '/api/health', {
        cache: 'no-store', credentials: 'omit', signal: controller.signal,
        headers: token ? { 'x-admin-token': token } : {},
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.ok) throw new Error('Resposta HTTP ' + response.status)
      resolve({ enabled: true, base: root, token, info: data })
    } catch (error) {
      reject(error.name === 'AbortError' ? new Error('tempo esgotado') : error)
    } finally { clearTimeout(timer) }
  })
}
async function initApi() {
  const savedBase = String(readJSON(API_KEY, '') || '').trim()
  const token = String(readJSON(API_TOKEN_KEY, '') || '').trim()
  const candidates = []
  if (savedBase) candidates.push(savedBase)
  if (/^https?:$/.test(location.protocol)) candidates.push(location.origin)
  lastServerError = ''
  for (const candidate of [...new Set(candidates)]) {
    try {
      api = await probeApi(candidate, token)
      if (savedBase && candidate === savedBase) fillSettings()
      return true
    } catch (error) {
      if (savedBase && candidate === savedBase) lastServerError = error.message
    }
  }
  api = { enabled: false, base: '', token: '', info: null }
  return false
}
async function apiFetch(path, options = {}) {
  if (!api.enabled) throw new Error('Servidor não conectado. Vá em Conexão → Servidor do catálogo.')
  const headers = new Headers(options.headers || {})
  if (api.token) headers.set('x-admin-token', api.token)
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(api.base + path, { ...options, headers, cache: 'no-store', credentials: 'omit' })
  const type = String(response.headers.get('content-type') || '')
  const data = type.includes('json') ? await response.json().catch(() => null) : await response.text()
  if (!response.ok) throw new Error((data && data.error) || ('HTTP ' + response.status))
  return data
}

async function loadCatalog() {
  if (api.enabled) return await apiFetch('/api/catalog')
  const base = githubBase()
  if (base) return await loadPublic(base, config)
  const local = readLocal()
  if (local) return local.feed
  const response = await fetch(new URL('feed.ini', location.href), { cache: 'no-store' })
  if (!response.ok) throw Error('O catálogo local está indisponível.')
  return readFeed(await response.text())
}
async function refresh(silent = false) {
  const version = ++readVersion
  try {
    const next = await loadCatalog()
    if (version !== readVersion) return
    if (pending) {
      const entry = pending.slug ? next.games.find(g => g.slug === pending.slug) : next.update
      if (JSON.stringify(entry) !== pending.value && Date.now() < pending.deadline) return
      pending = null
    }
    feed = next
    saveLocal(feed)
    draw()
    if (!silent) feedback('Catálogo atualizado: ' + sourceDescription())
  } catch (error) {
    if (version !== readVersion) return
    const local = readLocal()
    if (local) {
      feed = local.feed
      draw()
      if (!silent) feedback('Catálogo remoto indisponível (' + error.message + '). Usando a cópia salva neste navegador.', true)
      return
    }
    if (!silent) feedback('Catálogo indisponível: ' + error.message, true)
  }
}
function broadcastCatalog() {
  try { localStorage.setItem(SYNC_KEY, String(Date.now())) } catch {}
  try { channel?.postMessage({ type: 'catalog', at: Date.now() }) } catch {}
}
function applyCatalog(next, message = '') {
  if (!next || !Array.isArray(next.games)) throw Error('O catálogo recebido é inválido.')
  ++readVersion
  feed = next
  saveLocal(feed)
  draw()
  broadcastCatalog()
  if (message) feedback(message)
}
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('loja360-catalogo') : null
if (channel) channel.onmessage = event => { if (event.data?.type === 'catalog') refresh(true) }
window.addEventListener('storage', event => {
  if (event.key === SYNC_KEY) refresh(true)
  else if (event.key === 'cards-studio-source') { config = restore(); fillSettings(); refresh(true) }
  else if (event.key === API_KEY || event.key === API_TOKEN_KEY) initApi().then(() => { fillSettings(); refresh(true) })
})
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true) })

function requireClient() {
  if (client) return true
  feedback('Conecte o GitHub em Conexão para usar as Issues e ideias.', true)
  location.hash = 'conexao'
  return false
}

settings?.addEventListener('submit', async event => {
  event.preventDefault()
  const button = event.submitter
  if (button) button.disabled = true
  try {
    const data = Object.fromEntries(new FormData(settings))
    const publicConfig = validate({
      owner: data.owner.trim(), repo: data.repo.trim(), branch: data.branch.trim(),
      prefix: data.prefix.trim().replace(/^\/+|\/+$/g, ''), baseUrl: data.baseUrl.trim(),
    })
    const token = String(data.token || '').trim()
    const nextClient = token ? await connect({ ...publicConfig, token }) : null
    if (token) githubTokenMem = token
    if (settings.elements.token) settings.elements.token.value = ''
    config = publicConfig; client = nextClient; pending = null; activeThread = 0; threadVersion++; threadStamp = ''
    writeJSON('cards-studio-source', config)
    try { if (token) localStorage.setItem('cards-studio-token', token); else localStorage.removeItem('cards-studio-token') } catch {}
    fillSettings(); draw()
    feedback(nextClient ? 'GitHub conectado. Você já pode publicar no Pages.' : 'Endereço do Pages salvo. Adicione um token para publicar.')
    await refresh(true)
  } catch (error) { feedback(error.message, true) } finally { if (button) button.disabled = false }
})
$('#disconnect') && ($('#disconnect').onclick = () => {
  client = null; activeThread = 0; threadVersion++; threadStamp = ''
  if (settings?.elements.token) settings.elements.token.value = ''
  try { localStorage.removeItem('cards-studio-token') } catch {}
  fillSettings(); draw()
  feedback('GitHub desconectado. O servidor e a cópia local continuam funcionando.')
  refresh(true)
})
$('#api-connect') && ($('#api-connect').onclick = async () => {
  const base = String($('#api-url')?.value || '').trim() || location.origin
  const token = String($('#api-token')?.value || '').trim() || api.token || String(readJSON(API_TOKEN_KEY, '') || '')
  const button = $('#api-connect'); if (button) button.disabled = true
  try {
    api = await probeApi(base, token)
    writeJSON(API_KEY, api.base)
    if (token) writeJSON(API_TOKEN_KEY, token)
    lastServerError = ''
    fillSettings(); draw()
    feedback('Servidor conectado. O catálogo agora é salvo no servidor.')
    await refresh(true)
  } catch (error) {
    lastServerError = error.message
    updateApiStatus()
    feedback('Não foi possível conectar ao servidor: ' + error.message, true)
  } finally { if (button) button.disabled = false }
})
$('#api-disconnect') && ($('#api-disconnect').onclick = () => {
  api = { enabled: false, base: '', token: '', info: null }
  try { localStorage.removeItem(API_KEY); localStorage.removeItem(API_TOKEN_KEY) } catch {}
  lastServerError = ''
  fillSettings(); draw()
  feedback('Servidor desconectado. Usando o catálogo local/GitHub.')
  refresh(true)
})
$('#refresh-store') && ($('#refresh-store').onclick = async () => {
  feedback('Atualizando a loja...')
  pending = null
  await refresh(false)
  feedback('Loja atualizada. A dashboard recarrega o feed ao abrir o menu da loja.')
})
$('#download-config') && ($('#download-config').onclick = () => {
  try {
    const url = feedUrl()
    if (location.protocol === 'file:') throw Error('Abra o site por HTTP ou conecte um servidor antes de gerar o store-site.ini.')
    downloadFile('store-site.ini', 'url=' + url + '\n')
    feedback('store-site.ini gerado para ' + url)
  } catch (error) { feedback(error.message, true) }
})
$('#download-feed') && ($('#download-feed').onclick = () => {
  try {
    downloadFile('feed.ini', writeFeed(feed))
    feedback('feed.ini gerado com ' + feed.games.length + ' jogo(s).')
  } catch (error) { feedback(error.message, true) }
})
$('#export-catalog') && ($('#export-catalog').onclick = () => {
  downloadFile('catalogo-loja360.json', JSON.stringify(feed, null, 2), 'application/json')
  feedback('Catálogo exportado em JSON.')
})
$('#import-catalog') && ($('#import-catalog').onclick = () => $('#import-file')?.click())
$('#import-file') && ($('#import-file').onchange = async event => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const parsed = JSON.parse(await file.text())
    const value = Array.isArray(parsed) ? { games: parsed, update: null } : parsed
    if (!value || !Array.isArray(value.games)) throw Error('O JSON precisa ter { games: [], update: null }.')
    const clean = readFeed(writeFeed({ games: value.games, update: value.update || null }))
    if (!confirm(`Substituir o catálogo atual por ${clean.games.length} jogo(s)?`)) return
    let next
    if (api.enabled) next = await apiFetch('/api/catalog', { method: 'PUT', body: JSON.stringify(clean) })
    else if (client) next = await client.replaceCatalog(clean)
    else next = clean
    applyCatalog(next, 'Catálogo importado.')
  } catch (error) { feedback('Importação falhou: ' + error.message, true) }
})

function openPublish(kind, item = null, copy = false) {
  if (!publish) return
  publication = kind
  const isGame = kind === 'game'
  editingItem = !copy && item ? item : null
  copySource = copy && item ? item : null
  editing = isGame ? (editingItem?.slug || '') : (editingItem ? 'update' : '')
  slugEdited = !!editing
  publish.reset()
  originalPublishUrl = ''
  $('#game-fields').hidden = !isGame
  $('#update-fields').hidden = isGame
  for (const el of $('#game-fields').querySelectorAll('input,textarea')) el.disabled = !isGame
  for (const el of $('#update-fields').querySelectorAll('input,textarea')) el.disabled = isGame
  if (publish.elements.build) publish.elements.build.required = !isGame
  if (publish.elements.slug) publish.elements.slug.readOnly = false
  const base = isGame ? (editingItem || copySource) : editingItem
  if (isGame && base) {
    if (publish.elements.title) publish.elements.title.value = copy ? base.title + ' (cópia)' : base.title
    if (publish.elements.slug) publish.elements.slug.value = copy ? '' : base.slug
    if (publish.elements.genre) publish.elements.genre.value = base.genre
    if (publish.elements.description) publish.elements.description.value = base.description
    if (publish.elements.externalUrl) publish.elements.externalUrl.value = base.url
    if (publish.elements.externalSha) publish.elements.externalSha.value = base.sha256 || ''
    if (publish.elements.externalSize) publish.elements.externalSize.value = String(base.size || '')
    originalPublishUrl = base.url || ''
    setCurrentImage('cover', base.cover || '')
    setCurrentImage('background', base.background || '')
  } else if (isGame) {
    setCurrentImage('cover', '')
    setCurrentImage('background', '')
  }
  if (!isGame) {
    if (base) {
      if (publish.elements.build) publish.elements.build.value = String(base.build ?? 0)
      if (publish.elements.notes) publish.elements.notes.value = base.notes || ''
      if (publish.elements.externalUrl) publish.elements.externalUrl.value = base.url
      if (publish.elements.externalSha) publish.elements.externalSha.value = base.sha256 || ''
      if (publish.elements.externalSize) publish.elements.externalSize.value = String(base.size || '')
      originalPublishUrl = base.url || ''
    } else {
      if (publish.elements.build) publish.elements.build.value = String(Math.min(100, (feed.update?.build ?? -1) + 1))
      originalPublishUrl = ''
    }
  }
  const title = $('#publish-title')
  if (title) title.textContent = isGame ? (editing ? 'Editar jogo' : copy ? 'Duplicar jogo' : 'Publicar jogo') : (editing ? 'Editar atualização' : 'Publicar atualização')
  const type = $('#publish-type')
  if (type) type.textContent = isGame ? 'Catálogo do Xbox' : 'Software da dashboard'
  const submit = $('#publish-submit')
  if (submit) submit.textContent = api.enabled ? (isGame ? 'Salvar no servidor' : 'Salvar atualização') : (isGame ? 'Publicar no catálogo' : 'Publicar atualização automática')
  const result = $('#publish-result')
  if (result) result.textContent = api.enabled ? 'As alterações serão salvas no servidor.' : client ? 'As alterações serão publicadas no GitHub Pages.' : 'As alterações serão salvas neste navegador.'
  toggleSource()
  $('#publish-dialog').showModal()
}
function activePackageInputs() {
  const game = publication === 'game'
  return { file: $(game ? '#game-file' : '#update-file'), folder: $(game ? '#game-files' : '#update-files') }
}
function clearPackageInputs() {
  for (const id of ['game-file', 'game-files', 'update-file', 'update-files']) {
    const el = $('#' + id); if (el) el.value = ''
  }
}
function syncPackageMode() {
  const { file, folder } = activePackageInputs()
  const chosen = Boolean(file?.files?.[0] || folder?.files?.length)
  const input = publish.elements.externalUrl
  if (input) input.required = !chosen
  if (chosen) {
    if (input) input.value = ''
    if (publish.elements.externalSha) publish.elements.externalSha.value = ''
    if (publish.elements.externalSize) publish.elements.externalSize.value = ''
  }
}
function toggleSource() {
  const us = $('#url-source'); if (us) us.hidden = false
  syncPackageMode()
}
publish?.elements.externalUrl?.addEventListener('change', () => autoFillFromUrl())
publish?.elements.externalUrl?.addEventListener('paste', () => setTimeout(() => autoFillFromUrl(), 50))
publish?.elements.externalUrl?.addEventListener('input', () => {
  const value = publish.elements.externalUrl.value.trim()
  if (value) clearPackageInputs()
  if (value !== originalPublishUrl) {
    if (publish.elements.externalSha) publish.elements.externalSha.value = ''
    if (publish.elements.externalSize) publish.elements.externalSize.value = ''
  }
  syncPackageMode()
})
for (const id of ['game-file', 'game-files', 'update-file', 'update-files']) {
  $('#' + id)?.addEventListener('change', syncPackageMode)
}
$('#auto-fill-hash') && ($('#auto-fill-hash').onclick = () => autoFillFromUrl(true))
publish?.elements.title?.addEventListener('input', () => {
  if (!slugEdited && publish.elements.slug) {
    publish.elements.slug.value = publish.elements.title.value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  }
})
publish?.elements.slug?.addEventListener('input', () => { slugEdited = true })

function normalizePublicUrl(raw) {
  let u = String(raw || '').trim()
  const folderId = driveFolderId(u)
  if (folderId && /\/folders\//.test(u)) return 'https://drive.google.com/uc?export=download&confirm=t&id=' + folderId
  const m = u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) || u.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (m && /drive\.google\.com/.test(u)) u = 'https://drive.google.com/uc?export=download&confirm=t&id=' + m[1]
  return u
}
async function autoFillFromUrl(force = false) {
  const input = publish?.elements.externalUrl
  const raw = String(input?.value || '').trim()
  if (!raw) return false
  const value = normalizePublicUrl(raw)
  if (value !== raw && input) input.value = value
  if (!force && publish.elements.externalSha?.value && publish.elements.externalSize?.value) return true
  const status = $('#publish-result')
  const set = (sha, size, message) => {
    if (publish.elements.externalSha) publish.elements.externalSha.value = sha
    if (publish.elements.externalSize) publish.elements.externalSize.value = String(size)
    if (status) status.textContent = message
    return true
  }
  let serverError = ''
  if (api.enabled) {
    try {
      if (status) status.textContent = 'Calculando SHA-256 e tamanho no servidor...'
      const result = await apiFetch('/api/hash', { method: 'POST', body: JSON.stringify({ url: value }) })
      return set(result.sha256, result.size, `SHA-256 e tamanho calculados pelo servidor (${formatBytes(result.size)}).`)
    } catch (error) { serverError = error.message }
  }
  try {
    if (status) status.textContent = 'Calculando SHA-256 e tamanho no navegador...'
    const response = await fetch(value, { mode: 'cors', credentials: 'omit', cache: 'no-store' })
    if (!response.ok) throw Error('HTTP ' + response.status)
    const len = response.headers.get('content-length')
    if (len && publish.elements.externalSize) publish.elements.externalSize.value = String(len)
    const reader = response.body?.getReader?.()
    if (!reader) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      return set(await hash(bytes), bytes.length, 'SHA-256 e tamanho preenchidos automaticamente.')
    }
    const state = sha256Init(); let total = 0
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      sha256Push(state, chunk); total += chunk.length
      if (status) status.textContent = 'Calculando SHA-256... ' + formatBytes(total)
    }
    return set(sha256Finish(state), total, `SHA-256 e tamanho calculados no navegador (${formatBytes(total)}).`)
  } catch (error) {
    const detail = serverError ? 'Servidor: ' + serverError + '. ' : ''
    if (status) status.textContent = detail + 'Não foi possível calcular automaticamente (' + error.message + '). Conecte o servidor ou preencha “Avançado” manualmente.'
    return false
  }
}
function sha256Init() { const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]); return { h, buf: new Uint8Array(64), len: 0, total: 0n } }
function sha256Push(s, chunk) {
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2])
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0
  const w = new Uint32Array(64)
  let off = 0; s.total += BigInt(chunk.length)
  while (off < chunk.length) {
    const take = Math.min(64 - s.len, chunk.length - off)
    s.buf.set(chunk.subarray(off, off + take), s.len); s.len += take; off += take
    if (s.len !== 64) break
    for (let i = 0; i < 16; i++) w[i] = (s.buf[i * 4] << 24) | (s.buf[i * 4 + 1] << 16) | (s.buf[i * 4 + 2] << 8) | s.buf[i * 4 + 3]
    for (let i = 16; i < 64; i++) { const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0; const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0; w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0 }
    let a = s.h[0], b = s.h[1], c = s.h[2], d = s.h[3], e = s.h[4], f = s.h[5], g = s.h[6], h = s.h[7]
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    s.h[0] = (s.h[0] + a) >>> 0; s.h[1] = (s.h[1] + b) >>> 0; s.h[2] = (s.h[2] + c) >>> 0; s.h[3] = (s.h[3] + d) >>> 0
    s.h[4] = (s.h[4] + e) >>> 0; s.h[5] = (s.h[5] + f) >>> 0; s.h[6] = (s.h[6] + g) >>> 0; s.h[7] = (s.h[7] + h) >>> 0
    s.len = 0
  }
}
function sha256Finish(s) {
  const bitLen = s.total * 8n
  sha256Push(s, new Uint8Array([0x80]))
  while (s.len !== 56) sha256Push(s, new Uint8Array([0]))
  const tail = new Uint8Array(8)
  for (let i = 0; i < 8; i++) tail[7 - i] = Number((bitLen >> (BigInt(i) * 8n)) & 0xffn)
  sha256Push(s, tail)
  let hex = ''
  for (let i = 0; i < 8; i++) hex += s.h[i].toString(16).padStart(8, '0')
  return hex
}
function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(Error('Falha ao ler a imagem.'))
    reader.readAsDataURL(file)
  })
}
async function uploadMedia(file, label) {
  if (!file) return null
  if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) throw Error(`A ${label} precisa ser PNG, JPEG ou WebP.`)
  if (file.size <= 0 || file.size > 2 * 1024 * 1024) throw Error(`A ${label} pode ter até 2 MiB.`)
  const dataUrl = await fileAsDataUrl(file)
  const result = await apiFetch('/api/media', { method: 'POST', body: JSON.stringify({ name: file.name, dataUrl }) })
  return result.url
}
async function mediaUrlFor(file, label, current, copy, remove, originalUrl) {
  if (remove) return ''
  if (file) {
    if (api.enabled) return await uploadMedia(file, label)
    return null
  }
  if (copy?.cover && label === 'capa') return copy.cover
  if (copy?.background && label === 'fundo') return copy.background
  return current || originalUrl || undefined
}

function localEntryFromForm(isGame, args, existing, copy) {
  if (!isGame) {
    const build = Number(args.build)
    const oldBuild = Number(feed.update?.build ?? 0)
    if (!Number.isInteger(build) || build < 1) throw Error('Informe um número de build válido.')
    if (build < oldBuild) throw Error('Use uma build maior ou igual à publicada.')
    return { build, url: args.url, sha256: args.sha256, size: Number(args.size), notes: args.notes }
  }
  const entry = {
    slug: args.slug, title: args.title, genre: args.genre, description: args.description,
    url: args.url, sha256: args.sha256, size: Number(args.size),
  }
  if (!args.removeCover) {
    const cover = copy?.cover || existing?.cover
    if (cover) entry.cover = cover
  }
  if (!args.removeBackground) {
    const background = copy?.background || existing?.background
    if (background) entry.background = background
  }
  return entry
}

publish && (publish.onsubmit = async event => {
  event.preventDefault()
  const button = $('#publish-submit'); if (button) button.disabled = true
  const result = $('#publish-result')
  try {
    const form = new FormData(publish)
    const isGame = publication === 'game'
    const existing = isGame ? editingItem : (editing === 'update' ? editingItem : null)
    const copy = copySource
    const file = isGame ? ($('#game-file')?.files?.[0] || null) : ($('#update-file')?.files?.[0] || null)
    const folderFiles = isGame ? Array.from($('#game-files')?.files || []) : Array.from($('#update-files')?.files || [])
    const localPackage = Boolean(file || folderFiles.length)
    let url = String(form.get('externalUrl') || '').trim()
    let sha = '', size = ''
    if (localPackage) {
      if (!client) throw Error(api.enabled
        ? 'No modo servidor, envie o pacote ao Google Drive e cole o link público (.zip/.xex). O servidor não recebe pacotes grandes.'
        : 'Conecte o GitHub em Conexão para enviar arquivo ou pasta. Sem isso, use um link HTTPS.')
      url = ''
      if (publish.elements.externalUrl) publish.elements.externalUrl.value = ''
    } else {
      if (!url && existing?.url) url = existing.url
      if (!url) throw Error('Informe o link público do arquivo (HTTPS).')
      url = normalizePublicUrl(url)
      if (url !== String(form.get('externalUrl') || '').trim() && publish.elements.externalUrl) publish.elements.externalUrl.value = url
      // SHA-256 e tamanho são opcionais: o Xbox baixa mesmo sem eles.
      sha = ''
      size = '0'
    }
    const args = {
      slug: String(form.get('slug') || '').trim(),
      title: String(form.get('title') || '').trim(),
      genre: String(form.get('genre') || '').trim(),
      description: String(form.get('description') || '').trim(),
      build: String(form.get('build') || '').trim(),
      notes: String(form.get('notes') || '').trim(),
      url, sha256: sha, size: Number(size),
      externalUrl: url, externalSha: sha, externalSize: size,
      removeCover: Boolean(form.get('removeCover')),
      removeBackground: Boolean(form.get('removeBackground')),
    }
    const coverFile = isGame && publish.elements.coverFile?.files?.[0] ? publish.elements.coverFile.files[0] : null
    const backgroundFile = isGame && publish.elements.backgroundFile?.files?.[0] ? publish.elements.backgroundFile.files[0] : null
    let next
    let uploadedCover = null
    let uploadedBackground = null
    if (api.enabled && isGame) {
      uploadedCover = await mediaUrlFor(coverFile, 'capa', existing?.cover, copy, args.removeCover, '')
      uploadedBackground = await mediaUrlFor(backgroundFile, 'fundo', existing?.background, copy, args.removeBackground, '')
    }
    if (api.enabled) {
      if (isGame) {
        if (!args.slug) throw Error('Informe o identificador do jogo.')
        const body = { slug: args.slug, title: args.title, genre: args.genre, description: args.description, url, sha256: sha, size: Number(size) }
        if (args.removeCover) body.cover = ''
        else if (uploadedCover) body.cover = uploadedCover
        else if (copy?.cover) body.cover = copy.cover
        if (args.removeBackground) body.background = ''
        else if (uploadedBackground) body.background = uploadedBackground
        else if (copy?.background) body.background = copy.background
        next = editingItem
          ? await apiFetch('/api/games/' + encodeURIComponent(editingItem.slug), { method: 'PUT', body: JSON.stringify(body) })
          : await apiFetch('/api/games', { method: 'POST', body: JSON.stringify(body) })
      } else {
        const build = Number(args.build)
        if (!Number.isInteger(build) || build < 1) throw Error('Informe um número de build válido.')
        next = await apiFetch('/api/update', { method: 'PUT', body: JSON.stringify({ build, notes: args.notes, url, sha256: sha, size: Number(size) }) })
      }
    } else if (client) {
      const formArgs = {
        ...args,
        previousSlug: isGame ? (editingItem?.slug || '') : '',
        editing: !isGame && Boolean(editingItem),
        coverFile, backgroundFile, file, files: folderFiles,
        cover: copy?.cover || '',
        background: copy?.background || '',
      }
      if (isGame) next = await client.publishGame(formArgs)
      else next = await client.publishUpdate(formArgs)
      const entry = isGame ? next.games.find(g => g.slug === args.slug) : next.update
      pending = { slug: isGame ? args.slug : '', value: JSON.stringify(entry), deadline: Date.now() + 600000 }
    } else {
      if (coverFile || backgroundFile) throw Error('Para enviar capa/fundo, conecte o servidor ou o GitHub. Sem isso, publique sem imagem.')
      const base = { ...feed, games: [...feed.games] }
      if (isGame) {
        if (!args.slug) throw Error('Informe o identificador do jogo.')
        const entry = localEntryFromForm(true, args, existing, copy)
        writeFeed({ ...base, games: [...base.games.filter(g => g.slug !== args.slug && (!editingItem || g.slug !== editingItem.slug)), entry] })
        if (editingItem && editingItem.slug !== args.slug) base.games = base.games.filter(g => g.slug !== editingItem.slug)
        const at = base.games.findIndex(g => g.slug === args.slug)
        if (at >= 0) base.games[at] = entry
        else base.games.unshift(entry)
      } else {
        if (!Number.isInteger(Number(args.build)) || Number(args.build) < 1) throw Error('Informe um número de build válido.')
        if (Number(args.build) < Number(feed.update?.build ?? 0)) throw Error('Use uma build maior ou igual à publicada.')
        base.update = localEntryFromForm(false, args, existing, copy)
      }
      writeFeed(base)
      next = base
    }
    applyCatalog(next, api.enabled ? 'Publicação salva no servidor.' : client ? 'Publicação enviada ao GitHub Pages.' : 'Publicação salva neste navegador.')
    $('#publish-dialog').close()
    location.hash = isGame ? 'biblioteca' : 'updates'
  } catch (error) {
    if (result) result.textContent = error.message
  } finally { if (button) button.disabled = false }
})

async function deleteGame(slugValue) {
  const game = feed.games.find(g => g.slug === slugValue)
  if (!game) return
  if (!confirm(`Excluir “${game.title}” do catálogo? Essa ação não pode ser desfeita.`)) return
  try {
    const next = api.enabled
      ? await apiFetch('/api/games/' + encodeURIComponent(slugValue), { method: 'DELETE' })
      : client
        ? await client.deleteGame(slugValue)
        : (() => { const base = { ...feed, games: feed.games.filter(g => g.slug !== slugValue) }; writeFeed(base); return base })()
    applyCatalog(next, 'Jogo excluído.')
  } catch (error) { feedback('Não foi possível excluir: ' + error.message, true) }
}
async function deleteUpdate() {
  if (!feed.update) return
  if (!confirm('Excluir a build publicada? A dashboard deixará de oferecer essa atualização.')) return
  try {
    const next = api.enabled
      ? await apiFetch('/api/update', { method: 'DELETE' })
      : client
        ? await client.deleteUpdate()
        : (() => { const base = { ...feed, update: null }; writeFeed(base); return base })()
    applyCatalog(next, 'Atualização excluída.')
  } catch (error) { feedback('Não foi possível excluir a atualização: ' + error.message, true) }
}
$('#edit-update') && ($('#edit-update').onclick = () => { if (feed.update) openPublish('update', feed.update) })
$('#delete-update') && ($('#delete-update').onclick = deleteUpdate)

function driveFolderId(url) {
  const m = String(url || '').match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/) || String(url || '').match(/[?&]id=([a-zA-Z0-9_-]+)/)
  return m ? m[1] : ''
}
function decodeDriveEscapes(value) {
  return String(value || '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/')
}
function parseDriveFolderHtml(body) {
  const entries = []; const seen = new Set()
  const push = (id, name, mime) => { if (!id || !name || seen.has(id)) return; seen.add(id); entries.push({ id, name, mime: mime || '' }) }
  let text = String(body || '')
  const ivd = /_DRIVE_ivd'\]\s*=\s*'([\s\S]*?)';/.exec(text)
  if (ivd) text = decodeDriveEscapes(ivd[1])
  else if (text.includes('\\x5b') || text.includes('\\x22')) text = decodeDriveEscapes(text)
  const re = /\["([a-zA-Z0-9_-]{25,60})"\s*,\s*\[[^\]]*\]\s*,\s*"([^"]{1,200})"\s*,\s*"((?:application\/[^"]+|[^"]*folder[^"]*|[^"]*zip[^"]*|[^"]*octet[^"]*))"/g
  let m
  while ((m = re.exec(text)) && entries.length < 100) push(m[1], m[2], m[3])
  if (!entries.length) {
    const re2 = /\["([a-zA-Z0-9_-]{25,60})"\s*,\s*"([^"]+\.(?:zip|xex|ZIP|XEX))"/g
    while ((m = re2.exec(text)) && entries.length < 100) push(m[1], m[2], '')
  }
  return entries.filter(e => e.id && e.name && e.name !== '.' && e.name !== '..')
}
async function fetchDriveFolder(folderUrl) {
  const id = driveFolderId(folderUrl)
  if (!id) throw new Error('Link de pasta do Drive inválido.')
  if (api.enabled) {
    return await apiFetch('/api/folders/list?url=' + encodeURIComponent(folderUrl))
  }
  const url = 'https://drive.google.com/drive/folders/' + id
  const attempts = [url, 'https://corsproxy.io/?url=' + encodeURIComponent(url), 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url)]
  let lastErr
  for (const u of attempts) {
    try {
      const r = await fetch(u, { mode: 'cors', credentials: 'omit' })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const body = await r.text()
      const entries = parseDriveFolderHtml(body)
      if (entries.length) return { id, entries }
      if (/drive\.google|_DRIVE_ivd|Drive/.test(body)) return { id, entries: [] }
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('Não foi possível ler a pasta pública.')
}
function driveFileDirectUrl(id) { return 'https://drive.google.com/uc?export=download&confirm=t&id=' + id }
function folderExploreUrl(id) { return 'https://drive.google.com/drive/folders/' + id }
function renderDriveFolderEntries(kind, entries) {
  const box = $(`#${kind}-folder-list`), status = $(`#${kind}-folder-status`)
  if (!box) return
  box.replaceChildren()
  if (!entries.length) { if (status) status.textContent = 'Nenhum arquivo/pasta encontrado na listagem pública. Verifique se a pasta está como “Qualquer pessoa com o link” ou cole o link direto do arquivo.'; return }
  if (status) status.textContent = `${entries.length} item(ns) encontrado(s).`
  for (const entry of entries) {
    const row = node('div', null, 'hint')
    const isFolder = /folder/i.test(entry.mime || '') || /\/folders\//.test(entry.url || '')
    const name = node('div', (isFolder ? '📁 ' : '📄 ') + entry.name)
    const actions = node('div', null, 'actions compact')
    if (isFolder) {
      const explore = node('button', 'Explorar pasta', 'outline'); explore.type = 'button'
      explore.onclick = () => {
        const url = folderExploreUrl(entry.id)
        const input = $(`#${kind}-folder-url`); if (input) input.value = url
        importDriveFolder(kind, url)
      }
      actions.append(explore)
    } else {
      const publishButton = node('button', 'Publicar', 'outline'); publishButton.type = 'button'
      publishButton.onclick = () => {
        openPublish(kind === 'library' ? 'game' : 'update')
        const url = entry.url && /^https?:\/\//i.test(entry.url) ? entry.url : driveFileDirectUrl(entry.id)
        if (publish.elements.externalUrl) publish.elements.externalUrl.value = url
        if (publish.elements.externalSha) publish.elements.externalSha.value = ''
        if (publish.elements.externalSize) publish.elements.externalSize.value = ''
        const baseName = entry.name.replace(/\.(zip|xex)$/i, '')
        if (kind === 'library' && publish.elements.title && !publish.elements.title.value) {
          publish.elements.title.value = baseName; publish.elements.title.dispatchEvent(new Event('input'))
        }
        if (kind === 'updates' && publish.elements.notes && !publish.elements.notes.value) publish.elements.notes.value = baseName
        const result = $('#publish-result')
        if (result) result.textContent = 'Arquivo selecionado. Calculando SHA-256/tamanho...'
        autoFillFromUrl()
      }
      actions.append(publishButton)
    }
    const open = node('a', 'Abrir', 'outline')
    open.href = entry.url || (entry.id ? 'https://drive.google.com/open?id=' + entry.id : '#')
    open.target = '_blank'; open.rel = 'noopener noreferrer'
    actions.append(open)
    row.append(name, actions)
    box.append(row)
  }
}
async function importDriveFolder(kind, overrideUrl = '') {
  const input = $(`#${kind}-folder-url`)
  const status = $(`#${kind}-folder-status`)
  const url = String(overrideUrl || input?.value || '').trim() || (kind === 'library' ? DEFAULT_LIBRARY_FOLDER : DEFAULT_UPDATES_FOLDER)
  if (input && !input.value) input.value = url
  const open = $(`#${kind}-folder-open`)
  if (open) { const id = driveFolderId(url); open.href = id ? folderExploreUrl(id) : url }
  try {
    if (status) status.textContent = 'Lendo pasta pública do Drive...'
    const { entries } = await fetchDriveFolder(url)
    renderDriveFolderEntries(kind, entries)
  } catch (error) {
    if (status) status.textContent = 'Não foi possível importar automaticamente (' + (error.message || 'erro') + '). ' + (api.enabled ? 'Verifique a pasta.' : 'Conecte o servidor para importar pelo backend, ou abra a pasta e cole o link público do arquivo.')
  }
}
function importDriveFolderLinks(kind) {
  const textarea = $(`#${kind}-folder-links`), status = $(`#${kind}-folder-status`)
  const lines = String(textarea?.value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  if (!lines.length) { if (status) status.textContent = 'Cole ao menos um link.'; return }
  const entries = []
  for (const raw of lines) {
    const folderMatch = raw.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/)
    const fileMatch = raw.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) || raw.match(/[?&]id=([a-zA-Z0-9_-]+)/)
    const id = folderMatch?.[1] || fileMatch?.[1] || ''
    const isFolder = Boolean(folderMatch)
    const nameGuess = decodeURIComponent((raw.split('/').pop() || '').split('?')[0]).replace(/[-_]+/g, ' ').replace(/\.(zip|xex)$/i, '') || (id ? id.slice(0, 12) : raw.slice(0, 40))
    const direct = id ? (isFolder ? folderExploreUrl(id) : driveFileDirectUrl(id)) : raw
    entries.push({ id, name: nameGuess, mime: isFolder ? 'application/vnd.google-apps.folder' : '', url: direct })
  }
  renderDriveFolderEntries(kind, entries)
}
$('#library-folder-import') && ($('#library-folder-import').onclick = () => importDriveFolder('library'))
$('#updates-folder-import') && ($('#updates-folder-import').onclick = () => importDriveFolder('updates'))
$('#library-folder-import-links') && ($('#library-folder-import-links').onclick = () => importDriveFolderLinks('library'))
$('#updates-folder-import-links') && ($('#updates-folder-import-links').onclick = () => importDriveFolderLinks('updates'))
$('#library-folder-url')?.addEventListener('change', e => { const id = driveFolderId(e.target.value); const a = $('#library-folder-open'); if (a) a.href = id ? folderExploreUrl(id) : e.target.value })
$('#updates-folder-url')?.addEventListener('change', e => { const id = driveFolderId(e.target.value); const a = $('#updates-folder-open'); if (a) a.href = id ? folderExploreUrl(id) : e.target.value })

async function loadIdeas() {
  const box = $('#idea-list'), c = client
  if (!box) return
  if (!c) {
    box.replaceChildren(
      node('p', 'Conecte o GitHub para acessar suas ideias. Você ainda pode conversar com a IA sem GitHub.', 'hint'),
      (() => { const b = node('button', 'Abrir IA', 'primary'); b.type = 'button'; b.onclick = openAi; return b })(),
    )
    return
  }
  try {
    const ideas = await c.listIdeas()
    if (c !== client) return
    box.replaceChildren()
    if (!ideas.length) box.append(node('p', 'Nenhuma ideia publicada.', 'hint'))
    for (const idea of ideas) {
      const b = node('button', '#' + idea.number + '  ' + ideaTitle(idea.title), 'topic')
      b.onclick = () => openThread(idea.number)
      b.setAttribute('aria-current', String(idea.number === activeThread))
      box.append(b)
    }
  } catch (error) { if (c === client) box.textContent = error.message }
}
const ideaTitle = s => s.replace(/^\[Ideia\]\s*/, '')
async function openThread(number, quiet = false) {
  const c = client; if (!c) return
  const version = ++threadVersion; activeThread = number
  const box = $('#thread')
  if (!box) return
  try {
    const result = await c.readIdea(number)
    if (c !== client || version !== threadVersion) return
    const stamp = JSON.stringify([number, result.body, result.comments.map(m => [m.id, m.body])])
    if (quiet && stamp === threadStamp) return
    const draft = box.dataset.number === String(number) ? box.querySelector('textarea')?.value : ''
    threadStamp = stamp; box.dataset.number = String(number)
    box.replaceChildren(node('p', '#' + number, 'kicker'), node('h2', ideaTitle(result.title)), node('p', clean(result.body), 'thread-text'))
    for (const m of result.comments) {
      const p = node('div', null, 'post')
      const assistant = m.author === 'github-actions[bot]' && m.type === 'Bot' && m.body.startsWith('<!-- dash:assistant:')
      p.append(node('strong', assistant ? 'Assistente' : m.author), node('p', clean(m.body), 'thread-text'))
      box.append(p)
    }
    const form = node('form', null, 'stack'), label = node('label', 'Continuar a conversa'), input = node('textarea')
    input.required = true; input.maxLength = 4000; input.rows = 3; input.value = draft || ''; label.append(input)
    const button = node('button', 'Enviar ao chat', 'primary'), message = node('p', '', 'hint'); message.setAttribute('role', 'status')
    form.append(label, node('small', 'A mensagem será publicada na Issue.', 'hint'), button, message)
    form.onsubmit = async event => {
      event.preventDefault(); button.disabled = true
      try { await c.replyIdea(number, input.value); input.value = ''; await openThread(number); feedback('Mensagem publicada. A resposta aparecerá nesta conversa.') }
      catch (error) { message.textContent = error.message } finally { button.disabled = false }
    }
    box.append(form)
    if (!quiet) loadIdeas()
  } catch (error) { if (c === client && version === threadVersion && !quiet) feedback(error.message, true) }
}
$('#new-idea') && ($('#new-idea').onclick = () => {
  if (!requireClient()) return
  ideaForm.reset(); const result = $('#idea-result'); if (result) result.textContent = ''
  $('#idea-dialog').showModal()
})
ideaForm && (ideaForm.onsubmit = async event => {
  event.preventDefault()
  const button = event.submitter; if (button) button.disabled = true
  try {
    if (!client) throw Error('Conecte o GitHub para publicar uma ideia.')
    const issue = await client.submitIdea({ title: ideaForm.elements.title.value, body: ideaForm.elements.body.value, chat: ideaForm.elements.chat.checked })
    $('#idea-dialog').close()
    await openThread(issue.number)
    feedback('Ideia publicada no GitHub.')
  } catch (error) { const result = $('#idea-result'); if (result) result.textContent = error.message }
  finally { if (button) button.disabled = false }
})

function clean(text) {
  return String(text || '').replace(/<!--[\s\S]*?-->/g, '').replace(/[<>]/g, '')
}

/* ------------------------------ Assistente IA ------------------------------ */
function aiBubble(role, text, source = '') {
  const box = $('#ai-messages'); if (!box) return null
  const wrap = node('div', null, 'ai-msg ' + role)
  wrap.append(node('span', role === 'user' ? 'Você' : 'Assistente', 'ai-role'), node('p', text))
  if (source) wrap.append(node('small', source === 'ai' ? 'IA externa' : 'Assistente local', 'ai-source-tag'))
  box.append(wrap)
  box.scrollTop = box.scrollHeight
  return wrap
}
function aiSourceLabel() {
  const el = $('#ai-source')
  if (!el) return
  if (api.enabled && api.info?.aiConfigured) el.textContent = 'Conectada à IA externa configurada no servidor. Também conhece o catálogo atual.'
  else if (api.enabled) el.textContent = 'Assistente local do servidor (configure AI_API_KEY para usar um modelo externo).'
  else el.textContent = 'Assistente local do site. Para IA externa, conecte um servidor com AI_API_KEY.'
}
function localAiReply(question) {
  const text = String(question || '').toLowerCase()
  const games = feed.games || []
  const update = feed.update
  if (/quantos|quantidade|total|contar/.test(text)) return `O catálogo tem ${games.length} jogo(s) publicado(s).`
  if (/lista|quais|jogos|catálogo|catalogo/.test(text)) return games.length ? 'Jogos publicados:\n' + games.map(g => `• ${g.title} (${g.slug}) — ${g.genre} — ${formatBytes(g.size)}`).join('\n') : 'Ainda não há jogos publicados.'
  if (/atualiza|build|vers[aã]o/.test(text)) return update ? `A atualização publicada é a build ${update.build}, com ${formatBytes(update.size)}.\n${update.notes || ''}` : 'Ainda não há atualização publicada.'
  if (/sha|hash|tamanho|calcular/.test(text)) return 'Abra “Publicar jogo” ou “Editar”, cole o link HTTPS e use “Calcular SHA-256 e tamanho”. Com o servidor conectado, o cálculo é feito pelo backend e funciona mesmo quando o Drive bloqueia o navegador.'
  if (/editar|renomear|trocar|remover|excluir|apagar/.test(text)) return 'Em Biblioteca, cada cartão tem Editar, Duplicar e Excluir. Em Editar você troca título, identificador, gênero, descrição, link, capa e fundo. Em Atualizações há Editar build e Excluir build.'
  if (/servidor|api|hospedar|host|persist/.test(text)) return 'Rode `node server.mjs` no host Node. Ele mantém o catálogo em `data/catalog.json`, gera `/feed.ini`, calcula SHA-256, salva capas e permite editar/excluir de qualquer navegador. Configure `ADMIN_TOKEN` e `PUBLIC_BASE_URL` em produção.'
  if (/ia|assistente|chat|modelo/.test(text)) return api.enabled ? 'O servidor está conectado. Sem AI_API_KEY ele responde localmente; com AI_API_KEY usa o provedor compatível com OpenAI configurado.' : 'Nenhum servidor conectado. Eu respondo localmente com os dados do catálogo. Para uma IA externa, rode o server.mjs com AI_API_KEY.'
  if (/drive|pasta|importar/.test(text)) return 'Use “Importar da pasta” na Biblioteca ou em Atualizações. Com o servidor conectado a importação é feita pelo backend; sem servidor, o navegador pode ser bloqueado por CORS. Você também pode colar links diretos.'
  if (/publicar|adicionar|novo/.test(text)) return 'Clique em “Publicar jogo”, informe título, gênero, descrição e o link HTTPS. O SHA-256 e o tamanho são calculados automaticamente quando possível. Para atualização da dash, use Atualizações → Publicar build.'
  if (/dash|xbox|console/.test(text)) return 'A dashboard lê o feed.ini. Ao abrir a aba Loja ela força uma atualização. Use “Baixar store-site.ini” e copie para assets/store-site.ini no Xbox.'
  return `Assistente local da Loja 360. ${games.length} jogo(s), ${update ? 'build ' + update.build : 'sem atualização publicada'}. Pergunte “quantos jogos”, “listar jogos”, “como publicar”, “SHA-256”, “Drive” ou “servidor”.`
}
async function aiSend(text) {
  const value = String(text || '').trim()
  if (!value) return
  aiBubble('user', value)
  aiMessages.push({ role: 'user', content: value })
  aiMessages = aiMessages.slice(-40)
  const waiting = aiBubble('assistant', 'Pensando…')
  const input = $('#ai-input'); if (input) input.value = ''
  const button = $('#ai-send'); if (button) button.disabled = true
  try {
    let reply = '', source = 'local'
    if (api.enabled) {
      const result = await apiFetch('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: aiMessages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-20) }),
      })
      reply = result.reply; source = result.source || 'local'
    } else {
      await new Promise(resolve => setTimeout(resolve, 180))
      reply = localAiReply(value)
    }
    aiMessages.push({ role: 'assistant', content: reply })
    if (waiting) {
      waiting.replaceChildren(node('span', 'Assistente', 'ai-role'), node('p', reply), node('small', source === 'ai' ? 'IA externa' : 'Assistente local', 'ai-source-tag'))
    }
    const box = $('#ai-messages'); if (box) box.scrollTop = box.scrollHeight
  } catch (error) {
    const fallback = localAiReply(value)
    if (waiting) waiting.replaceChildren(node('span', 'Assistente', 'ai-role'), node('p', 'A IA externa falhou (' + error.message + '). Resposta local:\n\n' + fallback), node('small', 'Assistente local', 'ai-source-tag'))
    aiMessages.push({ role: 'assistant', content: fallback })
  } finally { if (button) button.disabled = false }
}
function openAi() {
  const dialog = $('#ai-dialog'); if (!dialog) return
  if (!aiMessages.length) {
    const greeting = 'Olá! Eu sou o assistente da Loja 360. Posso listar jogos, explicar como publicar, calcular SHA-256, falar sobre a build da dash e ajudar a usar o servidor. O que você precisa?'
    aiMessages.push({ role: 'assistant', content: greeting })
    aiBubble('assistant', greeting, 'local')
  }
  aiSourceLabel()
  if (!dialog.open) dialog.showModal()
  setTimeout(() => $('#ai-input')?.focus(), 50)
}
$('#ai-open') && ($('#ai-open').onclick = openAi)
$('#ai-open-ideas') && ($('#ai-open-ideas').onclick = openAi)
$('#ai-clear') && ($('#ai-clear').onclick = () => {
  aiMessages = []
  $('#ai-messages')?.replaceChildren()
  openAi()
})
$('#ai-form') && ($('#ai-form').onsubmit = event => {
  event.preventDefault()
  const input = $('#ai-input')
  aiSend(input?.value || '')
})
$$('[data-ai-prompt]').forEach(button => {
  button.onclick = () => aiSend(button.dataset.aiPrompt || button.textContent)
})

/* -------------------------------- Inicialização -------------------------------- */
$$('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close())
$$('[data-game]').forEach(button => button.onclick = () => openPublish('game'))
$$('.connectBtn').forEach(button => button.onclick = () => { location.hash = '#conexao' })
$('#open-update') && ($('#open-update').onclick = () => openPublish('update'))
$('#query') && ($('#query').oninput = draw)
$('#sort-games') && ($('#sort-games').onchange = draw)
$('#filter-genre') && ($('#filter-genre').onchange = draw)
window.addEventListener('hashchange', route)

async function boot() {
  try { applyBakedConfig(await loadBakedConfig()) } catch {}
  fillSettings(); draw(); route()
  await initApi()
  fillSettings(); draw()
  await refresh(true)
  if (api.enabled) feedback('Servidor conectado: ' + api.base)
  else if (lastServerError) feedback('Servidor salvo indisponível (' + lastServerError + '). Usando GitHub/local.', true)
  // Tenta reconectar o GitHub salvo, sem impedir o modo local/servidor.
  try {
    const token = githubTokenMem || localStorage.getItem('cards-studio-token')
    if (token && config.owner && config.repo) {
      const connected = await connect({ ...validate(config), token })
      client = connected; githubTokenMem = token
      try { localStorage.setItem('cards-studio-token', token) } catch {}
      fillSettings(); draw()
      await refresh(true)
    }
  } catch {}
}
boot()
setInterval(() => { if (!document.hidden) refresh(true) }, 60000)
setInterval(() => { if (!document.hidden && client && location.hash === '#ideias' && activeThread && !$('#thread textarea:focus')) openThread(activeThread, true) }, 12000)
