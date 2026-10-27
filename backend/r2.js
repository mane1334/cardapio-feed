"use strict";
/* Cliente leve para Cloudflare R2 (API compatível com S3) usando Node 18+ nativo (sem dependências).
 * Suporta upload de imagens/vídeos e sincronização do db.json.
 */
const crypto = require("crypto");

class R2Client {
  constructor(cfg = {}) {
    this.accountId = cfg.accountId || process.env.R2_ACCOUNT_ID || "";
    this.accessKeyId = cfg.accessKeyId || process.env.R2_ACCESS_KEY_ID || "";
    this.secretAccessKey = cfg.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY || "";
    this.bucket = cfg.bucket || process.env.R2_BUCKET || "";
    this.publicUrl = (cfg.publicUrl || process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
    this.region = cfg.region || "auto";
  }

  isConfigured() {
    return Boolean(this.accountId && this.accessKeyId && this.secretAccessKey && this.bucket);
  }

  getPublicUrl(key) {
    const cleanKey = String(key).replace(/^\/+/, "");
    if (this.publicUrl) return `${this.publicUrl}/${cleanKey}`;
    return null;
  }

  _sha256(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
  }

  _hmac(key, data) {
    return crypto.createHmac("sha256", key).update(data).digest();
  }

  _getSigningKey(dateStamp) {
    const kDate = this._hmac("AWS4" + this.secretAccessKey, dateStamp);
    const kRegion = this._hmac(kDate, this.region);
    const kService = this._hmac(kRegion, "s3");
    return this._hmac(kService, "aws4_request");
  }

  _buildHeaders(method, uriPath, payloadBuf, contentType) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const host = `${this.accountId}.r2.cloudflarestorage.com`;
    const payloadHash = this._sha256(payloadBuf);

    const headersMap = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    if (contentType) {
      headersMap["content-type"] = contentType;
    }

    const sortedKeys = Object.keys(headersMap).sort();
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${headersMap[k]}\n`).join("");
    const signedHeaders = sortedKeys.join(";");

    // Codifica cada segmento de caminho sem codificar as barras
    const encodedUri = uriPath
      .split("/")
      .map((part) => encodeURIComponent(decodeURIComponent(part)))
      .join("/");

    const canonicalRequest = [
      method.toUpperCase(),
      encodedUri,
      "", // query string
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      this._sha256(canonicalRequest)
    ].join("\n");

    const signingKey = this._getSigningKey(dateStamp);
    const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    const authHeader = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = {
      Host: host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: authHeader
    };
    if (contentType) headers["Content-Type"] = contentType;

    return { headers, host, encodedUri };
  }

  async putObject(key, body, contentType = "application/octet-stream") {
    if (!this.isConfigured()) throw new Error("R2 não configurado");
    const cleanKey = String(key).replace(/^\/+/, "");
    const uriPath = `/${this.bucket}/${cleanKey}`;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);

    const { headers, host, encodedUri } = this._buildHeaders("PUT", uriPath, buf, contentType);
    const url = `https://${host}${encodedUri}`;

    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: buf
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Falha no upload para o R2 (status ${res.status}): ${errText}`);
    }

    return {
      ok: true,
      publicUrl: this.getPublicUrl(cleanKey),
      key: cleanKey
    };
  }

  async getObject(key) {
    if (!this.isConfigured()) return null;
    const cleanKey = String(key).replace(/^\/+/, "");
    const uriPath = `/${this.bucket}/${cleanKey}`;
    const emptyBuf = Buffer.alloc(0);

    const { headers, host, encodedUri } = this._buildHeaders("GET", uriPath, emptyBuf, null);
    const url = `https://${host}${encodedUri}`;

    const res = await fetch(url, {
      method: "GET",
      headers
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Falha ao buscar objeto do R2 (status ${res.status}): ${errText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

module.exports = { R2Client };
