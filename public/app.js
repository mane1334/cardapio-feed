/* Cardápio em feed — cliente.
 * Feed vertical, categorias, favoritos, pedido com bandeja, acompanhamento do pedido,
 * 5 temas, estatísticas por prato enviadas ao servidor e cache offline do menu.
 */
(() => {
  "use strict";

  const qs = new URLSearchParams(location.search);
  const slug = qs.get("slug") || (location.pathname.match(/^\/r\/([^/]+)/) || [])[1] || "";
  const mesa = (qs.get("mesa") || "").replace(/[^\w-]/g, "").slice(0, 12);
  const preview = qs.get("preview") === "1"; // dentro do painel: não conta estatísticas nem pedidos

  const THEME_COLOR = { noite: "#0b0b0b", creme: "#f4ecdc", floresta: "#08140d", brasa: "#140605", oceano: "#06121f" };
  const STATUS = {
    novo: { label: "Recebido", step: 0 },
    preparo: { label: "Em preparo", step: 1 },
    pronto: { label: "Pronto", step: 2 },
    entregue: { label: "Entregue", step: 3 },
    cancelado: { label: "Cancelado", step: -1 }
  };
  const VISIBLE_RATIO = 0.6;
  const MIN_VIEW_MS = 700;

  const $ = (id) => document.getElementById(id);
  const $feed = $("feed");
  const $chips = $("chips");
  const $tray = $("trayBar");
  const $sheetRoot = $("sheetRoot");

  let activeMesa = mesa || "";

  const saveData = (navigator.connection && navigator.connection.saveData) || matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- armazenamento (tolerante a falhas) ---------- */
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (_) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* sem armazenamento */ } }
  };

  const sessionId = (() => {
    let s = store.get("cf.sid", "");
    if (!s) { s = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set("cf.sid", s); }
    return s;
  })();

  /* ---------- estado ---------- */
  let data = null; // { restaurant, categories, dishes }
  let settings = {};
  const byId = new Map();
  let favs = store.get(`cf.fav.${slug}`, {});
  let cart = new Map(Object.entries(store.get(`cf.cart.${slug}`, {})).map(([k, v]) => [k, Number(v)]));
  let muted = true;
  let myOrders = [];
  let ordersSheetOpen = false;

  /* ---------- util ---------- */
  function el(tag, props = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v; // só com strings estáticas do código
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children)) if (c != null && c !== false) n.append(c);
    return n;
  }

  const fmtNum = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0 });
  const money = (v) => `${fmtNum.format(v)} ${settings.currency || "MT"}`;

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "Algo correu mal. Tenta de novo.");
    return json;
  }

  const ICON = {
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.500s-8-4.900-8-11A4.500 4.500 0 0 1 12 6.800 4.500 4.500 0 0 1 20 9.500c0 6.100-8 11-8 11z"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.500 7.500 12 3l4.500 4.500M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
    mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3zm13.600 2 2.400-2.400-1.400-1.400-2.400 2.400-2.400-2.400-1.400 1.400 2.400 2.400-2.400 2.400 1.400 1.400 2.400-2.400 2.400 2.400 1.400-1.400L16.600 12z"/></svg>',
    sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l5 4V6L7 10H3zm13.500 2a4.500 4.500 0 0 0-2.500-4v8a4.500 4.500 0 0 0 2.500-4z"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>',
    bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
  };

  /* ---------- tema ---------- */
  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  }

  function applyTheme(s) {
    const theme = THEME_COLOR[qs.get("theme")] ? qs.get("theme") : THEME_COLOR[s.theme] ? s.theme : "noite";
    document.documentElement.dataset.theme = theme;
    const root = document.documentElement.style;
    if (/^#[0-9a-f]{6}$/i.test(s.accent || "")) {
      root.setProperty("--accent", s.accent);
      root.setProperty("--accent-ink", luminance(s.accent) > 0.38 ? "#111111" : "#ffffff");
    } else {
      root.removeProperty("--accent");
      root.removeProperty("--accent-ink");
    }
    document.querySelector('meta[name="theme-color"]').setAttribute("content", THEME_COLOR[theme]);
  }

  /* ---------- estatísticas ---------- */
  const pending = new Map();
  const viewing = new Map();

  function bump(id, key, v = 1) {
    const p = pending.get(id) || { d: id, views: 0, ms: 0, favs: 0, taps: 0 };
    p[key] += v;
    pending.set(id, p);
  }

  function startView(id) {
    if (!viewing.has(id)) viewing.set(id, { t0: performance.now(), counted: false });
  }

  function commit(id, entry, now) {
    const elapsed = now - entry.t0;
    if (!entry.counted) {
      if (elapsed < MIN_VIEW_MS) return;
      entry.counted = true;
      bump(id, "views");
    }
    bump(id, "ms", Math.round(elapsed));
    entry.t0 = now;
  }

  function stopView(id) {
    const entry = viewing.get(id);
    if (!entry) return;
    viewing.delete(id);
    commit(id, entry, performance.now());
  }

  function flush(beacon = false) {
    if (preview || !data) return;
    const now = performance.now();
    for (const [id, entry] of viewing) commit(id, entry, now);
    const events = [...pending.values()];
    pending.clear();
    const body = JSON.stringify({ restaurantId: data.restaurant.id, sessionId, mesa, events });
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon("/api/track", new Blob([body], { type: "application/json" }));
      return;
    }
    fetch("/api/track", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
      .then((r) => { if (!r.ok) throw new Error(r.status); })
      .catch(() => { for (const e of events) for (const k of ["views", "ms", "favs", "taps"]) bump(e.d, k, e[k]); });
  }

  /* ---------- carrinho ---------- */
  const cartCount = () => [...cart.values()].reduce((n, q) => n + q, 0);
  const cartTotal = () => [...cart].reduce((n, [id, q]) => n + (byId.get(id)?.price || 0) * q, 0);

  function persistCart() { store.set(`cf.cart.${slug}`, Object.fromEntries(cart)); }

  function setQty(id, qty) {
    const dish = byId.get(id);
    if (!dish || dish.soldOut) return;
    qty = Math.max(0, Math.min(20, qty));
    if (qty === 0) cart.delete(id); else cart.set(id, qty);
    persistCart();
    const buy = $feed.querySelector(`[data-id="${CSS.escape(id)}"] .buy`);
    if (buy) renderBuy(buy, dish);
    updateTray();
  }

  /* ---------- feed ---------- */
  function renderBuy(host, dish) {
    host.replaceChildren(el("span", { class: "price", text: money(dish.price) }));
    if (dish.soldOut || !settings.orderingEnabled) return;
    const qty = cart.get(dish.id) || 0;
    if (!qty) {
      host.append(el("button", { class: "order", type: "button", text: "Pedir", onclick: () => setQty(dish.id, 1) }));
    } else {
      host.append(el("div", { class: "stepper" }, [
        el("button", { type: "button", "aria-label": "Menos um", text: "−", onclick: () => setQty(dish.id, qty - 1) }),
        el("b", { text: String(qty) }),
        el("button", { type: "button", "aria-label": "Mais um", text: "+", onclick: () => setQty(dish.id, qty + 1) })
      ]));
    }
  }

  /* ---------- mídias e slider ---------- */
  function getDishMedia(dish) {
    const list = [];
    const videos = Array.isArray(dish.videos) && dish.videos.length ? dish.videos : (dish.video ? [dish.video] : []);
    const images = Array.isArray(dish.images) && dish.images.length ? dish.images : (dish.image ? [dish.image] : []);

    for (const v of videos) list.push({ type: "video", url: v, poster: dish.poster });
    for (const img of images) list.push({ type: "image", url: img });

    if (!list.length) list.push({ type: "empty" });
    return list;
  }

  function buildMedia(dish) {
    const mediaList = getDishMedia(dish);
    const media = el("div", { class: "media" });
    media.style.setProperty("--c1", dish.colors?.[0] || "#222");
    media.style.setProperty("--c2", dish.colors?.[1] || "#555");

    if (mediaList.length === 1 && mediaList[0].type === "empty") {
      media.classList.add("plain");
      media.append(el("div", { class: "art", "aria-hidden": "true", text: dish.emoji || "🍽️" }));
      return media;
    }

    const slider = el("div", { class: "media-slider" });
    const dots = mediaList.length > 1 ? el("div", { class: "media-dots" }) : null;

    mediaList.forEach((m, idx) => {
      const slide = el("div", { class: `media-slide ${m.type}`, "data-idx": String(idx) });
      if (m.type === "image") {
        slide.append(el("img", { src: m.url, alt: dish.name, loading: idx === 0 ? "eager" : "lazy", decoding: "async" }));
      } else if (m.type === "video" && !saveData) {
        const video = el("video", {
          muted: true, loop: true, playsinline: true, preload: "none", "data-src": m.url
        });
        if (m.poster) video.setAttribute("poster", m.poster);
        video.muted = muted;
        slide.append(video);
      }
      slider.append(slide);

      if (dots) {
        dots.append(el("span", { class: `dot${idx === 0 ? " active" : ""}` }));
      }
    });

    media.append(slider);

    if (dots) {
      media.append(dots);
      slider.addEventListener("scroll", () => {
        const width = slider.clientWidth || 1;
        const activeIdx = Math.round(slider.scrollLeft / width);
        dots.querySelectorAll(".dot").forEach((d, i) => d.classList.toggle("active", i === activeIdx));
      }, { passive: true });
    }

    // Navegação lateral em telas de tablet e computador
    if (mediaList.length > 1) {
      const prev = el("button", {
        class: "slide-nav prev", type: "button", "aria-label": "Foto anterior",
        onclick: (e) => { e.stopPropagation(); slider.scrollBy({ left: -slider.clientWidth, behavior: "smooth" }); }
      }, [el("span", { html: "&#10094;" })]);
      const next = el("button", {
        class: "slide-nav next", type: "button", "aria-label": "Próxima foto",
        onclick: (e) => { e.stopPropagation(); slider.scrollBy({ left: slider.clientWidth, behavior: "smooth" }); }
      }, [el("span", { html: "&#10095;" })]);
      media.append(prev, next);
    }

    return media;
  }

  function buildDish(dish) {
    const tags = el("div", { class: "tags" });
    if (dish.soldOut) tags.append(el("span", { class: "tag out", text: "Esgotado" }));
    if (dish.bestSeller) tags.append(el("span", { class: "tag hot", text: "Best seller" }));
    for (const t of dish.tags || []) tags.append(el("span", { class: "tag", text: t }));

    const buy = el("div", { class: "buy" });
    renderBuy(buy, dish);

    const detail = el("button", { class: "act", type: "button", "aria-label": `Ver detalhes de ${dish.name}`, onclick: () => dishDetailSheet(dish) },
      [el("span", { class: "ico", html: ICON.info }), el("span", { text: "Detalhes" })]);

    const fav = el("button", {
      class: "act", type: "button", "aria-pressed": String(Boolean(favs[dish.id])), "aria-label": `Guardar ${dish.name}`,
      onclick: (e) => {
        const on = !favs[dish.id];
        if (on) { favs[dish.id] = 1; bump(dish.id, "favs"); if (navigator.vibrate) navigator.vibrate(12); }
        else delete favs[dish.id];
        store.set(`cf.fav.${slug}`, favs);
        e.currentTarget.setAttribute("aria-pressed", String(on));
      }
    }, [el("span", { class: "ico", html: ICON.heart }), el("span", { text: "Guardar" })]);

    const share = el("button", { class: "act", type: "button", "aria-label": `Partilhar ${dish.name}`, onclick: () => shareDish(dish) },
      [el("span", { class: "ico", html: ICON.share }), el("span", { text: "Enviar" })]);

    const hasVid = Boolean((dish.videos && dish.videos.length) || dish.video);
    const sound = el("button", { class: "sound", type: "button", "aria-label": "Ligar ou desligar o som", html: ICON.mute, onclick: toggleSound });

    const info = el("div", { class: "info" }, [
      el("div", { class: "text" }, [
        tags.childElementCount ? tags : null,
        el("h2", { class: "name", text: dish.name }),
        dish.description ? el("p", { class: "desc", text: dish.description }) : null,
        buy
      ]),
      el("div", { class: "side" }, [detail, fav, share])
    ]);

    const article = el("article", {
      class: "dish" + (hasVid && !saveData ? " has-video" : ""), "data-id": dish.id, "data-cat": dish.category, id: `p-${dish.id}`, "aria-label": dish.name
    }, [buildMedia(dish), el("div", { class: "shade" }), sound, info]);
    article.addEventListener("click", (e) => { if (!e.target.closest("button")) bump(dish.id, "taps"); });
    return article;
  }
    article.addEventListener("click", (e) => { if (!e.target.closest("button")) bump(dish.id, "taps"); });
    return article;
  }

  async function shareDish(dish) {
    const url = `${location.origin}/r/${data.restaurant.slug}${mesa ? `?mesa=${mesa}` : ""}#${dish.id}`;
    try {
      if (navigator.share) { await navigator.share({ title: `${dish.name} · ${data.restaurant.name}`, url }); return; }
      await navigator.clipboard.writeText(url);
      toast("Link copiado");
    } catch (_) { /* cancelado */ }
  }

  /* ---------- detalhes do prato ---------- */
  function dishDetailSheet(dish) {
    bump(dish.id, "taps");
    openSheet(dish.name, (body) => {
      const hero = el("div", { class: "detail-hero" });
      hero.style.setProperty("--c1", dish.colors?.[0] || "#222");
      hero.style.setProperty("--c2", dish.colors?.[1] || "#555");
      const mediaList = getDishMedia(dish);

      if (mediaList.length === 1 && mediaList[0].type === "empty") {
        hero.classList.add("plain");
        hero.append(el("div", { class: "detail-emoji", "aria-hidden": "true", text: dish.emoji || "🍽️" }));
      } else {
        const slider = el("div", { class: "detail-slider" });
        const dots = mediaList.length > 1 ? el("div", { class: "detail-dots" }) : null;

        mediaList.forEach((m, idx) => {
          const slide = el("div", { class: "detail-slide" });
          if (m.type === "image") {
            slide.append(el("img", { src: m.url, alt: dish.name }));
          } else if (m.type === "video") {
            const v = el("video", {
              src: m.url, controls: true, playsinline: true, muted: false, preload: "metadata"
            });
            if (m.poster) v.poster = m.poster;
            slide.append(v);
          }
          slider.append(slide);

          if (dots) {
            dots.append(el("span", { class: `dot${idx === 0 ? " active" : ""}` }));
          }
        });

        hero.append(slider);

        if (dots) {
          hero.append(dots);
          slider.addEventListener("scroll", () => {
            const width = slider.clientWidth || 1;
            const activeIdx = Math.round(slider.scrollLeft / width);
            dots.querySelectorAll(".dot").forEach((d, i) => d.classList.toggle("active", i === activeIdx));
          }, { passive: true });
        }
      }
      body.append(hero);

      // tags
      if (dish.soldOut || dish.bestSeller || (dish.tags && dish.tags.length)) {
        const tags = el("div", { class: "tags", style: "margin: 14px 0 8px;" });
        if (dish.soldOut) tags.append(el("span", { class: "tag out", text: "Esgotado" }));
        if (dish.bestSeller) tags.append(el("span", { class: "tag hot", text: "Best seller" }));
        for (const t of dish.tags || []) tags.append(el("span", { class: "tag", text: t }));
        body.append(tags);
      }

      // descrição
      if (dish.description) {
        body.append(el("p", { class: "detail-desc", text: dish.description }));
      }

      // linha de compra: preço + botão pedir
      const buyRow = el("div", { class: "detail-buy" });
      buyRow.append(el("span", { class: "detail-price", text: money(dish.price) }));
      if (!dish.soldOut && settings.orderingEnabled) {
        const qty = cart.get(dish.id) || 0;
        if (!qty) {
          buyRow.append(el("button", {
            class: "order", type: "button", text: "Adicionar ao pedido",
            onclick: () => { setQty(dish.id, 1); closeSheet(); toast(`${dish.name} adicionado!`); }
          }));
        } else {
          buyRow.append(el("div", { class: "stepper" }, [
            el("button", { type: "button", "aria-label": "Menos um", text: "−", onclick: () => setQty(dish.id, qty - 1) }),
            el("b", { text: String(qty) }),
            el("button", { type: "button", "aria-label": "Mais um", text: "+", onclick: () => setQty(dish.id, qty + 1) })
          ]));
        }
      }
      body.append(buyRow);

      const shareBtn = el("button", {
        class: "btn ghost", type: "button",
        text: "Enviar este prato",
        onclick: () => shareDish(dish)
      });
      body.append(shareBtn);
    });
  }

  /* ---------- chamar garçom ---------- */
  let waiterCooldown = false;

  function callWaiterSheet() {
    openSheet("Chamar garçom", (body) => {
      let currentMesa = activeMesa || store.get(`cf.mesa.${slug}`, "");
      let mesaInput;
      if (!currentMesa) {
        mesaInput = el("input", { type: "text", maxlength: "12", placeholder: "Ex: 4 ou mesaum", autocomplete: "off" });
        body.append(
          el("p", { text: "Indica o número ou nome da tua mesa para o garçom saber onde ir:" }),
          el("label", { class: "field" }, [el("span", { text: "Mesa *" }), mesaInput])
        );
      } else {
        body.append(el("p", { text: `Vais chamar o garçom para a mesa ${currentMesa}.` }));
      }
      const note = el("textarea", { rows: "2", maxlength: "100", placeholder: "Ex: pode trazer a conta, mais água…" });
      body.append(el("label", { class: "field" }, [el("span", { text: "Mensagem (opcional)" }), note]));

      const btn = el("button", {
        class: "btn", type: "button",
        html: `<span style="display:inline-flex;align-items:center;gap:8px;justify-content:center">${ICON.bell} ${currentMesa ? `Chamar garçom · Mesa ${currentMesa}` : "Chamar garçom"}</span>`
      });
      if (waiterCooldown) {
        btn.disabled = true;
        btn.textContent = "Garçom já chamado";
      }
      btn.addEventListener("click", async () => {
        if (preview) { toast("Pré-visualização: o sinal não é enviado"); return; }
        if (waiterCooldown) return;
        const targetMesa = (currentMesa || mesaInput?.value || "").trim().replace(/[^\w-]/g, "");
        if (!targetMesa) {
          toast("Por favor indica o número ou nome da tua mesa.");
          mesaInput?.focus();
          return;
        }
        if (!currentMesa) {
          activeMesa = targetMesa;
          store.set(`cf.mesa.${slug}`, targetMesa);
          $("mesaLabel").textContent = `· Mesa ${targetMesa}`;
        }
        btn.disabled = true;
        btn.textContent = "A avisar o garçom…";
        try {
          await api("/api/call-waiter", {
            method: "POST",
            body: { restaurantId: data.restaurant.id, mesa: targetMesa, note: note.value }
          });
          waiterCooldown = true;
          toast(`✔ Garçom avisado para a mesa ${targetMesa}! Vem já ter contigo.`);
          if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
          closeSheet();
          setTimeout(() => { waiterCooldown = false; }, 60_000); // 60s cooldown
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = "Tentar de novo";
        }
      });
      body.append(btn);
    });
  }

  function toggleSound() {
    muted = !muted;
    for (const v of $feed.querySelectorAll("video")) v.muted = muted;
    for (const b of $feed.querySelectorAll(".sound")) b.innerHTML = muted ? ICON.mute : ICON.sound;
  }

  /* ---------- categorias ---------- */
  let chipDefs = [];

  function renderChips() {
    chipDefs = [];
    if (data.dishes.some((d) => d.bestSeller)) chipDefs.push({ id: "__best", label: "Best seller", first: data.dishes.find((d) => d.bestSeller) });
    for (const c of data.categories) chipDefs.push({ id: c.id, label: c.label, first: data.dishes.find((d) => d.category === c.id) });
    $chips.replaceChildren(...chipDefs.filter((c) => c.first).map((c) => el("button", {
      class: "chip", type: "button", "data-cat": c.id, text: c.label,
      onclick: () => {
        $(`p-${c.first.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        setActiveChip(c.id);
      }
    })));
  }

  function setActiveChip(catId) {
    for (const chip of $chips.children) {
      const on = chip.dataset.cat === catId;
      chip.setAttribute("aria-current", String(on));
      if (on) chip.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    }
  }

  /* ---------- observação do scroll ---------- */
  function observe() {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const node = e.target;
        const id = node.dataset.id;
        if (e.isIntersecting && e.intersectionRatio >= VISIBLE_RATIO) {
          startView(id);
          const dish = byId.get(id);
          setActiveChip(dish.category);
          const vids = node.querySelectorAll("video");
          for (const v of vids) {
            if (!v.src && v.dataset.src) v.src = v.dataset.src;
            v.muted = muted;
            v.play().catch(() => {});
          }
        } else {
          stopView(id);
          for (const v of node.querySelectorAll("video")) v.pause();
        }
      }
    }, { root: $feed, threshold: [0, VISIBLE_RATIO, 1] });

    const pre = new IntersectionObserver((entries) => {
      for (const e of entries) {
        for (const v of e.target.querySelectorAll("video")) {
          if (e.isIntersecting && !v.src && v.dataset.src) { v.preload = "metadata"; v.src = v.dataset.src; }
        }
      }
    }, { root: $feed, rootMargin: "100% 0px 100% 0px" });

    for (const node of $feed.children) { io.observe(node); pre.observe(node); }
  }

  /* ---------- painéis (sheets) ---------- */
  let closeSheet = () => {};

  function openSheet(title, build) {
    closeSheet();
    const body = el("div", { class: "body" });
    const sheet = el("section", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title }, [
      el("div", { class: "grab" }),
      el("header", {}, [el("h2", { text: title }), el("button", { class: "x", type: "button", "aria-label": "Fechar", text: "✕", onclick: () => closeSheet() })]),
      body
    ]);
    const backdrop = el("div", { class: "backdrop", onclick: () => closeSheet() });
    const onKey = (e) => { if (e.key === "Escape") closeSheet(); };
    document.addEventListener("keydown", onKey);
    $sheetRoot.replaceChildren(backdrop, sheet);
    closeSheet = () => {
      document.removeEventListener("keydown", onKey);
      $sheetRoot.replaceChildren();
      ordersSheetOpen = false;
      closeSheet = () => {};
    };
    build(body);
    sheet.querySelector(".x").focus({ preventScroll: true });
  }

  function infoSheet() {
    openSheet(data.restaurant.name, (body) => {
      if (settings.welcome) body.append(el("p", { text: settings.welcome }));
      const currentM = activeMesa || mesa || store.get(`cf.mesa.${slug}`, "");
      if (currentM) body.append(el("p", { class: "muted", text: `Estás na mesa ${currentM}. Os pedidos chegam diretamente à cozinha.` }));
      if (settings.orderingEnabled) body.append(el("button", { class: "btn", type: "button", text: "Os meus pedidos", onclick: ordersSheet }));
      body.append(el("button", {
        class: "btn ghost", type: "button",
        html: `<span style="display:inline-flex;align-items:center;gap:8px;justify-content:center">${ICON.bell} Chamar garçom</span>`,
        onclick: () => { closeSheet(); callWaiterSheet(); }
      }));
      if (settings.whatsapp) body.append(el("a", { class: "btn ghost", href: `https://wa.me/${settings.whatsapp}`, target: "_blank", rel: "noopener", text: "Falar no WhatsApp" }));
      if (settings.instagram) body.append(el("a", { class: "btn ghost", href: `https://instagram.com/${settings.instagram}`, target: "_blank", rel: "noopener", text: `Instagram @${settings.instagram}` }));
    });
  }

  /* ---------- bandeja e pedidos ---------- */
  function traySheet() {
    openSheet("O teu pedido", (body) => {
      const render = () => {
        if (!cart.size) { closeSheet(); return; }
        body.replaceChildren();
        for (const [id, qty] of cart) {
          const d = byId.get(id);
          if (!d) continue;
          body.append(el("div", { class: "line" }, [
            el("span", { class: "n", text: d.name }),
            el("span", { class: "t", text: money(d.price * qty) }),
            el("div", { class: "stepper" }, [
              el("button", { type: "button", "aria-label": "Menos um", text: "−", onclick: () => { setQty(id, qty - 1); render(); } }),
              el("b", { text: String(qty) }),
              el("button", { type: "button", "aria-label": "Mais um", text: "+", onclick: () => { setQty(id, qty + 1); render(); } })
            ])
          ]));
        }
        body.append(el("div", { class: "total" }, [el("span", { text: "Total" }), el("span", { text: money(cartTotal()) })]));
        if (settings.minOrder > cartTotal()) body.append(el("p", { class: "muted", text: `Pedido mínimo: ${money(settings.minOrder)}` }));
        const name = el("input", { type: "text", maxlength: "40", autocomplete: "given-name", placeholder: "Opcional" });
        const note = el("textarea", { rows: "2", maxlength: "200", placeholder: "Sem cebola, bem passado…" });
        body.append(
          el("label", { class: "field" }, [el("span", { text: "O teu nome" }), name]),
          el("label", { class: "field" }, [el("span", { text: "Observações" }), note])
        );
        const send = el("button", { class: "btn", type: "button", text: mesa ? `Enviar à cozinha · Mesa ${mesa}` : "Enviar à cozinha" });
        send.addEventListener("click", async () => {
          if (preview) { toast("Pré-visualização: o pedido não é enviado"); return; }
          send.disabled = true;
          send.textContent = "A enviar…";
          try {
            const out = await api("/api/orders", {
              method: "POST",
              body: { restaurantId: data.restaurant.id, sessionId, mesa, name: name.value, note: note.value, items: [...cart].map(([dishId, qty]) => ({ dishId, qty })) }
            });
            cart = new Map();
            persistCart();
            for (const b of $feed.querySelectorAll(".buy")) renderBuy(b, byId.get(b.closest(".dish").dataset.id));
            myOrders = [out.order, ...myOrders.filter((o) => o.id !== out.order.id)];
            updateTray();
            ordersSheet();
          } catch (err) {
            toast(err.message);
            send.disabled = false;
            send.textContent = "Tentar de novo";
          }
        });
        body.append(send);
      };
      render();
    });
  }

  async function refreshOrders() {
    if (preview || !data) return;
    try {
      const out = await api(`/api/myorders?restaurantId=${data.restaurant.id}&sessionId=${encodeURIComponent(sessionId)}`);
      const was = JSON.stringify(myOrders.map((o) => [o.id, o.status]));
      myOrders = out.orders;
      if (JSON.stringify(myOrders.map((o) => [o.id, o.status])) !== was) {
        updateTray();
        if (ordersSheetOpen) ordersSheet(true);
        const ready = myOrders.find((o) => o.status === "pronto");
        if (ready && !store.get(`cf.ready.${ready.id}`, false)) {
          store.set(`cf.ready.${ready.id}`, true);
          toast(`Pedido ${ready.code} pronto!`);
          if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
        }
      }
    } catch (_) { /* offline: tenta no próximo ciclo */ }
  }

  function ordersSheet(silent = false) {
    ordersSheetOpen = true;
    const build = (body) => {
      if (!myOrders.length) { body.append(el("p", { class: "muted", text: "Ainda não fizeste nenhum pedido." })); return; }
      for (const o of myOrders) {
        const st = STATUS[o.status] || STATUS.novo;
        const card = el("div", { class: "order-card" }, [
          el("div", { class: "row" }, [el("span", { class: "code", text: o.code }), el("span", { class: "status-pill", text: st.label })]),
          el("ul", {}, o.items.map((i) => el("li", { text: `${i.qty}× ${i.name}` }))),
          el("div", { class: "row" }, [el("span", { class: "muted", text: o.mesa ? `Mesa ${o.mesa}` : "Sem mesa" }), el("b", { text: money(o.total) })])
        ]);
        if (st.step >= 0) {
          card.append(
            el("div", { class: "steps" }, [0, 1, 2, 3].map((i) => el("i", { class: i <= st.step ? "on" : "" }))),
            el("div", { class: "steps-l" }, ["Recebido", "Preparo", "Pronto", "Entregue"].map((t) => el("span", { text: t })))
          );
        }
        if (o.status === "novo" && Date.now() - o.createdAt < 180_000) {
          card.append(el("button", {
            class: "btn ghost", type: "button", text: "Cancelar pedido",
            onclick: async () => {
              try { await api(`/api/orders/${o.id}/cancel`, { method: "POST", body: { sessionId } }); toast("Pedido cancelado"); refreshOrders(); }
              catch (err) { toast(err.message); }
            }
          }));
        }
        body.append(card);
      }
    };
    if (silent && $sheetRoot.querySelector(".sheet")) {
      const body = $sheetRoot.querySelector(".sheet .body");
      body.replaceChildren();
      build(body);
      return;
    }
    openSheet("Os meus pedidos", build);
    ordersSheetOpen = true;
    refreshOrders();
  }

  function updateTray() {
    const n = cartCount();
    const active = myOrders.find((o) => ["novo", "preparo", "pronto"].includes(o.status));
    if (n) {
      $tray.hidden = false;
      $tray.onclick = traySheet;
      $tray.replaceChildren(el("span", { text: `Ver pedido · ${n} ${n === 1 ? "item" : "itens"}` }), el("span", { text: money(cartTotal()) }));
    } else if (active) {
      $tray.hidden = false;
      $tray.onclick = () => ordersSheet();
      $tray.replaceChildren(el("span", { text: `Pedido ${active.code}` }), el("span", { text: STATUS[active.status].label }));
    } else {
      $tray.hidden = true;
    }
    document.body.classList.toggle("has-tray", !$tray.hidden);
  }

  /* ---------- arranque ---------- */
  async function init() {
    const skeleton = el("div", { class: "dish" }, [el("div", { class: "skeleton" })]);
    $feed.replaceChildren(skeleton);
    try {
      data = await api(`/api/menu${slug ? `?slug=${encodeURIComponent(slug)}` : ""}`, { headers: {} });
    } catch (err) {
      $feed.replaceChildren(el("p", { class: "msg", text: err.message || "Não foi possível carregar o cardápio." }));
      return;
    }
    settings = data.restaurant.settings;
    for (const d of data.dishes) byId.set(d.id, d);
    // limpa do carrinho pratos que já não existem ou esgotaram
    for (const id of [...cart.keys()]) if (!byId.has(id) || byId.get(id).soldOut) cart.delete(id);

    applyTheme(settings);
    document.title = data.restaurant.name;
    $("brandName").textContent = data.restaurant.name;
    const initialMesa = activeMesa || mesa || store.get(`cf.mesa.${slug}`, "");
    if (initialMesa) $("mesaLabel").textContent = `· Mesa ${initialMesa}`;
    $("infoBtn").addEventListener("click", infoSheet);

    if (!data.dishes.length) {
      $feed.replaceChildren(el("div", { class: "dish" }, [el("div", { class: "empty", text: "O cardápio ainda está vazio. Volta daqui a pouco." })]));
      return;
    }

    const order = data.categories.map((c) => c.id);
    const sorted = [...data.dishes].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
    $feed.replaceChildren(...sorted.map(buildDish));
    renderChips();
    observe();
    updateTray();

    if (location.hash.length > 1) $(`p-${decodeURIComponent(location.hash.slice(1))}`)?.scrollIntoView({ block: "start" });

    if (!preview) {
      refreshOrders();
      setInterval(() => { if (!document.hidden && (myOrders.some((o) => ["novo", "preparo", "pronto"].includes(o.status)) || ordersSheetOpen)) refreshOrders(); }, 8000);
      setInterval(() => { if (!document.hidden) flush(); }, 12000);
      flush();
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) { flush(true); for (const v of $feed.querySelectorAll("video")) v.pause(); }
        else refreshOrders();
      });
      addEventListener("pagehide", () => flush(true));
      if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
    }
  }

  // Pré-visualização ao vivo vinda do painel (mesma origem).
  addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== "cf-preview") return;
    settings = { ...settings, ...e.data.settings };
    applyTheme(settings);
    if (e.data.name) $("brandName").textContent = e.data.name;
  });

  init();
})();
