# Cardápio em Feed — registo de progresso

> Atualizar sempre que uma funcionalidade for concluída.

## 1. Ideia
Cardápio digital estilo rede social: o cliente encosta o telemóvel (NFC) ou lê um QR e desliza num feed vertical, um prato por ecrã, com foto ou vídeo curto, preço, favoritos e categorias. Pede pelo prato. O dono gere tudo num painel com login, pedidos em tempo real e métricas.

## 2. Estado atual (v1.0)
- **Cliente** (`public/index.html`, `app.js`, `styles.css`, `themes.css`): feed, chips de categoria, favoritos, partilha, vídeo automático, Pedir + bandeja + acompanhamento do pedido, PWA offline.
- **5 temas:** Noite, Creme, Floresta, Brasa, Oceano. Cada restaurante escolhe o seu e uma cor de destaque. Pré-visualização com `?theme=`.
- **Painel** (`public/painel.*`): Pedidos, Métricas, Cardápio, Mesas e QR, Aparência, Conta.
- **Backend** (`backend/`): Node sem dependências, multi-restaurante, SSE, base JSON com gravação atómica e cópia diária.
- **Testes:** `npm test` → 14 testes de API (auth, pedidos, isolamento entre restaurantes, uploads, SSE, segurança) + teste manual de ponta a ponta no navegador (pedido do cliente → painel → métricas → editor → tema).
- **Hospedagem:** `Dockerfile`, `docker-compose.yml`, `Caddyfile` (HTTPS automático), `DEPLOY.md`, `iniciar.bat`.

## 3. Arquitetura
```
cliente ── POST /api/track (a cada 12 s) ──▶ server ── SSE /api/stream ──▶ painel
cliente ── POST /api/orders ───────────────▶ db.json ◀── /api/orders (auth) ─ painel
painel ── PUT /api/menu · /api/settings · POST /api/upload · /api/tables ─▶ db.json · media/
```
- Tokens aleatórios de 7 dias, guardados com hash SHA-256; senhas com scrypt.
- Cada restaurante tem `slug`: `/r/<slug>?mesa=<n>`.
- O servidor calcula sempre o preço e o total do pedido (nunca confia no cliente).
- Métricas por dia (`views`, `ms`, `favs`, `taps`) por prato; "a ver agora" por presença (45 s).

## 4. API
| Método | Rota | Auth | Descrição |
|---|---|---|---|
| POST | `/api/auth/register` | — | cria restaurante + dono + cardápio base |
| POST | `/api/auth/login` | — | `{email,password}` → `{token,user,restaurant}` |
| GET | `/api/auth/me` | Bearer | sessão atual |
| POST | `/api/auth/logout` | Bearer | termina a sessão |
| POST | `/api/auth/password` | Bearer | altera a senha e termina as outras sessões |
| GET | `/api/menu?slug=` | — | menu público (sem pratos ocultos) |
| GET | `/api/menu/full` | Bearer | menu completo para edição |
| PUT | `/api/menu` | Bearer | grava `{categories,dishes}` (validado) |
| PUT | `/api/settings` | Bearer | nome, tema, cor, boas-vindas, WhatsApp, Instagram, pedido mínimo… |
| POST | `/api/upload?kind=image\|video` | Bearer | corpo bruto → `{url}` (imagem ≤ 8 MB, vídeo ≤ 25 MB, tipo validado pelos bytes) |
| POST | `/api/track` | — | `{restaurantId,sessionId,events[]}` estatísticas + presença |
| GET | `/api/metrics?range=today\|7d\|30d\|all` | Bearer | totais, por prato, série diária, online |
| GET | `/api/stream?token=` | token | SSE: `orders` e `metrics` em tempo real |
| GET/POST/DELETE | `/api/tables` | Bearer | mesas |
| POST | `/api/orders` | — | novo pedido (valida prato, esgotado, mínimo) |
| GET | `/api/orders` | Bearer | pedidos das últimas 24 h |
| PATCH | `/api/orders/:id` | Bearer | `novo → preparo → pronto → entregue` ou `cancelado` |
| GET | `/api/myorders?restaurantId=&sessionId=` | — | pedidos do próprio cliente |
| POST | `/api/orders/:id/cancel` | sessão | cliente cancela nos primeiros 3 min, se ainda "novo" |
| GET | `/health` | — | estado do servidor |

## 5. Decisões
- Zero dependências no backend: corre em qualquer PC com Node, sem `npm install`.
- SSE em vez de WebSocket: simples e chega para o tempo real do painel.
- Uploads em corpo bruto (sem multipart); fotos reduzidas no navegador antes de enviar (poupa dados).
- Menu guardado dentro do restaurante em `db.json`; limites de 300 pratos e 30 categorias.
- Texto do utilizador nunca entra como HTML: o cliente e o painel usam `textContent`.
- QR gerado por `api.qrserver.com` (precisa de internet ao imprimir).

## 6. Por fazer
- Vários utilizadores por restaurante (cozinha, garçom) com permissões.
- Pagamento M-Pesa / e-Mola no pedido e cobrança de mensalidade aos restaurantes.
- Recuperação de senha por email.
- Migrar de JSON para SQLite/PostgreSQL acima de algumas dezenas de restaurantes.
- Armazenamento de media em S3/R2 e miniaturas geradas no servidor.
- Variantes e extras por prato (tamanho, adicionais), horário por prato, idiomas PT/EN.
- Painel do dono do SaaS (`/admin`) para gerir restaurantes e planos.
- Manifest PWA por restaurante (hoje o "instalar" abre a raiz).
