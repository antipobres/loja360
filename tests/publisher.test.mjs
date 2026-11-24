import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { connect, loadPublic, readFeed } from '../publisher.mjs'

const site = 'https://tester.github.io/project/'
const apiRoot = 'https://api.github.com/repos/tester/project'
const config = { owner: 'tester', repo: 'project', branch: 'main', prefix: 'docs', baseUrl: site, token: 'local-test' }
const sha256 = 'ab'.repeat(32)
const format = (id, url = site + 'media/game.xex') =>
  `[game:${id}]\ntitle=Jogo ${id}\ngenre=RPG\ndescription=Jogo independente.\nurl=${url}\nsha256=${sha256}\nsize=12\n`
const header = '[store]\nschema=1\n'
const asset = { id: 55, state: 'uploaded', digest: 'sha256:' + sha256, size: 40000000,
  name: 'cards-base.xex', browser_download_url: 'https://github.com/tester/project/releases/download/v3/cards-base.xex' }

function github(t) {
  const calls = [], files = new Map()
  const state = { calls, files, nextWrite: null, assets: [asset] }
  const result = (body, status = 200) => Response.json(body, { status })
  const put = (name, buf) => {
    const sha = createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex')
    files.set(name, { size: buf.length, type: 'file', sha, encoding: 'base64', content: buf.toString('base64') })
  }
  put('feed.ini', Buffer.from(header))
  const issue = { number: 4, title: '[Ideia] Cores', body: 'Texto', html_url: 'https://github.com/tester/project/issues/4' }
  let comment = { id: 20, body: 'Resposta', user: { login: 'github-actions[bot]', type: 'Bot' } }
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url), method = options.method || 'GET'
    const data = options.body && JSON.parse(options.body)
    calls.push({ href, method, data, headers: options.headers })
    if (href === site + 'feed.ini') {
      assert.equal(options.headers?.Authorization, undefined)
      return new Response(Buffer.from(files.get('feed.ini').content, 'base64'))
    }
    assert(href.startsWith(apiRoot))
    assert.equal(options.headers.Authorization, 'Bearer local-test')
    assert.equal(options.redirect, 'error')
    const route = href.slice(apiRoot.length).split('?')[0]
    if (!route) return result({ private: false, archived: false })
    if (route === '/branches/main') return result({ name: 'main' })
    if (route.startsWith('/contents/docs/')) {
      const name = route.slice('/contents/docs/'.length)
      if (method === 'GET') return files.has(name) ? result(files.get(name)) : result({},404)
      assert.equal(data.branch, 'main')
      if (name === 'feed.ini' && state.nextWrite) {
        const next = state.nextWrite
        state.nextWrite = null
        put('feed.ini', Buffer.from(next))
      }
      if (data.sha !== files.get(name)?.sha) return result({},409)
      put(name,Buffer.from(data.content,'base64'))
      return result({})
    }
    if (route === '/releases') return result([{ id: 44, tag_name: 'v3', draft: false }])
    if (route === '/releases/44/assets') return result(state.assets)
    if (route === '/issues' && method === 'GET') return result([issue, { ...issue, pull_request: {} }])
    if (route === '/issues') return result({ ...issue, ...data })
    if (route === '/issues/4') return result(issue)
    if (route === '/issues/4/comments' && method === 'GET') return result([comment])
    if (route === '/issues/4/comments') { comment = { ...comment, ...data }; return result(comment) }
    throw Error('Unexpected mock route ' + route)
  })
  return state
}

const form = () => ({ slug: 'solo', title: 'Corrida', genre: 'Esporte', description: 'Corrida local.',
  file: new File(['XEX2test'], 'racer.xex') })

test('parser rejects duplicates, oversized UTF-8 fields and line injection', () => {
  assert.deepEqual(readFeed(header), { games: [], update: null })
  assert.equal(readFeed(header + format('one')).games[0].slug, 'one')
  assert.throws(() => readFeed(header + format('one') + format('one')))
  assert.throws(() => readFeed(header + format('one').replace('Jogo one','é'.repeat(41))))
  assert.throws(() => readFeed(header + format('one') + 'foo=bad'))
  assert.throws(() => readFeed(header + format('one').replace('size=12', 'size=2147483648')))
})

