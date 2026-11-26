# Loja 360 — site de publicação e catálogo

Painel para publicar **jogos**, **capas/fundos**, **atualizações da dashboard** e conversar com a **IA**, com um catálogo que a dashboard Xbox 360 lê via `feed.ini`.

O site funciona em três modos:

| Modo | Persistência | Quando usar |
| --- | --- | --- |
| **Servidor Node** (recomendado) | `data/catalog.json` no host | Salvar de verdade entre abas, navegadores e dispositivos. Também calcula SHA-256, importa pastas do Drive e serve capas. |
| **GitHub Pages** | `feed.ini` no repositório | Site estático público. Editar exige um token fine-grained no navegador. |
| **Local** | `localStorage` do navegador | Demonstração e testes rápidos, sem publicar em lugar nenhum. |

> O GitHub Pages sozinho **não** compartilha edições entre navegadores/dispositivos. Para isso use o servidor Node ou um token do GitHub no painel.

## Início rápido (local)

Requisitos: **Node.js 18+**. Não há dependências para instalar.

```powershell
cd update-site
npm start
```

Abra `http://127.0.0.1:8787/`. O painel detecta o servidor automaticamente e mostra “Servidor” como fonte do catálogo.

Para testar com uma pasta de dados separada e sem chave de administração:

```powershell
$env:DATA_DIR="$env:TEMP\loja360"
$env:PORT="8799"
node server.mjs
```

Para carregar um `.env` (Node 20.6+):

```powershell
node --env-file=.env server.mjs
```

## Servidor em produção

1. Copie a pasta `update-site/` para o host (VPS, Railway, Render, Fly.io, etc.).
2. Defina as variáveis de ambiente (veja `.env.example`):
   - `PUBLIC_BASE_URL=https://seu-dominio` — usado nas URLs de capa e do feed.
   - `ADMIN_TOKEN=uma-chave-forte` — obrigatória para editar em servidor público.
   - `DATA_DIR=/caminho/persistente` — monte um volume para não perder o catálogo.
   - `CORS_ORIGINS=https://antipobres.github.io,https://seu-dominio` — se o painel for servido de outro domínio.
3. Inicie com `node server.mjs` (ou `npm start`) atrás de HTTPS (nginx, Caddy, proxy da plataforma).
4. No painel, abra **Conexão → Servidor do catálogo**, informe `https://seu-dominio` e a `ADMIN_TOKEN`.
5. Baixe o `store-site.ini` e copie para `assets/store-site.ini` na dashboard.

O servidor bloqueia acesso direto a `server.mjs`, `data/`, `tests/`, `.env`, `.git` e `node_modules`. As capas ficam em `data/media/` e são servidas em `/media/...`.

### Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `8787` | Porta HTTP. |
| `HOST` | `0.0.0.0` | Interface de escuta. |
| `DATA_DIR` | `./data` | Catálogo, feed e mídia persistidos. |
| `PUBLIC_BASE_URL` | inferido da requisição | Base das URLs públicas. Use HTTPS em produção. |
| `ADMIN_TOKEN` | vazio | Chave `x-admin-token` para mutações. Vazio = sem proteção. |
| `CORS_ORIGINS` | mesma origem | Origens extras permitidas, separadas por vírgula. |
| `MAX_HASH_BYTES` | 20 GiB | Limite de download para SHA-256. |
| `ALLOW_PRIVATE_URLS` | `0` | Permite HTTP/localhost para testes locais. |
| `AI_API_KEY` | vazio | Ativa a IA externa compatível com OpenAI. |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Base do provedor. |
| `AI_MODEL` | `gpt-4o-mini` | Modelo usado no chat. |

## GitHub Pages (opcional)

1. Crie um repositório público e copie o conteúdo de `update-site/` para a raiz.
2. Em **Settings → Pages**, publique a branch `main` na raiz.
3. Abra `https://SEU-USUARIO.github.io/REPO/` e vá em **Conexão**.
4. Preencha conta, repositório, branch, pasta e endereço público.
5. Crie um token fine-grained com **Contents: Read and write** e **Issues: Read and write** e cole no painel. O token fica apenas no `localStorage`.
6. Publique um jogo/build e baixe o `store-site.ini`.

O modo GitHub grava o `feed.ini` no repositório e usa releases/limites do GitHub para arquivos grandes. O site publica capas e arquivos em `media/` quando cabem no limite direto; acima disso use Releases.

### Salvamento automático no GitHub Pages (sem configurar toda vez)

Se você quiser que o site já venha conectado, copie `site-config.example.json` para `site-config.json` e preencha com seu repo/token. O painel lê esse arquivo no boot e conecta automaticamente.

```json
{
  "github": {
    "owner": "SEU-USUARIO",
    "repo": "SEU-REPO",
    "branch": "main",
    "prefix": "",
    "baseUrl": "https://SEU-USUARIO.github.io/SEU-REPO/",
    "token": "ghp_SEU_TOKEN"
  }
}
```

**Aviso de segurança:** isso coloca o token no arquivo publicado. Qualquer pessoa que acessar o site/repo pode ver o token. Use só em repositório/site privado e com token fine-grained limitado a esse repositório. Se o repo for público, não use essa opção.

