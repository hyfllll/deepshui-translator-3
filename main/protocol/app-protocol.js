'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.ico', 'image/x-icon'], ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'], ['.pdf', 'application/pdf'],
]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'";

function safeRendererPath(rendererRoot, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (!relative || relative.includes('\0')) return null;
  const root = path.resolve(rendererRoot);
  const target = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(prefix)) return null;
  return target;
}

async function serveRenderer(request, rendererRoot) {
  if (!['GET', 'HEAD'].includes(String(request.method || 'GET').toUpperCase())) {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const url = new URL(request.url);
  const target = safeRendererPath(rendererRoot, url.pathname);
  if (!target) return new Response('Forbidden', { status: 403 });
  let stat;
  try { stat = await fsp.stat(target); } catch { return new Response('Not found', { status: 404 }); }
  if (!stat.isFile()) return new Response('Not found', { status: 404 });
  const headers = new Headers({
    'Content-Type': MIME_TYPES.get(path.extname(target).toLowerCase()) || 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Content-Security-Policy': CSP,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
  });
  if (String(request.method).toUpperCase() === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(Readable.toWeb(fs.createReadStream(target)), { status: 200, headers });
}

function registerAppProtocol({ session, rendererRoot, tokens, sessionPartition }) {
  session.webRequest.onBeforeRequest({ urls: ['app://local/document/*'] }, (details, callback) => {
    const allowed = tokens.authorizeRequest({
      url: details.url,
      method: details.method,
      webContentsId: details.webContentsId,
      sessionPartition,
    });
    callback({ cancel: !allowed });
  });

  session.protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'local') return new Response('Forbidden', { status: 403 });
    if (url.pathname.startsWith('/document/')) return tokens.handleRequest(request, sessionPartition);
    return serveRenderer(request, rendererRoot);
  });
}

module.exports = { registerAppProtocol, safeRendererPath, serveRenderer, CSP };