test('local upload commits immutable bytes first, merges concurrent independent change and loads public feed', async t => {
  const state = github(t)
  state.nextWrite = header + format('other')
  const client = await connect(config)
  const feed = await client.publishGame(form())
  assert.deepEqual(feed.games.map(g => g.slug), ['solo','other'])
  assert.equal(feed.games[0].sha256, createHash('sha256').update('XEX2test').digest('hex'))
  const puts = state.calls.filter(c => c.method === 'PUT')
  assert.match(puts[0].href,/\/media\/[0-9a-f]{64}\.xex$/)
  assert.equal(puts.filter(c => c.href.endsWith('/feed.ini')).length,2)
  assert.deepEqual(await loadPublic(site), feed)
  const f = form(); delete f.file; f.title = 'Corrida 2'
  assert.equal((await client.publishGame(f)).games[0].title,'Corrida 2')
})

test('concurrent conflicting edits preserve the other writer', async t => {
  const state = github(t)
  state.nextWrite = header + format('solo')
  const client = await connect(config)
  await assert.rejects(client.publishGame(form()),/Outra publicação/)
  assert.equal((await loadPublic(site)).games[0].title,'Jogo solo')
})

test('uses verified Release asset; rejects downgrade, missing digest, wrong origin and bootstrap', async t => {
  const state = github(t)
  const client = await connect(config)
  const feed = await client.publishUpdate({ build: 3, notes: 'Melhora a loja.', assetId: '55' })
  assert.equal(feed.update.url,asset.browser_download_url)
  await assert.rejects(client.publishUpdate({ build: 3, assetId: 55 }), /maior/)
  state.assets = [{ ...asset, digest: null }]
  await assert.rejects(client.publishUpdate({ build: 4, assetId: 55 }), /SHA-256/)
  state.assets = [{ ...asset, browser_download_url: 'https://github.com/outro/projeto/releases/download/v3/cards-base.xex' }]
  await assert.rejects(client.publishUpdate({ build: 4, assetId: 55 }), /repositório/)
  await assert.rejects(client.publishUpdate({ build: 4, file: new File(['XEX2foo'],'default.txt') }), /xex|zip|pacote/i)
  await assert.rejects(client.publishGame({ ...form(), file: new File(['AAAA'],'game.bin') }), /xex|zip|pacote/i)
})

test('validates cover dimensions and includes a supported cover before feed commit', async t => {
  github(t)
  const client = await connect(config)
  const png = Buffer.alloc(33)
  png.writeUInt32BE(0x89504e47)
  png.writeUInt32BE(0x0d0a1a0a,4)
  png.writeUInt32BE(13,8); png.write('IHDR',12)
  png.writeUInt32BE(2147483647,16); png.writeUInt32BE(900,20)
  await assert.rejects(client.publishGame({ ...form(), coverFile: new File([png],'c.png') }), /2048/)
  png.writeUInt32BE(640,16)
  assert.match((await client.publishGame({ ...form(), coverFile: new File([png],'c.png') })).games[0].cover, /\.png$/)
})

test('chat markers are written only on explicit requests; issue list excludes PRs', async t => {
  const state = github(t)
  const client = await connect(config)
  assert.equal((await client.listIdeas()).length,1)
  assert.equal((await client.readIdea(4)).comments[0].type, 'Bot')
  await client.submitIdea({ title: 'Cores', body: 'Tema verde.' })
  assert.equal(state.calls.at(-1).data.body,'Tema verde.')
  await client.submitIdea({ title: 'Cores', body: 'Tema verde.', chat: true })
  assert.equal(state.calls.at(-1).data.title,'[Ideia] Cores')
  assert.match(state.calls.at(-1).data.body,/<!-- dash:chat -->$/)
  await client.replyIdea(4,'Mais opções')
  assert.match(state.calls.at(-1).data.body,/<!-- dash:chat -->$/)
  await assert.rejects(client.submitIdea({ title:'Teste',body:'<!-- dash:chat -->' }))
})
