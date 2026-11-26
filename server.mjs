/**
 * Loja 360 - servidor opcional com catálogo persistente e APIs.
 *
 * Funciona em qualquer host Node.js 18+ sem dependências externas.
 * Endpoints principais:
 *   GET    /api/health
 *   GET    /api/catalog
 *   PUT    /api/games/:slug
 *   DELETE /api/games/:slug
 *   PUT    /api/update
 *   DELETE /api/update
 *   POST   /api/hash            { url } -> { url, sha256, size }
 *   POST   /api/media           { name, dataUrl } -> { url }
 *   GET    /api/folders/list?url=...
 *   POST   /api/ai/chat         { messages: [{role, content}] }
 *   GET    /feed.ini            feed gerado a partir do catálogo
 *   GET    /store-site.ini      configuração pronta para a dash
 *
 * Variáveis de ambiente:
 *   PORT=8787
 *   HOST=0.0.0.0
 *   DATA_DIR=./data
 *   PUBLIC_BASE_URL=https://loja.exemplo.com
 *   ADMIN_TOKEN=uma-chave-forte
 *   CORS_ORIGINS=https://site.exemplo.com
 *   MAX_HASH_BYTES=21474836480
 *   ALLOW_PRIVATE_URLS=1
 *   AI_API_KEY=...
 *   AI_BASE_URL=https://api.openai.com/v1
 *   AI_MODEL=gpt-4o-mini
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFeed, writeFeed } from './publisher.mjs'

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)))
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.xex': 'application/octet-stream',
}
const JSON_LIMIT = 4 * 1024 * 1024
const MEDIA_LIMIT = 2 * 1024 * 1024
const MEDIA_JSON_LIMIT = Math.ceil(MEDIA_LIMIT * 4 / 3) + 256 * 1024
const DEFAULT_MAX_HASH = 20 * 1024 * 1024 * 1024
const DEFAULT_POLL = 60

export function normalizeExternalUrl(raw) {
  let value = String(raw || '').trim()
  const folder = value.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/)
  if (folder) return 'https://drive.google.com/uc?export=download&confirm=t&id=' + folder[1]
  const file = value.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) || value.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (file && /drive\.google\.com/.test(value)) value = 'https://drive.google.com/uc?export=download&confirm=t&id=' + file[1]
  return value
}

function privateHost(hostname) {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (h.endsWith('.internal') || h.endsWith('.local')) return true
  return false
}

export function assertExternalUrl(raw, { allowPrivate = false } = {}) {
  const value = normalizeExternalUrl(raw)
  let url
  try { url = new URL(value) } catch { throw new Error('Link inválido. Use um endereço HTTPS.') }
  // Servidores locais/LAN podem usar HTTP quando ALLOW_PRIVATE_URLS=1.
  const protocols = allowPrivate ? ['https:', 'http:'] : ['https:']
  if (!protocols.includes(url.protocol)) throw new Error('O link precisa usar HTTPS.')
  if (url.username || url.password) throw new Error('O link não pode conter usuário/senha.')
  if (!allowPrivate && privateHost(url.hostname)) throw new Error('Endereço privado bloqueado no servidor público.')
  return url
}

function driveConfirmTarget(html, currentUrl) {
  if (!/drive\.google\.com|drive\.usercontent\.google\.com/i.test(currentUrl)) return null
  const action = /<form[^>]+action="([^"]+)"/i.exec(html)?.[1]
  if (!action) return null
  const params = new URLSearchParams()
  const input = /<input\b[^>]*>/gi
  let tag
  while ((tag = input.exec(html))) {
    const name = /\bname="([^"]+)"/i.exec(tag[0])?.[1]
    if (!name) continue
    const value = /\bvalue="([^"]*)"/i.exec(tag[0])?.[1] ?? ''
    params.set(name, value.replace(/&amp;/g, '&'))
  }
  if (!params.get('id')) return null
  if (!params.has('export')) params.set('export', 'download')
  if (!params.has('confirm')) params.set('confirm', 't')
  return action.replace(/&amp;/g, '&') + '?' + params.toString()
}

function decodeDriveEscapes(value) {
  return String(value || '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/')
}

export function parseDriveFolderHtml(body) {
  const entries = []
  const seen = new Set()
  const push = (id, name, mime) => {
    if (!id || !name || seen.has(id) || name === '.' || name === '..') return
    seen.add(id)
    entries.push({ id, name, mime: mime || '' })
  }
  let text = String(body || '')
  // O Drive entrega a listagem em window['_DRIVE_ivd'] com escapes \xNN.
  const ivd = /_DRIVE_ivd'\]\s*=\s*'([\s\S]*?)';/.exec(text)
  if (ivd) text = decodeDriveEscapes(ivd[1])
  else if (text.includes('\\x5b') || text.includes('\\x22')) text = decodeDriveEscapes(text)
  const re = /\["([a-zA-Z0-9_-]{25,60})"\s*,\s*\[[^\]]*\]\s*,\s*"([^"]{1,200})"\s*,\s*"((?:application\/[^"]+|[^"]*folder[^"]*|[^"]*zip[^"]*|[^"]*octet[^"]*))"/g
  let match
  while ((match = re.exec(text)) && entries.length < 200) {
    const name = match[2].replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    push(match[1], name, match[3])
  }
  if (!entries.length) {
    const fallback = /\["([a-zA-Z0-9_-]{25,60})"\s*,\s*"([^"]+\.(?:zip|xex|ZIP|XEX))"/g
    while ((match = fallback.exec(text)) && entries.length < 200) push(match[1], match[2], '')
  }
  return entries
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function localAssistant(messages, feed) {
  const last = [...(messages || [])].reverse().find(m => m && m.role === 'user')
  const text = String(last?.content || '').toLowerCase()
  const games = Array.isArray(feed?.games) ? feed.games : []
  const update = feed?.update || null
  const titles = games.map(g => `${g.title} (${g.slug})`).join(', ')
  if (/quantos|quantidade|total/.test(text)) return `O catálogo tem ${games.length} jogo(s) publicado(s).`
  if (/lista|quais|jogos/.test(text)) return games.length ? `Jogos publicados: ${titles}.` : 'Ainda não há jogos publicados.'
  if (/atualiza|build|vers[aã]o/.test(text)) return update ? `A atualização publicada é a build ${update.build}.` : 'Ainda não há atualização publicada.'
  if (/sha|hash|tamanho/.test(text)) return 'Use o botão “Calcular SHA-256 e tamanho” no diálogo de publicação. No servidor, a API /api/hash baixa o link e calcula os dois automaticamente.'
  if (/como|publicar|adicionar|editar|apagar|remover/.test(text)) return 'Para adicionar: Biblioteca → Publicar jogo → cole o link → publique. Para editar ou excluir, use os botões no cartão do jogo. Atualizações ficam na aba Atualizações.'
  if (/servidor|api|hospedar|host/.test(text)) return 'Rode `node server.mjs` no host Node. Ele mantém o catálogo em `data/catalog.json`, gera `/feed.ini`, calcula SHA-256 e salva capas. Configure `ADMIN_TOKEN` se o servidor for público.'
  if (/ia|assistente|chat/.test(text)) return 'O assistente externo usa a chave `AI_API_KEY` configurada no servidor. Sem chave, eu respondo localmente com informações do catálogo.'
  return `Assistente local da Loja 360. ${games.length} jogo(s), ${update ? 'build ' + update.build : 'sem atualização publicada'}. Pergunte “quantos jogos”, “listar jogos”, “como publicar” ou “SHA-256”.`
}

async function externalAi(messages, feed, env) {
  const key = String(env.AI_API_KEY || '').trim()
  if (!key) return { reply: localAssistant(messages, feed), source: 'local' }
  const base = String(env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const model = env.AI_MODEL || 'gpt-4o-mini'
  const catalogSummary = {
    games: (feed.games || []).map(g => ({ slug: g.slug, title: g.title, genre: g.genre, size: g.size })),
    update: feed.update ? { build: feed.update.build, notes: feed.update.notes } : null,
  }
  const system = 'Você é o assistente da Loja 360, um catálogo de jogos e atualizações para Xbox 360. Responda em português do Brasil, de forma curta e prática. Nunca invente links. Catálogo atual: ' + JSON.stringify(catalogSummary)
  const payload = {
    model,
    temperature: 0.4,
    messages: [{ role: 'system', content: system }, ...messages.slice(-20)],
  }
  const response = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error('IA HTTP ' + response.status + (detail ? ': ' + detail.slice(0, 240) : ''))
  }
  const data = await response.json()
  const reply = data?.choices?.[0]?.message?.content
  if (!reply) throw new Error('A IA não retornou resposta.')
  return { reply: String(reply), source: 'ai' }
}

export async function hashUrl(rawUrl, options = {}) {
  const allowPrivate = options.allowPrivate ?? process.env.ALLOW_PRIVATE_URLS === '1'
  const url = assertExternalUrl(rawUrl, { allowPrivate })
  const maxBytes = Number(options.maxBytes || process.env.MAX_HASH_BYTES || DEFAULT_MAX_HASH)
  const timeout = options.timeout || 15 * 60 * 1000
  const userAgent = { 'User-Agent': 'Loja360/1.0 (+https://github.com/)', Accept: '*/*' }
  let response = await fetch(url, {
    redirect: 'follow',
    headers: userAgent,
    signal: AbortSignal.timeout(timeout),
  }).catch(error => { throw new Error('Falha ao baixar o link: ' + error.message) })
  if (!response.ok) throw new Error('O link respondeu HTTP ' + response.status + '.')
  let type = String(response.headers.get('content-type') || '')
  if (/text\/html/i.test(type)) {
    // Google Drive mostra uma tela de confirmação para arquivos grandes.
    const html = await response.text()
    const target = driveConfirmTarget(html, url.href)
    if (!target) {
      throw new Error('O link retornou uma página HTML, não o arquivo. Use o link direto “uc?export=download&id=...” ou publique pelo servidor.')
    }
    response = await fetch(target, {
      redirect: 'follow',
      headers: userAgent,
      signal: AbortSignal.timeout(timeout),
    }).catch(error => { throw new Error('Falha ao baixar o arquivo confirmado do Drive: ' + error.message) })
    if (!response.ok) throw new Error('O Drive respondeu HTTP ' + response.status + '.')
    type = String(response.headers.get('content-type') || '')
    if (/text\/html/i.test(type)) throw new Error('O Drive ainda retornou HTML. Verifique se o arquivo está público (“Qualquer pessoa com o link”).')
  }
  const length = Number(response.headers.get('content-length') || 0)
  if (length > maxBytes) throw new Error('O arquivo excede o limite de ' + Math.round(maxBytes / 1073741824) + ' GiB.')
  const hash = createHash('sha256')
  let total = 0
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer())
    total = bytes.length
    if (total > maxBytes) throw new Error('O arquivo excede o limite configurado.')
    hash.update(bytes)
  } else {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk)
      total += bytes.length
      if (total > maxBytes) throw new Error('O arquivo excede o limite configurado.')
      hash.update(bytes)
    }
  }
  if (!total) throw new Error('O arquivo está vazio.')
  return { url: url.href, sha256: hash.digest('hex'), size: total, contentType: type }
}

