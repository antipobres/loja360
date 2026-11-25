import { connect, loadPublic, readFeed, writeFeed, hash, zipFiles, isXex, isZip } from './publisher.mjs'

const $ = s => document.querySelector(s)
const names = {inicio:'Visão geral', biblioteca:'Biblioteca', catalogo:'Upload', updates:'Atualizações', ideias:'Ideias e chat', conexao:'Conexão'}
const settings = $('#settings-form')
const publish = $('#publish-form')
const ideaForm = $('#idea-form')
const emptyFeed = () => ({ games:[], update:null })
let feed = emptyFeed(), client = null, editing = '', publication = '', activeThread = 0
let pending = null, readVersion = 0, threadVersion = 0, threadStamp = '', slugEdited = false

function node(tag, text, cls) {
  const n = document.createElement(tag)
  if (text != null) n.textContent = text
  if (cls) n.className = cls
  return n
}
function infer() {
  const host = location.hostname
  if (!host.endsWith('.github.io')) return {}
  const owner = host.slice(0,-10)
  const parts = new URL('.',location.href).pathname.split('/').filter(Boolean)
  return {owner, repo:parts.shift() || host, branch:'main', prefix:parts.join('/'), baseUrl:new URL('.',location.href).href}
}
function restore() {
  try { return JSON.parse(localStorage.getItem('cards-studio-source') || 'null') || infer() }
  catch { return infer() }
}
let config = restore()
try { githubTokenMem = localStorage.getItem('cards-studio-token') || '' } catch {}
function validate(input) {
  const {owner, repo, branch, prefix} = input
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
  return {owner,repo,branch,prefix,baseUrl:url.href}
}
function fillSettings(){
  for(const k of ['owner','repo','branch','prefix','baseUrl']) settings.elements[k].value = config[k] || (k === 'branch' ? 'main' : '')
  document.querySelectorAll('.connection-label').forEach(x => x.textContent = client ? 'Conectado' : 'Conexão')
  $('.connectBtn').classList.toggle('connected',!!client)
}
function feedback(text='',error=false){const el=$('#feedback');el.textContent=text;el.hidden=!text;el.dataset.error=String(error)}
function route(){
  let key=location.hash.slice(1); if(key==='catalogo') key='biblioteca'; if(!(key in names)) key='inicio'
  document.querySelectorAll('.view').forEach(s=>s.hidden=s.id!==key)
  document.querySelectorAll('.rail nav a').forEach(a=>{
    if(a.hash==='#'+key) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current')
  })
  $('#crumb').textContent=names[key]; document.title=names[key]+' • Cards Studio'
  if(key==='ideias') loadIdeas()
  window.scrollTo(0,0)
}
function empty(title, text) {
  const wrap=node('div',null,'empty'), art=node('span',null,'empty-art'), icon=node('i',null,'ico covers')
  art.setAttribute('aria-hidden','true');art.append(icon)
  const content=node('div'); content.append(node('strong',title),node('p',text));wrap.append(art,content);return wrap
}
function listGames(target,games,editable){
  target.replaceChildren()
  if(!games.length){
    const filtered=editable && ($('#query')?.value?.trim()||'')
    target.append(empty(filtered?'Nenhum jogo encontrado':'Nenhum jogo publicado',filtered?'Tente outro título ou gênero.':'O primeiro jogo publicado aqui aparecerá no catálogo do Xbox.'))
    return
  }
  const grid=node('div',null,'gamegrid')
  for(const game of games){
    const card=node('div',null,'gamecard'), art=node('div',game.title.substring(0,2).toUpperCase(),'art')
    if(game.cover){
      const img=node('img');img.alt='';img.loading='lazy';img.referrerPolicy='no-referrer'
      img.addEventListener('error',()=>art.replaceChildren(document.createTextNode(game.title.substring(0,2).toUpperCase())),{once:true})
      img.src=game.cover;art.replaceChildren(img)
    }
    const details=node('article');details.append(node('span',game.genre,'meta'),node('h3',game.title))
    if(editable){details.append(node('p',game.description))
      if(client){const b=node('button','Editar jogo','outline');b.onclick=()=>openPublish('game',game);details.append(b)}
    }
    card.append(art,details);grid.append(card)
  }
  target.append(grid)
}
function draw(){
  $('#game-count').textContent=String(feed.games.length);$('#build-number').textContent=feed.update?.build || '—'
  $('#source-state').textContent=config.baseUrl?'Configurada':'Configurar'
  listGames($('#recent'),feed.games.slice(0,4),false)
  const norm=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  const qEl=$('#query'); const q=norm(qEl?.value?.trim()||'')
  const filtered=feed.games.filter(g=>norm([g.title,g.genre,g.description].join(' ')).includes(q))
  const cat=$('#catalog-list'); if(cat) listGames(cat,filtered,true)
  const lib=$('#library-list'); if(lib) listGames(lib, feed.games, false)
  const update=feed.update
  $('#release-title').textContent=update?'Build '+update.build:'Sem build publicada'
  $('#release-notes').textContent=update?.notes || (update?'':'A primeira versão publicada aparecerá aqui.')
  const meta=$('#release-meta');meta.replaceChildren()
  if(update) for(const [k,v] of [['Tamanho',(update.size/1048576).toFixed(2)+' MiB'],['SHA-256',update.sha256]]) meta.append(node('dt',k),node('dd',v))
}
async function refresh(silent=false){
  const version=++readVersion
  try{
    let next
    if(config.baseUrl) next=await loadPublic(config.baseUrl,config)
    else {
      const response=await fetch('./feed.ini',{cache:'no-store'})
      if(!response.ok) throw Error('O catálogo local está indisponível.')
      next=readFeed(await response.text())
    }
    if(version!==readVersion)return
    if(pending){
      const entry=pending.slug?next.games.find(g=>g.slug===pending.slug):next.update
      if(JSON.stringify(entry)!==pending.value && Date.now()<pending.deadline)return
      pending=null
    }
    feed=next;draw()
  }catch(e){
    if(version!==readVersion) return
    try{ const local=JSON.parse(localStorage.getItem('cards-studio-feed-local')||'null'); if(local && Array.isArray(local.games)){ feed=local; draw(); if(!silent) feedback('Usando catálogo salvo localmente.', false); return } }catch{}
    if(!silent) feedback('Catálogo indisponível. '+e.message,true)
  }
}
function requireClient(){
  if(client) return true
  feedback('Sem conexão GitHub: a publicação será salva localmente. Conecte em Conexão para publicar no site.', false)
  return true
}
function askConnect(){location.hash='conexao'}
let githubTokenMem=''

