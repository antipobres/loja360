import { connect, loadPublic, readFeed, hash, zipFiles, isXex, isZip } from './publisher.mjs'

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
  document.querySelectorAll('.connection-label').forEach(x => x.textContent = client ? 'GitHub conectado' : 'Conectar GitHub')
  $('.connectBtn').classList.toggle('connected',!!client)
}
function feedback(text='',error=false){const el=$('#feedback');el.textContent=text;el.hidden=!text;el.dataset.error=String(error)}
function route(){
  const key=location.hash.slice(1) in names ? location.hash.slice(1) : 'inicio'
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
    const filtered=editable && $('#query').value.trim()
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
  const q=norm($('#query').value.trim())
  const filtered=feed.games.filter(g=>norm([g.title,g.genre,g.description].join(' ')).includes(q))
  listGames($('#catalog-list'),filtered,true)
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
  }catch(e){if(!silent && version===readVersion) feedback('Catálogo indisponível. '+e.message,true)}
}
function requireClient(){
  if(client)return true
  location.hash='conexao';feedback('Conecte a conta do GitHub para publicar neste repositório.');return false
}
function askConnect(){location.hash='conexao'}
const VAULT_KEY='cards-studio-vault'
const te=new TextEncoder(), td=new TextDecoder()
const b64e=b=>btoa(String.fromCharCode(...new Uint8Array(b)))
const b64d=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0))
let vaultMemKey=null, githubTokenMem=''
async function vaultDerive(pass,salt){
  const base=await crypto.subtle.importKey('raw',te.encode(pass),'PBKDF2',false,['deriveKey'])
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:120000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])
}
function vaultStatus(t){ const el=$('#vault-status'); if(el) el.textContent=t }
function vaultData(){ return {config, token: settings.elements.token.value.trim() || githubTokenMem || '', driveClientId: drive.clientId || ''} }
async function vaultPersist(){
  if(!vaultMemKey) return
  const iv=crypto.getRandomValues(new Uint8Array(12))
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},vaultMemKey,te.encode(JSON.stringify(vaultData())))
  const blob=JSON.parse(localStorage.getItem(VAULT_KEY)||'{}')
  blob.v=1; blob.iv=b64e(iv); blob.ct=b64e(ct)
  localStorage.setItem(VAULT_KEY, JSON.stringify(blob))
  vaultStatus('Cofre salvo (criptografado).')
}
async function vaultUnlock(pass){
  const blobStr=localStorage.getItem(VAULT_KEY)
  if(!blobStr){
    const salt=crypto.getRandomValues(new Uint8Array(16))
    vaultMemKey=await vaultDerive(pass,salt)
    localStorage.setItem(VAULT_KEY, JSON.stringify({v:1,salt:b64e(salt)}))
    await vaultPersist()
    vaultStatus('Cofre criado e desbloqueado.')
    return
  }
  try{
    const o=JSON.parse(blobStr)
    vaultMemKey=await vaultDerive(pass,b64d(o.salt))
    if(o.ct && o.iv){
      const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64d(o.iv)},vaultMemKey,b64d(o.ct))
      const data=JSON.parse(td.decode(pt))
      if(data.config) config = { ...config, ...data.config }
      if(data.driveClientId) { drive.clientId=data.driveClientId; const di=$('#drive-client-id'); if(di) di.value=drive.clientId; try{localStorage.setItem('cards-drive-client-id',drive.clientId)}catch{} }
      fillSettings(); draw()
      if(data.token){
        githubTokenMem=data.token
        try{ client=await connect({ ...validate(config), token:data.token }); feedback('Cofre desbloqueado e GitHub conectado.') }
        catch(e){ client=null; feedback('Cofre desbloqueado, mas token GitHub falhou: '+e.message, true) }
      } else { client=null; feedback('Cofre desbloqueado.') }
    }
    await vaultPersist()
    vaultStatus('Desbloqueado.')
  }catch(e){ vaultMemKey=null; vaultStatus('Senha incorreta ou cofre inválido.') }
}
$('#vault-form')?.addEventListener('submit', async e=>{ e.preventDefault(); const pass=$('#vault-pass').value; if(!pass){ vaultStatus('Digite uma senha.'); return } await vaultUnlock(pass) })
$('#vault-lock')?.addEventListener('click', ()=>{ vaultMemKey=null; githubTokenMem=''; client=null; settings.elements.token.value=''; drive.token=null; drive.expires=0; vaultStatus('Bloqueado.'); fillSettings(); draw(); feedback('Sessão bloqueada.') })

