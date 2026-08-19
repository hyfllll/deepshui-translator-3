'use strict';

const fs = require('node:fs');

const port = Number(process.argv[2] || 9234);
const screenshotPath = process.argv[3];
const resultPath = process.argv[4];

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((target) => target.type === 'page' && target.url === 'app://local/index.html');
  if (!page) throw new Error('未找到 3.0 页面');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let requestId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Page.enable');
  await call('Runtime.enable');

  const initial = await call('Runtime.evaluate', {
    expression: `({ documentCards: document.querySelectorAll('.document-card').length })`,
    returnByValue: true,
  });
  if (!initial.result.value.documentCards) throw new Error('测试资料库为空');
  await call('Runtime.evaluate', { expression: `document.querySelector('.document-card').click()` });

  let loaded = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = await call('Runtime.evaluate', {
      expression: `({ pageCount: PdfViewer.pageCount, disabled: document.getElementById('btn-bookmark').disabled })`,
      returnByValue: true,
    });
    if (state.result.value.pageCount > 0 && !state.result.value.disabled) { loaded = true; break; }
  }
  if (!loaded) throw new Error('PDF 或书签接口未就绪');

  const bookmarkState = await call('Runtime.evaluate', {
    expression: `document.getElementById('btn-bookmark').classList.contains('active')`,
    returnByValue: true,
  });
  if (bookmarkState.result.value) {
    await call('Runtime.evaluate', { expression: `document.getElementById('btn-bookmark').click()` });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await call('Runtime.evaluate', {
    expression: `document.getElementById('btn-bookmark').click()`,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const result = await call('Runtime.evaluate', {
    expression: `(async () => ({
      pageCount: PdfViewer.pageCount,
      page: PdfViewer.currentPage,
      bookmarkText: document.getElementById('btn-bookmark').textContent,
      bookmarkActive: document.getElementById('btn-bookmark').classList.contains('active'),
      bookmarkCount: (await window.deepshui.bookmarks.list(document.querySelector('.document-card')?.dataset.documentId || '')).length,
      title: document.title
    }))()`,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = result.result.value;
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  fs.writeFileSync(resultPath, JSON.stringify(value, null, 2) + '\n');
  socket.close();
  if (!value.bookmarkActive || value.bookmarkCount !== 1) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