settings.addEventListener('submit',async e=>{
  e.preventDefault();const button=e.submitter;button.disabled=true
  try{
    const data=Object.fromEntries(new FormData(settings))
    const publicConfig=validate({owner:data.owner.trim(),repo:data.repo.trim(),branch:data.branch.trim(),prefix:data.prefix.trim().replace(/^\/+|\/+$/g,''),baseUrl:data.baseUrl.trim()})
    const token=(data.token||'').trim()
    const nextClient=token?await connect({...publicConfig,token}):null
    if(token) githubTokenMem=token
    settings.elements.token.value=''
    config=publicConfig;client=nextClient;pending=null;activeThread=0;threadVersion++;threadStamp=''
    try{ localStorage.setItem('cards-studio-source',JSON.stringify(config)) }catch{}
    try{ if(token) localStorage.setItem('cards-studio-token', token); else localStorage.removeItem('cards-studio-token') }catch{}
    feed=emptyFeed();fillSettings();draw();feedback(client?'Configuração salva.':'Configuração salva. Adicione um token para publicar.')
    await refresh(true)
  }catch(err){feedback(err.message,true)}finally{button.disabled=false}
})
$('#disconnect').onclick=()=>{client=null;activeThread=0;threadVersion++;threadStamp='';settings.elements.token.value='';fillSettings();draw();feedback('Conta desconectada.');$('#thread').replaceChildren(node('h2','Selecione uma ideia'))}
$('#refresh-store') && ($('#refresh-store').onclick=async()=>{ feedback('Atualizando a loja...'); await refresh(false); feedback('Loja atualizada. A dash vai carregar o feed ao abrir o menu da loja.') })
$('#download-config').onclick=()=>{
  try{
    if(!config.repo) throw Error('Salve o endereço do repositório antes de gerar o arquivo.')
    const url=validate(config).baseUrl+'feed.ini'
    const ref=URL.createObjectURL(new Blob(['url='+url+'\n'],{type:'text/plain;charset=utf-8'}))
    const a=node('a');a.href=ref;a.download='store-site.ini';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(ref),1500)
    feedback('Arquivo gerado para '+url)
  }catch(e){feedback(e.message,true)}
}
function openPublish(kind,game=null){
  if(!requireClient())return
  publication=kind;editing=game?.slug || '';slugEdited=!!editing;publish.reset()
  const isGame=kind==='game'
  $('#game-fields').hidden=!isGame;$('#update-fields').hidden=isGame
  for(const el of $('#game-fields').querySelectorAll('input,textarea')) el.disabled=!isGame
  for(const el of $('#update-fields').querySelectorAll('input,textarea')) el.disabled=isGame
  publish.elements.build.required=!isGame;publish.elements.slug.readOnly=!!editing
  if(game) for(const k of ['title','slug','genre','description']) publish.elements[k].value=game[k]
  if(!isGame)publish.elements.build.value=Math.max(2,(feed.update?.build||1)+1)
  $('#publish-title').textContent=isGame?(editing?'Editar jogo':'Publicar jogo'):'Publicar atualização'
  $('#publish-type').textContent=isGame?'Catálogo do Xbox':'Software da dashboard'
  if(publish.elements.source) publish.elements.source.value='url'
  $('#publish-submit').textContent=isGame?'Publicar no catálogo':'Publicar atualização automática'
  const rl=$('#release-link'); if(rl) rl.href='https://github.com/'+config.owner+'/'+config.repo+'/releases'
  $('#publish-result').textContent='';toggleSource(false);$('#publish-dialog').showModal()
}
function toggleSource(){
  const us=$('#url-source'); if(us) us.hidden=false
  if(publish.elements.externalUrl) publish.elements.externalUrl.required=true
  if(publish.elements.externalSha) publish.elements.externalSha.required=false
  if(publish.elements.externalSize) publish.elements.externalSize.required=false
}