settings.addEventListener('submit',async e=>{
  e.preventDefault();const button=e.submitter;button.disabled=true
  try{
    const data=Object.fromEntries(new FormData(settings))
    const publicConfig=validate({owner:data.owner.trim(),repo:data.repo.trim(),branch:data.branch.trim(),prefix:data.prefix.trim().replace(/^\/+|\/+$/g,''),baseUrl:data.baseUrl.trim()})
    const token=data.token.trim()
    const nextClient=token?await connect({...publicConfig,token}):null
    if(token) githubTokenMem=token
    settings.elements.token.value=''
    config=publicConfig;client=nextClient;pending=null;activeThread=0;threadVersion++;threadStamp=''
    try{ localStorage.setItem('cards-studio-source',JSON.stringify(config)) }catch{}
    if(vaultMemKey) await vaultPersist()
    feed=emptyFeed();fillSettings();draw();feedback(client?'GitHub conectado. Você já pode publicar.':'Endereço salvo. Você já pode gerar o arquivo do Xbox.')
    await refresh(true)
  }catch(err){feedback(err.message,true)}finally{button.disabled=false}
})
$('#disconnect').onclick=()=>{client=null;activeThread=0;threadVersion++;threadStamp='';settings.elements.token.value='';fillSettings();draw();feedback('Conta desconectada.');$('#thread').replaceChildren(node('h2','Selecione uma ideia'))}
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
  $('#file-label').textContent=isGame?(editing?'Novo pacote (.xex/.zip) • deixe vazio para manter o atual':'Pacote do jogo (.xex ou .zip)'):'Pacote da dashboard (.zip com todos os arquivos, ou .xex)'
  const fl=$('#folder-label'); if(fl) fl.textContent=isGame?'Pasta do jogo (será empacotada em .zip)':'Pasta completa da dash (será empacotada em .zip)'
  $('#publish-submit').textContent=isGame?'Publicar no catálogo':'Publicar atualização automática'
  $('#release-link').href='https://github.com/'+config.owner+'/'+config.repo+'/releases'
  $('#publish-result').textContent='';toggleSource(false);$('#publish-dialog').showModal()
}
function toggleSource(fetchAssets=true){
  const src=publish.elements.source.value
  const release=src==='release', folder=src==='folder', file=src==='file', url=src==='url'
  $('#release-source').hidden=!release
  $('#file-source').hidden=!file
  const fs=$('#folder-source'); if(fs) fs.hidden=!folder
  const us=$('#url-source'); if(us) us.hidden=!url
  publish.elements.file.required=file&&!editing
  if(publish.elements.folder) publish.elements.folder.required=folder&&!editing
  publish.elements.assetId.required=release
  if(publish.elements.externalUrl) publish.elements.externalUrl.required=url
  if(publish.elements.externalSha) publish.elements.externalSha.required=url
  if(publish.elements.externalSize) publish.elements.externalSize.required=url
  if(release&&fetchAssets)loadAssets()
}
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
publish.elements.source.onchange=toggleSource;$('#reload-assets').onclick=loadAssets
publish.onsubmit=async e=>{
  e.preventDefault();const b=$('#publish-submit');b.disabled=true
  try{
    const args=Object.fromEntries(new FormData(publish));args.onProgress=t=>$('#publish-result').textContent=t
    args.file=args.source==='file'?publish.elements.file.files[0]:null
    args.files=args.source==='folder'?Array.from(publish.elements.folder.files||[]):null
    args.assetId=args.source==='release'?args.assetId:null
    args.externalUrl=args.source==='url'?args.externalUrl:null
    args.externalSha=args.source==='url'?args.externalSha:null
    args.externalSize=args.source==='url'?args.externalSize:null
    args.coverFile=publication==='game'?publish.elements.coverFile.files[0]:null

    // Drive-first: if Drive connected and local file/folder, upload to Drive automatically
    const isLocal = args.source==='file' || args.source==='folder'
    if(isLocal && drive.token && Date.now() < drive.expires){
      const PART_THRESHOLD = 256 * 1024 * 1024
      let name='package.zip'
      let totalSha='', totalSize=0, parts=[]
      if(args.source==='folder'){
        const folderFiles = args.files.filter(f=>f && f.size>=0)
        args.onProgress?.('Empacotando pasta em .zip…')
        const mapped = folderFiles.map(f => ({ path: f.webkitRelativePath || f.name, arrayBuffer: () => f.arrayBuffer() }))
        const bytes = await zipFiles(mapped, args.onProgress)
        name = (args.slug || args.title || 'package').replace(/[^a-z0-9_-]+/gi,'-').replace(/^-|-$/g,'') + '.zip'
        totalSize = bytes.length
        args.onProgress?.('Calculando SHA-256…')
        totalSha = await hash(bytes)
        if(bytes.length > PART_THRESHOLD){
          // split bytes into parts
          const partCount = Math.ceil(bytes.length / PART_THRESHOLD)
          let off = 0
          for(let i=0;i<partCount;i++){
            const end = Math.min(off+PART_THRESHOLD, bytes.length)
            const chunk = bytes.slice(off, end)
            const psha = await hash(chunk)
            const up = await driveUploadBytes(`${name}.part${i}`, chunk, 'application/octet-stream', (t)=>args.onProgress?.(`Parte ${i+1}/${partCount}: ${t}`))
            parts.push({ url: up.url, sha256: psha, size: chunk.length })
            off = end
          }
        } else {
          const up = await driveUploadBytes(name, bytes, 'application/octet-stream', args.onProgress)
          args.externalUrl = up.url
        }
      } else {
        const f = args.file
        if(!f) throw new Error('Selecione um arquivo.')
        const head = new Uint8Array(await f.slice(0,4).arrayBuffer())
        const zip = isZip(head), xex = isXex(head)
        if(!zip && !xex) throw new Error('Envie um .xex válido ou um pacote .zip.')
        const ext = zip ? '.zip' : '.xex'
        name = (f.name || ('package'+ext)).replace(/[^\w.\-]+/g,'_')
        totalSize = f.size
        if(f.size > PART_THRESHOLD){
          const r = await driveUploadFileInParts(f, name, PART_THRESHOLD, args.onProgress)
          totalSha = r.sha256; totalSize = r.size; parts = r.parts
        } else {
          args.onProgress?.('Lendo arquivo e calculando SHA-256…')
          const bytes = new Uint8Array(await f.arrayBuffer())
          totalSha = await hash(bytes)
          const up = await driveUploadBytes(name, bytes, 'application/octet-stream', args.onProgress)
          args.externalUrl = up.url
        }
      }
      if(parts.length){
        // use first part url as main url for backward compat, include parts
        args.externalUrl = parts[0].url
        args.parts = parts
      }
      args.source = 'url'
      args.externalSha = totalSha
      args.externalSize = String(totalSize)
      args.file = null; args.files = null
      args.onProgress?.('Arquivo no Drive. Publicando no catálogo…')
    }

    const isGame=publication==='game';const next=isGame?await client.publishGame(args):await client.publishUpdate(args)
    ++readVersion;feed=next
    const entry=isGame?next.games.find(g=>g.slug===args.slug):next.update
    pending={slug:isGame?args.slug:'',value:JSON.stringify(entry),deadline:Date.now()+600000}
    draw();$('#publish-dialog').close();location.hash=isGame?'catalogo':'updates'
    feedback('Publicação salva. Arquivo no Drive e feed atualizado no GitHub.')
  }catch(err){$('#publish-result').textContent=err.message}finally{b.disabled=false}
}
function clean(text){return text.replace(/<!--\s*\/?dash:[\s\S]*?-->/g,'').trim()}
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
// --- Google Drive OAuth 2.0 (PKCE) ---
const drive = { token:null, expires:0, clientId: localStorage.getItem('cards-drive-client-id') || '654689610968-fe4ho0kk0ppm8gnvuq0tookk9llrkobd.apps.googleusercontent.com' }
const driveStatus = (t)=>{ const el=$('#drive-status'); if(el) el.textContent=t }
const b64url = (buf)=>btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
async function pkce(){
  const v = crypto.getRandomValues(new Uint8Array(64)); const verifier=b64url(v)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: b64url(digest) }
}
function driveRedirect(){ return location.origin + location.pathname }
function saveDriveClientId(){ drive.clientId = ($('#drive-client-id')?.value || '').trim(); try{ localStorage.setItem('cards-drive-client-id', drive.clientId) }catch{} }
async function driveConnect(){
  saveDriveClientId()
  if(!drive.clientId) { driveStatus('Informe o Google OAuth Client ID.'); return }
  const {verifier, challenge} = await pkce()
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)))
  sessionStorage.setItem('drive_pkce_verifier', verifier)
  sessionStorage.setItem('drive_pkce_state', state)
  const params = new URLSearchParams({
    client_id: drive.clientId, redirect_uri: driveRedirect(), response_type:'code',
    scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly',
    access_type:'online', include_granted_scopes:'true', state, code_challenge:challenge, code_challenge_method:'S256', prompt:'consent'
  })
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString()
}
async function driveExchange(code){
  const verifier = sessionStorage.getItem('drive_pkce_verifier') || ''
  const body = new URLSearchParams({ client_id: drive.clientId, grant_type:'authorization_code', code, redirect_uri: driveRedirect(), code_verifier: verifier })
  const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body })
  const j = await r.json()
  if(!r.ok) throw new Error(j.error_description || j.error || 'Falha OAuth')
  drive.token = j.access_token; drive.expires = Date.now() + (j.expires_in||3600)*1000
  sessionStorage.removeItem('drive_pkce_verifier'); sessionStorage.removeItem('drive_pkce_state')
  driveStatus('Google Drive conectado.')
}
async function driveHandleCallback(){
  const p = new URLSearchParams(location.search)
  const code = p.get('code'), state = p.get('state'), err = p.get('error')
  if(err) { driveStatus('OAuth erro: '+err); return }
  if(!code) return
  const expected = sessionStorage.getItem('drive_pkce_state')
  if(expected && state !== expected) { driveStatus('Estado OAuth inválido.'); return }
  try { await driveExchange(code) } catch(e){ driveStatus(e.message) }
  history.replaceState({}, document.title, location.pathname + location.hash)
}
function driveAuthHeader(){ if(!drive.token || Date.now()>=drive.expires) throw new Error('Conecte o Google Drive novamente.'); return { Authorization: 'Bearer ' + drive.token } }
async function driveMakePublic(fileId){
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`, {
    method:'POST', headers:{ ...driveAuthHeader(), 'Content-Type':'application/json' },
    body: JSON.stringify({ role:'reader', type:'anyone' })
  })
  if(!r.ok){ let msg='Falha ao tornar arquivo público'; try{ const j=await r.json(); msg=j.error?.message||msg }catch{} throw new Error(msg) }
}
function driveDirectUrl(fileId){ return `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}` }
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

async function driveUploadFileResumable(file, name, mime='application/octet-stream', onProgress){
  const size = file.size
  const startRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size', {
    method:'POST', headers:{ ...driveAuthHeader(), 'Content-Type':'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify({ name })
  })
  if(!startRes.ok){ let msg='Falha ao iniciar upload no Drive'; try{ const j=await startRes.json(); msg=j.error?.message||msg }catch{} throw new Error(msg) }
  const sessionUrl = startRes.headers.get('Location')
  if(!sessionUrl) throw new Error('Drive não retornou sessão de upload.')
  const chunkSize = 8 * 1024 * 1024
  let offset = 0, result = null
  while(offset < size){
    const end = Math.min(offset + chunkSize, size)
    const chunk = await file.slice(offset, end).arrayBuffer()
    onProgress?.(`Enviando para o Drive… ${Math.round(end/size*100)}%`)
    const r = await fetch(sessionUrl, { method:'PUT', headers:{ 'Content-Length': String(end-offset), 'Content-Range': `bytes ${offset}-${end-1}/${size}` }, body: chunk })
    if(r.status === 308){ offset = end; continue }
    if(!r.ok){ let msg='Falha no upload do Drive'; try{ const j=await r.json(); msg=j.error?.message||msg }catch{} throw new Error(msg) }
    try{ result = await r.json() }catch{ result = { id: null } }
    offset = end
  }
  if(!result?.id) throw new Error('Upload no Drive concluído sem ID.')
  onProgress?.('Tornando arquivo público no Drive…')
  await driveMakePublic(result.id)
  return { id: result.id, name: result.name || name, url: driveDirectUrl(result.id), size }
}
async function driveUploadFileInParts(file, baseName, partSize, onProgress){
  const totalSize = file.size
  const totalHash = sha256Init()
  const parts = []
  const partCount = Math.ceil(totalSize / partSize)
  for(let i=0, offset=0; offset < totalSize; i++){
    const end = Math.min(offset + partSize, totalSize)
    const blob = file.slice(offset, end)
    // hash part
    const ph = sha256Init()
    const step = 4 * 1024 * 1024
    for(let o=0; o<blob.size; o+=step){
      const chunk = new Uint8Array(await blob.slice(o, Math.min(o+step, blob.size)).arrayBuffer())
      sha256Push(ph, chunk); sha256Push(totalHash, chunk)
    }
    const partSha = sha256Finish(ph)
    const partName = `${baseName}.part${i}`
    onProgress?.(`Enviando parte ${i+1}/${partCount} para o Drive…`)
    const up = await driveUploadFileResumable(new File([blob], partName, {type:'application/octet-stream'}), partName, 'application/octet-stream', (t)=>onProgress?.(`Parte ${i+1}/${partCount}: ${t}`))
    parts.push({ url: up.url, sha256: partSha, size: blob.size })
    offset = end
  }
  return { sha256: sha256Finish(totalHash), size: totalSize, parts }
}
async function driveUploadBytes(name, bytes, mime='application/octet-stream', onProgress){
  // Resumable upload for reliability/large files
  const size = bytes.byteLength || bytes.length
  const startRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size', {
    method:'POST', headers:{ ...driveAuthHeader(), 'Content-Type':'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size) },
    body: JSON.stringify({ name })
  })
  if(!startRes.ok){ let msg='Falha ao iniciar upload no Drive'; try{ const j=await startRes.json(); msg=j.error?.message||msg }catch{} throw new Error(msg) }
  const sessionUrl = startRes.headers.get('Location')
  if(!sessionUrl) throw new Error('Drive não retornou sessão de upload.')
  const chunkSize = 8 * 1024 * 1024 // 8 MiB, multiple of 256 KiB
  let offset = 0
  let result = null
  while(offset < size){
    const end = Math.min(offset + chunkSize, size)
    const chunk = bytes.slice(offset, end)
    onProgress?.(`Enviando para o Drive… ${Math.round(end/size*100)}%`)
    const r = await fetch(sessionUrl, { method:'PUT', headers:{ 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${offset}-${end-1}/${size}` }, body: chunk })
    if(r.status === 308){ offset = end; continue }
    if(!r.ok){ let msg='Falha no upload do Drive'; try{ const j=await r.json(); msg=j.error?.message||msg }catch{} throw new Error(msg) }
    result = await r.json()
    offset = end
  }
  if(!result?.id) throw new Error('Upload no Drive concluído sem ID.')
  onProgress?.('Tornando arquivo público no Drive…')
  await driveMakePublic(result.id)
  return { id: result.id, name: result.name || name, url: driveDirectUrl(result.id), size }
}
async function driveList(){
  try{
    saveDriveClientId()
    const r = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,size,webViewLink,webContentLink)&q=trashed=false', { headers: driveAuthHeader() })
    const j = await r.json(); if(!r.ok) throw new Error(j.error?.message || 'Falha ao listar')
    const box=$('#drive-files'); box.replaceChildren()
    if(!j.files?.length){ box.textContent='Nenhum arquivo encontrado.'; return }
    for(const f of j.files){
      const row=node('div',null,'hint')
      const use=node('button','Usar no catálogo','outline'); use.type='button'
      use.onclick=()=>{
        const u=driveDirectUrl(f.id)
        navigator.clipboard?.writeText(u)
        const dlg=$('#publish-dialog')
        if(dlg?.open && publish.elements.source){
          publish.elements.source.value='url'; toggleSource(false)
          if(publish.elements.externalUrl) publish.elements.externalUrl.value=u
          if(publish.elements.externalSize && f.size) publish.elements.externalSize.value=String(f.size)
          if(publish.elements.externalSha) publish.elements.externalSha.focus()
          feedback('Link do Drive preenchido no diálogo. Informe o SHA-256 para publicar.')
        } else {
          openPublish('game')
          publish.elements.source.value='url'; toggleSource(false)
          if(publish.elements.externalUrl) publish.elements.externalUrl.value=u
          if(publish.elements.externalSize && f.size) publish.elements.externalSize.value=String(f.size)
          if(publish.elements.title && !publish.elements.title.value) publish.elements.title.value=f.name.replace(/\.(xex|zip)$/i,'')
          publish.elements.title?.dispatchEvent(new Event('input'))
          feedback('Arquivo do Drive selecionado. Preencha os dados e o SHA-256 para publicar.')
        }
      }
      row.append(node('div', `${f.name} (${f.size||'?'} bytes)`), use)
      box.append(row)
    }
  }catch(e){ driveStatus(e.message) }
}
async function driveUpload(){
  try{
    saveDriveClientId()
    const inp=$('#drive-upload-file'); const f=inp?.files?.[0]
    if(!f) { driveStatus('Selecione um arquivo para enviar.'); return }
    driveStatus('Enviando para o Drive...')
    const up = await driveUploadFileResumable(f, f.name, f.type || 'application/octet-stream', driveStatus)
    driveStatus('Enviado e público: '+up.name+' — '+up.url)
    await driveList()
  }catch(e){ driveStatus(e.message) }
}
if($('#drive-client-id')) $('#drive-client-id').value = drive.clientId
$('#drive-connect') && ($('#drive-connect').onclick=()=>driveConnect().catch(e=>driveStatus(e.message)))
$('#drive-disconnect') && ($('#drive-disconnect').onclick=()=>{ drive.token=null; drive.expires=0; driveStatus('Drive desconectado.') })
$('#drive-list') && ($('#drive-list').onclick=driveList)
$('#drive-upload') && ($('#drive-upload').onclick=driveUpload)
$('#pick-drive-file') && ($('#pick-drive-file').onclick=async ()=>{
  const box=$('#drive-picker'); if(!box) return; box.hidden=false; box.textContent='Carregando...'
  try{
    saveDriveClientId()
    const r = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,size)&q=trashed=false', { headers: driveAuthHeader() })
    const j = await r.json(); if(!r.ok) throw new Error(j.error?.message||'Falha ao listar')
    box.replaceChildren()
    if(!j.files?.length){ box.textContent='Nenhum arquivo no Drive.'; return }
    for(const f of j.files){
      const b=node('button', `${f.name} (${f.size||'?'} bytes)`, 'outline'); b.type='button'
      b.onclick=()=>{ if(publish.elements.externalUrl) publish.elements.externalUrl.value = driveDirectUrl(f.id); if(publish.elements.externalSize && f.size) publish.elements.externalSize.value=String(f.size); box.hidden=true; feedback('Arquivo do Drive selecionado. Informe o SHA-256.') }
      box.append(b)
    }
  }catch(e){ box.textContent=e.message }
})
driveHandleCallback()

document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close())
document.querySelectorAll('[data-game]').forEach(b=>b.onclick=()=>openPublish('game'))
document.querySelectorAll('.connectBtn').forEach(b=>b.onclick=askConnect)
$('#open-update').onclick=()=>openPublish('update');$('#query').oninput=draw
window.addEventListener('hashchange',route)
fillSettings();draw();route();refresh()
if(localStorage.getItem(VAULT_KEY)) vaultStatus('Cofre encontrado. Digite a senha para desbloquear.')
setInterval(()=>{if(!document.hidden)refresh(true)},60000)
setInterval(()=>{if(!document.hidden && client && location.hash==='#ideias' && activeThread && !$('#thread textarea:focus'))openThread(activeThread,true)},12000)
