import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { startServer, sha256Bytes, parseDriveFolderHtml, localAssistant } from '../server.mjs'
import { readFeed } from '../publisher.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')
const sha = c => c.repeat(64)

async function start(options = {}) {
  const app = startServer({ host: '127.0.0.1', port: 0, ...options })
  if (!app.server.listening) await once(app.server, 'listening')
  const base = 'http://127.0.0.1:' + app.server.address().port
  return { ...app, base }
}
async function stop(app) {
  if (!app?.server?.listening) return
  await new Promise(resolve => app.server.close(resolve))
}
function headers(token = 'segredo', json = false) {
  return { ...(json ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-admin-token': token } : {}) }
}
async function json(res) {
  const body = await res.json()
  return { status: res.status, body }
}

test('servidor: catálogo, hash, mídia, edição, exclusão, IA e persistência', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loja360-test-'))
  const source = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': '4096' })
    res.end(Buffer.alloc(4096, 7))
  })
  source.listen(0, '127.0.0.1')
  await once(source, 'listening')
  const fileUrl = 'http://127.0.0.1:' + source.address().port + '/game.zip'
  const env = { ADMIN_TOKEN: 'segredo', ALLOW_PRIVATE_URLS: '1', AI_API_KEY: '' }
  let app = await start({ dataDir, env })
  let base = app.base

  t.after(async () => {
    await stop(app)
    await new Promise(resolve => source.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  })

  await t.test('health informa o servidor e a ausência de IA externa', async () => {
    const { status, body } = await json(await fetch(base + '/api/health'))
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.storage, 'server')
    assert.equal(body.authRequired, true)
    assert.equal(body.aiConfigured, false)
    assert.match(body.feedUrl, /\/feed\.ini$/)
  })

  await t.test('mutação exige a chave de administração', async () => {
    const response = await fetch(base + '/api/games', {
      method: 'POST', headers: headers('', true),
      body: JSON.stringify({ slug: 'x', title: 'X', genre: 'G', description: 'D', url: 'https://example.com/x.zip', sha256: sha('a'), size: 1 }),
    })
    assert.equal(response.status, 401)
  })

  await t.test('calcula SHA-256 e tamanho de um link', async () => {
    const { status, body } = await json(await fetch(base + '/api/hash', {
      method: 'POST', headers: headers('segredo', true), body: JSON.stringify({ url: fileUrl }),
    }))
    assert.equal(status, 200)
    assert.equal(body.size, 4096)
    assert.equal(body.sha256, sha256Bytes(Buffer.alloc(4096, 7)))
  })

  await t.test('cria jogo e normaliza o catálogo', async () => {
    const { status, body } = await json(await fetch(base + '/api/games', {
      method: 'POST', headers: headers('segredo', true),
      body: JSON.stringify({
        slug: 'aurora', title: 'Aurora', genre: 'Aventura', description: 'Um jogo de teste.',
        url: 'https://example.com/aurora.zip', sha256: sha('a'), size: 1024,
      }),
    }))
    assert.equal(status, 200)
    assert.equal(body.games.length, 1)
    assert.equal(body.games[0].slug, 'aurora')
    assert.equal(body.games[0].size, 1024)
  })

  await t.test('envia e serve uma capa', async () => {
    const { status, body } = await json(await fetch(base + '/api/media', {
      method: 'POST', headers: headers('segredo', true),
      body: JSON.stringify({ name: 'cover.png', dataUrl: 'data:image/png;base64,' + png.toString('base64') }),
    }))
    assert.equal(status, 200)
    assert.match(body.url, /\/media\/[a-f\d]{64}\.png$/)
    const image = await fetch(body.url)
    assert.equal(image.status, 200)
    assert.equal(image.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png)
    const updated = await json(await fetch(base + '/api/games/aurora', {
      method: 'PUT', headers: headers('segredo', true), body: JSON.stringify({ cover: body.url }),
    }))
    assert.equal(updated.status, 200)
    assert.equal(updated.body.games[0].cover, body.url)
  })

  await t.test('edita, renomeia e remove a capa', async () => {
    const { status, body } = await json(await fetch(base + '/api/games/aurora', {
      method: 'PUT', headers: headers('segredo', true),
      body: JSON.stringify({ slug: 'aurora-2', title: 'Aurora 2', cover: '' }),
    }))
    assert.equal(status, 200)
    assert.equal(body.games.length, 1)
    assert.equal(body.games[0].slug, 'aurora-2')
    assert.equal(body.games[0].title, 'Aurora 2')
    assert.equal(body.games[0].cover, undefined)
  })

  await t.test('impede identificador duplicado', async () => {
    const first = await json(await fetch(base + '/api/games', {
      method: 'POST', headers: headers('segredo', true),
      body: JSON.stringify({ slug: 'outro', title: 'Outro', genre: 'Ação', description: 'Outro jogo.', url: 'https://example.com/outro.zip', sha256: sha('c'), size: 10 }),
    }))
    assert.equal(first.status, 200)
    const response = await fetch(base + '/api/games/outro', {
      method: 'PUT', headers: headers('segredo', true),
      body: JSON.stringify({ slug: 'aurora-2' }),
    })
    assert.equal(response.status, 409)
  })

  await t.test('publica build, gera feed.ini e permite editar mantendo a build', async () => {
    const created = await json(await fetch(base + '/api/update', {
      method: 'PUT', headers: headers('segredo', true),
      body: JSON.stringify({ build: 2, url: 'https://example.com/dash.zip', sha256: sha('b'), size: 2048, notes: 'Build 2' }),
    }))
    assert.equal(created.status, 200)
    assert.equal(created.body.update.build, 2)
    const edited = await json(await fetch(base + '/api/update', {
      method: 'PUT', headers: headers('segredo', true),
      body: JSON.stringify({ build: 2, url: 'https://example.com/dash.zip', sha256: sha('b'), size: 2048, notes: 'Build 2 revisada' }),
    }))
    assert.equal(edited.status, 200)
    assert.equal(edited.body.update.notes, 'Build 2 revisada')
    const feed = readFeed(await (await fetch(base + '/feed.ini')).text())
    assert.equal(feed.update.build, 2)
    assert.equal(feed.games.length, 2)
    const site = await (await fetch(base + '/store-site.ini')).text()
    assert.equal(site.trim(), 'url=' + base + '/feed.ini')
  })

  await t.test('importa catálogo completo', async () => {
    const catalog = { games: [{ slug: 'importado', title: 'Importado', genre: 'RPG', description: 'Do JSON.', url: 'https://example.com/i.zip', sha256: sha('d'), size: 33 }], update: null }
    const imported = await json(await fetch(base + '/api/catalog', {
      method: 'PUT', headers: headers('segredo', true), body: JSON.stringify(catalog),
    }))
    assert.equal(imported.status, 200)
    assert.equal(imported.body.games.length, 1)
    assert.equal(imported.body.games[0].slug, 'importado')
    assert.equal(imported.body.update, null)
  })

  await t.test('assistente local responde com o catálogo', async () => {
    const { status, body } = await json(await fetch(base + '/api/ai/chat', {
      method: 'POST', headers: headers('segredo', true),
      body: JSON.stringify({ messages: [{ role: 'user', content: 'quantos jogos existem?' }] }),
    }))
    assert.equal(status, 200)
    assert.equal(body.source, 'local')
    assert.match(body.reply, /1 jogo/)
  })

  await t.test('exclui jogo', async () => {
    const { status, body } = await json(await fetch(base + '/api/games/importado', {
      method: 'DELETE', headers: headers('segredo', true),
    }))
    assert.equal(status, 200)
    assert.equal(body.games.length, 0)
  })

  await t.test('arquivos privados não são servidos', async () => {
    assert.equal((await fetch(base + '/server.mjs')).status, 403)
    assert.equal((await fetch(base + '/data/catalog.json')).status, 403)
    assert.equal((await fetch(base + '/tests/server.test.mjs')).status, 403)
    const home = await fetch(base + '/')
    assert.equal(home.status, 200)
    assert.match(await home.text(), /<!doctype html>/i)
  })

  await t.test('persiste o catálogo após reiniciar o servidor', async () => {
    await json(await fetch(base + '/api/games', {
      method: 'POST', headers: headers('segredo', true),
      body: JSON.stringify({ slug: 'persistente', title: 'Persistente', genre: 'Ação', description: 'Sobrevive ao restart.', url: 'https://example.com/p.zip', sha256: sha('e'), size: 77 }),
    }))
    await stop(app)
    app = await start({ dataDir, env })
    base = app.base
    const { body } = await json(await fetch(base + '/api/catalog'))
    assert.equal(body.games.some(g => g.slug === 'persistente'), true)
    assert.equal(body.update, null)
  })
})

