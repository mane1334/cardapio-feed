# Guia de Deploy: GitHub + Hospedagem + Cloudflare

Este guia explica como colocar o **Cardápio em Feed** no ar em ambiente de testes ou produção usando **GitHub** (código e automação), uma **plataforma na nuvem** (execução do Node.js + disco persistente) e **Cloudflare** (domínio, SSL e proteção).

---

## 1. Visão Geral da Arquitetura

O Cardápio em Feed é uma aplicação Node.js dinâmica completa:
- **Banco de dados local:** `storage/db.json` (pedidos, cardápios, métricas).
- **Uploads de mídia:** `storage/media/` (fotos e vídeos dos pratos).
- **Tempo real:** Conexão contínua por **Server-Sent Events (SSE)** em `/api/stream` para que os pedidos cheguem ao painel do dono instantaneamente com som de notificação.

```mermaid
flowchart LR
    Cliente([Cliente / Dono]) -->|HTTPS| CF[Cloudflare\nDNS + Proxy + SSL]
    CF -->|Tráfego Web + SSE| Host[Hospedagem Node.js\nRender / Railway / VPS]
    Host --> Disk[(Disco Persistente\ndb.json + media/)]
    GitHub[GitHub Repo] -->|Deploy Automático| Host
```

> [!IMPORTANT]
> **Por que não Cloudflare Pages puro?**
> O Cloudflare Pages é otimizado para sites estáticos. Como o cardápio precisa de um servidor Node.js ativo gravando em disco (`db.json` e fotos) e mantendo conexões SSE abertas, o backend precisa rodar numa plataforma com suporte a Node.js e disco persistente. O **Cloudflare entra na frente**, cuidando do DNS, proteção contra DDoS, CDN e certificado SSL.

---

## 2. Passo 1 — Subir o Código para o GitHub

O código já possui o arquivo `.gitignore` configurado para não subir fotos locais nem senhas (`storage/` e `.env`).

### 1. Criar e enviar para o GitHub via terminal:
```bash
# 1. Adicionar os ficheiros
git add .

# 2. Criar o primeiro commit
git commit -m "feat: versão inicial do cardapio-feed pronta para deploy"

# 3. Criar o repositório no GitHub (privado ou público) e fazer push:
# Exemplo com GitHub CLI (gh):
gh repo create cardapio-feed --private --source=. --remote=origin --push
```

*(Se preferir criar pelo site do GitHub, crie um novo repositório vazio e siga as instruções para adicionar o `origin` e fazer `git push -u origin main`).*

---

## 3. Passo 2 — Hospedar a Aplicação (Opções de Teste / Produção)

Escolha a plataforma de sua preferência para rodar o Node.js:

