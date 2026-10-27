"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { R2Client } = require("../backend/r2");
const { createApp } = require("../backend/server");

test("R2Client: deteção de configuração e URLs", () => {
  const unconfigured = new R2Client({ accountId: "" });
  assert.equal(unconfigured.isConfigured(), false);
  assert.equal(unconfigured.getPublicUrl("test.jpg"), null);

  const configured = new R2Client({
    accountId: "acc123",
    accessKeyId: "key123",
    secretAccessKey: "secret123",
    bucket: "meu-bucket",
    publicUrl: "https://media.exemplo.com"
  });
  assert.equal(configured.isConfigured(), true);
  assert.equal(configured.getPublicUrl("foto.jpg"), "https://media.exemplo.com/foto.jpg");
  assert.equal(configured.getPublicUrl("/pasta/foto.jpg"), "https://media.exemplo.com/pasta/foto.jpg");
});

test("R2Client: cabeçalhos SigV4 gerados corretamente", () => {
  const r2 = new R2Client({
    accountId: "112233445566778899aabbccddeeff00",
    accessKeyId: "AKIATEST",
    secretAccessKey: "SECRETTEST",
    bucket: "cardapio"
  });

  const { headers } = r2._buildHeaders("PUT", "/cardapio/foto.jpg", Buffer.from("conteudo"), "image/jpeg");
  assert.equal(headers.Host, "112233445566778899aabbccddeeff00.r2.cloudflarestorage.com");
  assert.match(headers["x-amz-date"], /^\d{8}T\d{6}Z$/);
  assert.match(headers["x-amz-content-sha256"], /^[0-9a-f]{64}$/);
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/);
  assert.equal(headers["Content-Type"], "image/jpeg");
});

test("Integração: upload usa R2 e retorna publicUrl", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cardapio-r2-"));
  const uploadedKeys = [];

  const mockR2 = {
    isConfigured: () => true,
    publicUrl: "https://pub-123.r2.dev",
    getPublicUrl: (k) => `https://pub-123.r2.dev/${k}`,
    async putObject(key, buf, mime) {
      uploadedKeys.push({ key, len: buf.length, mime });
      return { ok: true, key, publicUrl: `https://pub-123.r2.dev/${key}` };
    },
    async getObject(key) {
      return null;
    }
  };

  const app = createApp({ dataDir: dir, demo: false, r2: mockR2 });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  try {
    // 1. Criar restaurante
    const regRes = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restaurantName: "R2 Grill", email: "r2@grill.mz", password: "senha-segura-1" })
    });
    const regData = await regRes.json();
    const token = regData.token;

    // 2. Upload de imagem
    const pngBuf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 2)]);
    const upRes = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: pngBuf
    });
    const upData = await upRes.json();

    assert.equal(upRes.status, 201);
    assert.match(upData.url, /^https:\/\/pub-123\.r2\.dev\/media\//);
    assert.equal(uploadedKeys.length >= 1, true);
    assert.match(uploadedKeys[0].key, /^media\//);

    // 3. Forçar flush e verificar se db.json foi sincronizado para o R2
    app.db.flush();
    await new Promise((r) => setTimeout(r, 600)); // espera o debounce de 500ms
    const dbUpload = uploadedKeys.find((u) => u.key === "data/db.json");
    assert.ok(dbUpload, "data/db.json deveria ter sido enviado para o R2");
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
