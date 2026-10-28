/* Painel do restaurante: pedidos em tempo real, métricas, editor do cardápio, mesas/QR, aparência e conta. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TABS = [
    ["pedidos", "Pedidos"], ["garcom", "Garçom"], ["metricas", "Métricas"], ["cardapio", "Cardápio"],
    ["mesas", "Mesas e QR"], ["aparencia", "Aparência"], ["conta", "Conta"]
  ];
  const THEMES = [
    { id: "noite", name: "Noite", desc: "Escuro e cinematográfico, letra itálica.", bg: "#0b0b0b", ink: "#f6f1ea", accent: "#ff7a3d", card: "transparent" },
    { id: "creme", name: "Creme", desc: "Claro e editorial, cartão creme sobre a foto.", bg: "#fbf6ea", ink: "#17301f", accent: "#1f5b3a", card: "#fbf6ea" },
    { id: "floresta", name: "Floresta", desc: "Verde profundo com vidro e verde-lima.", bg: "#0e2316", ink: "#eaf5e4", accent: "#b7f34a", card: "#0e2316" },
    { id: "brasa", name: "Brasa", desc: "Ousado: letras grandes, vermelho e amarelo.", bg: "#c8321d", ink: "#fff3e8", accent: "#ffcf1f", card: "#c8321d" },
    { id: "oceano", name: "Oceano", desc: "Azul profundo com vidro e turquesa.", bg: "#0a2036", ink: "#e8f4ff", accent: "#2de2c4", card: "#0a2036" }
  ];
  const ACCENTS = ["#ff7a3d", "#e5484d", "#ffcf1f", "#b7f34a", "#2de2c4", "#4c8dff", "#9b6bff", "#f48fb1"];
  const STATUS_LABEL = { novo: "Novo", preparo: "Em preparo", pronto: "Pronto", entregue: "Entregue", cancelado: "Cancelado" };
  const NEXT = { novo: ["preparo", "Iniciar preparo"], preparo: ["pronto", "Marcar pronto"], pronto: ["entregue", "Entregue ao cliente"] };

  const S = {
    token: read("cf.token"), user: null, restaurant: null, tab: "pedidos",
    orders: [], fresh: new Set(), online: 0, sound: read("cf.sound") !== "0",
    waiterCalls: [], freshCalls: new Set(),
    menu: null, menuSnap: "", dirty: false, expanded: new Set(),
    tables: [], range: "7d", metrics: null, sort: "views",
    look: null, lookSnap: "", es: null
  };

  function read(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function write(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} }

  /* ---------- util ---------- */
  function el(tag, props = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v; // apenas strings estáticas
      else if (k === "value" || k === "checked" || k === "disabled" || k === "selected" || k === "open") n[k] = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children)) if (c != null && c !== false) n.append(c);
    return n;
  }
  const clear = (n) => n.replaceChildren();
  const fmt = new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0 });
  const cur = () => S.restaurant?.settings?.currency || "MT";
  const money = (v) => `${fmt.format(v || 0)} ${cur()}`;
  const slugify = (t) => String(t).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const rand = () => Math.random().toString(36).slice(2, 6);

  function ago(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return "agora";
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  }

  function secs(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}min ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}min`;
  }

  let toastTimer;
  function toast(msg, isErr = false) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("err", isErr);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), isErr ? 4200 : 2400);
  }

  async function api(path, { method = "GET", body, raw, headers = {} } = {}) {
    const h = { ...headers };
    if (S.token) h.Authorization = `Bearer ${S.token}`;
    let payload;
    if (raw) payload = raw;
    else if (body !== undefined) { h["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(path, { method, headers: h, body: payload });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && S.token) { logout(true); throw new Error(json.error || "Sessão expirada."); }
    if (!res.ok) throw new Error(json.error || "Algo correu mal. Tenta de novo.");
    return json;
  }

  async function guard(btn, fn) {
    const label = btn?.textContent;
    if (btn) { btn.disabled = true; }
    try { return await fn(); }
    catch (err) { toast(err.message, true); }
    finally { if (btn) { btn.disabled = false; if (label != null) btn.textContent = label; } }
  }

  function modal(content) {
    const root = $("modalRoot");
    const close = () => { clear(root); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    root.replaceChildren(el("div", { class: "modal-bg", onclick: (e) => { if (e.target.classList.contains("modal-bg")) close(); } },
      [el("div", { class: "modal", role: "dialog", "aria-modal": "true" }, [content, el("button", { class: "btn", type: "button", text: "Fechar", style: "margin-top:14px", onclick: close })])]));
    return close;
  }

  const publicUrl = (mesa) => `${location.origin}/r/${S.restaurant.slug}${mesa ? `?mesa=${encodeURIComponent(mesa)}` : ""}`;
  const qrSrc = (url, size = 300) => `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&data=${encodeURIComponent(url)}`;

  /* ---------- sons ---------- */
  let actx;
  function beep() {
    if (!S.sound) return;
    try {
      actx ||= new (window.AudioContext || window.webkitAudioContext)();
      [[880, 0], [660, 0.26]].forEach(([freq, at]) => {
        const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + at;
        o.type = "sine"; o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.03); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
        o.start(t); o.stop(t + 0.5);
      });
    } catch (_) { /* sem áudio */ }
  }

  function bellSound() {
    if (!S.sound) return;
    try {
      actx ||= new (window.AudioContext || window.webkitAudioContext)();
      [[987, 0], [1318, 0.14], [987, 0.32]].forEach(([freq, at]) => {
        const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + at;
        o.type = "sine"; o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.start(t); o.stop(t + 0.4);
      });
    } catch (_) { /* sem áudio */ }
  }

  /* ================= ENTRAR ================= */
  function showLogin(mode = "login", message = "") {
    $("app").hidden = true;
    const root = $("login");
    root.hidden = false;
    const isReg = mode === "register";
    const err = el("div", { class: "err", role: "alert", text: message });
    const email = el("input", { type: "email", autocomplete: "email", required: true, placeholder: "tu@restaurante.co.mz" });
    const pass = el("input", { type: "password", autocomplete: isReg ? "new-password" : "current-password", required: true, minlength: "8", placeholder: isReg ? "Pelo menos 8 caracteres" : "" });
    const name = el("input", { type: "text", maxlength: "60", required: true, placeholder: "Café do Mane" });
    const submit = el("button", { class: "btn primary", type: "submit", text: isReg ? "Criar conta" : "Entrar" });
    const form = el("form", { novalidate: true }, [
      isReg ? el("label", { class: "f" }, [el("span", { text: "Nome do restaurante" }), name]) : null,
      el("label", { class: "f" }, [el("span", { text: "Email" }), email]),
      el("label", { class: "f" }, [el("span", { text: "Senha" }), pass]),
      err, submit
    ]);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      submit.disabled = true;
      try {
        const out = await fetch(isReg ? "/api/auth/register" : "/api/auth/login", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.value, password: pass.value, restaurantName: name.value })
        });
        const json = await out.json().catch(() => ({}));
        if (!out.ok) throw new Error(json.error || "Não foi possível entrar.");
        S.token = json.token; write("cf.token", S.token);
        S.user = json.user; S.restaurant = json.restaurant;
        enterApp();
      } catch (ex) { err.textContent = ex.message; submit.disabled = false; }
    });
    clear(root);
    root.append(el("div", { class: "box card" }, [
      el("h1", { text: "Cardápio em Feed" }),
      el("p", { class: "muted", text: isReg ? "Cria a conta do teu restaurante. Em poucos minutos tens o cardápio no ar." : "Entra para ver pedidos, métricas e editar o cardápio." }),
      form,
      el("p", { class: "small", style: "margin:14px 0 0" }, [
        isReg ? "Já tens conta? " : "Ainda não tens conta? ",
        el("button", { class: "link-btn", type: "button", text: isReg ? "Entrar" : "Criar conta", onclick: () => showLogin(isReg ? "login" : "register") })
      ])
    ]));
    (isReg ? name : email).focus();
  }

  function logout(expired = false) {
    if (S.token && !expired) fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${S.token}` } }).catch(() => {});
    S.token = null; write("cf.token", null);
    S.es?.close(); S.es = null;
    S.dirty = false; S.lookDirty = false;
    showLogin("login", expired ? "A sessão terminou. Entra de novo." : "");
  }

  /* ================= ESTRUTURA ================= */
  async function enterApp() {
    $("login").hidden = true;
    $("app").hidden = false;
    $("rName").textContent = S.restaurant.name;
    $("viewLink").href = publicUrl("");
    $("btnSound").setAttribute("aria-pressed", String(S.sound));
    $("btnSound").onclick = () => {
      S.sound = !S.sound; write("cf.sound", S.sound ? "1" : "0");
      $("btnSound").setAttribute("aria-pressed", String(S.sound));
      if (S.sound) beep();
      toast(S.sound ? "Som ligado" : "Som desligado");
    };
    connect();
    await Promise.all([loadOrders(), loadWaiterCalls()]);
    const want = location.hash.slice(1);
    setTab(TABS.some(([id]) => id === want) ? want : "pedidos", true);
  }

  function renderTabs() {
    const active = S.orders.filter((o) => o.status === "novo").length;
    const waiterActive = S.waiterCalls.filter((c) => c.status === "pendente").length;
    $("tabs").replaceChildren(...TABS.map(([id, label]) => el("button", {
      class: "tab", type: "button", role: "tab", "aria-selected": String(id === S.tab),
      onclick: () => setTab(id)
    }, [
      label,
      id === "pedidos" && active ? el("span", { class: "badge", text: String(active) }) : null,
      id === "garcom" && waiterActive ? el("span", { class: "badge waiter-badge", text: String(waiterActive) }) : null
    ])));
    let title = "Painel do restaurante";
    if (waiterActive && active) title = `(${waiterActive} 🔔 / ${active} novos) · Painel`;
    else if (waiterActive) title = `(${waiterActive} 🔔 garçom) · Painel`;
    else if (active) title = `(${active}) Pedidos novos · Painel`;
    document.title = title;
  }

  function confirmLeave() {
    if ((S.dirty && S.tab === "cardapio") || (S.lookDirty && S.tab === "aparencia")) {
      return confirm("Tens alterações por guardar. Sair mesmo assim?");
    }
    return true;
  }

  function setTab(id, force = false) {
    if (!force && id !== S.tab && !confirmLeave()) return;
    if (id !== S.tab) { S.dirty = false; S.lookDirty = false; }
    S.tab = id;
    history.replaceState(null, "", `#${id}`);
    renderTabs();
    renderView();
    scrollTo({ top: 0 });
  }

  function renderView() {
    const view = $("view");
    clear(view);
    ({ pedidos: viewOrders, garcom: viewWaiterCalls, metricas: viewMetrics, cardapio: viewMenu, mesas: viewTables, aparencia: viewLook, conta: viewAccount })[S.tab](view);
  }

  function setLive(on) {
    const n = $("live");
    n.textContent = on ? "● ao vivo" : "● sem ligação";
    n.classList.toggle("off", !on);
  }

  /* ================= TEMPO REAL ================= */
  function connect() {
    S.es?.close();
    const es = new EventSource(`/api/stream?token=${encodeURIComponent(S.token)}`);
    S.es = es;
    es.addEventListener("hello", (e) => {
      setLive(true);
      S.online = JSON.parse(e.data).online;
      loadOrders();
      loadWaiterCalls();
    });
    es.addEventListener("orders", (e) => onOrderEvent(JSON.parse(e.data)));
    es.addEventListener("metrics", (e) => { S.online = JSON.parse(e.data).online; const k = $("kOnline"); if (k) k.textContent = String(S.online); });
    es.addEventListener("waiter-call", (e) => {
      const { type, call } = JSON.parse(e.data);
      if (!call) return;
      if (type === "delete") {
        S.waiterCalls = S.waiterCalls.filter((c) => c.id !== call.id);
      } else {
        const i = S.waiterCalls.findIndex((c) => c.id === call.id);
        if (i >= 0) S.waiterCalls[i] = call;
        else S.waiterCalls.unshift(call);
        if (type === "new") {
          S.freshCalls.add(call.id);
          bellSound();
          toast(`🔔 Garçom chamado: Mesa ${call.mesa}${call.note ? ` ("${call.note}")` : ""}`);
        }
      }
      renderTabs();
      if (S.tab === "garcom" || S.tab === "pedidos") renderView();
    });
    es.onerror = () => {
      setLive(false);
      if (es.readyState === EventSource.CLOSED) {
        setTimeout(async () => {
          try { await api("/api/auth/me"); connect(); } catch (_) { /* 401 já trata do logout */ }
        }, 5000);
      }
    };
  }

  function upsertOrder(o) {
    const i = S.orders.findIndex((x) => x.id === o.id);
    if (i >= 0) S.orders[i] = o; else S.orders.unshift(o);
  }

  function onOrderEvent({ type, order }) {
    upsertOrder(order);
    if (type === "new") {
      S.fresh.add(order.id);
      beep();
      toast(`Novo pedido ${order.code}${order.mesa ? ` · Mesa ${order.mesa}` : ""}`);
      if (S.autoPrint) printTicket(order);
    }
    renderTabs();
    if (S.tab === "pedidos") renderView();
  }

  async function loadOrders() {
    try { S.orders = (await api("/api/orders")).orders; renderTabs(); if (S.tab === "pedidos" && !$("app").hidden) renderView(); }
    catch (_) { /* mantém o que tem */ }
  }

  async function loadWaiterCalls() {
    try {
      const res = await api("/api/waiter-calls");
      S.waiterCalls = res.calls || [];
      renderTabs();
      if ((S.tab === "garcom" || S.tab === "pedidos") && !$("app").hidden) renderView();
    } catch (_) { /* mantém o que tem */ }
  }

  /* ================= PEDIDOS ================= */
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function viewOrders(view) {
    const pendingCalls = S.waiterCalls.filter((c) => c.status === "pendente");
    if (pendingCalls.length) {
      view.append(el("div", {
        class: "waiter-banner",
        onclick: () => setTab("garcom")
      }, [
        el("span", { class: "icon", text: "🔔" }),
        el("div", {}, [
          el("b", { text: `${pendingCalls.length} ${pendingCalls.length === 1 ? "mesa está a chamar" : "mesas estão a chamar"} o garçom!` }),
          el("small", { text: pendingCalls.map((c) => `Mesa ${c.mesa}`).join(", ") + " — Clica aqui para atender" })
        ]),
        el("button", { class: "btn sm", type: "button", text: "Ver chamadas" })
      ]));
    }

    const today = S.orders.filter((o) => o.createdAt >= startOfToday() && o.status !== "cancelado");
    const revenue = today.reduce((n, o) => n + o.total, 0);
    const byStatus = (s) => S.orders.filter((o) => o.status === s).sort((a, b) => a.createdAt - b.createdAt);

    view.append(
      el("div", { class: "page-head" }, [
        el("div", {}, [el("h2", { text: "Pedidos" }), el("span", { class: "muted small", text: "Novos pedidos aparecem aqui sozinhos, com um aviso sonoro." })]),
        el("label", { class: "switch" }, [
          el("input", { type: "checkbox", checked: Boolean(S.autoPrint), onchange: (e) => { S.autoPrint = e.target.checked; toast(S.autoPrint ? "Impressão automática ligada" : "Impressão automática desligada"); } }),
          el("i"), "Imprimir pedidos novos"
        ])
      ]),
      el("div", { class: "kpis" }, [
        kpi(String(today.length), "pedidos hoje", "lime"),
        kpi(money(revenue), "vendido hoje"),
        kpi(String(byStatus("novo").length + byStatus("preparo").length), "por fazer"),
        el("div", { class: "kpi" }, [el("b", { id: "kOnline", text: String(S.online) }), el("span", { text: "a ver o cardápio agora" })])
      ])
    );

    const board = el("div", { class: "board" });
    for (const [st, title] of [["novo", "Novos"], ["preparo", "Em preparo"], ["pronto", "Prontos"]]) {
      const list = byStatus(st);
      board.append(el("section", { class: "col" }, [
        el("h3", {}, [title, el("span", { class: "count", text: String(list.length) })]),
        ...(list.length ? list.map(ticketCard) : [el("div", { class: "card empty small", text: "Nenhum pedido aqui." })])
      ]));
    }
    view.append(board);

    const done = S.orders.filter((o) => o.status === "entregue" || o.status === "cancelado").sort((a, b) => b.updatedAt - a.updatedAt);
    view.append(el("details", { class: "done-list", open: Boolean(S.doneOpen), ontoggle: (e) => { S.doneOpen = e.target.open; } }, [
      el("summary", { text: `Entregues e cancelados (últimas 24 h): ${done.length}` }),
      ...done.map((o) => el("div", { class: "done-row" }, [
        el("span", {}, [el("b", { text: o.code }), ` · ${o.mesa ? `Mesa ${o.mesa} · ` : ""}${o.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}`]),
        el("span", {}, [el("span", { class: `pill ${o.status === "cancelado" ? "danger" : "ok"}`, text: STATUS_LABEL[o.status] }), ` ${money(o.total)}`])
      ]))
    ]));
  }

  function kpi(value, label, cls = "") {
    return el("div", { class: `kpi ${cls}` }, [el("b", { text: value }), el("span", { text: label })]);
  }

  function ticketCard(o) {
    const late = o.status === "novo" && Date.now() - o.createdAt > 8 * 60000;
    const next = NEXT[o.status];
    const card = el("article", { class: `ticket${late ? " late" : ""}${S.fresh.has(o.id) ? " fresh" : ""}` }, [
      el("div", { class: "head" }, [
        el("span", { class: "code", text: o.code }),
        el("span", {}, [o.mesa ? el("span", { class: "pill lime", text: `Mesa ${o.mesa}` }) : el("span", { class: "pill", text: "Sem mesa" }), " ", el("span", { class: `pill ${late ? "warn" : ""}`, text: ago(o.createdAt) })])
      ]),
      el("ul", {}, o.items.map((i) => el("li", {}, [el("b", { text: `${i.qty}×` }), i.name, i.note ? el("small", { text: i.note }) : null]))),
      o.name || o.note ? el("div", { class: "note", text: [o.name && `Cliente: ${o.name}`, o.note].filter(Boolean).join(" · ") }) : null,
      el("div", { class: "foot" }, [el("span", { class: "muted small", text: "Total" }), el("span", { text: money(o.total) })]),
      el("div", { class: "acts" }, [
        next ? el("button", { class: "btn primary", type: "button", text: next[1], onclick: (e) => setStatus(o, next[0], e.currentTarget) }) : null,
        el("button", { class: "btn sm", type: "button", text: "Imprimir", onclick: () => printTicket(o) }),
        el("button", { class: "btn sm danger", type: "button", text: "Cancelar", onclick: (e) => { if (confirm(`Cancelar o pedido ${o.code}?`)) setStatus(o, "cancelado", e.currentTarget); } })
      ])
    ]);
    setTimeout(() => S.fresh.delete(o.id), 1500);
    return card;
  }

  async function setStatus(order, status, btn) {
    await guard(btn, async () => {
      const out = await api(`/api/orders/${order.id}`, { method: "PATCH", body: { status } });
      upsertOrder(out.order);
      renderTabs();
      renderView();
    });
  }

  function printTicket(o) {
    const area = $("printArea");
    area.replaceChildren(
      el("div", { class: "tk-code", text: o.code }),
      el("div", { style: "text-align:center", text: `${S.restaurant.name}${o.mesa ? ` · MESA ${o.mesa}` : ""}` }),
      el("div", { style: "text-align:center", text: new Date(o.createdAt).toLocaleString("pt-PT") }),
      el("div", { class: "tk-sep" }),
      ...o.items.flatMap((i) => [
        el("div", { class: "tk-line" }, [el("span", { text: `${i.qty}× ${i.name}` }), el("span", { text: money(i.qty * i.price) })]),
        i.note ? el("div", { class: "tk-note", text: i.note }) : null
      ]),
      el("div", { class: "tk-sep" }),
      el("div", { class: "tk-line" }, [el("b", { text: "TOTAL" }), el("b", { text: money(o.total) })]),
      o.name ? el("div", { text: `Cliente: ${o.name}` }) : null,
      o.note ? el("div", { text: `Obs: ${o.note}` }) : null
    );
    document.body.classList.add("print-ticket");
    setTimeout(() => { print(); document.body.classList.remove("print-ticket"); }, 50);
  }

  setInterval(() => { if (S.token && (S.tab === "pedidos" || S.tab === "garcom") && !document.hidden && !$("app").hidden) renderView(); }, 30000);

  /* ================= GARÇOM ================= */
  function viewWaiterCalls(view) {
    const pending = S.waiterCalls.filter((c) => c.status === "pendente");
    const today = S.waiterCalls.filter((c) => c.createdAt >= startOfToday());
    const attendedToday = today.filter((c) => c.status === "atendido");

    view.append(
      el("div", { class: "page-head" }, [
        el("div", {}, [
          el("h2", { text: "Chamadas de Garçom" }),
          el("span", { class: "muted small", text: "Mesas que solicitaram atendimento no salão em tempo real." })
        ]),
        el("button", {
          class: "btn sm", type: "button", text: "Atualizar",
          onclick: () => loadWaiterCalls()
        })
      ]),
      el("div", { class: "kpis" }, [
        kpi(String(pending.length), "chamadas a aguardar", pending.length ? "warn" : "lime"),
        kpi(String(attendedToday.length), "atendidas hoje"),
        kpi(String(today.length), "total de chamadas hoje"),
        el("div", { class: "kpi" }, [el("b", { text: String(S.online) }), el("span", { text: "clientes no cardápio" })])
      ])
    );

    if (pending.length) {
      view.append(
        el("h3", { style: "margin: 18px 0 10px;", text: `A aguardar atendimento (${pending.length})` }),
        el("div", { class: "waiter-grid" }, pending.map(waiterCallCard))
      );
    } else {
      view.append(
        el("div", { class: "card empty", style: "margin: 20px 0;" }, [
          el("div", { style: "font-size: 2.2rem; margin-bottom: 6px;", text: "🔔" }),
          el("b", { text: "Nenhuma chamada pendente" }),
          el("p", { class: "muted", style: "margin: 0;", text: "Todas as mesas foram atendidas. Quando um cliente chamar pelo cardápio, toca um sinal sonoro e o pedido aparece aqui!" })
        ])
      );
    }

    const done = S.waiterCalls.filter((c) => c.status !== "pendente");
    if (done.length) {
      view.append(el("details", { class: "waiter-history", open: false }, [
        el("summary", { text: `Histórico de chamadas atendidas (${done.length})` }),
        ...done.map((c) => el("div", { class: "waiter-history-row" }, [
          el("span", {}, [
            el("b", { text: `Mesa ${c.mesa}` }),
            c.note ? ` · "${c.note}"` : "",
            el("span", { class: "muted small", style: "margin-left:8px;", text: `chamou às ${new Date(c.createdAt).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" })}` })
          ]),
          el("div", { style: "display:flex;align-items:center;gap:6px;" }, [
            el("span", { class: `pill ${c.status === "atendido" ? "ok" : "danger"}`, text: c.status === "atendido" ? "Atendido" : "Cancelado" }),
            el("button", {
              class: "btn sm danger", type: "button", style: "padding: 2px 8px; font-size: .75rem;", text: "✕", title: "Remover",
              onclick: (e) => deleteWaiterCall(c, e.currentTarget)
            })
          ])
        ]))
      ]));
    }
  }

  function waiterCallCard(c) {
    const isFresh = S.freshCalls.has(c.id);
    const card = el("article", { class: `waiter-card${isFresh ? " fresh" : ""}` }, [
      el("div", { class: "card-top" }, [
        el("div", {}, [
          el("span", { class: "pill warn", style: "font-size:.68rem; margin-bottom:4px;", text: "Aguardando" }),
          el("div", { class: "mesa-num", text: `Mesa ${c.mesa}` })
        ]),
        el("span", { class: "pill", text: ago(c.createdAt) })
      ]),
      c.note ? el("div", { class: "mesa-note", text: `"${c.note}"` }) : el("div", { class: "muted small", text: "Sem mensagem adicional." }),
      el("div", { class: "acts" }, [
        el("button", {
          class: "btn primary", type: "button", text: "✓ Atender Mesa",
          onclick: (e) => setWaiterStatus(c, "atendido", e.currentTarget)
        }),
        el("button", {
          class: "btn sm danger", type: "button", text: "Descartar",
          onclick: (e) => { if (confirm(`Descartar chamada da mesa ${c.mesa}?`)) deleteWaiterCall(c, e.currentTarget); }
        })
      ])
    ]);
    setTimeout(() => S.freshCalls.delete(c.id), 2500);
    return card;
  }

  async function setWaiterStatus(call, status, btn) {
    await guard(btn, async () => {
      const res = await api(`/api/waiter-calls/${call.id}`, { method: "PATCH", body: { status } });
      const i = S.waiterCalls.findIndex((x) => x.id === call.id);
      if (i >= 0) S.waiterCalls[i] = res.call;
      renderTabs();
      renderView();
      toast(`Mesa ${call.mesa} marcada como atendida!`);
    });
  }

  async function deleteWaiterCall(call, btn) {
    await guard(btn, async () => {
      await api(`/api/waiter-calls/${call.id}`, { method: "DELETE" });
      S.waiterCalls = S.waiterCalls.filter((x) => x.id !== call.id);
      renderTabs();
      renderView();
      toast("Chamada removida.");
    });
  }

  /* ================= MÉTRICAS ================= */
  async function ensureMenu() {
    if (S.menu) return;
    const out = await api("/api/menu/full");
    S.menu = { categories: out.categories, dishes: out.dishes };
    S.menuSnap = JSON.stringify(S.menu);
  }

  async function viewMetrics(view) {
    view.append(el("div", { class: "empty", text: "A carregar métricas…" }));
    let m;
    try {
      [m] = await Promise.all([api(`/api/metrics?range=${S.range}`), ensureMenu()]);
    } catch (err) { clear(view); view.append(el("div", { class: "empty", text: err.message })); return; }
    if (S.tab !== "metricas") return;
    S.metrics = m;
    S.online = m.online;
    clear(view);
    const t = m.totals;

    const pills = el("div", { class: "pills" }, [["today", "Hoje"], ["7d", "7 dias"], ["30d", "30 dias"], ["all", "Tudo"]].map(([id, label]) =>
      el("button", { type: "button", "aria-pressed": String(S.range === id), text: label, onclick: () => { S.range = id; renderView(); } })));

    view.append(
      el("div", { class: "page-head" }, [
        el("div", {}, [el("h2", { text: "Métricas" }), el("span", { class: "muted small", text: "O que os clientes veem, guardam e pedem." })]),
        el("div", { class: "row" }, [pills, el("button", { class: "btn sm", type: "button", text: "Exportar CSV", onclick: exportCsv })])
      ]),
      el("div", { class: "kpis" }, [
        el("div", { class: "kpi lime" }, [el("b", { id: "kOnline", text: String(m.online) }), el("span", { text: "a ver agora" })]),
        kpi(String(t.orders), "pedidos"),
        kpi(money(t.revenue), "vendas"),
        kpi(t.orders ? money(t.revenue / t.orders) : "—", "pedido médio"),
        kpi(fmt.format(t.views), "visualizações de pratos"),
        kpi(t.views ? secs(t.ms / t.views) : "—", "tempo médio por prato"),
        kpi(String(t.favs), "favoritos")
      ]),
      el("div", { class: "charts" }, [
        chart("Visualizações por dia", m.series, "views", "#1f5b3a"),
        chart("Pedidos por dia", m.series, "orders", "#d98324")
      ]),
      el("div", { class: "funnel" }, [
        step(fmt.format(t.views), "viram pratos"), arrow(pct(t.favs, t.views)),
        step(String(t.favs), "guardaram"), arrow(pct(t.items, t.views)),
        step(String(t.items), "itens pedidos")
      ])
    );

    const sorts = [["views", "Mais vistos"], ["qty", "Mais pedidos"], ["ms", "Mais tempo"], ["favs", "Mais guardados"]];
    const dishes = S.menu.dishes.map((d) => ({ d, p: m.per[d.id] || { views: 0, ms: 0, favs: 0, taps: 0, qty: 0, revenue: 0 } }))
      .sort((a, b) => b.p[S.sort] - a.p[S.sort]);
    const maxMs = Math.max(1, ...dishes.map((x) => x.p.ms));
    const topQty = Math.max(...dishes.map((x) => x.p.qty));

    const card = el("div", { class: "card" }, [
      el("div", { class: "row", style: "margin-bottom:6px" }, [el("h3", { text: "Pratos" }), el("span", { class: "spacer" }),
        el("div", { class: "pills" }, sorts.map(([id, label]) => el("button", { type: "button", "aria-pressed": String(S.sort === id), text: label, onclick: () => { S.sort = id; renderView(); } })))])
    ]);
    if (!dishes.length) card.append(el("div", { class: "empty", text: "Ainda não tens pratos." }));
    for (const { d, p } of dishes) {
      const avg = p.views ? p.ms / p.views : 0;
      const flags = [];
      if (p.qty > 0 && p.qty === topQty) flags.push(el("span", { class: "pill ok", text: "Campeão de pedidos" }));
      if (p.views >= 5 && p.qty === 0 && avg >= 6000) flags.push(el("span", { class: "pill warn", text: "Muito olhado, ninguém pede" }));
      card.append(el("div", { class: "dish-row" }, [
        thumb(d),
        el("div", {}, [
          el("div", { class: "row" }, [el("b", { text: d.name }), ...flags]),
          el("div", { class: "bar" }, [el("i", { style: `width:${Math.round((p.ms / maxMs) * 100)}%` })]),
          el("div", { class: "stats" }, [
            stat(p.views, "vistas"), stat(p.views ? secs(avg) : "—", "tempo médio"), stat(p.favs, "guardados"), stat(p.qty, "pedidos"), stat(money(p.revenue), "vendas")
          ])
        ])
      ]));
    }
    view.append(card);
  }

  const step = (b, label) => el("div", { class: "step" }, [el("b", { text: b }), el("span", { class: "muted small", text: label })]);
  const pct = (a, b) => (b > 0 && a <= b ? `${Math.round((a / b) * 100)}%` : "—");
  const arrow = (v) => el("div", { class: "arrow", text: `→ ${v}` });
  const stat = (v, label) => el("span", {}, [el("b", { text: String(v) }), ` ${label}`]);

  function thumb(d) {
    const t = el("div", { class: "thumb" });
    const src = d.image || d.poster;
    if (src) t.append(el("img", { src, alt: "", loading: "lazy" }));
    else { t.style.background = `linear-gradient(160deg, ${d.colors?.[0] || "#333"}, ${d.colors?.[1] || "#666"})`; t.textContent = d.emoji || "🍽️"; }
    return t;
  }

  function chart(title, series, key, color) {
    const NS = "http://www.w3.org/2000/svg";
    const total = series.reduce((n, s) => n + s[key], 0);
    const max = Math.max(1, ...series.map((s) => s[key]));
    const W = 300, H = 130, pad = 4, bw = (W - pad * 2) / series.length;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${title}: ${total} no total`);
    series.forEach((s, i) => {
      const h = Math.max(s[key] ? 3 : 1, (s[key] / max) * (H - 14));
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", pad + i * bw + bw * 0.12); r.setAttribute("y", H - h);
      r.setAttribute("width", Math.max(1, bw * 0.76)); r.setAttribute("height", h);
      r.setAttribute("rx", 2); r.setAttribute("fill", s[key] ? color : "#e3dcc8");
      const tt = document.createElementNS(NS, "title"); tt.textContent = `${s.day.slice(8)}/${s.day.slice(5, 7)}: ${s[key]}`;
      r.append(tt); svg.append(r);
    });
    const fmtDay = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
    return el("div", { class: "card chart" }, [
      el("h3", {}, [title, el("span", { class: "muted small", text: `${total} no total` })]),
      svg,
      el("div", { class: "axis" }, [el("span", { text: fmtDay(series[0].day) }), el("span", { text: fmtDay(series[series.length - 1].day) })])
    ]);
  }

  function exportCsv() {
    const m = S.metrics;
    const rows = [["Prato", "Categoria", "Visualizações", "Tempo total (s)", "Tempo médio (s)", "Favoritos", "Toques", "Itens pedidos", `Vendas (${cur()})`]];
    for (const d of S.menu.dishes) {
      const p = m.per[d.id] || { views: 0, ms: 0, favs: 0, taps: 0, qty: 0, revenue: 0 };
      const cat = S.menu.categories.find((c) => c.id === d.category)?.label || "";
      rows.push([d.name, cat, p.views, Math.round(p.ms / 1000), p.views ? Math.round(p.ms / p.views / 100) / 10 : 0, p.favs, p.taps, p.qty, p.revenue]);
    }
    const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), download: `metricas-${S.range}-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ================= CARDÁPIO (editor) ================= */
  const markDirty = () => { S.dirty = JSON.stringify(S.menu) !== S.menuSnap; updateSaveBar(); };
  function updateSaveBar() {
    const bar = $("saveBar");
    if (!bar) return;
    bar.classList.toggle("dirty", S.dirty);
    bar.querySelector(".msg").textContent = S.dirty ? "Tens alterações por guardar." : "Tudo guardado. O cardápio público já mostra esta versão.";
    bar.querySelector("button").disabled = !S.dirty;
  }

  async function viewMenu(view) {
    view.append(el("div", { class: "empty", text: "A carregar cardápio…" }));
    try { S.menu = null; await ensureMenu(); } catch (err) { clear(view); view.append(el("div", { class: "empty", text: err.message })); return; }
    if (S.tab !== "cardapio") return;
    renderMenuEditor(view);
  }

  function renderMenuEditor(view = $("view")) {
    const y = scrollY;
    clear(view);
    const M = S.menu;

    const saveBtn = el("button", { class: "btn lime sm", type: "button", text: "Guardar", onclick: (e) => guard(e.currentTarget, saveMenu) });
    view.append(
      el("div", { class: "page-head" }, [el("div", {}, [el("h2", { text: "Cardápio" }), el("span", { class: "muted small", text: "Edita pratos, preços, fotos e vídeos. Guarda para publicar." })])]),
      el("div", { class: "savebar", id: "saveBar" }, [el("span", { class: "msg" }), saveBtn])
    );

    /* categorias */
    const catCard = el("div", { class: "card" }, [el("h3", { text: "Categorias", style: "margin-bottom:10px" })]);
    M.categories.forEach((c, i) => {
      const count = M.dishes.filter((d) => d.category === c.id).length;
      catCard.append(el("div", { class: "cat-row" }, [
        el("input", { type: "text", value: c.label, maxlength: "30", "aria-label": "Nome da categoria", oninput: (e) => { c.label = e.target.value; markDirty(); } }),
        el("div", { class: "row" }, [
          el("button", { class: "icon-btn", type: "button", title: "Subir", text: "↑", disabled: i === 0, onclick: () => { [M.categories[i - 1], M.categories[i]] = [M.categories[i], M.categories[i - 1]]; markDirty(); renderMenuEditor(); } }),
          el("button", { class: "icon-btn", type: "button", title: "Descer", text: "↓", disabled: i === M.categories.length - 1, onclick: () => { [M.categories[i + 1], M.categories[i]] = [M.categories[i], M.categories[i + 1]]; markDirty(); renderMenuEditor(); } }),
          el("button", { class: "icon-btn", type: "button", title: count ? "Esvazia a categoria primeiro" : "Apagar", text: "✕", onclick: () => {
            if (count) return toast("Move ou apaga os pratos desta categoria primeiro.", true);
            if (M.categories.length === 1) return toast("Precisas de pelo menos uma categoria.", true);
            M.categories.splice(i, 1); markDirty(); renderMenuEditor();
          } })
        ])
      ]));
    });
    const newCat = el("input", { type: "text", maxlength: "30", placeholder: "Nova categoria (ex.: Sobremesas)" });
    const addCat = () => {
      const label = newCat.value.trim();
      if (!label) return;
      let id = slugify(label) || "cat", n = 1;
      while (M.categories.some((c) => c.id === id)) id = `${slugify(label)}-${++n}`;
      M.categories.push({ id, label }); markDirty(); renderMenuEditor();
    };
    newCat.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addCat(); } });
    catCard.append(el("div", { class: "row", style: "margin-top:8px" }, [newCat, el("button", { class: "btn sm", type: "button", text: "Adicionar", onclick: addCat })]));
    view.append(catCard);

    /* pratos por categoria */
    for (const c of M.categories) {
      const list = M.dishes.filter((d) => d.category === c.id);
      const group = el("section", { class: "group" }, [
        el("div", { class: "row" }, [el("h3", { text: c.label }), el("span", { class: "muted small", text: `${list.length} ${list.length === 1 ? "prato" : "pratos"}` }), el("span", { class: "spacer" }),
          el("button", { class: "btn sm", type: "button", text: "+ Novo prato", onclick: () => addDish(c.id) })])
      ]);
      if (!list.length) group.append(el("div", { class: "card empty small", text: "Sem pratos nesta categoria." }));
      list.forEach((d, i) => group.append(dishCard(d, list, i)));
      view.append(group);
    }
    updateSaveBar();
    scrollTo({ top: y });
  }

  function addDish(categoryId) {
    const d = {
      id: `prato-${rand()}${rand()}`, category: categoryId, name: "Novo prato", description: "", price: 0, bestSeller: false, soldOut: false, hidden: false,
      tags: [], emoji: "🍽️", colors: ["#2b2b2b", "#555555"], image: null, video: null, poster: null
    };
    S.menu.dishes.push(d);
    S.expanded.add(d.id);
    markDirty();
    renderMenuEditor();
  }

  function dishCard(d, siblings, idx) {
    const M = S.menu;
    const nameT = el("b", { text: d.name });
    const subT = el("small", { text: `${money(d.price)}${d.hidden ? " · oculto" : ""}${d.soldOut ? " · esgotado" : ""}` });
    const refresh = () => { nameT.textContent = d.name || "Sem nome"; subT.textContent = `${money(d.price)}${d.hidden ? " · oculto" : ""}${d.soldOut ? " · esgotado" : ""}`; };

    const sw = (label, key) => el("label", { class: "switch", onclick: (e) => e.stopPropagation() }, [
      el("input", { type: "checkbox", checked: Boolean(d[key]), onchange: (e) => { d[key] = e.target.checked; refresh(); markDirty(); card.classList.toggle("hidden-dish", d.hidden); } }), el("i"), label
    ]);

    const open = S.expanded.has(d.id);
    const head = el("div", { class: "dish-head", role: "button", tabindex: "0", "aria-expanded": String(open),
      onclick: () => { open ? S.expanded.delete(d.id) : S.expanded.add(d.id); renderMenuEditor(); },
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); } } }, [
      thumb(d), el("div", { class: "t" }, [nameT, subT]),
      el("div", { class: "row sw" }, [sw("Esgotado", "soldOut"), sw("Oculto", "hidden")])
    ]);

    const card = el("article", { class: `dish-card${d.hidden ? " hidden-dish" : ""}` }, [head]);
    if (!open) return card;

    const text = (label, key, extra = {}) => el("label", { class: "f" }, [el("span", { text: label }),
      el("input", { type: "text", value: d[key] ?? "", ...extra, oninput: (e) => { d[key] = e.target.value; refresh(); markDirty(); } })]);

    const body = el("div", { class: "dish-body" }, [
      el("div", { class: "form2" }, [
        text("Nome", "name", { maxlength: "60" }),
        el("label", { class: "f" }, [el("span", { text: `Preço (${cur()})` }),
          el("input", { type: "number", min: "0", step: "1", inputmode: "numeric", value: String(d.price), oninput: (e) => { d.price = Math.max(0, Math.round(Number(e.target.value) || 0)); refresh(); markDirty(); } })]),
        el("label", { class: "f" }, [el("span", { text: "Categoria" }),
          el("select", { onchange: (e) => { d.category = e.target.value; markDirty(); renderMenuEditor(); } },
            M.categories.map((c) => el("option", { value: c.id, text: c.label, selected: c.id === d.category })))])
      ]),
      el("label", { class: "f" }, [el("span", {}, ["Descrição ", el("small", { text: "(até 220 caracteres)" })]),
        el("textarea", { maxlength: "220", value: d.description, oninput: (e) => { d.description = e.target.value; markDirty(); } })]),
      el("div", { class: "form2" }, [
        el("label", { class: "f" }, [el("span", {}, ["Etiquetas ", el("small", { text: "(separadas por vírgula)" })]),
          el("input", { type: "text", value: (d.tags || []).join(", "), placeholder: "vegetariano, picante", oninput: (e) => { d.tags = e.target.value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 5); markDirty(); } })]),
        text("Emoji (quando não há foto)", "emoji", { maxlength: "8" }),
        el("div", { class: "f" }, [el("span", { text: "Cores do fundo (quando não há foto)" }), el("div", { class: "row" }, [
          el("input", { type: "color", value: d.colors[0], "aria-label": "Cor 1", oninput: (e) => { d.colors[0] = e.target.value; markDirty(); } }),
          el("input", { type: "color", value: d.colors[1], "aria-label": "Cor 2", oninput: (e) => { d.colors[1] = e.target.value; markDirty(); } })])])
      ]),
      el("label", { class: "switch" }, [el("input", { type: "checkbox", checked: d.bestSeller, onchange: (e) => { d.bestSeller = e.target.checked; markDirty(); } }), el("i"), "Best seller (aparece em destaque e na aba própria)"]),
      el("div", { class: "form2" }, [
        mediaBox(d, "image", "Foto", "image", "image/*"),
        mediaBox(d, "video", "Vídeo curto (3 a 5 s, vertical)", "video", "video/mp4,video/webm"),
        d.video ? mediaBox(d, "poster", "Capa do vídeo", "image", "image/*") : null
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "btn sm", type: "button", text: "↑ Subir", disabled: idx === 0, onclick: () => moveDish(d, siblings[idx - 1]) }),
        el("button", { class: "btn sm", type: "button", text: "↓ Descer", disabled: idx === siblings.length - 1, onclick: () => moveDish(d, siblings[idx + 1]) }),
        el("button", { class: "btn sm", type: "button", text: "Duplicar", onclick: () => duplicateDish(d) }),
        el("span", { class: "spacer" }),
        el("button", { class: "btn sm danger", type: "button", text: "Apagar prato", onclick: () => {
          if (!confirm(`Apagar "${d.name}"? Isto só fica definitivo quando guardares.`)) return;
          M.dishes.splice(M.dishes.indexOf(d), 1); S.expanded.delete(d.id); markDirty(); renderMenuEditor();
        } })
      ])
    ]);
    card.append(body);
    return card;
  }

  function moveDish(a, b) {
    const arr = S.menu.dishes, i = arr.indexOf(a), j = arr.indexOf(b);
    [arr[i], arr[j]] = [arr[j], arr[i]];
    markDirty(); renderMenuEditor();
  }

  function duplicateDish(d) {
    const copy = JSON.parse(JSON.stringify(d));
    copy.id = `${slugify(d.name) || "prato"}-${rand()}`.slice(0, 60);
    copy.name = `${d.name} (cópia)`.slice(0, 60);
    S.menu.dishes.splice(S.menu.dishes.indexOf(d) + 1, 0, copy);
    S.expanded.add(copy.id);
    markDirty(); renderMenuEditor();
  }

  function mediaBox(d, key, label, kind, accept) {
    const url = d[key];
    const prev = el("div", { class: "prev" });
    if (url && kind === "image") prev.append(el("img", { src: url, alt: "" }));
    else if (url) prev.append(el("video", { src: url, muted: true, loop: true, autoplay: true, playsinline: true }));
    else prev.textContent = kind === "video" ? "Sem vídeo" : "Sem imagem";
    const status = el("span", { class: "muted small" });
    const input = el("input", { type: "file", accept, "aria-label": label });
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      status.textContent = "A enviar…";
      try {
        const out = await uploadFile(file, kind);
        d[key] = out.url;
        markDirty(); renderMenuEditor();
        toast("Ficheiro carregado. Lembra-te de guardar.");
      } catch (err) { status.textContent = ""; toast(err.message, true); input.value = ""; }
    });
    return el("div", { class: "media-box" }, [
      el("b", { class: "small", text: label }), prev,
      el("div", { class: "row" }, [
        el("span", { class: "btn sm file-btn" }, [url ? "Trocar" : "Carregar", input]),
        url ? el("button", { class: "btn sm danger", type: "button", text: "Remover", onclick: () => { d[key] = null; markDirty(); renderMenuEditor(); } }) : null,
        status
      ]),
      kind === "video" && !url ? el("span", { class: "muted small", text: "MP4 ou WebM até 25 MB. Quanto mais leve, mais rápido abre com dados móveis." }) : null
    ]);
  }

  /* Reduz as imagens no telemóvel/PC antes de enviar: poupa dados e faz o cardápio abrir mais depressa. */
  async function shrinkImage(file, max = 1280) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      let blob = await new Promise((r) => canvas.toBlob(r, "image/webp", 0.82));
      if (!blob || blob.type !== "image/webp") blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
      return blob && blob.size < file.size ? blob : file;
    } catch (_) { return file; }
  }

  async function uploadFile(file, kind) {
    if (kind === "video" && file.size > 25 * 1024 * 1024) throw new Error("O vídeo tem mais de 25 MB. Comprime-o ou corta-o para 3 a 5 segundos.");
    const body = kind === "image" ? await shrinkImage(file) : file;
    return api(`/api/upload?kind=${kind}`, { method: "POST", raw: body, headers: { "Content-Type": body.type || "application/octet-stream" } });
  }

  async function saveMenu() {
    const out = await api("/api/menu", { method: "PUT", body: S.menu });
    S.menu = { categories: out.categories, dishes: out.dishes };
    S.menuSnap = JSON.stringify(S.menu);
    S.dirty = false;
    toast("Cardápio guardado e publicado");
    renderMenuEditor();
  }

  /* ================= MESAS ================= */
  async function viewTables(view) {
    try { S.tables = (await api("/api/tables")).tables; } catch (err) { view.append(el("div", { class: "empty", text: err.message })); return; }
    if (S.tab !== "mesas") return;
    const local = /^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname);

    const num = el("input", { type: "text", maxlength: "12", placeholder: "Número ou nome (ex.: 7, Varanda)", "aria-label": "Nova mesa" });
    const count = el("input", { type: "number", min: "1", max: "50", placeholder: "Quantas?", style: "max-width:110px", "aria-label": "Quantidade de mesas" });
    const add = async (btn) => guard(btn, async () => {
      if (!num.value.trim()) throw new Error("Indica o número ou nome da mesa.");
      await api("/api/tables", { method: "POST", body: { number: num.value } });
      renderView();
    });
    const bulk = async (btn) => guard(btn, async () => {
      const n = Math.min(50, Math.max(1, Number(count.value) || 0));
      if (!n) throw new Error("Indica quantas mesas queres criar.");
      const have = new Set(S.tables.map((t) => t.number));
      for (let i = 1; i <= n; i++) if (!have.has(String(i))) await api("/api/tables", { method: "POST", body: { number: String(i) } });
      renderView();
    });

    view.append(
      el("div", { class: "page-head" }, [el("div", {}, [el("h2", { text: "Mesas e QR" }), el("span", { class: "muted small", text: "Um QR ou autocolante NFC por mesa: o pedido chega à cozinha já com o número da mesa." })]),
        el("button", { class: "btn primary", type: "button", text: "Imprimir QR de todas as mesas", disabled: !S.tables.length, onclick: printAllQr })]),
      local ? el("div", { class: "card", style: "background:var(--warn-bg);border-color:#e1a13b", text: `Estás a usar ${location.host}. Os QR e links só funcionam para os clientes depois de publicares o sistema com um domínio (ver DEPLOY.md).` }) : null,
      el("div", { class: "card" }, [
        el("div", { class: "row" }, [num, el("button", { class: "btn primary sm", type: "button", text: "Adicionar mesa", onclick: (e) => add(e.currentTarget) })]),
        el("div", { class: "row", style: "margin-top:10px" }, [el("span", { class: "muted small", text: "Ou cria de uma vez as mesas 1 a" }), count, el("button", { class: "btn sm", type: "button", text: "Criar", onclick: (e) => bulk(e.currentTarget) })])
      ])
    );

    const grid = el("div", { class: "tables", style: "margin-top:12px" });
    grid.append(tableCard(null));
    for (const t of S.tables) grid.append(tableCard(t));
    view.append(grid);

    view.append(el("details", { class: "guide card", style: "margin-top:16px" }, [
      el("summary", { text: "Como gravar o autocolante NFC (passo a passo)" }),
      el("ol", {}, [
        "Compra autocolantes ou cartões NTAG213 ou NTAG215 (baratos e funcionam em iPhone e Android).",
        "Instala a app gratuita NFC Tools no telemóvel.",
        "Abre Escrever, depois Adicionar um registo, e escolhe URL/URI.",
        "Cola o link da mesa (botão Copiar link) e toca em Escrever. Encosta o autocolante ao telemóvel.",
        "Testa: encosta outro telemóvel e confirma que abre o cardápio na mesa certa.",
        "Opcional: em Outros, escolhe Tornar só de leitura para ninguém alterar o autocolante.",
        "Cola o autocolante na mesa e deixa também o QR impresso como alternativa."
      ].map((t) => el("li", { text: t })))
    ]));
  }

  function tableCard(t) {
    const link = publicUrl(t?.number);
    const img = el("img", { class: "qr", src: qrSrc(link, 220), alt: `QR da ${t ? `mesa ${t.number}` : "página principal"}`, loading: "lazy", width: "150", height: "150",
      onclick: () => modal(el("div", {}, [el("h3", { text: t ? `Mesa ${t.number}` : "Cardápio" }), el("img", { src: qrSrc(link, 500), alt: "QR ampliado" }), el("code", { class: "small", style: "word-break:break-all;display:block;margin-top:8px", text: link })])) });
    img.addEventListener("error", () => { img.replaceWith(el("div", { class: "muted small", style: "padding:20px 0", text: "QR indisponível sem internet. Usa o link abaixo." })); });
    return el("article", { class: "card table-card" }, [
      el("h3", { text: t ? `Mesa ${t.number}` : "Sem mesa (geral)" }), img,
      el("code", { text: link }),
      el("div", { class: "row" }, [
        el("button", { class: "btn sm", type: "button", text: "Copiar link", onclick: async () => { try { await navigator.clipboard.writeText(link); toast("Link copiado"); } catch (_) { prompt("Copia o link:", link); } } }),
        el("a", { class: "btn sm", href: link, target: "_blank", rel: "noopener", text: "Abrir" }),
        t ? el("button", { class: "btn sm danger", type: "button", text: "Remover", onclick: async (e) => { if (confirm(`Remover a mesa ${t.number}?`)) await guard(e.currentTarget, async () => { await api(`/api/tables/${t.id}`, { method: "DELETE" }); renderView(); }); } }) : null
      ])
    ]);
  }

  async function printAllQr() {
    const area = $("printArea");
    const imgs = [];
    area.replaceChildren(...S.tables.map((t) => {
      const img = el("img", { src: qrSrc(publicUrl(t.number), 400), alt: "" });
      imgs.push(img);
      return el("div", { class: "qr-card" }, [
        el("h2", { text: S.restaurant.name }), el("div", { class: "mesa", text: `Mesa ${t.number}` }), img,
        el("p", { text: "Aponta a câmara ou encosta o telemóvel para ver o cardápio e pedir." })
      ]);
    }));
    await Promise.all(imgs.map((i) => new Promise((r) => { if (i.complete) r(); else { i.onload = r; i.onerror = r; setTimeout(r, 5000); } })));
    document.body.classList.add("print-qr");
    setTimeout(() => { print(); document.body.classList.remove("print-qr"); }, 50);
  }

  /* ================= APARÊNCIA ================= */
  S.lookDirty = false;
  function viewLook(view) {
    const r = S.restaurant;
    if (!S.look) {
      S.look = { name: r.name, ...r.settings };
    }
    S.lookSnap = JSON.stringify({ name: r.name, ...r.settings });
    S.look = JSON.parse(S.lookSnap);
    S.lookDirty = false;
    const L = S.look;
    const iframe = el("iframe", { title: "Pré-visualização do cardápio", src: `/r/${r.slug}?preview=1`, loading: "lazy" });
    const push = () => { iframe.contentWindow?.postMessage({ type: "cf-preview", settings: { theme: L.theme, accent: L.accent, orderingEnabled: L.orderingEnabled, welcome: L.welcome }, name: L.name }, location.origin); };
    iframe.addEventListener("load", push);
    const dirty = () => { S.lookDirty = JSON.stringify(L) !== S.lookSnap; const b = $("lookSave"); if (b) b.disabled = !S.lookDirty; push(); };

    const themeGrid = el("div", { class: "themes" });
    const drawThemes = () => {
      themeGrid.replaceChildren(...THEMES.map((t) => {
        const accent = L.accent || t.accent;
        const mini = el("div", { class: "mini" }, [el("div", { class: "sheet", style: `background:${t.card === "transparent" ? "rgba(0,0,0,.0)" : t.card}` }, [
          el("i", { style: `background:${t.ink}` }), el("u", { style: `background:${accent}` })])]);
        return el("button", { class: "theme-card", type: "button", "aria-pressed": String(L.theme === t.id), onclick: () => { L.theme = t.id; drawThemes(); dirty(); } }, [mini, el("b", { text: t.name }), el("small", { text: t.desc })]);
      }));
    };
    drawThemes();

    const swatches = el("div", { class: "swatches" });
    const drawSwatches = () => {
      swatches.replaceChildren(
        el("button", { class: "btn sm", type: "button", "aria-pressed": String(!L.accent), text: "Cor do tema", onclick: () => { L.accent = ""; drawSwatches(); drawThemes(); dirty(); } }),
        ...ACCENTS.map((c) => el("button", { class: "swatch", type: "button", style: `background:${c}`, "aria-label": `Cor ${c}`, "aria-pressed": String(L.accent === c), onclick: () => { L.accent = c; drawSwatches(); drawThemes(); dirty(); } })),
        el("input", { type: "color", value: L.accent || "#ff7a3d", "aria-label": "Escolher outra cor", oninput: (e) => { L.accent = e.target.value; drawThemes(); dirty(); } })
      );
    };
    drawSwatches();

    const field = (label, key, extra = {}, hint) => el("label", { class: "f" }, [el("span", {}, [label, hint ? el("small", { text: ` ${hint}` }) : null]),
      el("input", { type: "text", value: L[key] ?? "", ...extra, oninput: (e) => { L[key] = e.target.value; dirty(); } })]);

    view.append(
      el("div", { class: "page-head" }, [el("div", {}, [el("h2", { text: "Aparência e definições" }), el("span", { class: "muted small", text: "Escolhe o tema e vê o resultado ao lado antes de guardar." })]),
        el("button", { class: "btn primary", id: "lookSave", type: "button", text: "Guardar", disabled: true, onclick: (e) => guard(e.currentTarget, saveLook) })]),
      el("div", { class: "look" }, [
        el("div", { class: "grid" }, [
          el("div", { class: "card" }, [el("h3", { text: "Tema", style: "margin-bottom:10px" }), themeGrid, el("h3", { text: "Cor de destaque", style: "margin:16px 0 8px" }), swatches]),
          el("div", { class: "card grid" }, [
            el("h3", { text: "O teu restaurante" }),
            field("Nome", "name", { maxlength: "60" }),
            el("label", { class: "f" }, [el("span", { text: "Mensagem de boas-vindas" }), el("textarea", { maxlength: "200", value: L.welcome, oninput: (e) => { L.welcome = e.target.value; dirty(); } })]),
            el("div", { class: "form2" }, [
              field("WhatsApp", "whatsapp", { type: "tel", inputmode: "numeric", placeholder: "258841234567" }, "(com indicativo)"),
              field("Instagram", "instagram", { placeholder: "cafe.do.mane" }, "(sem @)")
            ])
          ]),
          el("div", { class: "card grid" }, [
            el("h3", { text: "Pedidos" }),
            el("label", { class: "switch" }, [el("input", { type: "checkbox", checked: L.orderingEnabled, onchange: (e) => { L.orderingEnabled = e.target.checked; dirty(); } }), el("i"), "Aceitar pedidos pelo cardápio (botão Pedir)"]),
            el("div", { class: "form2" }, [
              el("label", { class: "f" }, [el("span", { text: "Pedido mínimo" }), el("input", { type: "number", min: "0", value: String(L.minOrder), oninput: (e) => { L.minOrder = Math.max(0, Math.round(Number(e.target.value) || 0)); dirty(); } })]),
              field("Moeda", "currency", { maxlength: "6" })
            ])
          ])
        ]),
        el("aside", { class: "preview" }, [el("div", { class: "phone" }, [iframe]), el("p", { class: "muted small", style: "text-align:center", text: "Pré-visualização: não conta visitas nem envia pedidos." })])
      ])
    );
  }

  async function saveLook() {
    const L = S.look;
    const out = await api("/api/settings", { method: "PUT", body: { name: L.name, theme: L.theme, accent: L.accent, welcome: L.welcome, whatsapp: L.whatsapp, instagram: L.instagram, orderingEnabled: L.orderingEnabled, minOrder: L.minOrder, currency: L.currency } });
    S.restaurant = out.restaurant;
    $("rName").textContent = S.restaurant.name;
    S.lookSnap = JSON.stringify({ name: S.restaurant.name, ...S.restaurant.settings });
    S.look = JSON.parse(S.lookSnap);
    S.lookDirty = false;
    $("lookSave").disabled = true;
    toast("Definições guardadas");
  }

  /* ================= CONTA ================= */
  function viewAccount(view) {
    const cur_ = el("input", { type: "password", autocomplete: "current-password" });
    const next = el("input", { type: "password", autocomplete: "new-password", minlength: "8" });
    const link = publicUrl("");
    view.append(
      el("div", { class: "page-head" }, [el("h2", { text: "Conta" })]),
      el("div", { class: "card grid" }, [
        el("h3", { text: "Ligação do cardápio" }),
        el("p", { class: "muted", style: "margin:0", text: "Este é o endereço público. Partilha-o nas redes sociais ou grava-o num cartão NFC." }),
        el("code", { style: "word-break:break-all", text: link }),
        el("div", { class: "row" }, [
          el("button", { class: "btn sm", type: "button", text: "Copiar", onclick: async () => { try { await navigator.clipboard.writeText(link); toast("Link copiado"); } catch (_) { prompt("Copia o link:", link); } } }),
          el("a", { class: "btn sm", href: link, target: "_blank", rel: "noopener", text: "Abrir" })
        ])
      ]),
      el("form", { class: "card grid", onsubmit: (e) => { e.preventDefault(); guard(e.submitter, async () => {
        await api("/api/auth/password", { method: "POST", body: { current: cur_.value, next: next.value } });
        cur_.value = next.value = ""; toast("Senha alterada. As outras sessões foram terminadas.");
      }); } }, [
        el("h3", { text: "Alterar senha" }),
        el("p", { class: "muted small", style: "margin:0", text: `Sessão iniciada como ${S.user.email}.` }),
        el("label", { class: "f" }, [el("span", { text: "Senha atual" }), cur_]),
        el("label", { class: "f" }, [el("span", { text: "Nova senha (mínimo 8 caracteres)" }), next]),
        el("div", {}, [el("button", { class: "btn primary", type: "submit", text: "Alterar senha" })])
      ]),
      el("div", { class: "card" }, [el("button", { class: "btn danger", type: "button", text: "Terminar sessão", onclick: () => logout() })])
    );
  }

  /* ================= ARRANQUE ================= */
  addEventListener("beforeunload", (e) => { if (S.dirty || S.lookDirty) { e.preventDefault(); e.returnValue = ""; } });
  addEventListener("hashchange", () => { const id = location.hash.slice(1); if (S.token && !$("app").hidden && id !== S.tab && TABS.some(([t]) => t === id)) setTab(id); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.token && !$("app").hidden) { loadOrders(); loadWaiterCalls(); } });

  (async function boot() {
    if (!S.token) return showLogin(location.hash === "#registo" ? "register" : "login");
    try {
      const me = await api("/api/auth/me");
      S.user = me.user; S.restaurant = me.restaurant;
      enterApp();
    } catch (_) { if (!S.token) return; showLogin("login"); }
  })();
})();
