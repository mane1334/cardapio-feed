"use strict";
/* Cardápio em Feed — servidor (Node 18+, sem dependências).
 * Serve o cardápio público, o painel do dono e a API, com tempo real por SSE.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { DB } = require("./db");
const U = require("./util");

const { HttpError } = U;

const ROOT = path.resolve(__dirname, "..");
const THEMES = ["noite", "creme", "floresta", "brasa", "oceano"];
const ORDER_STATUS = ["novo", "preparo", "pronto", "entregue", "cancelado"];
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8"
};

function createApp(opts = {}) {
  const env = process.env;
  const cfg = {
    dataDir: path.resolve(opts.dataDir || env.DATA_DIR || path.join(ROOT, "storage")),
    publicDir: path.join(ROOT, "public"),
    demo: opts.demo ?? (env.DEMO_MODE ? env.DEMO_MODE !== "off" : env.NODE_ENV !== "production"),
    registration: opts.registration ?? env.REGISTRATION !== "off",
    trustProxy: opts.trustProxy ?? env.TRUST_PROXY === "1",
    tzOffsetMin: Number(opts.tzOffsetMin ?? env.TZ_OFFSET_MIN ?? 120), // Maputo = UTC+2
    sessionDays: Number(env.SESSION_DAYS || 7)
  };
  cfg.mediaDir = path.join(cfg.dataDir, "media");
  fs.mkdirSync(cfg.mediaDir, { recursive: true });

  const db = new DB(path.join(cfg.dataDir, "db.json"), path.join(cfg.dataDir, "backups"));
  const D = db.data;

  const seedMenu = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "seed-menu.json"), "utf8"));

  /* ---------- tempo real ---------- */
  const streams = new Map(); // restaurantId -> Set<res>
  const presence = new Map(); // restaurantId -> Map<sessionId, ts>
  const dirtyMetrics = new Set();

  function broadcast(restId, event, data) {
    const set = streams.get(restId);
    if (!set) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(payload);
  }

  const metricsTimer = setInterval(() => {
    for (const restId of dirtyMetrics) broadcast(restId, "metrics", { online: onlineCount(restId) });
    dirtyMetrics.clear();
  }, 3000);
  metricsTimer.unref();

  function touchPresence(restId, sessionId) {
    if (!sessionId) return;
    let m = presence.get(restId);
    if (!m) presence.set(restId, (m = new Map()));
    m.set(sessionId, Date.now());
    dirtyMetrics.add(restId);
  }

  function onlineCount(restId) {
    const m = presence.get(restId);
    if (!m) return 0;
    const limit = Date.now() - 45_000;
    let n = 0;
    for (const [sid, ts] of m) {
      if (ts < limit) m.delete(sid);
      else n += 1;
    }
    return n;
  }

  /* ---------- auxiliares ---------- */
  const dayKey = (ts = Date.now()) => new Date(ts + cfg.tzOffsetMin * 60_000).toISOString().slice(0, 10);

  function clientIp(req) {
    if (cfg.trustProxy) {
      const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || "?";
  }

  function defaultSettings(name) {
    return {
      theme: "noite", accent: "", welcome: `Bem-vindo ao ${name}. Desliza para ver o cardápio.`,
      whatsapp: "", instagram: "", orderingEnabled: true, minOrder: 0, currency: "MT"
    };
  }

  function createRestaurant(name, email, password, preferredSlug) {
    let slug = U.slugify(preferredSlug || name) || "restaurante";
    const base = slug;
    let n = 1;
    while (D.restaurants.some((r) => r.slug === slug)) slug = `${base}-${++n}`;
    const restaurant = {
      id: U.id(6), slug, name, createdAt: Date.now(),
      settings: defaultSettings(name),
      menu: JSON.parse(JSON.stringify({ categories: seedMenu.categories, dishes: seedMenu.dishes }))
    };
    const user = { id: U.id(6), restaurantId: restaurant.id, email, passHash: U.hashPassword(password), role: "dono", createdAt: Date.now() };
    D.restaurants.push(restaurant);
    D.users.push(user);
    db.save();
    return { restaurant, user };
  }

  function publicRestaurant(r) {
    return { id: r.id, slug: r.slug, name: r.name, settings: r.settings };
  }

  function findRestaurant({ slug, id }) {
    if (id) return D.restaurants.find((r) => r.id === id);
    if (slug) return D.restaurants.find((r) => r.slug === slug);
    return D.restaurants.length === 1 ? D.restaurants[0] : undefined;
  }

  function newSession(user) {
    const token = U.id(32);
    D.sessions[U.sha256(token)] = { userId: user.id, exp: Date.now() + cfg.sessionDays * 86_400_000 };
    db.save();
    return token;
  }

  function authFrom(token) {
    if (!token) throw new HttpError(401, "Sessão inválida. Entra de novo.");
    const key = U.sha256(token);
    const s = D.sessions[key];
    if (!s || s.exp < Date.now()) {
      if (s) { delete D.sessions[key]; db.save(); }
      throw new HttpError(401, "Sessão expirada. Entra de novo.");
    }
    const user = D.users.find((u) => u.id === s.userId);
    const restaurant = user && D.restaurants.find((r) => r.id === user.restaurantId);
    if (!user || !restaurant) throw new HttpError(401, "Sessão inválida. Entra de novo.");
    return { user, restaurant, tokenKey: key };
  }

  const auth = (ctx) => authFrom((ctx.req.headers.authorization || "").replace(/^Bearer\s+/i, ""));

  /* ---------- sanitização do menu ---------- */
  const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,59}$/;
  function safeMedia(url, restId) {
    if (url == null || url === "") return null;
    const s = String(url).slice(0, 500);
    if (new RegExp(`^/media/${restId}/[a-f0-9]{16}\\.(jpg|png|webp|gif|mp4|webm)$`).test(s)) return s;
    if (/^https:\/\/[^\s"'<>]+$/.test(s)) return s;
    return null;
  }

  function sanitizeMenu(input, restId) {
    if (!Array.isArray(input.categories) || !Array.isArray(input.dishes)) {
      throw new HttpError(400, "Menu inválido: faltam categorias ou pratos.");
    }
    if (input.categories.length > 30) throw new HttpError(400, "No máximo 30 categorias.");
    if (input.dishes.length > 300) throw new HttpError(400, "No máximo 300 pratos.");

    const seenCat = new Set();
    const categories = [];
    for (const c of input.categories) {
      const cid = U.str(c.id, 60).toLowerCase();
      const label = U.str(c.label, 30);
      if (!SAFE_ID.test(cid) || !label || seenCat.has(cid)) continue;
      seenCat.add(cid);
      categories.push({ id: cid, label });
    }
    if (!categories.length) throw new HttpError(400, "Precisas de pelo menos uma categoria.");

    const seenDish = new Set();
    const dishes = [];
    for (const d of input.dishes) {
      const did = U.str(d.id, 60).toLowerCase();
      const name = U.str(d.name, 60);
      if (!SAFE_ID.test(did) || !name || seenDish.has(did)) continue;
      seenDish.add(did);
      const colors = Array.isArray(d.colors) ? d.colors.filter((x) => U.HEX.test(x)).slice(0, 2) : [];
      dishes.push({
        id: did,
        category: seenCat.has(d.category) ? d.category : categories[0].id,
        name,
        description: U.str(d.description, 220),
        price: Math.round(U.num(d.price, 0, 10_000_000, 0)),
        bestSeller: d.bestSeller === true,
        soldOut: d.soldOut === true,
        hidden: d.hidden === true,
        tags: Array.isArray(d.tags) ? [...new Set(d.tags.map((t) => U.str(t, 20).toLowerCase()).filter(Boolean))].slice(0, 5) : [],
        emoji: U.str(d.emoji, 8),
        colors: colors.length === 2 ? colors : ["#2b2b2b", "#555555"],
        image: safeMedia(d.image, restId),
        video: safeMedia(d.video, restId),
        poster: safeMedia(d.poster, restId)
      });
    }
    return { categories, dishes };
  }

  function sanitizeSettings(input, current) {
    const s = { ...current };
    if (input.theme !== undefined) {
      if (!THEMES.includes(input.theme)) throw new HttpError(400, "Tema inválido.");
      s.theme = input.theme;
    }
    if (input.accent !== undefined) {
      if (input.accent !== "" && !U.HEX.test(input.accent)) throw new HttpError(400, "Cor inválida.");
      s.accent = input.accent;
    }
    if (input.welcome !== undefined) s.welcome = U.str(input.welcome, 200);
    if (input.whatsapp !== undefined) s.whatsapp = String(input.whatsapp).replace(/\D/g, "").slice(0, 15);
    if (input.instagram !== undefined) s.instagram = U.str(input.instagram, 40).replace(/^@/, "").replace(/[^\w.]/g, "");
    if (input.orderingEnabled !== undefined) s.orderingEnabled = input.orderingEnabled === true;
    if (input.minOrder !== undefined) s.minOrder = Math.round(U.num(input.minOrder, 0, 1_000_000, 0));
    if (input.currency !== undefined) s.currency = U.str(input.currency, 6) || "MT";
    return s;
  }

  /* ---------- rotas ---------- */
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

  /* auth */
  route("POST", "/api/auth/register", async (ctx) => {
    if (!cfg.registration) throw new HttpError(403, "Os registos estão fechados.");
    if (!U.rateLimit(`reg:${ctx.ip}`, 5, 3_600_000)) throw new HttpError(429, "Demasiados registos. Tenta mais tarde.");
    const b = await U.readJSON(ctx.req);
    const email = U.str(b.email, 120).toLowerCase();
    const name = U.str(b.restaurantName, 60);
    const password = typeof b.password === "string" ? b.password : "";
    if (!U.EMAIL.test(email)) throw new HttpError(400, "Email inválido.");
    if (!name) throw new HttpError(400, "Indica o nome do restaurante.");
    if (password.length < 8 || password.length > 100) throw new HttpError(400, "A senha precisa de pelo menos 8 caracteres.");
    if (D.users.some((u) => u.email === email)) throw new HttpError(409, "Já existe uma conta com este email.");
    const { restaurant, user } = createRestaurant(name, email, password);
    return { status: 201, body: { token: newSession(user), user: { email: user.email, role: user.role }, restaurant: publicRestaurant(restaurant) } };
  });

  route("POST", "/api/auth/login", async (ctx) => {
    const b = await U.readJSON(ctx.req);
    const email = U.str(b.email, 120).toLowerCase();
    if (!U.rateLimit(`login:${ctx.ip}`, 15, 600_000) || !U.rateLimit(`loginmail:${email}`, 8, 900_000)) {
      throw new HttpError(429, "Demasiadas tentativas. Espera uns minutos.");
    }
    const user = D.users.find((u) => u.email === email);
    const ok = user && U.verifyPassword(String(b.password || ""), user.passHash);
    if (!ok) throw new HttpError(401, "Email ou senha incorretos.");
    const restaurant = D.restaurants.find((r) => r.id === user.restaurantId);
    return { body: { token: newSession(user), user: { email: user.email, role: user.role }, restaurant: publicRestaurant(restaurant) } };
  });

  route("GET", "/api/auth/me", (ctx) => {
    const { user, restaurant } = auth(ctx);
    return { body: { user: { email: user.email, role: user.role }, restaurant: publicRestaurant(restaurant) } };
  });

  route("POST", "/api/auth/logout", (ctx) => {
    const { tokenKey } = auth(ctx);
    delete D.sessions[tokenKey];
    db.save();
    return { body: { ok: true } };
  });

  route("POST", "/api/auth/password", async (ctx) => {
    const { user, tokenKey } = auth(ctx);
    const b = await U.readJSON(ctx.req);
    if (!U.verifyPassword(String(b.current || ""), user.passHash)) throw new HttpError(401, "A senha atual está incorreta.");
    const next = typeof b.next === "string" ? b.next : "";
    if (next.length < 8 || next.length > 100) throw new HttpError(400, "A nova senha precisa de pelo menos 8 caracteres.");
    user.passHash = U.hashPassword(next);
    // termina as outras sessões deste utilizador
    for (const [k, s] of Object.entries(D.sessions)) if (s.userId === user.id && k !== tokenKey) delete D.sessions[k];
    db.save();
    return { body: { ok: true } };
  });

  /* menu */
  route("GET", "/api/menu", (ctx) => {
    const r = findRestaurant({ slug: ctx.query.get("slug") });
    if (!r) throw new HttpError(404, "Restaurante não encontrado.");
    const dishes = r.menu.dishes.filter((d) => !d.hidden);
    const used = new Set(dishes.map((d) => d.category));
    return {
      body: { restaurant: publicRestaurant(r), categories: r.menu.categories.filter((c) => used.has(c.id)), dishes },
      headers: { "Cache-Control": "no-cache" }
    };
  });

  route("GET", "/api/menu/full", (ctx) => {
    const { restaurant } = auth(ctx);
    return { body: { restaurant: publicRestaurant(restaurant), ...restaurant.menu } };
  });

  route("PUT", "/api/menu", async (ctx) => {
    const { restaurant } = auth(ctx);
    const b = await U.readJSON(ctx.req, 2 * 1024 * 1024);
    restaurant.menu = sanitizeMenu(b, restaurant.id);
    db.save();
    return { body: { ok: true, ...restaurant.menu } };
  });

  route("PUT", "/api/settings", async (ctx) => {
    const { restaurant } = auth(ctx);
    const b = await U.readJSON(ctx.req);
    if (b.name !== undefined) {
      const name = U.str(b.name, 60);
      if (!name) throw new HttpError(400, "O nome não pode ficar vazio.");
      restaurant.name = name;
    }
    restaurant.settings = sanitizeSettings(b, restaurant.settings);
    db.save();
    return { body: { restaurant: publicRestaurant(restaurant) } };
  });

  /* uploads */
  route("POST", "/api/upload", async (ctx) => {
    const { restaurant } = auth(ctx);
    if (!U.rateLimit(`up:${restaurant.id}`, 60, 600_000)) throw new HttpError(429, "Demasiados uploads. Espera um pouco.");
    const wants = ctx.query.get("kind") === "video" ? "video" : "image";
    const limit = wants === "video" ? 25 * 1024 * 1024 : 8 * 1024 * 1024;
    const buf = await U.readBody(ctx.req, limit);
    const type = U.sniff(buf);
    if (!type || type.kind !== wants) {
      throw new HttpError(415, wants === "video" ? "Ficheiro inválido. Usa MP4 ou WebM." : "Imagem inválida. Usa JPG, PNG, WebP ou GIF.");
    }
    const dir = path.join(cfg.mediaDir, restaurant.id);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${U.id(8)}.${type.ext}`;
    fs.writeFileSync(path.join(dir, name), buf);
    return { status: 201, body: { url: `/media/${restaurant.id}/${name}`, bytes: buf.length } };
  });

  /* tracking público */
  route("POST", "/api/track", async (ctx) => {
    if (!U.rateLimit(`track:${ctx.ip}`, 600, 60_000)) throw new HttpError(429, "Demasiados pedidos.");
    const b = await U.readJSON(ctx.req, 64 * 1024);
    const r = findRestaurant({ id: U.str(b.restaurantId, 20) });
    if (!r) throw new HttpError(404, "Restaurante não encontrado.");
    const sid = U.str(b.sessionId, 40);
    touchPresence(r.id, sid);
    if (Array.isArray(b.events) && b.events.length) {
      const day = dayKey();
      const known = new Set(r.menu.dishes.map((d) => d.id));
      const byDish = ((D.analytics[r.id] ||= {}));
      for (const ev of b.events.slice(0, 60)) {
        const did = U.str(ev.d, 60);
        if (!known.has(did)) continue;
        const slot = (((byDish[did] ||= {})[day]) ||= { views: 0, ms: 0, favs: 0, taps: 0 });
        slot.views += Math.round(U.num(ev.views, 0, 5, 0));
        slot.ms += Math.round(U.num(ev.ms, 0, 600_000, 0));
        slot.favs += Math.round(U.num(ev.favs, 0, 3, 0));
        slot.taps += Math.round(U.num(ev.taps, 0, 20, 0));
      }
      db.save();
    }
    return { body: { ok: true } };
  });

  /* métricas */
  route("GET", "/api/metrics", (ctx) => {
    const { restaurant } = auth(ctx);
    const range = ["today", "7d", "30d", "all"].includes(ctx.query.get("range")) ? ctx.query.get("range") : "7d";
    const today = dayKey();
    const span = { today: 1, "7d": 7, "30d": 30, all: 3650 }[range];
    const first = dayKey(Date.now() - (span - 1) * 86_400_000);
    const inRange = (day) => day >= first && day <= today;

    const per = {};
    const daily = {};
    const totals = { views: 0, ms: 0, favs: 0, taps: 0, orders: 0, revenue: 0, items: 0 };
    const mine = D.analytics[restaurant.id] || {};
    for (const [dishId, days] of Object.entries(mine)) {
      for (const [day, s] of Object.entries(days)) {
        if (!inRange(day)) continue;
        const p = (per[dishId] ||= { views: 0, ms: 0, favs: 0, taps: 0, qty: 0, revenue: 0 });
        const dd = (daily[day] ||= { views: 0, ms: 0, favs: 0, orders: 0, revenue: 0 });
        for (const k of ["views", "ms", "favs", "taps"]) { p[k] += s[k]; totals[k] += s[k]; }
        dd.views += s.views; dd.ms += s.ms; dd.favs += s.favs;
      }
    }
    for (const o of D.orders) {
      if (o.restaurantId !== restaurant.id || o.status === "cancelado") continue;
      const day = dayKey(o.createdAt);
      if (!inRange(day)) continue;
      totals.orders += 1;
      totals.revenue += o.total;
      const dd = (daily[day] ||= { views: 0, ms: 0, favs: 0, orders: 0, revenue: 0 });
      dd.orders += 1; dd.revenue += o.total;
      for (const it of o.items) {
        totals.items += it.qty;
        const p = (per[it.dishId] ||= { views: 0, ms: 0, favs: 0, taps: 0, qty: 0, revenue: 0 });
        p.qty += it.qty; p.revenue += it.qty * it.price;
      }
    }
    const series = [];
    for (let i = Math.min(span, 30) - 1; i >= 0; i--) {
      const day = dayKey(Date.now() - i * 86_400_000);
      series.push({ day, ...(daily[day] || { views: 0, ms: 0, favs: 0, orders: 0, revenue: 0 }) });
    }
    return { body: { range, totals, per, series, online: onlineCount(restaurant.id) } };
  });

  /* tempo real */
  route("GET", "/api/stream", (ctx) => {
    const { restaurant } = authFrom(ctx.query.get("token"));
    const res = ctx.res;
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no"
    });
    res.write(`retry: 3000\nevent: hello\ndata: {"online":${onlineCount(restaurant.id)}}\n\n`);
    let set = streams.get(restaurant.id);
    if (!set) streams.set(restaurant.id, (set = new Set()));
    set.add(res);
    const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
    ctx.req.on("close", () => { clearInterval(beat); set.delete(res); });
    return { handled: true };
  });

  /* mesas */
  route("GET", "/api/tables", (ctx) => {
    const { restaurant } = auth(ctx);
    const tables = D.tables.filter((t) => t.restaurantId === restaurant.id)
      .sort((a, b) => a.number.localeCompare(b.number, "pt", { numeric: true }));
    return { body: { tables, slug: restaurant.slug } };
  });

  route("POST", "/api/tables", async (ctx) => {
    const { restaurant } = auth(ctx);
    const b = await U.readJSON(ctx.req);
    const number = U.str(String(b.number ?? ""), 12).replace(/[^\w-]/g, "");
    if (!number) throw new HttpError(400, "Indica o número ou nome da mesa.");
    const mine = D.tables.filter((t) => t.restaurantId === restaurant.id);
    if (mine.length >= 150) throw new HttpError(400, "Limite de 150 mesas.");
    if (mine.some((t) => t.number === number)) throw new HttpError(409, "Já existe uma mesa com esse número.");
    const table = { id: U.id(5), restaurantId: restaurant.id, number };
    D.tables.push(table);
    db.save();
    return { status: 201, body: { table } };
  });

  route("DELETE", "/api/tables/([a-f0-9]+)", (ctx, tid) => {
    const { restaurant } = auth(ctx);
    const i = D.tables.findIndex((t) => t.id === tid && t.restaurantId === restaurant.id);
    if (i < 0) throw new HttpError(404, "Mesa não encontrada.");
    D.tables.splice(i, 1);
    db.save();
    return { body: { ok: true } };
  });

  /* pedidos */
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function newCode(restId) {
    const recent = new Set(D.orders.filter((o) => o.restaurantId === restId && Date.now() - o.createdAt < 86_400_000).map((o) => o.code));
    for (let i = 0; i < 50; i++) {
      let c = "";
      for (let j = 0; j < 4; j++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!recent.has(c)) return c;
    }
    return U.id(3).toUpperCase();
  }

  const clientOrder = (o) => ({ id: o.id, code: o.code, status: o.status, total: o.total, mesa: o.mesa, createdAt: o.createdAt, items: o.items.map((i) => ({ name: i.name, qty: i.qty })) });

  route("POST", "/api/orders", async (ctx) => {
    if (!U.rateLimit(`order:${ctx.ip}`, 60, 600_000)) throw new HttpError(429, "Demasiados pedidos seguidos. Chama o empregado.");
    const b = await U.readJSON(ctx.req, 64 * 1024);
    const r = findRestaurant({ id: U.str(b.restaurantId, 20) });
    if (!r) throw new HttpError(404, "Restaurante não encontrado.");
    if (!r.settings.orderingEnabled) throw new HttpError(403, "Este restaurante não está a aceitar pedidos pelo cardápio.");
    const sessionId = U.str(b.sessionId, 40);
    if (!sessionId) throw new HttpError(400, "Sessão em falta.");
    if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, "O pedido está vazio.");
    if (b.items.length > 30) throw new HttpError(400, "Pedido demasiado grande.");

    const items = [];
    let total = 0;
    for (const raw of b.items) {
      const dish = r.menu.dishes.find((d) => d.id === raw.dishId && !d.hidden);
      if (!dish) throw new HttpError(409, "Um dos pratos já não está disponível.");
      if (dish.soldOut) throw new HttpError(409, `${dish.name} está esgotado.`);
      const qty = Math.round(U.num(raw.qty, 1, 20, 1));
      items.push({ dishId: dish.id, name: dish.name, price: dish.price, qty, note: U.str(raw.note, 120) });
      total += dish.price * qty; // preço sempre vem do servidor
    }
    if (total < r.settings.minOrder) throw new HttpError(400, `Pedido mínimo: ${r.settings.minOrder} ${r.settings.currency}.`);

    const order = {
      id: U.id(6), restaurantId: r.id, code: newCode(r.id), mesa: U.str(String(b.mesa ?? ""), 12).replace(/[^\w-]/g, ""),
      name: U.str(b.name, 40), note: U.str(b.note, 200), sessionId, items, total,
      status: "novo", createdAt: Date.now(), updatedAt: Date.now()
    };
    D.orders.push(order);
    db.save();
    broadcast(r.id, "orders", { type: "new", order });
    return { status: 201, body: { order: clientOrder(order) } };
  });

  route("GET", "/api/orders", (ctx) => {
    const { restaurant } = auth(ctx);
    const status = ctx.query.get("status");
    const since = Number(ctx.query.get("since")) || Date.now() - 86_400_000;
    const list = D.orders
      .filter((o) => o.restaurantId === restaurant.id && o.createdAt >= since && (!status || o.status === status))
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 300);
    return { body: { orders: list } };
  });

  route("PATCH", "/api/orders/([a-f0-9]+)", async (ctx, oid) => {
    const { restaurant } = auth(ctx);
    const b = await U.readJSON(ctx.req);
    const order = D.orders.find((o) => o.id === oid && o.restaurantId === restaurant.id);
    if (!order) throw new HttpError(404, "Pedido não encontrado.");
    if (!ORDER_STATUS.includes(b.status)) throw new HttpError(400, "Estado inválido.");
    order.status = b.status;
    order.updatedAt = Date.now();
    db.save();
    broadcast(restaurant.id, "orders", { type: "update", order });
    return { body: { order } };
  });

  route("GET", "/api/myorders", (ctx) => {
    const r = findRestaurant({ id: ctx.query.get("restaurantId") });
    const sid = U.str(ctx.query.get("sessionId") || "", 40);
    if (!r || !sid) return { body: { orders: [] } };
    const orders = D.orders
      .filter((o) => o.restaurantId === r.id && o.sessionId === sid && Date.now() - o.createdAt < 12 * 3_600_000)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 10).map(clientOrder);
    return { body: { orders } };
  });

  route("POST", "/api/orders/([a-f0-9]+)/cancel", async (ctx, oid) => {
    const b = await U.readJSON(ctx.req);
    const order = D.orders.find((o) => o.id === oid && o.sessionId === U.str(b.sessionId, 40));
    if (!order) throw new HttpError(404, "Pedido não encontrado.");
    if (order.status !== "novo" || Date.now() - order.createdAt > 180_000) {
      throw new HttpError(409, "Já não é possível cancelar. Fala com o empregado.");
    }
    order.status = "cancelado";
    order.updatedAt = Date.now();
    db.save();
    broadcast(order.restaurantId, "orders", { type: "update", order });
    return { body: { order: clientOrder(order) } };
  });

  route("GET", "/health", () => ({ body: { ok: true, restaurants: D.restaurants.length, uptime: Math.round(process.uptime()) } }));

  /* ---------- ficheiros estáticos ---------- */
  function sendFile(req, res, file, extra = {}) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound(res);
      const ext = path.extname(file).toLowerCase();
      const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "Accept-Ranges": "bytes", ...extra };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
        end = Math.min(end, st.size - 1);
        if (start > end || start < 0) {
          res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
        return req.method === "HEAD" ? res.end() : fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...headers, "Content-Length": st.size });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  function notFound(res) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Não encontrado." }));
  }

  function inside(base, target) {
    const rel = path.relative(base, target);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  }

  function serveStatic(req, res, pathname) {
    if (pathname.startsWith("/media/")) {
      const file = path.join(cfg.mediaDir, path.normalize(decodeURIComponent(pathname.slice(7))));
      if (!inside(cfg.mediaDir, file)) return notFound(res);
      return sendFile(req, res, file, { "Cache-Control": "public, max-age=2592000, immutable" });
    }
    let rel = pathname;
    if (rel === "/" || /^\/r\/[^/]+\/?$/.test(rel)) rel = "/index.html";
    else if (rel === "/painel" || rel === "/painel/") rel = "/painel.html";
    const file = path.join(cfg.publicDir, path.normalize(decodeURIComponent(rel)));
    if (!inside(cfg.publicDir, file)) return notFound(res);
    const extra = { "Cache-Control": "no-cache" };
    if (rel === "/sw.js") extra["Service-Worker-Allowed"] = "/";
    sendFile(req, res, file, extra);
  }

  /* ---------- servidor ---------- */
  const SECURITY = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
  };

  async function handle(req, res) {
    const started = Date.now();
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (!pathname.startsWith("/api/") && pathname !== "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") return notFound(res);
      return serveStatic(req, res, pathname);
    }

    const ctx = { req, res, query: url.searchParams, ip: clientIp(req) };
    try {
      let matched = false;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        matched = true;
        const out = await r.handler(ctx, ...m.slice(1));
        if (out && out.handled) return;
        res.writeHead(out.status || 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(out.headers || {}) });
        res.end(JSON.stringify(out.body));
        break;
      }
      if (!matched) throw new HttpError(404, "Rota não encontrada.");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error("[erro]", req.method, pathname, err);
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: status === 500 ? "Erro interno. Tenta de novo." : err.message }));
      }
    } finally {
      if (process.env.LOG_REQUESTS === "1") console.log(`${new Date().toISOString()} ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error(e); try { res.end(); } catch (_) {} });
  });
  server.keepAliveTimeout = 65_000;

  /* ---------- manutenção ---------- */
  function maintenance() {
    const now = Date.now();
    for (const [k, s] of Object.entries(D.sessions)) if (s.exp < now) delete D.sessions[k];
    const cutoff = now - 90 * 86_400_000;
    D.orders = D.orders.filter((o) => o.createdAt >= cutoff);
    db.save();
  }
  maintenance();
  const maint = setInterval(maintenance, 6 * 3_600_000);
  maint.unref();

  /* ---------- demonstração ---------- */
  if (cfg.demo && D.restaurants.length === 0) {
    const { restaurant } = createRestaurant("Café Kutsakai", "dono@kutsakai.mz", "kutsakai123", "cafe-kutsakai");
    D.tables.push(...["1", "2", "3"].map((n) => ({ id: U.id(5), restaurantId: restaurant.id, number: n })));
    db.save();
  }

  return {
    server, db, cfg,
    close() {
      clearInterval(metricsTimer); clearInterval(maint);
      for (const set of streams.values()) for (const res of set) res.end();
      db.flush();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createApp, THEMES };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 3001);
  const host = process.env.HOST || "0.0.0.0";
  const app = createApp();
  app.server.listen(port, host, () => {
    console.log(`Cardápio em Feed a correr em http://localhost:${port}`);
    if (app.cfg.demo) console.log("Modo demonstração: dono@kutsakai.mz / kutsakai123  (desliga com DEMO_MODE=off)");
    console.log(`Dados em ${app.cfg.dataDir}`);
  });
  const stop = () => { app.db.flush(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
