'use strict';

const fs = require('node:fs');

const port = Number(process.argv[2] || 9235);
const screenshotPath = process.argv[3];
const resultPath = process.argv[4];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return result.result.value;
  };

  await call('Page.enable');
  await call('Runtime.enable');
  const cardCount = await evaluate(`document.querySelectorAll('.document-card').length`);
  if (!cardCount) throw new Error('测试资料库为空');
  await evaluate(`document.querySelector('.document-card').click()`);

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(100);
    const state = await evaluate(`({ pageCount: PdfViewer.pageCount, originalHidden: document.getElementById('pdf-viewer').classList.contains('hidden') })`);
    if (state.pageCount > 0 && !state.originalHidden) { ready = true; break; }
  }
  if (!ready) throw new Error('PDF 原文阅读未就绪');

  await evaluate(`(() => {
    const select = document.getElementById('zoom-mode');
    select.value = 'fit-page';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await wait(350);
  await evaluate(`document.getElementById('btn-reader-mode').click()`);

  let reflowReady = false;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await wait(100);
    const state = await evaluate(`({
      visible: !document.getElementById('reflow-view').classList.contains('hidden'),
      blocks: document.querySelectorAll('.reflow-block').length,
      status: document.getElementById('reflow-status').textContent,
      running: !document.getElementById('btn-reflow-cancel').classList.contains('hidden')
    })`);
    if (state.visible && state.blocks > 0 && !state.running) { reflowReady = true; break; }
  }
  if (!reflowReady) throw new Error('本地智能排版未就绪');

  const beforeJump = await evaluate(`({
    blocks: document.querySelectorAll('.reflow-block').length,
    assetBlocks: document.querySelectorAll('.reflow-block.figure, .reflow-block.table, .reflow-block.formula-image').length,
    loadedAssets: [...document.querySelectorAll('.reflow-asset-image')].filter((image) => image.complete && image.naturalWidth > 0).length,
    formulaBlocks: document.querySelectorAll('.reflow-block.formula-image').length,
    figureBlocks: document.querySelectorAll('.reflow-block.figure').length,
    zoomMode: document.getElementById('zoom-mode').value,
    status: document.getElementById('reflow-status').textContent
  })`);
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  await evaluate(`document.querySelector('.reflow-origin').click()`);
  await wait(350);
  const result = await evaluate(`({
    pageCount: PdfViewer.pageCount,
    currentPage: PdfViewer.currentPage,
    originalVisible: !document.getElementById('pdf-viewer').classList.contains('hidden'),
    reflowHidden: document.getElementById('reflow-view').classList.contains('hidden'),
    zoomMode: document.getElementById('zoom-mode').value,
    reflowBlocks: ${JSON.stringify(beforeJump.blocks)},
    assetBlocks: ${JSON.stringify(beforeJump.assetBlocks)},
    loadedAssets: ${JSON.stringify(beforeJump.loadedAssets)},
    formulaBlocks: ${JSON.stringify(beforeJump.formulaBlocks)},
    figureBlocks: ${JSON.stringify(beforeJump.figureBlocks)},
    reflowStatus: ${JSON.stringify(beforeJump.status)}
  })`);
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  socket.close();
  if (!result.originalVisible || !result.reflowHidden || result.pageCount < 1 || result.reflowBlocks < 1
    || result.loadedAssets !== result.assetBlocks || result.zoomMode !== 'fit-page') process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