const DEFAULT_LIBRARY_FOLDER='https://drive.google.com/drive/folders/1xNVtJi_8Rv48lANGjJBDjTBpmoZaPnvS?usp=sharing'
const DEFAULT_UPDATES_FOLDER='https://drive.google.com/drive/folders/1MDYFD_Q6WDB17Jn1YGVIyrOjDqpe6q8p?usp=sharing'
function driveFolderId(url){
  const m=String(url||'').match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/) || String(url||'').match(/[?&]id=([a-zA-Z0-9_-]+)/)
  return m?m[1]:''
}
function normalizePublicUrl(raw){
  let u=String(raw||'').trim()
  const folderId=driveFolderId(u)
  if(folderId && /\/folders\//.test(u)) return 'https://drive.google.com/uc?export=download&confirm=t&id='+folderId
  const m=u.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) || u.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if(m && /drive\.google\.com/.test(u)) u='https://drive.google.com/uc?export=download&confirm=t&id='+m[1]
  return u
}
function parseDriveFolderHtml(body){
  const entries=[]; const seen=new Set()
  const push=(id,name,mime)=>{ if(!id||!name||seen.has(id)) return; seen.add(id); entries.push({id,name,mime:mime||''}) }
  const re=/\["([a-zA-Z0-9_-]{25,60})"\s*,\s*\[[^\]]*\]\s*,\s*"([^"]{1,200})"\s*,\s*"((?:application\/[^"]+|[^"]*folder[^"]*|[^"]*zip[^"]*|[^"]*octet[^"]*))"/g
  let m; while((m=re.exec(body))&&entries.length<100){ push(m[1],m[2].replace(/\\u([0-9a-fA-F]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16))),m[3]) }
  if(!entries.length){
    const re2=/\["([a-zA-Z0-9_-]{25,60})"\s*,\s*"([^"]+\.(?:zip|xex|ZIP|XEX))"/g
    while((m=re2.exec(body))&&entries.length<100) push(m[1],m[2],'')
  }
  return entries.filter(e=>e.id && e.name && e.name!=='.' && e.name!=='..')
}
async function fetchDriveFolder(folderUrl){
  const id=driveFolderId(folderUrl)
  if(!id) throw new Error('Link de pasta do Drive inválido.')
  const url='https://drive.google.com/drive/folders/'+id
  const attempts=[url, 'https://corsproxy.io/?url='+encodeURIComponent(url), 'https://api.allorigins.win/raw?url='+encodeURIComponent(url)]
  let lastErr
  for(const u of attempts){
    try{
      const r=await fetch(u,{mode:'cors',credentials:'omit'})
      if(!r.ok) throw new Error('HTTP '+r.status)
      const body=await r.text()
      const entries=parseDriveFolderHtml(body)
      if(entries.length) return {id, entries}
      // if body looks like Drive page but no entries, may be empty or parse failed
      if(/drive\.google|_DRIVE_ivd|Drive/.test(body) && !entries.length) return {id, entries:[]}
    }catch(e){ lastErr=e }
  }
  throw lastErr || new Error('Não foi possível ler a pasta pública.')
}
async function autoFillFromUrl(){
  const urlRaw=publish.elements.externalUrl?.value?.trim(); if(!urlRaw) return false
  const url=normalizePublicUrl(urlRaw)
  if(url!==urlRaw && publish.elements.externalUrl) publish.elements.externalUrl.value=url
  const resEl=$('#publish-result')
  try{
    if(resEl) resEl.textContent='Obtendo tamanho e SHA-256...'
    const r=await fetch(url, {mode:'cors', credentials:'omit'})
    if(!r.ok) throw new Error('HTTP '+r.status)
    const len=r.headers.get('content-length')
    if(len && publish.elements.externalSize && !publish.elements.externalSize.value) publish.elements.externalSize.value=String(len)
    const reader=r.body?.getReader?.()
    if(!reader){
      const buf=new Uint8Array(await r.arrayBuffer())
      const sha=await hash(buf)
      if(publish.elements.externalSha) publish.elements.externalSha.value=sha
      if(publish.elements.externalSize) publish.elements.externalSize.value=String(buf.length)
      if(resEl) resEl.textContent='SHA-256 e tamanho preenchidos automaticamente.'
      return true
    }
    const st=sha256Init(); let total=0
    while(true){
      const {done,value}=await reader.read(); if(done) break
      sha256Push(st,value); total+=value.length
      if(resEl) resEl.textContent='Calculando SHA-256... '+(total/1048576).toFixed(1)+' MiB'
    }
    if(publish.elements.externalSha) publish.elements.externalSha.value=sha256Finish(st)
    if(publish.elements.externalSize) publish.elements.externalSize.value=String(total)
    if(resEl) resEl.textContent='SHA-256 e tamanho preenchidos automaticamente.'
    return true
  }catch(e){
    if(resEl) resEl.textContent='Não foi possível obter SHA-256/tamanho automaticamente (CORS/bloqueio). Abra "Avançado" para preencher manualmente. '+(e.message||'')
    return false
  }
}
publish.elements.externalUrl?.addEventListener('change', autoFillFromUrl)
publish.elements.externalUrl?.addEventListener('paste', ()=>setTimeout(autoFillFromUrl, 50))
$('#auto-fill-hash') && ($('#auto-fill-hash').onclick=()=>autoFillFromUrl())
async function loadAssets(){
  const c=client
  try{
    $('#publish-result').textContent='Lendo Releases públicas…'
    const assets=await c.listAssets();if(c!==client)return
    const s=publish.elements.assetId;s.replaceChildren(new Option('Selecione um arquivo',''))
    for(const a of assets.filter(a=>/\.(xex|zip)$/i.test(a.name))) s.add(new Option(a.tag+' / '+a.name+' • '+(a.size/1048576).toFixed(1)+' MiB',a.id))
    $('#publish-result').textContent=s.length===1?'Nenhum pacote compatível (.xex/.zip). Adicione o arquivo a uma Release pública no GitHub e atualize a lista.':''
  }catch(e){$('#publish-result').textContent=e.message}
}
publish.elements.title.oninput=()=>{if(!slugEdited)publish.elements.slug.value=publish.elements.title.value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)}
publish.elements.slug.oninput=()=>{slugEdited=true}
if(publish.elements.source) publish.elements.source.onchange=toggleSource; const ra=$('#reload-assets'); if(ra) ra.onclick=loadAssets
publish.onsubmit=async e=>{
  e.preventDefault();const b=$('#publish-submit');b.disabled=true
  try{
    const args=Object.fromEntries(new FormData(publish));args.onProgress=t=>$('#publish-result').textContent=t
    args.file=null; args.files=null; args.assetId=null
    args.externalUrl=args.externalUrl||null; args.externalSha=(args.externalSha||'').trim(); args.externalSize=(args.externalSize||'').trim()
    if(args.externalUrl && (!args.externalSha || !args.externalSize)){
      const ok=await autoFillFromUrl()
      args.externalSha=publish.elements.externalSha?.value?.trim()||args.externalSha
      args.externalSize=publish.elements.externalSize?.value?.trim()||args.externalSize
      if(!ok || !args.externalSha || !args.externalSize) throw new Error('Não foi possível calcular SHA-256/tamanho automaticamente. Abra "Avançado" e preencha manualmente.')
    }
    args.coverFile=publication==='game'&&publish.elements.coverFile?.files?.[0]?publish.elements.coverFile.files[0]:null
    args.backgroundFile=publication==='game'&&publish.elements.backgroundFile?.files?.[0]?publish.elements.backgroundFile.files[0]:null
    const isGame=publication==='game'
    let next
    if(client){
      next=isGame?await client.publishGame(args):await client.publishUpdate(args)
    } else {
      if(args.coverFile || args.backgroundFile) throw new Error('Para enviar capa/fundo, conecte o GitHub em Conexão. Ou publique sem capa agora.')
      const base={...feed, games:[...feed.games]}
      if(isGame){
        const entry={slug:(args.slug||'').trim(), title:(args.title||'').trim(), genre:(args.genre||'').trim(), description:(args.description||'').trim(), url:args.externalUrl, sha256:(args.externalSha||'').toLowerCase(), size:Number(args.externalSize)}
        const i=base.games.findIndex(g=>g.slug===entry.slug)
        if(i>=0) base.games[i]={...base.games[i],...entry}
        else base.games.unshift(entry)
      } else {
        const build=Number(args.build)
        if(build <= Number(feed.update?.build||0)) throw new Error('Use um build maior que o já publicado.')
        base.update={build, url:args.externalUrl, sha256:(args.externalSha||'').toLowerCase(), size:Number(args.externalSize), notes:(args.notes||'').trim()}
      }
      writeFeed(base)
      next=base
      try{ localStorage.setItem('cards-studio-feed-local', JSON.stringify(next)) }catch{}
    }
    ++readVersion;feed=next
    const entry=isGame?next.games.find(g=>g.slug===args.slug):next.update
    pending={slug:isGame?args.slug:'',value:JSON.stringify(entry),deadline:Date.now()+600000}
    draw();$('#publish-dialog').close();location.hash=isGame?'biblioteca':'updates'
    feedback(client?'Publicação salva no catálogo.':'Publicação salva localmente. Conecte o GitHub em Conexão para publicar no site.')
  }catch(err){$('#publish-result').textContent=err.message}finally{b.disabled=false}
}
const ideaTitle=s=>s.replace(/^\[Ideia\]\s*/,'')
async function loadIdeas(){
  const box=$('#idea-list'), c=client
  if(!c){box.replaceChildren(node('p','Conecte o GitHub para acessar suas ideias.','hint'));return}
  try{
    const ideas=await c.listIdeas()
    if(c!==client)return
    box.replaceChildren()
    if(!ideas.length)box.append(node('p','Nenhuma ideia publicada.','hint'))
    for(const idea of ideas){const b=node('button','#'+idea.number+'  '+ideaTitle(idea.title),'topic');b.onclick=()=>openThread(idea.number);b.setAttribute('aria-current',String(idea.number===activeThread));box.append(b)}
  }catch(e){if(c===client)box.textContent=e.message}
}
async function openThread(number,quiet=false){
  const c=client;if(!c)return
  const version=++threadVersion;activeThread=number
  const box=$('#thread')
  try{
    const result=await c.readIdea(number);if(c!==client || version!==threadVersion)return
    const stamp=JSON.stringify([number,result.body,result.comments.map(m=>[m.id,m.body])])
    if(quiet && stamp===threadStamp)return
    const draft=box.dataset.number===String(number)?box.querySelector('textarea')?.value:''
    threadStamp=stamp;box.dataset.number=String(number);box.replaceChildren(node('p','#'+number,'kicker'),node('h2',ideaTitle(result.title)),node('p',clean(result.body),'thread-text'))
    for(const m of result.comments){
      const p=node('div',null,'post');const assistant=m.author==='github-actions[bot]' && m.type==='Bot' && m.body.startsWith('<!-- dash:assistant:')
      p.append(node('strong',assistant?'Assistente':m.author),node('p',clean(m.body),'thread-text'));box.append(p)
    }
    const form=node('form',null,'stack'), label=node('label','Continuar a conversa'), input=node('textarea')
    input.required=true;input.maxLength=4000;input.rows=3;input.value=draft||'';label.append(input)
    const button=node('button','Enviar ao chat','primary'), message=node('p','','hint');message.setAttribute('role','status')
    form.append(label,node('small','A mensagem será publicada na Issue.','hint'),button,message)
    form.onsubmit=async event=>{
      event.preventDefault();button.disabled=true
      try{await c.replyIdea(number,input.value);input.value='';await openThread(number);feedback('Mensagem publicada. A resposta aparecerá nesta conversa.')}
      catch(e){message.textContent=e.message}finally{button.disabled=false}
    };box.append(form)
    if(!quiet)loadIdeas()
  }catch(e){if(c===client && version===threadVersion && !quiet) feedback(e.message,true)}
}
$('#new-idea').onclick=()=>{if(requireClient()){ideaForm.reset();$('#idea-result').textContent='';$('#idea-dialog').showModal()}}
ideaForm.onsubmit=async e=>{
  e.preventDefault();const b=e.submitter;b.disabled=true
  try{const issue=await client.submitIdea({title:ideaForm.elements.title.value,body:ideaForm.elements.body.value,chat:ideaForm.elements.chat.checked});$('#idea-dialog').close();await openThread(issue.number);feedback('Ideia publicada no GitHub.')}
  catch(err){$('#idea-result').textContent=err.message}finally{b.disabled=false}
}
// Init
const b64url = (buf)=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
async function pkce(){
  const v = crypto.getRandomValues(new Uint8Array(64)); const verifier=b64url(v)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: b64url(digest) }
}
function driveRedirect(){ return location.origin + location.pathname }
// Incremental SHA-256 for large files
function sha256Init(){ const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]); return {h,buf:new Uint8Array(64),len:0,total:0n}; }
function sha256Push(s,chunk){ const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const rotr=(x,n)=>((x>>>n)|(x<<(32-n)))>>>0; const w=new Uint32Array(64);
  let off=0; s.total+=BigInt(chunk.length);
  while(off<chunk.length){ const take=Math.min(64-s.len, chunk.length-off); s.buf.set(chunk.subarray(off,off+take),s.len); s.len+=take; off+=take; if(s.len!==64) break;
    for(let i=0;i<16;i++) w[i]=(s.buf[i*4]<<24)|(s.buf[i*4+1]<<16)|(s.buf[i*4+2]<<8)|s.buf[i*4+3];
    for(let i=16;i<64;i++){ const s0=(rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3))>>>0; const s1=(rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10))>>>0; w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0; }
    let a=s.h[0],b=s.h[1],c=s.h[2],d=s.h[3],e=s.h[4],f=s.h[5],g=s.h[6],h=s.h[7];
    for(let i=0;i<64;i++){ const S1=(rotr(e,6)^rotr(e,11)^rotr(e,25))>>>0; const ch=((e&f)^(~e&g))>>>0; const t1=(h+S1+ch+K[i]+w[i])>>>0; const S0=(rotr(a,2)^rotr(a,13)^rotr(a,22))>>>0; const maj=((a&b)^(a&c)^(b&c))>>>0; const t2=(S0+maj)>>>0; h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0; }
    s.h[0]=(s.h[0]+a)>>>0; s.h[1]=(s.h[1]+b)>>>0; s.h[2]=(s.h[2]+c)>>>0; s.h[3]=(s.h[3]+d)>>>0; s.h[4]=(s.h[4]+e)>>>0; s.h[5]=(s.h[5]+f)>>>0; s.h[6]=(s.h[6]+g)>>>0; s.h[7]=(s.h[7]+h)>>>0; s.len=0;
  }
}
function sha256Finish(s){ const bitLen=s.total*8n; sha256Push(s,new Uint8Array([0x80])); while(s.len!==56) sha256Push(s,new Uint8Array([0])); const tail=new Uint8Array(8); for(let i=0;i<8;i++) tail[7-i]=Number((bitLen>>(BigInt(i)*8n))&0xffn); sha256Push(s,tail); let hex=''; for(let i=0;i<8;i++) hex+=s.h[i].toString(16).padStart(8,'0'); return hex; }
async function sha256File(file,onProgress){ const st=sha256Init(); const step=4*1024*1024; for(let o=0;o<file.size;o+=step){ const chunk=new Uint8Array(await file.slice(o,Math.min(o+step,file.size)).arrayBuffer()); sha256Push(st,chunk); onProgress?.(`Calculando SHA-256… ${Math.round(Math.min(o+step,file.size)/file.size*100)}%`); } return sha256Finish(st); }

