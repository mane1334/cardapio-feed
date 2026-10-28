"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createApp } = require("../backend/server");
const { clearRateLimits } = require("../backend/util");

let app, base, dir;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function call(method, url, { token, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) payload = raw;
  else if (body !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(base + url, { method, headers: h, body: payload });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

async function register(name, email) {
  const r = await call("POST", "/api/auth/register", { body: { restaurantName: name, email, password: "senha-segura-1" } });
  assert.equal(r.status, 201, r.text);
  return { token: r.json.token, restaurant: r.json.restaurant };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cardapio-test-"));
  app = createApp({ dataDir: dir, demo: false });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registo, login e sessão", async () => {
  clearRateLimits();
  const a = await register("Café Teste", "teste@exemplo.mz");
  assert.equal(a.restaurant.slug, "cafe-teste");
  const bad = await call("POST", "/api/auth/login", { body: { email: "teste@exemplo.mz", password: "errada-errada" } });
  assert.equal(bad.status, 401);
  const ok = await call("POST", "/api/auth/login", { body: { email: "teste@exemplo.mz", password: "senha-segura-1" } });
  assert.equal(ok.status, 200);
  const me = await call("GET", "/api/auth/me", { token: ok.json.token });
  assert.equal(me.json.restaurant.name, "Café Teste");
  assert.equal((await call("GET", "/api/auth/me")).status, 401);
  assert.equal((await call("GET", "/api/auth/me", { token: "x".repeat(64) })).status, 401);
  const dup = await call("POST", "/api/auth/register", { body: { restaurantName: "Outro", email: "TESTE@exemplo.mz", password: "senha-segura-1" } });
  assert.equal(dup.status, 409);
  const weak = await call("POST", "/api/auth/register", { body: { restaurantName: "X", email: "x@exemplo.mz", password: "123" } });
  assert.equal(weak.status, 400);
});

test("bloqueia tentativas de login em excesso", async () => {
  clearRateLimits();
  let last;
  for (let i = 0; i < 10; i++) last = await call("POST", "/api/auth/login", { body: { email: "alvo@exemplo.mz", password: "qualquer-coisa" } });
  assert.equal(last.status, 429);
  clearRateLimits();
});

test("menu público esconde pratos ocultos; tema e definições validados", async () => {
  clearRateLimits();
  const a = await register("Menu Público", "menu@exemplo.mz");
  const full = await call("GET", "/api/menu/full", { token: a.token });
  const dishes = full.json.dishes;
  dishes[0].hidden = true;
  const put = await call("PUT", "/api/menu", { token: a.token, body: { categories: full.json.categories, dishes } });
  assert.equal(put.status, 200);
  const pub = await call("GET", "/api/menu?slug=menu-publico");
  assert.ok(!pub.json.dishes.some((d) => d.id === dishes[0].id));
  assert.equal((await call("PUT", "/api/settings", { token: a.token, body: { theme: "inexistente" } })).status, 400);
  assert.equal((await call("PUT", "/api/settings", { token: a.token, body: { accent: "vermelho" } })).status, 400);
  const s = await call("PUT", "/api/settings", { token: a.token, body: { theme: "oceano", accent: "#2de2c4", name: "Novo Nome" } });
  assert.equal(s.json.restaurant.settings.theme, "oceano");
  assert.equal(s.json.restaurant.name, "Novo Nome");
  assert.equal((await call("GET", "/api/menu?slug=nao-existe")).status, 404);
});

test("menu rejeita URLs perigosos e media de outro restaurante", async () => {
  clearRateLimits();
  const a = await register("Seguro A", "a@exemplo.mz");
  const full = (await call("GET", "/api/menu/full", { token: a.token })).json;
  full.dishes[0].image = "javascript:alert(1)";
  full.dishes[1].image = "/media/outroid123456/0123456789abcdef.png";
  full.dishes[2].image = "https://exemplo.com/foto.jpg";
  full.dishes[3].name = "<img src=x onerror=alert(1)>";
  const r = await call("PUT", "/api/menu", { token: a.token, body: { categories: full.categories, dishes: full.dishes } });
  assert.equal(r.status, 200);
  assert.equal(r.json.dishes[0].image, null);
  assert.equal(r.json.dishes[1].image, null);
  assert.equal(r.json.dishes[2].image, "https://exemplo.com/foto.jpg");
  // o texto fica guardado como texto: o painel e o cardápio usam textContent, nunca innerHTML
  assert.equal(r.json.dishes[3].name, "<img src=x onerror=alert(1)>");
  assert.equal((await call("PUT", "/api/menu", { token: a.token, body: { categories: [], dishes: [] } })).status, 400);
});

test("menu suporta múltiplos vídeos (até 2) e fotos (até 4) por prato para slide", async () => {
  clearRateLimits();
  const a = await register("Galeria Slide", "slide@exemplo.mz");
  const full = (await call("GET", "/api/menu/full", { token: a.token })).json;
  const d = full.dishes[0];
  d.images = [
    "https://exemplo.com/foto1.jpg",
    "https://exemplo.com/foto2.jpg",
    "https://exemplo.com/foto3.jpg",
    "https://exemplo.com/foto4.jpg",
    "https://exemplo.com/foto5-excesso.jpg"
  ];
  d.videos = [
    "https://exemplo.com/video1.mp4",
    "https://exemplo.com/video2.mp4",
    "https://exemplo.com/video3-excesso.mp4"
  ];
  const put = await call("PUT", "/api/menu", { token: a.token, body: { categories: full.categories, dishes: full.dishes } });
  assert.equal(put.status, 200);
  const saved = put.json.dishes[0];
  assert.equal(saved.images.length, 4);
  assert.equal(saved.videos.length, 2);
  assert.equal(saved.image, "https://exemplo.com/foto1.jpg");
  assert.equal(saved.video, "https://exemplo.com/video1.mp4");
});

test("uploads: valida o conteúdo real do ficheiro e serve com Range", async () => {
  clearRateLimits();
  const a = await register("Upload", "up@exemplo.mz");
  const fake = await call("POST", "/api/upload?kind=image", { token: a.token, raw: Buffer.from("<script>alert(1)</script>".padEnd(40, " ")), headers: { "Content-Type": "image/png" } });
  assert.equal(fake.status, 415);
  const asVideo = await call("POST", "/api/upload?kind=video", { token: a.token, raw: PNG, headers: { "Content-Type": "video/mp4" } });
  assert.equal(asVideo.status, 415);
  assert.equal((await call("POST", "/api/upload?kind=image", { raw: PNG })).status, 401);
  const ok = await call("POST", "/api/upload?kind=image", { token: a.token, raw: PNG, headers: { "Content-Type": "image/png" } });
  assert.equal(ok.status, 201);
  assert.match(ok.json.url, new RegExp(`^/media/${a.restaurant.id}/[a-f0-9]{16}\\.png$`));
  const file = await fetch(base + ok.json.url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "image/png");
  const part = await fetch(base + ok.json.url, { headers: { Range: "bytes=0-7" } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 8);
  const big = await call("POST", "/api/upload?kind=image", { token: a.token, raw: Buffer.alloc(9 * 1024 * 1024, 1), headers: { "Content-Type": "image/png" } });
  assert.equal(big.status, 413);
});

test("pedidos: preço vem do servidor, esgotado/oculto/mínimo validados", async () => {
  clearRateLimits();
  const a = await register("Pedidos", "ped@exemplo.mz");
  const rid = a.restaurant.id;
  const menu = (await call("GET", "/api/menu?slug=pedidos")).json;
  const dish = menu.dishes[0];

  const r = await call("POST", "/api/orders", { body: { restaurantId: rid, sessionId: "sess1", mesa: "5", items: [{ dishId: dish.id, qty: 2, price: 1 }] } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.order.total, dish.price * 2);
  assert.equal(r.json.order.status, "novo");
  assert.match(r.json.order.code, /^[A-Z2-9]{4}$/);

  assert.equal((await call("POST", "/api/orders", { body: { restaurantId: rid, sessionId: "s", items: [] } })).status, 400);
  assert.equal((await call("POST", "/api/orders", { body: { restaurantId: rid, sessionId: "s", items: [{ dishId: "nao-existe", qty: 1 }] } })).status, 409);
  assert.equal((await call("POST", "/api/orders", { body: { restaurantId: "naoexiste", sessionId: "s", items: [{ dishId: dish.id, qty: 1 }] } })).status, 404);

  const full = (await call("GET", "/api/menu/full", { token: a.token })).json;
  full.dishes[0].soldOut = true;
  await call("PUT", "/api/menu", { token: a.token, body: { categories: full.categories, dishes: full.dishes } });
  const out = await call("POST", "/api/orders", { body: { restaurantId: rid, sessionId: "s", items: [{ dishId: dish.id, qty: 1 }] } });
  assert.equal(out.status, 409);
  assert.match(out.json.error, /esgotado/);

  await call("PUT", "/api/settings", { token: a.token, body: { minOrder: 100000 } });
  const min = await call("POST", "/api/orders", { body: { restaurantId: rid, sessionId: "s", items: [{ dishId: menu.dishes[1].id, qty: 1 }] } });
  assert.equal(min.status, 400);
  await call("PUT", "/api/settings", { token: a.token, body: { minOrder: 0, orderingEnabled: false } });
  const off = await call("POST", "/api/orders", { body: { restaurantId: rid, sessionId: "s", items: [{ dishId: menu.dishes[1].id, qty: 1 }] } });
  assert.equal(off.status, 403);
});

test("pedidos: ciclo de estados, os meus pedidos e cancelamento só pelo dono da sessão", async () => {
  clearRateLimits();
  const a = await register("Ciclo", "ciclo@exemplo.mz");
  const rid = a.restaurant.id;
  const dish = (await call("GET", "/api/menu?slug=ciclo")).json.dishes[0];
  const o = (await call("POST", "/api/orders", { body: { restaurantId: rid, sessionId: "cliente-A", mesa: "2", items: [{ dishId: dish.id, qty: 1 }] } })).json.order;

  const list = await call("GET", "/api/orders", { token: a.token });
  assert.equal(list.json.orders.length, 1);
  const p = await call("PATCH", `/api/orders/${o.id}`, { token: a.token, body: { status: "preparo" } });
  assert.equal(p.json.order.status, "preparo");
  assert.equal((await call("PATCH", `/api/orders/${o.id}`, { token: a.token, body: { status: "voando" } })).status, 400);

  const mine = await call("GET", `/api/myorders?restaurantId=${rid}&sessionId=cliente-A`);
  assert.equal(mine.json.orders[0].status, "preparo");
  assert.ok(!("sessionId" in mine.json.orders[0]), "não expõe a sessão");
  assert.equal((await call("GET", `/api/myorders?restaurantId=${rid}&sessionId=cliente-B`)).json.orders.length, 0);

  const o2 = (await call("POST", "/api/orders", { body: { restaurantId: rid, sessionId: "cliente-A", items: [{ dishId: dish.id, qty: 1 }] } })).json.order;
  assert.equal((await call("POST", `/api/orders/${o2.id}/cancel`, { body: { sessionId: "cliente-B" } })).status, 404);
  assert.equal((await call("POST", `/api/orders/${o2.id}/cancel`, { body: { sessionId: "cliente-A" } })).json.order.status, "cancelado");
  assert.equal((await call("POST", `/api/orders/${o.id}/cancel`, { body: { sessionId: "cliente-A" } })).status, 409, "já em preparo");
});

test("isolamento: um restaurante não vê nem altera dados de outro", async () => {
  clearRateLimits();
  const a = await register("Isolado A", "isoa@exemplo.mz");
  const b = await register("Isolado B", "isob@exemplo.mz");
  const dish = (await call("GET", "/api/menu?slug=isolado-a")).json.dishes[0];
  const order = (await call("POST", "/api/orders", { body: { restaurantId: a.restaurant.id, sessionId: "s", items: [{ dishId: dish.id, qty: 1 }] } })).json.order;
  const table = (await call("POST", "/api/tables", { token: a.token, body: { number: "1" } })).json.table;

  assert.equal((await call("GET", "/api/orders", { token: b.token })).json.orders.length, 0);
  assert.equal((await call("PATCH", `/api/orders/${order.id}`, { token: b.token, body: { status: "entregue" } })).status, 404);
  assert.equal((await call("DELETE", `/api/tables/${table.id}`, { token: b.token })).status, 404);
  assert.equal((await call("GET", "/api/tables", { token: b.token })).json.tables.length, 0);
  assert.equal((await call("GET", "/api/metrics?range=all", { token: b.token })).json.totals.orders, 0);
  // o menu completo de B não contém pratos de A
  const fullB = (await call("GET", "/api/menu/full", { token: b.token })).json;
  assert.equal(fullB.restaurant.slug, "isolado-b");
  // tracking com ID de outro restaurante não altera as métricas de A por engano
  await call("POST", "/api/track", { body: { restaurantId: b.restaurant.id, sessionId: "x", events: [{ d: dish.id, views: 1, ms: 1000 }] } });
  const mA = (await call("GET", "/api/metrics?range=all", { token: a.token })).json;
  assert.equal(mA.totals.views, 0);
});

test("estatísticas: tracking, limites e métricas por prato", async () => {
  clearRateLimits();
  const a = await register("Métricas", "met@exemplo.mz");
  const dish = (await call("GET", "/api/menu?slug=metricas")).json.dishes[0];
  const t = await call("POST", "/api/track", { body: { restaurantId: a.restaurant.id, sessionId: "v1", mesa: "1", events: [
    { d: dish.id, views: 1, ms: 4000, favs: 1, taps: 2 },
    { d: "prato-falso", views: 99, ms: 99999 },
    { d: dish.id, views: 9999, ms: 9e9 } // valores absurdos são limitados
  ] } });
  assert.equal(t.status, 200);
  const m = (await call("GET", "/api/metrics?range=today", { token: a.token })).json;
  assert.equal(m.online, 1);
  assert.ok(m.per[dish.id].views >= 1 && m.per[dish.id].views <= 6);
  assert.ok(m.per[dish.id].ms <= 4000 + 600000);
  assert.ok(!m.per["prato-falso"]);
  assert.equal(m.series.length, 1);
});

test("mesas: criar, duplicado e remover", async () => {
  clearRateLimits();
  const a = await register("Mesas", "mesas@exemplo.mz");
  const t = await call("POST", "/api/tables", { token: a.token, body: { number: "10" } });
  assert.equal(t.status, 201);
  assert.equal((await call("POST", "/api/tables", { token: a.token, body: { number: "10" } })).status, 409);
  assert.equal((await call("POST", "/api/tables", { token: a.token, body: { number: "  " } })).status, 400);
  assert.equal((await call("DELETE", `/api/tables/${t.json.table.id}`, { token: a.token })).status, 200);
});

test("chamadas de garçom: criar, listar, atualizar e remover", async () => {
  clearRateLimits();
  const a = await register("Bar Garçom", "garcom@exemplo.mz");
  // tenta sem mesa
  const semMesa = await call("POST", "/api/call-waiter", { body: { restaurantId: a.restaurant.id, note: "conta" } });
  assert.equal(semMesa.status, 400);

  // cria chamada com sucesso
  const res = await call("POST", "/api/call-waiter", { body: { restaurantId: a.restaurant.id, mesa: "mesaum", note: "trazer conta" } });
  assert.equal(res.status, 201);
  assert.equal(res.json.call.mesa, "mesaum");
  assert.equal(res.json.call.status, "pendente");

  // dono lista chamadas
  const list = await call("GET", "/api/waiter-calls", { token: a.token });
  assert.equal(list.status, 200);
  assert.equal(list.json.calls.length, 1);
  assert.equal(list.json.calls[0].mesa, "mesaum");

  // dono atende a chamada
  const patch = await call("PATCH", `/api/waiter-calls/${res.json.call.id}`, { token: a.token, body: { status: "atendido" } });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.call.status, "atendido");

  // dono remove chamada
  const del = await call("DELETE", `/api/waiter-calls/${res.json.call.id}`, { token: a.token });
  assert.equal(del.status, 200);

  // agora a lista está vazia
  const listAfter = await call("GET", "/api/waiter-calls", { token: a.token });
  assert.equal(listAfter.json.calls.length, 0);
});

test("tempo real: o painel recebe o pedido novo por SSE", async () => {
  clearRateLimits();
  const a = await register("Tempo Real", "sse@exemplo.mz");
  const dish = (await call("GET", "/api/menu?slug=tempo-real")).json.dishes[0];
  const got = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/stream?token=${a.token}`, (res) => {
      assert.equal(res.headers["content-type"], "text/event-stream");
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        if (buf.includes("event: orders")) { req.destroy(); resolve(buf); }
        if (buf.includes("event: hello") && !buf.includes("orders") && !res.__sent) {
          res.__sent = true;
          call("POST", "/api/orders", { body: { restaurantId: a.restaurant.id, sessionId: "s", mesa: "9", items: [{ dishId: dish.id, qty: 1 }] } }).catch(reject);
        }
      });
    });
    req.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
    setTimeout(() => reject(new Error("tempo esgotado")), 5000);
  });
  assert.match(got, /"type":"new"/);
  assert.equal((await call("GET", "/api/stream?token=invalido")).status, 401);
});

test("segurança: cabeçalhos, path traversal e páginas", async () => {
  const idx = await fetch(base + "/");
  assert.equal(idx.status, 200);
  assert.equal(idx.headers.get("x-content-type-options"), "nosniff");
  assert.match(idx.headers.get("content-security-policy"), /script-src 'self'/);
  for (const p of ["/../backend/server.js", "/..%2fbackend%2fserver.js", "/%2e%2e/%2e%2e/etc/passwd", "/media/..%2f..%2fdb.json", "/media/../db.json"]) {
    const r = await fetch(base + p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal((await fetch(base + "/backend/server.js")).status, 404);
  assert.equal((await fetch(base + "/r/qualquer-coisa")).status, 200);
  assert.equal((await fetch(base + "/painel")).status, 200);
  assert.equal((await fetch(base + "/painel.js")).status, 200);
  assert.equal((await call("POST", "/", {})).status, 404);
  const h = await call("GET", "/health");
  assert.equal(h.json.ok, true);
});

test("alterar senha termina as outras sessões", async () => {
  clearRateLimits();
  const a = await register("Senha", "senha@exemplo.mz");
  const second = (await call("POST", "/api/auth/login", { body: { email: "senha@exemplo.mz", password: "senha-segura-1" } })).json.token;
  assert.equal((await call("POST", "/api/auth/password", { token: a.token, body: { current: "errada", next: "nova-senha-123" } })).status, 401);
  assert.equal((await call("POST", "/api/auth/password", { token: a.token, body: { current: "senha-segura-1", next: "nova-senha-123" } })).status, 200);
  assert.equal((await call("GET", "/api/auth/me", { token: second })).status, 401);
  assert.equal((await call("GET", "/api/auth/me", { token: a.token })).status, 200);
  assert.equal((await call("POST", "/api/auth/login", { body: { email: "senha@exemplo.mz", password: "nova-senha-123" } })).status, 200);
});

test("dados persistem em disco com gravação atómica", async () => {
  app.db.flush();
  const file = path.join(dir, "db.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(saved.restaurants.length >= 5);
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.ok(fs.readdirSync(path.join(dir, "backups")).some((f) => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f)));
  assert.ok(!JSON.stringify(saved).includes("senha-segura-1"), "senhas nunca em texto simples");
});