export function createApp(options = {}) {
  const root = resolve(options.rootDir || ROOT)
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || join(root, 'data'))
  const mediaDir = join(dataDir, 'media')
  const catalogPath = join(dataDir, 'catalog.json')
  const feedPath = join(dataDir, 'feed.ini')
  const env = options.env || process.env
  const adminToken = String(env.ADMIN_TOKEN || '')
  const corsOrigins = String(env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  const allowPrivate = env.ALLOW_PRIVATE_URLS === '1'
  let catalogCache = null
  let catalogLoadedAt = 0

  function baseUrl(req) {
    if (env.PUBLIC_BASE_URL) return String(env.PUBLIC_BASE_URL).replace(/\/+$/, '')
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim()
    return proto + '://' + host
  }

  function cors(req, res) {
    const origin = String(req.headers.origin || '')
    const allow = corsOrigins.includes('*') || (origin && corsOrigins.includes(origin))
    if (allow) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-admin-token')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    }
  }

  function auth(req) {
    if (!adminToken) return true
    return String(req.headers['x-admin-token'] || '') === adminToken
  }

  function send(res, status, body, type = 'application/json; charset=utf-8') {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(data)
  }

  async function body(req, limit = JSON_LIMIT) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('Corpo da requisição muito grande.')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new Error('JSON inválido.') }
  }

  async function loadCatalog(force = false) {
    if (!force && catalogCache && Date.now() - catalogLoadedAt < 1500) return catalogCache
    await mkdir(dataDir, { recursive: true })
    try {
      const source = await readFile(catalogPath, 'utf8')
      const parsed = JSON.parse(source)
      catalogCache = readFeed(writeFeed({ games: parsed.games || [], update: parsed.update || null }))
    } catch {
      let seed = { games: [], update: null }
      try { seed = readFeed(await readFile(join(root, 'feed.ini'), 'utf8')) } catch {}
      catalogCache = seed
      await saveCatalog(seed)
    }
    catalogLoadedAt = Date.now()
    return catalogCache
  }

  async function saveCatalog(feed) {
    const clean = readFeed(writeFeed({ games: feed.games || [], update: feed.update || null }))
    await mkdir(dataDir, { recursive: true })
    const text = writeFeed(clean)
    const temp = catalogPath + '.tmp'
    await writeFile(temp, JSON.stringify(clean, null, 2) + '\n', 'utf8')
    await rename(temp, catalogPath)
    await writeFile(feedPath, text, 'utf8')
    catalogCache = clean
    catalogLoadedAt = Date.now()
    return clean
  }

  function cleanGame(value, existing = null) {
    const merged = { ...(existing || {}), ...(value || {}) }
    if (value && Object.prototype.hasOwnProperty.call(value, 'cover')) {
      if (!value.cover) delete merged.cover
    }
    if (value && Object.prototype.hasOwnProperty.call(value, 'background')) {
      if (!value.background) delete merged.background
    }
    if (merged.url) merged.url = normalizeExternalUrl(merged.url)
    if (merged.cover) merged.cover = normalizeExternalUrl(merged.cover)
    if (merged.background) merged.background = normalizeExternalUrl(merged.background)
    if (merged.sha256) merged.sha256 = String(merged.sha256).toLowerCase()
    if (merged.size != null) merged.size = Number(merged.size)
    delete merged.onProgress
    delete merged.editing
    delete merged.removeCover
    delete merged.removeBackground
    delete merged.previousSlug
    delete merged.newSlug
    delete merged.force
    return readFeed(writeFeed({ games: [merged], update: null })).games[0]
  }

  function cleanUpdate(value, existing = null) {
    const merged = { ...(existing || {}), ...(value || {}) }
    if (merged.url) merged.url = normalizeExternalUrl(merged.url)
    if (merged.sha256) merged.sha256 = String(merged.sha256).toLowerCase()
    if (merged.size != null) merged.size = Number(merged.size)
    if (merged.build != null) merged.build = Number(merged.build)
    delete merged.onProgress
    delete merged.editing
    delete merged.force
    return readFeed(writeFeed({ games: [], update: merged })).update
  }

  async function listDriveFolder(folderUrl) {
    const value = String(folderUrl || '').trim()
    const match = value.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/) || value.match(/[?&]id=([a-zA-Z0-9_-]+)/)
    if (!match) throw new Error('Link de pasta do Google Drive inválido.')
    const url = new URL('https://drive.google.com/drive/folders/' + match[1])
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) throw new Error('Google Drive respondeu HTTP ' + response.status + '.')
    const html = await response.text()
    return { id: match[1], entries: parseDriveFolderHtml(html) }
  }

  async function serveStatic(req, res, pathname) {
    let relative = pathname === '/' ? '/index.html' : pathname
    try { relative = decodeURIComponent(relative) } catch { return send(res, 400, { error: 'Caminho inválido.' }) }
    if (relative.includes('\0')) return send(res, 400, { error: 'Caminho inválido.' })
    const blocked = relative.replace(/^\/+/, '').toLowerCase()
    if (blocked === 'server.mjs' || blocked === 'package.json' || blocked === 'package-lock.json' ||
        blocked === 'publish-update.ps1' || blocked === '.env' || blocked.startsWith('.env.') ||
        blocked.startsWith('data/') || blocked.startsWith('tests/') || blocked.startsWith('.git/') ||
        blocked.startsWith('.github/') || blocked.startsWith('node_modules/')) {
      return send(res, 403, { error: 'Acesso negado.' })
    }
    const target = normalize(join(root, relative))
    if (!target.startsWith(root + sep) && target !== root) return send(res, 403, { error: 'Acesso negado.' })
    let info
    try { info = await stat(target) } catch { return send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8') }
    if (info.isDirectory()) return serveStatic(req, res, pathname.replace(/\/?$/, '/') + 'index.html')
    const ext = extname(target).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': ['.html', '.mjs', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=300',
    })
    createReadStream(target).pipe(res)
  }

  async function handler(req, res) {
    cors(req, res)
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    const url = new URL(req.url || '/', 'http://localhost')
    const pathname = url.pathname
    try {
      if (pathname === '/api/health') {
        const catalog = await loadCatalog()
        return send(res, 200, {
          ok: true,
          service: 'loja360',
          version: 3,
          authRequired: Boolean(adminToken),
          aiConfigured: Boolean(env.AI_API_KEY),
          storage: 'server',
          games: catalog.games.length,
          build: catalog.update?.build || null,
          feedUrl: baseUrl(req) + '/feed.ini',
          features: ['catalog', 'hash', 'media', 'folders', 'ai', 'edit', 'delete', 'import'],
        })
      }

      if (pathname === '/api/catalog' && req.method === 'GET') {
        return send(res, 200, await loadCatalog(true))
      }

      if (pathname === '/api/catalog' && (req.method === 'PUT' || req.method === 'POST')) {
        const input = await body(req, JSON_LIMIT)
        if (!input || !Array.isArray(input.games)) return send(res, 400, { error: 'Envie { games: [], update: null }.' })
        const next = await saveCatalog({ games: input.games, update: input.update || null })
        return send(res, 200, next)
      }

      if (pathname === '/feed.ini' && req.method === 'GET') {
        const catalog = await loadCatalog()
        return send(res, 200, writeFeed(catalog), 'text/plain; charset=utf-8')
      }

      if (pathname === '/store-site.ini' && req.method === 'GET') {
        return send(res, 200, 'url=' + baseUrl(req) + '/feed.ini\n', 'text/plain; charset=utf-8')
      }

      if (pathname === '/api/export/catalog.json' && req.method === 'GET') {
        return send(res, 200, await loadCatalog())
      }

      if (pathname.startsWith('/media/') && req.method === 'GET') {
        const name = pathname.slice('/media/'.length)
        if (!/^[a-f\d]{64}\.(png|jpg|jpeg|webp)$/i.test(name)) return send(res, 404, { error: 'Mídia não encontrada.' })
        const target = join(mediaDir, name)
        try {
          const info = await stat(target)
          res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'public, max-age=31536000, immutable' })
          createReadStream(target).pipe(res)
          return
        } catch { return send(res, 404, { error: 'Mídia não encontrada.' }) }
      }

      if (pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && !auth(req)) return send(res, 401, { error: 'Informe a chave de administração do servidor.' })

        if (pathname === '/api/hash' && req.method === 'POST') {
          const input = await body(req)
          if (!input.url) return send(res, 400, { error: 'Informe o link do arquivo.' })
          const result = await hashUrl(input.url, { allowPrivate })
          return send(res, 200, result)
        }

        if (pathname === '/api/media' && req.method === 'POST') {
          const input = await body(req, MEDIA_JSON_LIMIT)
          const match = String(input.dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/)
          if (!match) return send(res, 400, { error: 'Envie uma imagem PNG, JPEG ou WebP em data URL.' })
          const bytes = Buffer.from(match[2], 'base64')
          if (!bytes.length || bytes.length > MEDIA_LIMIT) return send(res, 400, { error: 'A imagem pode ter até 2 MiB.' })
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
          const digest = sha256Bytes(bytes)
          const name = digest + '.' + ext
          await mkdir(mediaDir, { recursive: true })
          await writeFile(join(mediaDir, name), bytes)
          return send(res, 200, { url: baseUrl(req) + '/media/' + name, sha256: digest, size: bytes.length })
        }

        if (pathname === '/api/folders/list' && req.method === 'GET') {
          const result = await listDriveFolder(url.searchParams.get('url') || '')
          return send(res, 200, result)
        }

        if (pathname === '/api/ai/chat' && req.method === 'POST') {
          const input = await body(req)
          const messages = Array.isArray(input.messages) ? input.messages.filter(m => m && typeof m.content === 'string').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content.slice(0, 8000) })) : []
          if (!messages.length) return send(res, 400, { error: 'Envie ao menos uma mensagem.' })
          try {
            const result = await externalAi(messages, await loadCatalog(), env)
            return send(res, 200, result)
          } catch (error) {
            return send(res, 200, { reply: 'A IA externa falhou: ' + error.message + '\n\n' + localAssistant(messages, await loadCatalog()), source: 'local' })
          }
        }

        if (pathname === '/api/games' && req.method === 'POST') {
          const input = await body(req)
          const slug = String(input.slug || '')
          if (!/^[a-z\d-]{1,40}$/.test(slug)) return send(res, 400, { error: 'Identificador inválido.' })
          const catalog = await loadCatalog(true)
          const index = catalog.games.findIndex(g => g.slug === slug)
          if (index < 0 && catalog.games.length >= 64) return send(res, 400, { error: 'O catálogo comporta até 64 jogos.' })
          const entry = cleanGame(input, index >= 0 ? catalog.games[index] : null)
          const games = [...catalog.games]
          if (index >= 0) games[index] = entry
          else games.unshift(entry)
          const next = await saveCatalog({ games, update: catalog.update })
          return send(res, 200, next)
        }

        const gameMatch = pathname.match(/^\/api\/games\/([a-z\d-]{1,40})$/)
        if (gameMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
          const original = gameMatch[1]
          const input = await body(req)
          const target = String(input.slug || input.newSlug || original)
          if (!/^[a-z\d-]{1,40}$/.test(target)) return send(res, 400, { error: 'Identificador inválido.' })
          const catalog = await loadCatalog(true)
          const index = catalog.games.findIndex(g => g.slug === original)
          const conflict = catalog.games.findIndex(g => g.slug === target)
          if (conflict >= 0 && conflict !== index) return send(res, 409, { error: 'Já existe um jogo com esse identificador.' })
          if (index < 0 && catalog.games.length >= 64) return send(res, 400, { error: 'O catálogo comporta até 64 jogos.' })
          input.slug = target
          const entry = cleanGame(input, index >= 0 ? catalog.games[index] : null)
          const games = index >= 0
            ? catalog.games.map((game, at) => at === index ? entry : game)
            : [entry, ...catalog.games]
          const next = await saveCatalog({ games, update: catalog.update })
          return send(res, 200, next)
        }

        if (gameMatch && req.method === 'DELETE') {
          const catalog = await loadCatalog(true)
          const games = catalog.games.filter(g => g.slug !== gameMatch[1])
          if (games.length === catalog.games.length) return send(res, 404, { error: 'Jogo não encontrado.' })
          return send(res, 200, await saveCatalog({ games, update: catalog.update }))
        }

        if (pathname === '/api/update' && (req.method === 'PUT' || req.method === 'POST')) {
          const input = await body(req)
          const catalog = await loadCatalog(true)
          const build = Number(input.build)
          if (catalog.update && Number.isFinite(build) && build < Number(catalog.update.build) && input.force !== true) {
            return send(res, 400, { error: 'Use uma build maior ou igual à publicada.' })
          }
          const entry = cleanUpdate(input, catalog.update)
          return send(res, 200, await saveCatalog({ games: catalog.games, update: entry }))
        }

        if (pathname === '/api/update' && req.method === 'DELETE') {
          const catalog = await loadCatalog(true)
          return send(res, 200, await saveCatalog({ games: catalog.games, update: null }))
        }

        return send(res, 404, { error: 'API não encontrada.' })
      }

      if (pathname === '/feed.ini' || pathname === '/store-site.ini') return send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8')
      return serveStatic(req, res, pathname)
    } catch (error) {
      if (!res.headersSent) send(res, 400, { error: error.message || 'Erro inesperado.' })
      else res.end()
    }
  }

  return { handler, dataDir, mediaDir, catalogPath, feedPath, loadCatalog, saveCatalog }
}

export function startServer(options = {}) {
  const app = createApp(options)
  const port = options.port ?? Number(process.env.PORT || 8787)
  const host = options.host || process.env.HOST || '0.0.0.0'
  const server = createServer(app.handler)
  server.listen(port, host, () => {
    const address = server.address()
    const shown = typeof address === 'object' && address ? address.port : port
    console.log(`Loja 360 em http://${host}:${shown} (dados em ${app.dataDir})`)
  })
  return { server, ...app }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startServer()
}
