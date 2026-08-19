'use strict';

const fs = require('node:fs');

const port = Number(process.argv[2] || 9223);
const outputPath = process.argv[3];
const requestedTheme = process.argv[4] || 'light';
if (!outputPath) throw new Error('缺少截图输出路径');

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((target) => target.type === 'page' && (
    target.url === 'app://local/index.html' || target.url.includes('/renderer/index.html')
  ));
  if (!page) throw new Error('未找到应用页面');
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

  await call('Runtime.evaluate', {
    expression: `(() => {
      const select = document.getElementById('theme-select');
      select.value = ${JSON.stringify(requestedTheme)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
    awaitPromise: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const libraryProbe = await call('Runtime.evaluate', {
    expression: `window.deepshui.library.list()
      .then(value => ({ ok: true, count: value.length }))
      .catch(error => ({ ok: false, error: error.message }))`,
    awaitPromise: true,
    returnByValue: true,
  });
  const inspection = await call('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      theme: document.documentElement.dataset.theme,
      libraryVisible: !document.getElementById('library-view').classList.contains('hidden'),
      readerHidden: document.getElementById('reader-view').classList.contains('hidden'),
      summary: document.getElementById('library-summary').textContent,
      duplicateIds: [...document.querySelectorAll('[id]')].map(e => e.id).filter((id, i, all) => all.indexOf(id) !== i)
    })`,
    returnByValue: true,
  });
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
  socket.close();
  const inspected = JSON.parse(inspection.result.value);
  inspected.libraryProbe = libraryProbe.result.value;
  process.stdout.write(JSON.stringify(inspected) + '\n');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
