# Cardápio em Feed

Cardápio digital que funciona como rede social: o cliente encosta o telemóvel (NFC) ou lê um QR e desliza num feed vertical, um prato por ecrã, com foto ou vídeo curto. Pede pelo prato e acompanha o pedido. O dono gere tudo num painel, com pedidos em tempo real.

Sem dependências npm. Só precisa de **Node.js 18 ou mais recente**.

## Arrancar

```bash
npm start            # ou: node backend/server.js 3001
```

No Windows: duplo clique em `iniciar.bat` (reinicia sozinho se o servidor parar).

| O quê | Onde |
|---|---|
| Cardápio do cliente | `http://localhost:3001/r/cafe-kutsakai?mesa=3` |
| Painel do dono | `http://localhost:3001/painel` |
| Conta de demonstração | `dono@kutsakai.mz` / `kutsakai123` (só com `DEMO_MODE` ligado) |

Testes: `npm test` (14 testes da API, incluindo isolamento entre restaurantes e segurança dos uploads).

## O que tem

**Cliente**
- Feed com scroll-snap, categorias que acompanham o scroll, foto ou vídeo por prato
- **5 temas:** Noite, Creme, Floresta, Brasa, Oceano (+ cor de destaque à escolha)
- Botão **Pedir**, bandeja, envio à cozinha com código do pedido, acompanhamento do estado e cancelamento nos primeiros 3 minutos
- Favoritos, partilha de um prato por link, esgotado, etiquetas (vegetariano, picante…)
- Funciona offline depois da primeira visita (PWA); vídeo só carrega quando está no ecrã e respeita "poupança de dados"
- Estatísticas por prato (vistas, tempo, favoritos, toques) enviadas ao servidor

**Painel**
- **Pedidos:** quadro Novos / Em preparo / Prontos em tempo real, aviso sonoro, ticket para impressora térmica
- **Métricas:** visualizações, pedidos e vendas por dia, funil, ranking de pratos, exportação CSV
- **Cardápio:** categorias, pratos, preços, esgotado/oculto, fotos e vídeos (as fotos são reduzidas antes de enviar), reordenar e duplicar
- **Mesas e QR:** link, QR e folha para imprimir por mesa, guia de gravação do NFC
- **Aparência:** escolha do tema com pré-visualização ao vivo, cor, boas-vindas, WhatsApp, Instagram, pedido mínimo
- **Conta:** alterar senha, link público

**Servidor**
- Multi-restaurante (cada um com o seu endereço `/r/<nome>`), registo e login com senha em scrypt
- API REST + SSE para tempo real, uploads validados pelo conteúdo real do ficheiro
- Limites de pedidos por IP, cabeçalhos de segurança (CSP), cópia diária automática da base de dados

## Estrutura

```
backend/server.js     API, ficheiros estáticos, tempo real
backend/db.js         base de dados JSON com gravação atómica e backups
backend/util.js       senhas, limites, validação
public/               cardápio (index.html, app.js, styles.css, themes.css, sw.js) e painel (painel.*)
data/seed-menu.json   cardápio inicial de cada novo restaurante
test/api.test.js      testes
Dockerfile, docker-compose.yml, Caddyfile   hospedagem com HTTPS
```

Dados em tempo de execução (ficam fora do git): `storage/db.json`, `storage/media/`, `storage/backups/`.

## Publicar

Ver **DEPLOY.md** (VPS com HTTPS automático, plataforma gerida ou túnel para testes) e `.env.example` para as variáveis.

## Subir para o GitHub

```bash
git init -b main
git add .
git commit -m "Cardápio em Feed: cliente, painel e backend"
gh repo create cardapio-feed --private --source=. --push
```

## Adicionar um tema

Em `public/themes.css`, copia um bloco `[data-theme="..."]`, muda as variáveis e acrescenta o tema em `THEMES` (`backend/server.js`), em `THEME_COLOR` (`public/app.js`) e na lista `THEMES` do `public/painel.js`.