test('mídia aceita imagens até 2 MiB e rejeita acima do limite', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loja360-media-'))
  const app = await start({ dataDir, env: {} })
  t.after(async () => {
    await stop(app)
    await rm(dataDir, { recursive: true, force: true })
  })
  const bytes = Buffer.alloc(1536 * 1024, 5)
  const accepted = await fetch(app.base + '/api/media', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'grande.png', dataUrl: 'data:image/png;base64,' + bytes.toString('base64') }),
  })
  assert.equal(accepted.status, 200)
  const media = await accepted.json()
  assert.match(media.url, /\/media\/[a-f\d]{64}\.png$/)
  const downloaded = await fetch(media.url)
  assert.equal(downloaded.status, 200)
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).length, bytes.length)
  const tooBig = Buffer.alloc(2 * 1024 * 1024 + 1, 5)
  const rejected = await fetch(app.base + '/api/media', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'enorme.png', dataUrl: 'data:image/png;base64,' + tooBig.toString('base64') }),
  })
  assert.equal(rejected.status, 400)
})

test('IA externa usa provedor compatível com OpenAI e cai para o assistente local em falha', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'loja360-ai-'))
  let mode = 'ok'
  let received = null
  const mock = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    received = JSON.parse(raw || '{}')
    if (mode === 'fail') {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('provedor indisponível')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'Resposta externa de teste.' } }] }))
  })
  mock.listen(0, '127.0.0.1')
  await once(mock, 'listening')
  const mockBase = 'http://127.0.0.1:' + mock.address().port + '/v1'
  const app = await start({
    dataDir,
    env: { AI_API_KEY: 'chave-teste', AI_BASE_URL: mockBase, AI_MODEL: 'modelo-teste' },
  })
  t.after(async () => {
    await stop(app)
    await new Promise(resolve => mock.close(resolve))
    await rm(dataDir, { recursive: true, force: true })
  })
  const ok = await json(await fetch(app.base + '/api/ai/chat', {
    method: 'POST', headers: headers('', true),
    body: JSON.stringify({ messages: [{ role: 'user', content: 'qual a build?' }] }),
  }))
  assert.equal(ok.status, 200)
  assert.equal(ok.body.source, 'ai')
  assert.equal(ok.body.reply, 'Resposta externa de teste.')
  assert.equal(received.model, 'modelo-teste')
  assert.match(received.messages[0].content, /Catálogo atual/)
  mode = 'fail'
  const failed = await json(await fetch(app.base + '/api/ai/chat', {
    method: 'POST', headers: headers('', true),
    body: JSON.stringify({ messages: [{ role: 'user', content: 'quantos jogos?' }] }),
  }))
  assert.equal(failed.status, 200)
  assert.equal(failed.body.source, 'local')
  assert.match(failed.body.reply, /A IA externa falhou/)
  assert.match(failed.body.reply, /0 jogo/)
})

test('parser de pasta do Drive e respostas locais', () => {
  const html = '[["1abcDEFghijklmnopqrstuvwxyz",["x"],"Aurora","application/vnd.google-apps.folder"]]'
  const entries = parseDriveFolderHtml(html)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'Aurora')
  const payload = '[["1LBQ2Wfy7LzbiLBsXwzRWN0eXfBlUHHVr",["folder"],"Aurora.zip","application/x-zip-compressed"]]'
  const escaped = payload.replace(/\[/g, '\\x5b').replace(/\]/g, '\\x5d').replace(/"/g, '\\x22').replace(/\//g, '\\/')
  const current = parseDriveFolderHtml("window['_DRIVE_ivd'] = '" + escaped + "';")
  assert.deepEqual(current, [{ id: '1LBQ2Wfy7LzbiLBsXwzRWN0eXfBlUHHVr', name: 'Aurora.zip', mime: 'application/x-zip-compressed' }])
  const reply = localAssistant([{ role: 'user', content: 'lista os jogos' }], { games: [{ title: 'Aurora', slug: 'aurora', size: 10 }], update: { build: 4 } })
  assert.match(reply, /Aurora/)
})
