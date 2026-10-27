"use strict";
const crypto = require("crypto");

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const id = (bytes = 8) => crypto.randomBytes(bytes).toString("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/* ---------- senhas (scrypt) ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || "").split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/* ---------- limite de pedidos por chave (IP, email…) ---------- */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

function clearRateLimits() {
  buckets.clear();
}

/* ---------- corpo da requisição ---------- */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) {
      req.resume();
      return reject(new HttpError(413, "Ficheiro ou pedido demasiado grande."));
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "Ficheiro ou pedido demasiado grande."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJSON(req, limit = 512 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString("utf8"));
    if (v === null || typeof v !== "object") throw new Error("não é objeto");
    return v;
  } catch (_) {
    throw new HttpError(400, "JSON inválido.");
  }
}

/* ---------- validação ---------- */
function str(v, max, fallback = "") {
  if (typeof v !== "string") return fallback;
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
}

function num(v, min, max, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function slugify(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/* Detecta o tipo real do ficheiro pelos primeiros bytes (não confia na extensão). */
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: "image", ext: "jpg", mime: "image/jpeg" };
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", ext: "png", mime: "image/png" };
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return { kind: "image", ext: "webp", mime: "image/webp" };
  if (buf.slice(0, 4).toString() === "GIF8") return { kind: "image", ext: "gif", mime: "image/gif" };
  if (buf.slice(4, 8).toString() === "ftyp") return { kind: "video", ext: "mp4", mime: "video/mp4" };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { kind: "video", ext: "webm", mime: "video/webm" };
  return null;
}

module.exports = {
  HttpError, id, sha256, hashPassword, verifyPassword,
  rateLimit, clearRateLimits, readBody, readJSON, str, num, slugify, HEX, EMAIL, sniff
};
