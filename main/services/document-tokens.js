'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

class DocumentTokenStore {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.tokens = new Map();
  }

  issue({ documentId, filePath, webContentsId, sessionPartition, generation }) {
    if (!documentId || !filePath || !Number.isSafeInteger(webContentsId) || webContentsId < 1) {
      throw new Error('文档令牌参数无效');
    }
    if (!sessionPartition || !Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('文档令牌缺少会话或代次');
    }
    this.cleanupExpired();
    this.revokeFor(webContentsId);
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = Date.now() + this.ttlMs;
    this.tokens.set(tokenHash, {
      tokenHash,
      documentId,
      filePath,
      webContentsId,
      sessionPartition,
      generation,
      allowedMethods: ['GET', 'HEAD'],
      expiresAt,
    });
    return { url: `app://local/document/${token}`, expiresAt, generation };
  }

  revokeFor(webContentsId, generation = null) {
    for (const [tokenHash, entry] of this.tokens) {
      if (entry.webContentsId !== webContentsId) continue;
      if (generation !== null && entry.generation !== generation) continue;
      this.tokens.delete(tokenHash);
    }
  }

  cleanupExpired() {
    const time = Date.now();
    for (const [tokenHash, entry] of this.tokens) {
      if (entry.expiresAt <= time) this.tokens.delete(tokenHash);
    }
  }

  entryForUrl(urlString) {
    this.cleanupExpired();
    let url;
    try { url = new URL(urlString); } catch { return null; }
    if (url.protocol !== 'app:' || url.hostname !== 'local') return null;
    const match = /^\/document\/([A-Za-z0-9_-]{40,})$/.exec(url.pathname);
    if (!match) return null;
    return this.tokens.get(hashToken(match[1])) || null;
  }

  authorizeRequest({ url, method = 'GET', webContentsId, sessionPartition }) {
    const entry = this.entryForUrl(url);
    const normalizedMethod = String(method).toUpperCase();
    if (!entry || !ALLOWED_METHODS.has(normalizedMethod)) return false;
    if (entry.webContentsId !== webContentsId) return false;
    if (entry.sessionPartition !== sessionPartition) return false;
    return entry.allowedMethods.includes(normalizedMethod);
  }

  async handleRequest(request, sessionPartition) {
    const method = String(request.method || 'GET').toUpperCase();
    const entry = this.entryForUrl(request.url);
    if (!entry || entry.sessionPartition !== sessionPartition || !ALLOWED_METHODS.has(method)) {
      return new Response('Document token expired or invalid', { status: 403 });
    }

    let stat;
    try { stat = await fsp.stat(entry.filePath); } catch { return new Response('Document not found', { status: 404 }); }
    if (!stat.isFile()) return new Response('Document not found', { status: 404 });

    const size = stat.size;
    const rangeHeader = request.headers.get('range');
    let start = 0;
    let end = size - 1;
    let status = 200;
    const headers = new Headers({
      'Content-Type': 'application/pdf',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      if (!match[1] && match[2]) {
        const suffix = Number(match[2]);
        start = Math.max(0, size - suffix);
        end = size - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      end = Math.min(end, size - 1);
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }

    const length = end - start + 1;
    headers.set('Content-Length', String(length));
    if (method === 'HEAD') return new Response(null, { status, headers });
    return new Response(Readable.toWeb(fs.createReadStream(entry.filePath, { start, end })), { status, headers });
  }
}

module.exports = { DocumentTokenStore, DEFAULT_TTL_MS, hashToken };
