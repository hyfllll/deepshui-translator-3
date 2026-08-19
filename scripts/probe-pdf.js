'use strict';

const fs = require('node:fs');

const port = Number(process.argv[2] || 9231);
const outputPath = process.argv[3] || null;
const resultPath = process.argv[4] || null;

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
  let dialogMessage = '';
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Page.javascriptDialogOpening') {
      dialogMessage = message.params.message || '';
      call('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      return;
    }
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });

  await call('Page.enable');
  await call('Runtime.enable');
  const click = await call('Runtime.evaluate', {
    expression: `(() => {
      if (document.getElementById('library-view').classList.contains('hidden')) {
        return { clicked: false, reason: 'already-in-reader' };
      }
      const card = document.querySelector('.document-card');
      if (!card) return { clicked: false, reason: 'no-document-card' };
      card.click();
      return { clicked: true, documentId: card.dataset.documentId };
    })()`,
    returnByValue: true,
  });

  let state = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const evaluated = await call('Runtime.evaluate', {
      expression: `({
        readerVisible: !document.getElementById('reader-view').classList.contains('hidden'),
        pageCount: typeof PdfViewer === 'undefined' ? -1 : PdfViewer.pageCount,
        pageInfo: document.getElementById('page-info').textContent,
        placeholderHidden: document.getElementById('pdf-placeholder').classList.contains('hidden'),
        canvasCount: document.querySelectorAll('.page-wrapper canvas').length,
        textLayerCount: document.querySelectorAll('.page-wrapper .textLayer').length,
        title: document.title
      })`,
      returnByValue: true,
    });
    state = evaluated.result.value;
    if ((state.pageCount > 0 && state.canvasCount > 0 && state.textLayerCount > 0) || dialogMessage) break;
  }
  if (outputPath) {
    const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'));
  }
  socket.close();
  const result = { click: click.result.value, state, dialogMessage };
  if (resultPath) fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!state || state.pageCount <= 0 || state.canvasCount <= 0 || state.textLayerCount <= 0 || dialogMessage) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