No modo GitHub você também pode enviar um `.zip`/`.xex` ou **uma pasta completa** de jogo/atualização no diálogo de publicação; o site empacota a pasta em `.zip` e calcula SHA-256/tamanho. No modo servidor, envie o pacote ao Google Drive e cole o link público — o servidor não recebe `.zip`/`.xex` grandes.

## Google Drive

O painel aceita links públicos de arquivo e de pasta:

- Pasta da biblioteca: `https://drive.google.com/drive/folders/1xNVtJi_8Rv48lANGjJBDjTBpmoZaPnvS?usp=sharing`
- Pasta de atualizações: `https://drive.google.com/drive/folders/1MDYFD_Q6WDB17Jn1YGVIyrOjDqpe6q8p?usp=sharing`

Com o servidor conectado, **Importar da pasta** lê a listagem pública no backend. Sem servidor, o navegador pode ser bloqueado por CORS; nesse caso cole os links diretos no campo “Ou cole links” ou publique pelo servidor.

O SHA-256 e o tamanho são calculados automaticamente:

- pelo servidor em `/api/hash` (recomendado; lida com a confirmação de arquivos grandes do Drive);
- pelo navegador em streaming quando o Drive permite CORS.

Os campos em **Avançado** só precisam ser preenchidos manualmente se ambos os caminhos falharem.

Formatos de link aceitos são normalizados para `https://drive.google.com/uc?export=download&confirm=t&id=...`.

## IA

O botão **IA** abre o chat. Sem `AI_API_KEY`, o assistente responde localmente com os dados do catálogo (jogos, build, instruções). Com a chave configurada no servidor, o backend chama um provedor compatível com OpenAI em `AI_BASE_URL/chat/completions`.

O assistente recebe um resumo do catálogo no prompt do sistema. Se o provedor falhar, a resposta cai automaticamente para o assistente local e o painel informa o erro.

## Dashboard Xbox 360

1. No painel, abra **Conexão → Atualizar a loja**.
2. Clique em **Baixar store-site.ini**.
3. Copie o arquivo para `assets/store-site.ini` na pasta da dashboard (ou grave no Xbox junto do executável).
4. Formato:

```ini
url=https://seu-dominio/feed.ini
```

A dashboard atualiza o feed:

- ao abrir a aba **Loja** (Windows e `port_xsdk`);
- periodicamente enquanto a loja está aberta.

O `feed.ini` gerado contém `[store]`, os jogos e, quando publicada, a seção `[update]` com `build`, `url`, `sha256` e `size`. O Windows/XSDK validam o SHA-256 e o tamanho antes de aplicar a atualização, por isso esses campos são mantidos no feed — o painel os calcula para você.

O pacote de atualização pode ser um `.zip` com **todos** os arquivos da dash ou um `.xex`. Use o mesmo número de build da compilação.

## API do servidor

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/api/health` | Estado, versão, IA configurada e URL do feed. |
| `GET` | `/api/catalog` | Catálogo atual. |
| `PUT/POST` | `/api/catalog` | Importa `{ games, update }` completo. |
| `POST` | `/api/games` | Cria/atualiza um jogo. |
| `PUT/PATCH` | `/api/games/:slug` | Edita, renomeia (`slug`/`newSlug`) ou remove capa/fundo. |
| `DELETE` | `/api/games/:slug` | Exclui um jogo. |
| `PUT` | `/api/update` | Publica ou edita a build da dashboard. |
| `DELETE` | `/api/update` | Remove a build publicada. |
| `POST` | `/api/hash` | `{ url }` → `{ sha256, size }`. |
| `POST` | `/api/media` | `{ name, dataUrl }` → URL da capa salva. |
| `GET` | `/api/folders/list?url=...` | Lista uma pasta pública do Drive. |
| `POST` | `/api/ai/chat` | `{ messages }` → `{ reply, source }`. |
| `GET` | `/feed.ini` | Feed gerado para a dashboard. |
| `GET` | `/store-site.ini` | `url=.../feed.ini` pronto para o Xbox. |

Mutações exigem `x-admin-token` quando `ADMIN_TOKEN` está definido.

## Testes

```powershell
npm test
npm run check
```

- `tests/publisher.test.mjs`: parsing/escrita do feed, concorrência, releases, capas e Issues.
- `tests/server.test.mjs`: catálogo, autenticação, hash, mídia, edição/renomeação/exclusão, Drive, feed, IA externa com mock OpenAI, fallback local, bloqueio de arquivos privados e persistência após reinício.

## Limitações e segurança

- **GitHub Pages estático não persiste edições entre dispositivos.** Use o servidor Node ou o modo GitHub com token.
- **Drive/CORS:** a importação de pasta pelo navegador pode falhar; o servidor resolve.
- **HTTPS:** produção deve usar HTTPS. `ALLOW_PRIVATE_URLS=1` é apenas para testes locais.
- **IA:** o chat não se conecta diretamente a este agente; ele usa o provedor configurado ou o assistente local.
- **Deploy no Xbox:** a atualização da dash depende de hardware/runtime real; valide o `feed.ini` e o pacote no console.
- **Chaves:** revogue tokens/chaves que já tenham sido expostos e nunca comite `.env` ou `data/`.