function driveFileDirectUrl(id){ return 'https://drive.google.com/uc?export=download&confirm=t&id='+id }
function renderDriveFolderEntries(kind, entries){
  const box=$(`#${kind}-folder-list`), status=$(`#${kind}-folder-status`)
  if(!box) return
  box.replaceChildren()
  if(!entries.length){ if(status) status.textContent='Nenhum arquivo/pasta encontrado na listagem pública. Verifique se a pasta está como “Qualquer pessoa com o link” ou cole o link direto do arquivo.'; return }
  if(status) status.textContent=`${entries.length} item(ns) encontrado(s). Clique em “Publicar” para preencher o link.`
  for(const e of entries){
    const row=node('div',null,'hint')
    const isFolder=/folder/i.test(e.mime||'')
    const name=node('div', (isFolder?'📁 ':'📄 ')+e.name)
    const btn=node('button','Publicar','outline'); btn.type='button'
    btn.onclick=()=>{
      if(!requireClient()){ feedback('Conecte o GitHub na aba Conexão para publicar.', true); return }
      openPublish(kind==='library'?'game':'update')
      const url=isFolder?driveFileDirectUrl(e.id):driveFileDirectUrl(e.id)
      if(publish.elements.externalUrl) publish.elements.externalUrl.value=url
      if(publish.elements.externalSha) publish.elements.externalSha.value=''
      if(publish.elements.externalSize) publish.elements.externalSize.value=''
      const baseName=e.name.replace(/\.(zip|xex)$/i,'')
      if(kind==='library' && publish.elements.title && !publish.elements.title.value){ publish.elements.title.value=baseName; publish.elements.title.dispatchEvent(new Event('input')) }
      if(kind==='updates' && publish.elements.notes && !publish.elements.notes.value){ publish.elements.notes.value=baseName }
      const res=$('#publish-result')
      if(res) res.textContent=isFolder?'Pasta selecionada: o link aponta para download da pasta no Drive. Confirme se o Drive gera um .zip direto; se não, publique o .zip do jogo. Calculando SHA-256/tamanho...':'Arquivo selecionado. Calculando SHA-256/tamanho...'
      autoFillFromUrl()
    }
    const open=node('a','Abrir','outline'); open.href='https://drive.google.com/open?id='+e.id; open.target='_blank'; open.rel='noopener noreferrer'
    const actions=node('div',null,'actions'); actions.append(btn,open)
    row.append(name,actions)
    box.append(row)
  }
}
async function importDriveFolder(kind){
  const input=$(`#${kind}-folder-url`)
  const status=$(`#${kind}-folder-status`)
  const url=(input?.value||'').trim() || (kind==='library'?DEFAULT_LIBRARY_FOLDER:DEFAULT_UPDATES_FOLDER)
  if(input && !input.value) input.value=url
  const open=$(`#${kind}-folder-open`); if(open){ const fid=driveFolderId(url); open.href=fid?('https://drive.google.com/drive/folders/'+fid):url }
  try{
    if(status) status.textContent='Lendo pasta pública do Drive...'
    const {entries}=await fetchDriveFolder(url)
    renderDriveFolderEntries(kind, entries)
  }catch(e){
    if(status) status.textContent='Não foi possível importar automaticamente ('+(e.message||'erro')+'). Abra a pasta, copie o link público do arquivo e cole no botão Publicar.'
  }
}
function importDriveFolderLinks(kind){
  const ta=$(`#${kind}-folder-links`), status=$(`#${kind}-folder-status`)
  const lines=String(ta?.value||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean)
  if(!lines.length){ if(status) status.textContent='Cole ao menos um link.'; return }
  const entries=[]
  for(const raw of lines){
    const fileM=raw.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) || raw.match(/[?&]id=([a-zA-Z0-9_-]+)/)
    const folderM=raw.match(/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/)
    const id=folderM?.[1] || fileM?.[1] || ''
    const isFolder=!!folderM && /\/folders\//.test(raw)
    const nameGuess=decodeURIComponent((raw.split('/').pop()||'').split('?')[0]).replace(/[-_]+/g,' ').replace(/\.(zip|xex)$/i,'') || (id ? id.slice(0,12) : raw.slice(0,40))
    entries.push({id: id||raw, name:nameGuess, mime:isFolder?'application/vnd.google-apps.folder':'', url:raw})
  }
  renderDriveFolderEntries(kind, entries.map(e=>e.id && /^[a-zA-Z0-9_-]{10,}$/.test(e.id)?e:{...e, name:e.name, mime:e.mime, _rawUrl:e.url}))
}
$('#library-folder-import') && ($('#library-folder-import').onclick=()=>importDriveFolder('library'))
$('#updates-folder-import') && ($('#updates-folder-import').onclick=()=>importDriveFolder('updates'))
$('#library-folder-import-links') && ($('#library-folder-import-links').onclick=()=>importDriveFolderLinks('library'))
$('#updates-folder-import-links') && ($('#updates-folder-import-links').onclick=()=>importDriveFolderLinks('updates'))
$('#library-folder-url')?.addEventListener('change', e=>{ const fid=driveFolderId(e.target.value); const a=$('#library-folder-open'); if(a) a.href=fid?('https://drive.google.com/drive/folders/'+fid):e.target.value })
$('#updates-folder-url')?.addEventListener('change', e=>{ const fid=driveFolderId(e.target.value); const a=$('#updates-folder-open'); if(a) a.href=fid?('https://drive.google.com/drive/folders/'+fid):e.target.value })

document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close())
document.querySelectorAll('[data-game]').forEach(b=>b.onclick=()=>openPublish('game'))
document.querySelectorAll('.connectBtn').forEach(b=>b.onclick=()=>{location.hash='#conexao'})
$('#open-update').onclick=()=>openPublish('update'); const q=$('#query'); if(q) q.oninput=draw
window.addEventListener('hashchange',route)
fillSettings();draw();route();refresh()
try{ const t=localStorage.getItem('cards-studio-token'); if(t){ githubTokenMem=t; connect({...validate(config),token:t}).then(c=>{client=c;fillSettings();draw();refresh(true)}).catch(()=>{}) } }catch{}
setInterval(()=>{if(!document.hidden)refresh(true)},60000)
setInterval(()=>{if(!document.hidden && client && location.hash==='#ideias' && activeThread && !$('#thread textarea:focus'))openThread(activeThread,true)},12000)
