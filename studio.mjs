import { connect, loadPublic, readFeed } from './publisher.mjs'

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
settings.addEventListener('submit',async e=>{
  e.preventDefault();const button=e.submitter;button.disabled=true
  try{
    const data=Object.fromEntries(new FormData(settings))
    const publicConfig=validate({owner:data.owner.trim(),repo:data.repo.trim(),branch:data.branch.trim(),prefix:data.prefix.trim().replace(/^\/+|\/+$/g,''),baseUrl:data.baseUrl.trim()})
    const token=data.token.trim()
    const nextClient=token?await connect({...publicConfig,token}):null
    settings.elements.token.value=''
    config=publicConfig;client=nextClient;pending=null;activeThread=0;threadVersion++;threadStamp=''
    try{ localStorage.setItem('cards-studio-source',JSON.stringify(config)) }catch{}
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
  const release=src==='release', folder=src==='folder', file=src==='file'
  $('#release-source').hidden=!release
  $('#file-source').hidden=!file
  const fs=$('#folder-source'); if(fs) fs.hidden=!folder
  publish.elements.file.required=file&&!editing
  if(publish.elements.folder) publish.elements.folder.required=folder&&!editing
  publish.elements.assetId.required=release
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
    args.coverFile=publication==='game'?publish.elements.coverFile.files[0]:null
    const isGame=publication==='game';const next=isGame?await client.publishGame(args):await client.publishUpdate(args)
    ++readVersion;feed=next
    const entry=isGame?next.games.find(g=>g.slug===args.slug):next.update
    pending={slug:isGame?args.slug:'',value:JSON.stringify(entry),deadline:Date.now()+600000}
    draw();$('#publish-dialog').close();location.hash=isGame?'catalogo':'updates'
    feedback('Publicação salva no GitHub. A dash recebe a mudança depois que o Pages disponibilizar o catálogo.')
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
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close())
document.querySelectorAll('[data-game]').forEach(b=>b.onclick=()=>openPublish('game'))
document.querySelectorAll('.connectBtn').forEach(b=>b.onclick=askConnect)
$('#open-update').onclick=()=>openPublish('update');$('#query').oninput=draw
window.addEventListener('hashchange',route)
fillSettings();draw();route();refresh()
setInterval(()=>{if(!document.hidden)refresh(true)},60000)
setInterval(()=>{if(!document.hidden && client && location.hash==='#ideias' && activeThread && !$('#thread textarea:focus'))openThread(activeThread,true)},12000)
