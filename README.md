# Cards Studio / Dashboard Site

Site estático para publicar jogos, atualizações e ideias da dashboard Xbox 360.

## Deploy no GitHub Pages

1. Crie um repositório **público** no GitHub (ex.: `cards-studio`).
2. Copie o conteúdo desta pasta `update-site/` para a raiz do repositório (ou configure Pages para a pasta usada).
3. No GitHub: **Settings → Pages → Build and deployment**:
   - Source: **Deploy from a branch**
   - Branch: `main` (ou a sua) / **/(root)**
4. Aguarde o Pages publicar. A URL ficará algo como:
   - `https://SEU-USUARIO.github.io/cards-studio/`
5. Abra o site, vá em **Conexão**, preencha conta/repo/branch/pasta/endereço público.
6. Gere um token fine-grained no GitHub com permissão de **Contents: Read and write** e **Issues: Read and write** para esse repositório. Cole no painel para publicar.
7. Clique em **Baixar store-site.ini** e copie o arquivo para `assets/store-site.ini` na dashboard.

## O que o site publica

- `feed.ini`: catálogo de jogos e atualização da dash. A dashboard lê esse arquivo automaticamente.
- `media/*.xex` ou `media/*.zip`: jogos/pacotes publicados pelo painel. Você pode enviar **arquivo .xex/.zip** ou **pasta completa** (o site empacota em .zip automaticamente). Upload direto até 100 MiB; acima disso use Release do GitHub.
- Atualizações: envie um **.zip com todos os arquivos da dash** (ou .xex, quando aplicável).
- Ideias/chat: Issues do GitHub. O workflow `.github/workflows/dash-ideas.yml` pode responder com IA se `OPENAI_API_KEY` estiver configurado em **Settings → Secrets and variables → Actions**.

## Formato esperado pela dashboard

`assets/store-site.ini`:

```ini
url=https://SEU-USUARIO.github.io/cards-studio/feed.ini
```

A dashboard Windows verifica esse feed periodicamente e atualiza a Loja/pesquisa. Quando houver `[update]` no feed, ela usa esse manifesto para verificação de atualização.