### Opção 1: Render (Recomendado para Testes e Produção)
O [Render](https://render.com) possui conexão direta com o GitHub e suporta discos persistentes.

1. Crie uma conta no [Render](https://render.com) e conecte sua conta GitHub.
2. Clique em **New +** → **Web Service**.
3. Selecione o repositório `cardapio-feed`.
4. Configure os campos:
   - **Name:** `cardapio-feed` (ou o nome que preferir).
   - **Environment:** `Node` (ou `Docker` usando o `Dockerfile` do projeto).
   - **Branch:** `main`.
   - **Build Command:** *(deixe em branco ou `echo "Sem build necessário"`)*.
   - **Start Command:** `node backend/server.js`.
5. **Variáveis de Ambiente (Environment Variables):**
   - `PORT`: `3001` *(ou a porta padrão informada pelo Render, o servidor já detecta `process.env.PORT`)*
   - `DEMO_MODE`: `off` *(ou `on` se quiser dados de exemplo durante os testes)*
   - `TRUST_PROXY`: `1` *(obrigatório para que o IP do cliente passe corretamente pelo Cloudflare/Render)*
   - `TZ_OFFSET_MIN`: `120` *(para fuso horário de Moçambique UTC+2, ou ajuste conforme sua região)*
   - `DATA_DIR`: `/data`
6. **Disco Persistente (Disks) — CRÍTICO:**
   - Vá na seção **Disks** do serviço no Render.
   - Adicione um disco:
     - **Name:** `cardapio-dados`
     - **Mount Path:** `/data`
     - **Size:** `1 GB` (suficiente para testes; expanda conforme necessário).
7. Clique em **Deploy Web Service**. O Render gerará uma URL como `cardapio-feed.onrender.com`.

---

### Opção 2: Railway ou Fly.io
1. Conecte o repositório GitHub.
2. Como o projeto já possui um [Dockerfile](file:///c:/Users/maneb/Desktop/cardapio-feed/Dockerfile), a plataforma detectará e fará o build automaticamente.
3. Crie um **Volume** montado em `/data` e defina `DATA_DIR=/data`.
4. Defina as variáveis `TRUST_PROXY=1`, `DEMO_MODE=off`, `TZ_OFFSET_MIN=120`.

---

### Opção 3: VPS Própria (Hetzner / DigitalOcean / Contabo) com Docker
Se tiver uma VPS:
1. Instale o Docker (`curl -fsSL https://get.docker.com | sh`).
2. Clone o repositório: `git clone <url-do-repo> && cd cardapio-feed`.
3. Configure o `.env` a partir do `.env.example`.
4. Inicie com: `docker compose up -d --build`.

---

## 4. Passo 3 — Configurar o Cloudflare

Agora que a aplicação está rodando na nuvem, configure o Cloudflare para gerenciar seu domínio e fornecer SSL HTTPS.

### 1. Criar o Registo DNS
1. Acesse o painel do [Cloudflare](https://dash.cloudflare.com/) e selecione seu domínio.
2. Vá em **DNS** → **Records** → **Add record**.
3. Preencha:
   - **Type:** `CNAME`
   - **Name:** `cardapio` (para `cardapio.seudominio.com`) ou `@` (para o domínio raiz).
   - **Target:** O endereço gerado pela sua hospedagem (ex: `cardapio-feed.onrender.com`).
   - **Proxy status:** **Proxied** (ícone da nuvem laranja ativado).
4. Clique em **Save**.

---

### 2. Configurar SSL/TLS no Cloudflare
1. No menu lateral, acesse **SSL/TLS**.
2. No modo de criptografia, selecione:
   - **Full** ou **Full (strict)**.
   > [!WARNING]
   > Não utilize o modo "Flexible", pois plataformas como Render já usam HTTPS internamente, e o modo Flexible causará o erro de loop infinito `ERR_TOO_MANY_REDIRECTS`.

---

### 3. Regras para Tempo Real (SSE) e Cache
O painel do dono usa Server-Sent Events (`/api/stream`) para receber os pedidos em tempo real. O Cloudflare precisa deixar esses dados passarem sem reter em buffer.

1. **WebSockets e Streaming:**
   - Em **Network**, certifique-se de que **WebSockets** está **On** (ativado por padrão).
2. **Ignorar Cache nas APIs e Painel:**
   - Vá em **Caching** → **Cache Rules** (ou **Page Rules**).
   - Crie uma regra:
     - **If incoming requests match:** URI Path contains `/api/`
     - **Then Cache Eligibility:** **Bypass cache**
   - *(Opcional)* Crie outra regra para `/painel` se não desejar nenhum cache HTML do painel administrativo.

---

## 5. Alternativa Gratuita para Testes: Cloudflare Tunnel

Se você não quer pagar por servidor na nuvem durante a fase de testes e quer rodar no seu próprio PC ou num computador local com o seu domínio do Cloudflare:

1. Baixe o executável do **cloudflared**:
   [Instruções oficiais da Cloudflare](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
2. Inicie a app localmente:
   - No Windows: execute `iniciar.bat` ou `node backend/server.js 3001`
3. Execute o túnel:
   - **Teste rápido temporário:**
     ```bash
     cloudflared tunnel --url http://localhost:3001
     ```
     O Cloudflare gerará um endereço `https://xxxx.trycloudflare.com` acessível de qualquer telemóvel com HTTPS.
   - **Túnel associado ao seu domínio:**
     Crie um túnel no painel **Cloudflare Zero Trust** → **Access** → **Tunnels** apontando para `http://localhost:3001`.

---

## 6. Checklist Pós-Deploy

- [ ] Acesse `https://seu-dominio/health` e confirme resposta `{"ok":true}`
- [ ] Crie a conta do dono em `https://seu-dominio/painel#registo`
- [ ] No `.env` ou variáveis da plataforma, defina `REGISTRATION=off` após criar as contas necessárias
- [ ] Faça um pedido de teste no cardápio de uma mesa e verifique se o painel recebe o alerta sonoro instantaneamente
- [ ] Imprima os QR Codes das mesas ou teste gravando tags NFC com o link `https://seu-dominio/r/<slug>?m=<numero>`

