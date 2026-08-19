/**
 * deepshui-translator - PDF 阅读器模块
 * 基于 PDF.js，连续滚动 + 虚拟滚动按需渲染
 */

const PdfViewer = (() => {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.min.js';

  // 常量
  const MAX_CONCURRENT = 2;   // 并发渲染上限
  const RENDER_MARGIN = 800;  // 视口上下预渲染余量 (px)
  const RECYCLE_MARGIN = 2400; // 超出此距离回收页面 (px)
  const PAGE_GAP = 16;        // 页间间距 (px)
  const MAX_FIT_SCALE = 1.5;
  const MIN_SCALE = 0.4;
  const MAX_SCALE = 4.0;

  let pdfDoc = null;
  let currentPage = 1;
  let scale = 1.0;
  let fitScale = 1.0;
  let zoomMode = 'fit-width';
  let fileName = '';
  let isLoading = false;
  let loadingTask = null;
  let documentGeneration = 0;

  // 虚拟滚动状态
  let pageHeights = [];        // 每页 CSS 高度
  let pageOffsets = [];        // 每页 top 偏移
  let totalHeight = 0;
  let spacer = null;           // 撑开滚动条的占位层
  const rendered = new Map();  // pageNum -> wrapper

  // 渲染队列（并发控制）
  let renderQueue = [];
  let activeRenders = 0;
  const renderTasks = new Set();
  let scrollRaf = 0;           // 滚动节流

  const viewerEl = document.getElementById('pdf-viewer');
  const zoomLabel = document.getElementById('zoom-label');
  const pageInfo = document.getElementById('page-info');
  const pageInput = document.getElementById('page-input');
  const placeholderEl = document.getElementById('pdf-placeholder');
  const loadingProgress = document.getElementById('loading-progress');
  const placeholderText = document.getElementById('placeholder-text');

  let onTextSelect = null;
  let onPdfLoaded = null;
  let onProgress = null;

  async function releaseDocument() {
    renderQueue = [];
    for (const task of renderTasks) {
      try { task.cancel(); } catch {}
    }
    renderTasks.clear();
    for (const pageNum of [...rendered.keys()]) disposePage(pageNum);
    if (loadingTask) {
      try { await loadingTask.destroy(); } catch {}
      loadingTask = null;
    } else if (pdfDoc) {
      try { await pdfDoc.destroy(); } catch {}
    }
    pdfDoc = null;
  }

  // ── 加载 PDF ─────────────────────────────
  async function loadPdf(source, name, options = {}) {
    const generation = Number(options.generation) || documentGeneration + 1;
    documentGeneration = generation;
    isLoading = true;
    try {
      await releaseDocument();
      if (generation !== documentGeneration) return false;
      loadingTask = pdfjsLib.getDocument(typeof source === 'string' ? { url: source } : { data: source });
      const loadedDocument = await loadingTask.promise;
      if (generation !== documentGeneration) {
        await loadedDocument.destroy();
        return false;
      }
      pdfDoc = loadedDocument;
      loadingTask = null;
      fileName = name;
      document.title = `${name} - DeepShui Translator 3`;

      placeholderEl.classList.remove('hidden');
      loadingProgress.classList.remove('hidden');
      placeholderText.textContent = '正在准备文档...';
      loadingProgress.textContent = '正在计算页面尺寸...';

      // 根据阅读偏好设置缩放；默认适合宽度，避免侧栏占用空间时出现裁切。
      const page1 = await pdfDoc.getPage(1);
      const savedZoom = Number(options.progress && options.progress.zoom);
      const savedMode = options.readerState && options.readerState.zoom_mode;
      if (savedMode === 'manual' && Number.isFinite(savedZoom) && savedZoom >= MIN_SCALE && savedZoom <= MAX_SCALE) {
        scale = savedZoom;
        zoomMode = 'manual';
      } else {
        zoomMode = ['fit-width', 'fit-page', 'actual-size'].includes(savedMode) ? savedMode : 'fit-width';
        scale = getScaleForMode(page1, zoomMode);
      }

      // 预计算所有页高度（轻量操作，不渲染）
      await computePageLayout();

      // 重建滚动骨架
      rebuildSpacer();
      rendered.clear();
      viewerEl.innerHTML = '';
      viewerEl.appendChild(spacer);
      currentPage = 1;

      const savedRatio = Number(options.progress && options.progress.scroll_ratio);
      if (Number.isFinite(savedRatio) && savedRatio > 0) {
        viewerEl.scrollTop = Math.max(0, Math.min(1, savedRatio)) * Math.max(0, totalHeight - viewerEl.clientHeight);
        currentPage = pageAtScrollTop(viewerEl.scrollTop);
      } else if (options.progress && Number(options.progress.page) > 1) {
        currentPage = Math.min(pdfDoc.numPages, Number(options.progress.page));
        viewerEl.scrollTop = pageOffsets[currentPage - 1] || 0;
      }

      // 渲染视口附近页面，渲染完第一页立刻显示
      placeholderEl.classList.add('hidden');
      loadingProgress.classList.add('hidden');
      updateToolbar();
      await renderVisiblePages(true);

      // 通知外部（拖拽/对话框打开都触发）
      if (onPdfLoaded) onPdfLoaded({ name: fileName, generation });
      return true;
    } catch (e) {
      if (generation !== documentGeneration) return false;
      console.error(e);
      alert('PDF 加载失败: ' + e.message);
      return false;
    } finally {
      if (generation === documentGeneration) isLoading = false;
    }
  }

  function getScaleForMode(page, mode) {
    const base = page.getViewport({ scale: 1 });
    const width = Math.max(1, viewerEl.clientWidth - 32);
    const height = Math.max(1, viewerEl.clientHeight - 32);
    fitScale = Math.min(width / base.width, MAX_FIT_SCALE);
    if (mode === 'fit-page') return Math.max(MIN_SCALE, Math.min(width / base.width, height / base.height, MAX_FIT_SCALE));
    if (mode === 'actual-size') return 1;
    return Math.max(MIN_SCALE, fitScale);
  }

  // 预计算所有页面布局（getPage 轻量，不绘制 canvas）
  async function computePageLayout() {
    pageHeights = [];
    pageOffsets = [];
    let offset = 0;
    for (let p = 1; p <= pdfDoc.numPages; p++) {
      if (p % 50 === 0 && loadingProgress) {
        loadingProgress.textContent = `正在计算页面尺寸 ${p} / ${pdfDoc.numPages}...`;
        await new Promise(r => setTimeout(r, 0)); // 让 UI 更新
      }
      const page = await pdfDoc.getPage(p);
      const vp = page.getViewport({ scale });
      const h = vp.height;
      pageHeights.push(h);
      pageOffsets.push(offset);
      offset += h + PAGE_GAP;
    }
    totalHeight = offset;
  }

  function rebuildSpacer() {
    spacer = document.createElement('div');
    spacer.id = 'pdf-spacer';
    spacer.style.position = 'relative';
    spacer.style.height = totalHeight + 'px';
    spacer.style.width = '100%';
  }

  // ── 按需渲染（虚拟滚动核心）──────────────
  async function renderVisiblePages(force) {
    if (!pdfDoc) return;
    const scrollTop = viewerEl.scrollTop;
    const viewBottom = scrollTop + viewerEl.clientHeight;
    const n = pdfDoc.numPages;

    for (let p = 1; p <= n; p++) {
      const top = pageOffsets[p - 1];
      const bottom = top + pageHeights[p - 1];
      const needRender = bottom > scrollTop - RENDER_MARGIN && top < viewBottom + RENDER_MARGIN;
      const farAway = bottom < scrollTop - RECYCLE_MARGIN || top > viewBottom + RECYCLE_MARGIN;

      if (needRender) {
        if (!rendered.has(p)) scheduleRender(p);
      } else if (farAway && rendered.has(p)) {
        disposePage(p);
      }
    }
  }

  function scheduleRender(pageNum) {
    if (rendered.has(pageNum) || renderQueue.some((item) => item.pageNum === pageNum && item.generation === documentGeneration)) return;
    renderQueue.push({ pageNum, generation: documentGeneration });
    pumpQueue();
  }

  function pumpQueue() {
    while (activeRenders < MAX_CONCURRENT && renderQueue.length) {
      const queued = renderQueue.shift();
      activeRenders++;
      renderPage(queued.pageNum, queued.generation)
        .catch(e => {
          if (e && e.name !== 'RenderingCancelledException') console.error(`渲染第${queued.pageNum}页失败:`, e);
        })
        .finally(() => { activeRenders--; pumpQueue(); });
    }
  }

  async function renderPage(pageNum, generation = documentGeneration) {
    if (generation !== documentGeneration || !pdfDoc) return;
    if (rendered.has(pageNum)) return;
    const activeDocument = pdfDoc;
    const page = await activeDocument.getPage(pageNum);
    if (generation !== documentGeneration || activeDocument !== pdfDoc) return;
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const top = pageOffsets[pageNum - 1];

    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.dataset.page = pageNum;
    wrapper.style.position = 'absolute';
    wrapper.style.top = top + 'px';
    wrapper.style.left = '50%';
    wrapper.style.transform = 'translateX(-50%)';
    wrapper.style.width = viewport.width + 'px';
    wrapper.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    wrapper.appendChild(canvas);

    // 渲染前先挂载（异步期间用户可能已滚走）
    spacer.appendChild(wrapper);
    rendered.set(pageNum, wrapper);

    try {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const canvasTask = page.render({ canvasContext: ctx, viewport });
      renderTasks.add(canvasTask);
      try {
        await canvasTask.promise;
      } finally {
        renderTasks.delete(canvasTask);
      }
      if (generation !== documentGeneration || activeDocument !== pdfDoc) return;

      // 文本层：官方 renderTextLayer（自含 scaleX 行末校正、基线定位、旋转处理）
      const textContent = await page.getTextContent();
      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer';
      // 官方依赖 --scale-factor CSS 变量做 calc() 定位
      textLayer.style.setProperty('--scale-factor', viewport.scale);
      wrapper.appendChild(textLayer);

      try {
        const task = pdfjsLib.renderTextLayer({
          textContentSource: textContent,
          container: textLayer,
          viewport,
          isOffscreenCanvasSupported: !!window.OffscreenCanvas,
        });
        renderTasks.add(task);
        try { await task.promise; } finally { renderTasks.delete(task); }
      } catch (e) {
        console.error('文本层渲染失败:', e);
      }

      // 渲染期间用户滚远了 → 立即回收
      if (isFarFromView(pageNum)) disposePage(pageNum);

      // 选图模式: 新渲染的页面自动绘制图片热区
      if (imageSelectActive && !isFarFromView(pageNum)) {
        drawImageHotspots(wrapper, pageNum);
      }
    } catch (e) {
      if (rendered.get(pageNum) === wrapper) disposePage(pageNum);
      throw e;
    }
  }

  function isFarFromView(pageNum) {
    const scrollTop = viewerEl.scrollTop;
    const viewBottom = scrollTop + viewerEl.clientHeight;
    const top = pageOffsets[pageNum - 1];
    const bottom = top + pageHeights[pageNum - 1];
    return bottom < scrollTop - RECYCLE_MARGIN || top > viewBottom + RECYCLE_MARGIN;
  }

  // 回收页面（释放 canvas 内存）
  function disposePage(pageNum) {
    const wrapper = rendered.get(pageNum);
    if (wrapper) {
      wrapper.remove();
      rendered.delete(pageNum);
    }
  }

  // ── 缩放（fit / manual 双模式）───────────
  function zoomIn() {
    if (!pdfDoc || isLoading) return;
    zoomMode = 'manual';
    scale = Math.min(scale * 1.2, MAX_SCALE);
    reRender();
  }

  function zoomOut() {
    if (!pdfDoc || isLoading) return;
    zoomMode = 'manual';
    scale = Math.max(scale / 1.2, MIN_SCALE);
    reRender();
  }

  async function setZoomMode(mode) {
    if (!pdfDoc || isLoading || !['fit-width', 'fit-page', 'actual-size'].includes(mode)) return;
    const page = await pdfDoc.getPage(currentPage || 1);
    zoomMode = mode;
    scale = getScaleForMode(page, mode);
    await reRender();
  }

  // 缩放后重建布局并渲染视口附近页面，保持阅读位置
  async function reRender() {
    const anchorPage = currentPage;
    // 锚点页面在当前视口内的相对位置
    const anchorTop = pageOffsets[anchorPage - 1];
    const anchorOffset = viewerEl.scrollTop - anchorTop;

    await computePageLayout();
    rebuildSpacer();
    rendered.clear();
    viewerEl.innerHTML = '';
    viewerEl.appendChild(spacer);

    // 恢复滚动位置（按锚点页偏移）
    const newTop = pageOffsets[anchorPage - 1] + anchorOffset;
    viewerEl.scrollTop = Math.max(0, newTop);

    updateToolbar();
    renderVisiblePages();
  }

  // 窗口尺寸变化：适合宽度或整页模式下自适应
  let resizeTimer = null;
  function handleResize() {
    if (!pdfDoc || isLoading || !['fit-width', 'fit-page'].includes(zoomMode)) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      const page = await pdfDoc.getPage(currentPage || 1);
      const newFit = getScaleForMode(page, zoomMode);
      if (Math.abs(newFit - scale) > 0.01) {
        scale = newFit;
        reRender();
      }
    }, 200);
  }

  function updateToolbar() {
    if (!pdfDoc) return;
    zoomLabel.textContent = Math.round(scale * 100) + '%';
    pageInfo.textContent = `${currentPage} / ${pdfDoc.numPages}`;
  }

  // ── 跳页 ─────────────────────────────────
  async function gotoPage(n) {
    if (!pdfDoc) return;
    n = Math.max(1, Math.min(n, pdfDoc.numPages));
    currentPage = n;
    if (!rendered.has(n)) {
      // 优先渲染目标页
      await renderPage(n);
    }
    viewerEl.scrollTop = Math.max(0, pageOffsets[n - 1] - 10);
    updateToolbar();
    renderVisiblePages();
  }

  // 二分查找当前页
  function pageAtScrollTop(scrollTop) {
    let lo = 0, hi = pageOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pageOffsets[mid] <= scrollTop + 4) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }

  // 拼接 text items：拉丁词边界补空格（修复跨 item 单词粘连），CJK 不受影响
  function joinTextItems(items) {
    let out = '';
    for (const it of items) {
      const s = it.str || '';
      if (out && s && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(s)) out += ' ';
      out += s;
      if (it.hasEOL) out += '\n';
    }
    return out;
  }

  // 清洗选中文本：还原断词连字符、换行转空格、压缩空白
  function cleanSelectionText(raw) {
    return raw
      // 断词连字符: "frame-\nwork" → "framework"（PDF 长单词断行）
      .replace(/-\s*\r?\n\s*/g, '')
      // 普通换行 → 空格（PDF 换行是排版行为，不是断句）
      .replace(/\s*\r?\n\s*/g, ' ')
      // 压缩多余空白: 多空格/制表符 → 单空格
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  // ── 图片区域检测（选图模式用）──────────────────
  // 扫描一页的 operator list，追踪 transform 矩阵栈（save/transform/restore），
  // 对每个 paintImageXObject（args=[name,w,h]，图片自身尺寸）计算其在页面坐标系中的 bbox。
  // 返回 [{x, y, w, h}]，坐标单位为页面点（PDF 坐标，原点左下，y 向上）。
  async function detectPageImages(pageNum, providedOpList = null) {
    if (!pdfDoc) return [];
    const page = await pdfDoc.getPage(pageNum);
    const opList = providedOpList || await page.getOperatorList();
    const { fnArray, argsArray } = opList;
    const OPS = pdfjsLib.OPS;
    const images = [];

    // CTM 栈（数组表示矩阵 [a,b,c,d,e,f]，即 PDF 的当前变换矩阵）
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];

    // 矩阵乘法: 返回 a·b（PDF 变换为后乘）
    function mul(a, b) {
      return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
      ];
    }

    // 用 CTM 变换一个点 [x,y] → [x',y']
    function apply(m, x, y) {
      return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    }

    // 计算矩形的变换后 bbox（4 个角点取 min/max）
    function rectBBox(m, w, h) {
      const pts = [
        apply(m, 0, 0), apply(m, w, 0),
        apply(m, 0, h), apply(m, w, h),
      ];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of pts) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i] || [];
      if (fn === OPS.save) {
        stack.push(ctm);
      } else if (fn === OPS.restore) {
        ctm = stack.pop() || ctm;
      } else if (fn === OPS.transform) {
        ctm = mul(ctm, args);
      } else if (fn === OPS.paintImageXObject || fn === OPS.paintImageMaskXObject || fn === OPS.paintInlineImageXObject) {
        // 关键：PDF.js canvas 后端用 ctx.scale(1/width, -1/height) 绘制，
        // 图片实际占单位矩形 (0,0)-(1,1)，再经 CTM 变换到页面坐标。
        // 因此 bbox = CTM 变换单位矩形，与图片像素尺寸无关。
        images.push(rectBBox(ctm, 1, 1));
      }
    }

    // 过滤过小区域（图标/装饰线）并去重重叠
    const filtered = images.filter(b => b.w >= 8 && b.h >= 8);
    // 合并几乎重叠的（同一图片被多次 paint 或相邻碎片）
    const merged = [];
    for (const b of filtered) {
      let hit = null;
      for (const m of merged) {
        const overlapX = Math.min(b.x + b.w, m.x + m.w) - Math.max(b.x, m.x);
        const overlapY = Math.min(b.y + b.h, m.y + m.h) - Math.max(b.y, m.y);
        if (overlapX > Math.min(b.w, m.w) * 0.6 && overlapY > Math.min(b.h, m.h) * 0.6) {
          hit = m;
          break;
        }
      }
      if (hit) {
        // 扩展合并区域
        hit.x = Math.min(hit.x, b.x);
        hit.y = Math.min(hit.y, b.y);
        hit.w = Math.max(hit.x + hit.w, b.x + b.w) - hit.x;
        hit.h = Math.max(hit.y + hit.h, b.y + b.h) - hit.y;
      } else {
        merged.push({ ...b });
      }
    }
    return merged;
  }

  // ── 区域渲染成 PNG ─────────────────────────
  // 渲染页面上指定 bbox（页面点坐标）为 PNG dataURL，
  // 用 viewport transform 平移裁剪区域。scale 控制清晰度（默认 2，即 2x DPR）。
  async function renderRegionToPng(pageNum, bbox, renderScale = 2) {
    if (!pdfDoc) return null;
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const outW = Math.max(1, Math.round(bbox.w * renderScale));
    const outH = Math.max(1, Math.round(bbox.h * renderScale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
    // 渲染顺序: ctx.transform(用户T) → ctx.transform(viewportT)，组合 = 用户T ∘ viewportT。
    // viewportT(scale=1) = [1,0,0,-1,0,H]，把页面坐标(y向上)翻转为 canvas 坐标(y向下)。
    // 用户T = [rs,0,0,rs, -bx*rs, (by+bh-H)*rs]：bbox 顶部(y=by+bh)映射到 canvas y=0。
    const transform = [
      renderScale, 0, 0, renderScale,
      -bbox.x * renderScale,
      (bbox.y + bbox.h - viewport.height) * renderScale,
    ];
    await page.render({ canvasContext: ctx, viewport, transform, background: '#ffffff' }).promise;
    return canvas.toDataURL('image/png');
  }

  // ── 整页渲染成 PNG（多模态总结用）──────────
  // 把整页渲染为 PNG dataURL，可选标注页码。scale 控制清晰度（默认 1.5）。
  async function renderPageToPng(pageNum, renderScale = 1.5) {
    if (!pdfDoc) return null;
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: renderScale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/png');
  }

  // ── 选图模式（点击 PDF 中图片上传）──────────
  let imageSelectActive = false;
  let imageSelectCallback = null;

  // 页面坐标(scale=1, y向上) → wrapper CSS 坐标(y向下)
  function pageToCss(bbox, pageHeight1, cssScale) {
    return {
      left: bbox.x * cssScale,
      top: (pageHeight1 - bbox.y - bbox.h) * cssScale,
      width: bbox.w * cssScale,
      height: bbox.h * cssScale,
    };
  }

  // 在指定页面 wrapper 上绘制图片热区
  async function drawImageHotspots(wrapper, pageNum) {
    if (!imageSelectActive) return;
    wrapper.querySelectorAll('.image-hotspot').forEach(el => el.remove());
    let boxes;
    try {
      boxes = await detectPageImages(pageNum);
    } catch (e) {
      console.error('检测图片区域失败:', e);
      return;
    }
    // await 期间可能已退出选图模式或页面被回收 → 放弃绘制，避免残留热区
    if (!imageSelectActive || !wrapper.isConnected) return;
    const page = await pdfDoc.getPage(pageNum);
    const pageHeight1 = page.getViewport({ scale: 1 }).height;
    const cssScale = scale;
    for (const bbox of boxes) {
      const pos = pageToCss(bbox, pageHeight1, cssScale);
      const el = document.createElement('div');
      el.className = 'image-hotspot';
      el.style.left = pos.left + 'px';
      el.style.top = pos.top + 'px';
      el.style.width = pos.width + 'px';
      el.style.height = pos.height + 'px';
      el.title = '点击上传此图片';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (imageSelectCallback) imageSelectCallback(pageNum, bbox);
      });
      wrapper.appendChild(el);
    }
  }

  // 进入选图模式: 对已渲染页面绘制热区; 新渲染页面也会自动绘制
  function enterImageSelectMode(callback) {
    imageSelectActive = true;
    imageSelectCallback = callback;
    for (const [pageNum, wrapper] of rendered) {
      if (isFarFromView(pageNum)) continue;
      drawImageHotspots(wrapper, pageNum);
    }
  }

  // 退出选图模式: 移除所有热区 + 清理进行中的框选
  function exitImageSelectMode() {
    imageSelectActive = false;
    imageSelectCallback = null;
    viewerEl.querySelectorAll('.image-hotspot').forEach(el => el.remove());
    if (dragState) {
      if (dragState.rectEl) dragState.rectEl.remove();
      dragState = null;
      window.removeEventListener('mousemove', onSelectMouseMove);
    }
  }

  // ── 自由框选（选图模式内，矢量图/任意区域可用）──────
  // 拖拽画矩形选区，松开把区域页面坐标交给回调（与位图热区并存：
  // 点热区 = 选位图，拖拽 = 框选任意区域）
  let dragState = null;  // { wrapper, pageNum, startX, startY, rectEl }

  function onSelectMouseDown(e) {
    if (!imageSelectActive || e.button !== 0) return;
    // 点在图片热区上 → 交给热区 click 处理
    if (e.target.classList && e.target.classList.contains('image-hotspot')) return;
    const wrapper = e.target.closest ? e.target.closest('.page-wrapper') : null;
    if (!wrapper) return;
    e.preventDefault();  // 阻止文本选择
    const rect = wrapper.getBoundingClientRect();
    dragState = {
      wrapper,
      pageNum: parseInt(wrapper.dataset.page),
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      rectEl: null,
    };
    window.addEventListener('mousemove', onSelectMouseMove);
    window.addEventListener('mouseup', onSelectMouseUp, { once: true });
  }

  function dragRect(ds, e) {
    const r = ds.wrapper.getBoundingClientRect();
    // 限制在页面范围内（不跨页）
    const curX = Math.max(0, Math.min(e.clientX - r.left, r.width));
    const curY = Math.max(0, Math.min(e.clientY - r.top, r.height));
    return {
      x: Math.min(ds.startX, curX),
      y: Math.min(ds.startY, curY),
      w: Math.abs(curX - ds.startX),
      h: Math.abs(curY - ds.startY),
    };
  }

  function onSelectMouseMove(e) {
    if (!dragState) return;
    if (!dragState.wrapper.isConnected) { dragState = null; return; }  // 页面被回收
    const { x, y, w, h } = dragRect(dragState, e);
    if (!dragState.rectEl && w > 4 && h > 4) {
      const el = document.createElement('div');
      el.className = 'region-select-rect';
      dragState.wrapper.appendChild(el);
      dragState.rectEl = el;
    }
    if (dragState.rectEl) {
      dragState.rectEl.style.left = x + 'px';
      dragState.rectEl.style.top = y + 'px';
      dragState.rectEl.style.width = w + 'px';
      dragState.rectEl.style.height = h + 'px';
    }
  }

  async function onSelectMouseUp(e) {
    window.removeEventListener('mousemove', onSelectMouseMove);
    if (!dragState) return;
    const ds = dragState;
    dragState = null;
    if (!ds.rectEl) return;  // 单击未拖动 → 不处理
    const { x, y, w, h } = dragRect(ds, e);
    ds.rectEl.remove();
    if (!ds.wrapper.isConnected) return;
    if (w < 8 || h < 8) return;  // 过小忽略
    // CSS 坐标(y向下) → 页面坐标(scale=1, y向上)
    const page = await pdfDoc.getPage(ds.pageNum);
    const pageHeight1 = page.getViewport({ scale: 1 }).height;
    const bbox = {
      x: x / scale,
      y: pageHeight1 - (y + h) / scale,
      w: w / scale,
      h: h / scale,
    };
    if (imageSelectCallback) imageSelectCallback(ds.pageNum, bbox);
  }

  // ── 事件绑定 ─────────────────────────────
  function init() {
    // 滚轮缩放 (Ctrl+滚轮)
    viewerEl.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn(); else zoomOut();
      }
    }, { passive: false });

    // 滚动：更新页码 + 按需渲染（rAF 节流）
    viewerEl.addEventListener('scroll', () => {
      if (!pdfDoc || isLoading) return;
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        currentPage = pageAtScrollTop(viewerEl.scrollTop);
        pageInfo.textContent = `${currentPage} / ${pdfDoc.numPages}`;
        renderVisiblePages();
        if (onProgress) {
          const denominator = Math.max(1, totalHeight - viewerEl.clientHeight);
          onProgress({
            page: currentPage,
            zoom: scale,
            scrollRatio: Math.max(0, Math.min(1, viewerEl.scrollTop / denominator)),
            generation: documentGeneration,
          });
        }
      });
    });

    // 划词翻译：事件委托到容器（选图模式时禁用，避免与热区点击冲突）
    viewerEl.addEventListener('mouseup', () => {
      if (!pdfDoc || imageSelectActive) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = cleanSelectionText(sel.toString());
      if (text && onTextSelect) onTextSelect(text);
    });

    // 自由框选（选图模式下拖拽选区）
    viewerEl.addEventListener('mousedown', onSelectMouseDown);

    // 窗口 resize：fit 模式自适应
    window.addEventListener('resize', handleResize);

  }

  // 提取全文（用于 AI 全文问答上下文），onProgress({current,total}) 每 10 页回调
  // 支持页数范围: { start, end }（1-based，含两端）
  async function extractFullText(onProgress, range) {
    if (!pdfDoc) return '';
    const activeDocument = pdfDoc;
    const generation = documentGeneration;
    const start = (range && range.start) || 1;
    const end = (range && range.end) || activeDocument.numPages;
    const total = end - start + 1;
    let full = '';
    let count = 0;
    for (let p = start; p <= end; p++) {
      if (generation !== documentGeneration || activeDocument !== pdfDoc) throw new Error('文档已切换');
      const page = await activeDocument.getPage(p);
      const tc = await page.getTextContent();
      full += joinTextItems(tc.items) + '\n';
      count++;
      // 进度回调 + 让出主线程
      if (count % 10 === 0) {
        if (onProgress) onProgress({ current: count, total });
        await new Promise(r => setTimeout(r, 0));
      }
    }
    if (onProgress) onProgress({ current: total, total });
    // 清洗断词连字符: "frame-\nwork" → "framework"
    return full.replace(/-\n/g, '');
  }

  function median(values) {
    if (!values.length) return 10;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function reflowBlockType(line, medianFontSize) {
    const text = line.text;
    if (/^(?:fig(?:ure)?|table|algorithm)\s+\d+\b/i.test(text)) return 'caption';
    if (/^(?:[-•‣]|\d+[.)])\s+/.test(text)) return 'list';
    if (line.monospace || (/^[\w.<>()[\]{};,:=+\-/*]+(?:\s+[\w.<>()[\]{};,:=+\-/*]+)*$/.test(text) && /[{};]|\b(?:const|let|class|def|return|import)\b/.test(text))) return 'code';
    const mathGlyphs = (text.match(/[=+−×÷±∓∑∫∏√∞≈≠≤≥→↔∀∃∈∉⊂⊆∪∩λμσθφψωαβγδπρτχΩΔΣΠ^_]/g) || []).length;
    const strongMathGlyphs = (text.match(/[∑∫∏√∞≈≠≤≥→↔∀∃∈∉⊂⊆∪∩λμσθφψωαβγδπρτχΩΔΣΠ]/g) || []).length;
    const looksLikeFigureMetadata = /\(\s*\|[^|]+\|\s*,\s*\|[^|]+\|\s*\)\s*=\s*\(\s*\d+\s*,\s*\d+\s*\)/.test(text);
    const looksLikeDisplayMath = text.length <= 220
      && !/[.!?。！？]$/.test(text)
      && !looksLikeFigureMetadata
      && (mathGlyphs >= 2 || strongMathGlyphs >= 1 || line.mathFontRatio >= 0.3)
      && (mathGlyphs >= 2 || /\b(?:sin|cos|tan|log|lim|max|min|exp)\b/i.test(text) || line.mathFontRatio >= 0.5);
    if (looksLikeDisplayMath) return 'equation';
    if (text.length <= 160 && (line.bold || line.fontSize >= medianFontSize * 1.18 || /^(?:\d+(?:\.\d+)*\s+|[IVX]{1,6}\.\s+)/.test(text))) return 'heading';
    return 'paragraph';
  }

  function buildReflowLines(items, pageWidth, styles = {}) {
    const usable = items.map((item) => ({
      text: String(item.str || '').replace(/\s+/g, ' ').trim(),
      x: Number(item.transform && item.transform[4]) || 0,
      y: Number(item.transform && item.transform[5]) || 0,
      width: Math.max(0, Number(item.width) || 0),
      height: Math.max(1, Number(item.height) || Math.abs(item.transform && item.transform[3]) || 10),
      fontName: [item.fontName, styles[item.fontName] && styles[item.fontName].fontFamily].filter(Boolean).join(' '),
    })).filter((item) => item.text);
    if (!usable.length) return [];
    const mid = pageWidth / 2;
    const left = usable.filter((item) => item.x + item.width * 0.5 < mid * 0.98);
    const right = usable.filter((item) => item.x + item.width * 0.5 >= mid * 1.02);
    const columns = left.length >= 6 && right.length >= 6 ? [left, right] : [usable];
    const lines = [];
    for (const column of columns) {
      const sorted = [...column].sort((a, b) => b.y - a.y || a.x - b.x);
      const columnLines = [];
      for (const item of sorted) {
        const previous = columnLines[columnLines.length - 1];
        const tolerance = Math.max(2, item.height * 0.48);
        if (previous && Math.abs(previous.y - item.y) <= tolerance) {
          previous.items.push(item);
          previous.y = (previous.y * (previous.items.length - 1) + item.y) / previous.items.length;
        } else {
          columnLines.push({ y: item.y, items: [item] });
        }
      }
      for (const line of columnLines) {
        const itemsInLine = line.items.sort((a, b) => a.x - b.x);
        const first = itemsInLine[0];
        const last = itemsInLine[itemsInLine.length - 1];
        lines.push({
          text: joinTextItems(itemsInLine.map((item) => ({ str: item.text }))).replace(/\s+/g, ' ').trim(),
          y: line.y,
          x: first.x,
          width: Math.max(1, last.x + last.width - first.x),
          height: Math.max(...itemsInLine.map((item) => item.height)),
          fontSize: median(itemsInLine.map((item) => item.height)),
          bold: itemsInLine.some((item) => /bold|black|heavy/i.test(item.fontName)),
          monospace: itemsInLine.filter((item) => /mono|courier|consolas|code/i.test(item.fontName)).length * 2 >= itemsInLine.length,
          mathFontRatio: itemsInLine.filter((item) => /math|symbol|cmmi|cmsy|cmex|msam|msbm|stix|asana|euler|mt extra|tex/i.test(item.fontName)).length / itemsInLine.length,
        });
      }
    }
    return lines;
  }

  function normalizedRectToPdfBbox(rect, pageWidth, pageHeight, padding = 0) {
    const x = rect.left * pageWidth - padding;
    const y = pageHeight - (rect.top + rect.height) * pageHeight - padding;
    const right = (rect.left + rect.width) * pageWidth + padding;
    const top = pageHeight - rect.top * pageHeight + padding;
    const clippedX = Math.max(0, x);
    const clippedY = Math.max(0, y);
    return {
      x: clippedX,
      y: clippedY,
      w: Math.max(1, Math.min(pageWidth, right) - clippedX),
      h: Math.max(1, Math.min(pageHeight, top) - clippedY),
    };
  }

  function pdfBboxToNormalizedRect(bbox, pageWidth, pageHeight) {
    return {
      left: Math.max(0, Math.min(1, bbox.x / pageWidth)),
      top: Math.max(0, Math.min(1, 1 - (bbox.y + bbox.h) / pageHeight)),
      width: Math.max(0, Math.min(1, bbox.w / pageWidth)),
      height: Math.max(0, Math.min(1, bbox.h / pageHeight)),
    };
  }

  function insertVisualBlock(pageBlocks, visualBlock) {
    const rect = visualBlock.sourceRect;
    if (!rect) {
      pageBlocks.push(visualBlock);
      return;
    }
    const left = rect.left;
    const right = rect.left + rect.width;
    let captionIndex = -1;
    let captionDistance = Infinity;
    for (let index = 0; index < pageBlocks.length; index++) {
      const candidate = pageBlocks[index];
      const candidateRect = candidate.sourceRect;
      if (candidate.type !== 'caption' || !candidateRect) continue;
      const overlap = Math.min(right, candidateRect.left + candidateRect.width) - Math.max(left, candidateRect.left);
      const distance = candidateRect.top - (rect.top + rect.height);
      if (overlap > Math.min(rect.width, candidateRect.width) * 0.25 && distance >= -0.03 && distance < 0.18 && distance < captionDistance) {
        captionIndex = index;
        captionDistance = distance;
      }
    }
    if (captionIndex >= 0) {
      pageBlocks.splice(captionIndex, 0, visualBlock);
      return;
    }
    const center = rect.left + rect.width / 2;
    const insertionIndex = pageBlocks.findIndex((candidate) => {
      const candidateRect = candidate.sourceRect;
      if (!candidateRect || candidateRect.top <= rect.top) return false;
      const candidateCenter = candidateRect.left + candidateRect.width / 2;
      return Math.abs(candidateCenter - center) <= 0.32;
    });
    if (insertionIndex >= 0) pageBlocks.splice(insertionIndex, 0, visualBlock);
    else pageBlocks.push(visualBlock);
  }

  async function extractReflowBlocks(onProgress, signal) {
    if (!pdfDoc) throw new Error('未打开 PDF');
    const activeDocument = pdfDoc;
    const generation = documentGeneration;
    const blocks = [];
    let assetCount = 0;
    const maxDocumentAssets = 250;
    for (let pageNum = 1; pageNum <= activeDocument.numPages; pageNum++) {
      if (signal && signal.aborted) throw new DOMException('排版已取消', 'AbortError');
      if (generation !== documentGeneration || activeDocument !== pdfDoc) throw new Error('文档已切换');
      const page = await activeDocument.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines = buildReflowLines(content.items, viewport.width, content.styles || {});
      const medianFontSize = median(lines.map((line) => line.fontSize));
      const pageBlocks = [];
      let pending = null;
      const flush = () => {
        if (pending) {
          delete pending.lastY;
          pageBlocks.push(pending);
          pending = null;
        }
      };
      for (const line of lines) {
        if (!line.text) continue;
        const type = reflowBlockType(line, medianFontSize);
        const rect = {
          left: Math.max(0, Math.min(1, line.x / viewport.width)),
          top: Math.max(0, Math.min(1, 1 - (line.y + line.height) / viewport.height)),
          width: Math.max(0, Math.min(1, line.width / viewport.width)),
          height: Math.max(0, Math.min(1, line.height / viewport.height)),
        };
        const canAppend = pending && pending.type === 'paragraph' && type === 'paragraph'
          && Math.abs(pending.lastY - line.y) <= Math.max(medianFontSize * 2.3, line.height * 2.2);
        if (!canAppend) {
          flush();
          pending = {
            type,
            sourcePageStart: pageNum - 1,
            sourcePageEnd: pageNum - 1,
            sourceRect: rect,
            textContent: line.text,
            confidence: lines.length ? 0.78 : 0.35,
            meta: { local: true },
            lastY: line.y,
          };
        } else {
          pending.textContent += (pending.textContent.endsWith('-') ? '' : ' ') + line.text;
          pending.sourceRect.width = Math.max(pending.sourceRect.width, rect.left + rect.width - pending.sourceRect.left);
          pending.sourceRect.height = Math.max(pending.sourceRect.height, rect.top + rect.height - pending.sourceRect.top);
          pending.lastY = line.y;
        }
      }
      flush();

      let pageOpList = null;
      try { pageOpList = await page.getOperatorList(); } catch {}
      const vectorOps = new Set([
        pdfjsLib.OPS.constructPath,
        pdfjsLib.OPS.stroke,
        pdfjsLib.OPS.closeStroke,
        pdfjsLib.OPS.fill,
        pdfjsLib.OPS.eoFill,
        pdfjsLib.OPS.fillStroke,
        pdfjsLib.OPS.eoFillStroke,
        pdfjsLib.OPS.closeFillStroke,
        pdfjsLib.OPS.closeEOFillStroke,
        pdfjsLib.OPS.shadingFill,
      ]);
      const vectorOpCount = pageOpList
        ? pageOpList.fnArray.reduce((count, fn) => count + (vectorOps.has(fn) ? 1 : 0), 0)
        : 0;
      const totalPageTextChars = pageBlocks.reduce((sum, block) => sum + block.textContent.length, 0);
      const longProseBlocks = pageBlocks.filter((block) => block.type === 'paragraph' && block.textContent.length >= 120).length;
      const vectorHeavyVisualPage = vectorOpCount >= 24 && totalPageTextChars <= 800 && longProseBlocks === 0;

      // 纯图表/示意图页通常由大量矢量路径组成，强行提取文字只会留下散乱刻度和标签。
      // 对“绘制密集且正文稀少”的整页采用保真渲染；普通论文正文页不触发。
      if (vectorHeavyVisualPage && assetCount < maxDocumentAssets) {
        try {
          const margin = 4;
          const bbox = {
            x: margin,
            y: margin,
            w: Math.max(1, viewport.width - margin * 2),
            h: Math.max(1, viewport.height - margin * 2),
          };
          const renderScale = Math.max(1.2, Math.min(1.6, 1400 / Math.max(bbox.w, bbox.h)));
          const dataUrl = await renderRegionToPng(pageNum, bbox, renderScale);
          if (dataUrl) {
            pageBlocks.length = 0;
            pageBlocks.push({
              type: 'figure',
              sourcePageStart: pageNum - 1,
              sourcePageEnd: pageNum - 1,
              sourceRect: pdfBboxToNormalizedRect(bbox, viewport.width, viewport.height),
              textContent: `矢量图页（第 ${pageNum} 页）`,
              confidence: 0.86,
              meta: {
                local: true,
                visualPreserved: true,
                assetKind: 'vector-heavy-page',
                vectorOpCount,
              },
              asset: {
                dataUrl,
                width: Math.max(1, Math.round(bbox.w * renderScale)),
                height: Math.max(1, Math.round(bbox.h * renderScale)),
              },
            });
            assetCount++;
          }
        } catch (error) {
          console.warn(`第 ${pageNum} 页矢量保真渲染失败:`, error);
        }
      }

      // 公式的纯文本层通常会丢失上下标、分数线和矩阵位置，因此对明确的陈列公式
      // 保留本地页面裁剪；裁剪失败时仍保留原 equation 文字块作为安全回退。
      const equationBlocks = vectorHeavyVisualPage ? [] : pageBlocks.filter((block) => block.type === 'equation').slice(0, 20);
      for (const block of equationBlocks) {
        if (signal && signal.aborted) throw new DOMException('排版已取消', 'AbortError');
        if (assetCount >= maxDocumentAssets) break;
        try {
          const bbox = normalizedRectToPdfBbox(block.sourceRect, viewport.width, viewport.height, 8);
          const renderScale = Math.max(1.5, Math.min(2.5, 1500 / Math.max(bbox.w, bbox.h)));
          const dataUrl = await renderRegionToPng(pageNum, bbox, renderScale);
          if (!dataUrl) continue;
          block.type = 'formula-image';
          block.asset = {
            dataUrl,
            width: Math.max(1, Math.round(bbox.w * renderScale)),
            height: Math.max(1, Math.round(bbox.h * renderScale)),
          };
          block.meta = { ...block.meta, visualPreserved: true, assetKind: 'display-formula' };
          assetCount++;
        } catch (error) {
          console.warn(`第 ${pageNum} 页公式保真裁剪失败:`, error);
        }
      }

      // PDF.js 已能给出嵌入位图的页面坐标；这里只保留足够大的内容图，过滤图标、装饰线和整页背景。
      if (assetCount < maxDocumentAssets && !vectorHeavyVisualPage) {
        try {
          const pageArea = viewport.width * viewport.height;
          const imageBoxes = (await detectPageImages(pageNum, pageOpList))
            .filter((bbox) => bbox.w >= 36 && bbox.h >= 28
              && bbox.w * bbox.h >= pageArea * 0.0025
              && bbox.w * bbox.h <= pageArea * 0.92)
            .sort((a, b) => (b.w * b.h) - (a.w * a.h))
            .slice(0, 12);
          for (const rawBbox of imageBoxes) {
            if (signal && signal.aborted) throw new DOMException('排版已取消', 'AbortError');
            if (assetCount >= maxDocumentAssets) break;
            const bbox = {
              x: Math.max(0, rawBbox.x - 2),
              y: Math.max(0, rawBbox.y - 2),
              w: Math.min(viewport.width, rawBbox.x + rawBbox.w + 2) - Math.max(0, rawBbox.x - 2),
              h: Math.min(viewport.height, rawBbox.y + rawBbox.h + 2) - Math.max(0, rawBbox.y - 2),
            };
            const renderScale = Math.max(1.2, Math.min(2, 1400 / Math.max(bbox.w, bbox.h)));
            const dataUrl = await renderRegionToPng(pageNum, bbox, renderScale);
            if (!dataUrl) continue;
            insertVisualBlock(pageBlocks, {
              type: 'figure',
              sourcePageStart: pageNum - 1,
              sourcePageEnd: pageNum - 1,
              sourceRect: pdfBboxToNormalizedRect(bbox, viewport.width, viewport.height),
              textContent: `图像（第 ${pageNum} 页）`,
              confidence: 0.9,
              meta: { local: true, visualPreserved: true, assetKind: 'embedded-image' },
              asset: {
                dataUrl,
                width: Math.max(1, Math.round(bbox.w * renderScale)),
                height: Math.max(1, Math.round(bbox.h * renderScale)),
              },
            });
            assetCount++;
          }
        } catch (error) {
          if (error && error.name === 'AbortError') throw error;
          console.warn(`第 ${pageNum} 页图片保真提取失败:`, error);
        }
      }

      blocks.push(...pageBlocks);
      if (onProgress) onProgress({ current: pageNum, total: activeDocument.numPages });
      if (pageNum % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return blocks;
  }

  // ── 多页拼网格图（多模态总结用）───────────
  // 把多个页面按 cols 列拼成一张网格 PNG（每格带页码角标），
  // 减少请求中的图片数量。返回 dataURL。
  async function renderPagesToGrid(pageNums, cols = 2, renderScale = 1.2) {
    if (!pdfDoc || pageNums.length === 0) return null;
    const activeDocument = pdfDoc;
    const generation = documentGeneration;
    const pages = [];
    for (const p of pageNums) {
      if (generation !== documentGeneration || activeDocument !== pdfDoc) throw new Error('文档已切换');
      pages.push({ page: await activeDocument.getPage(p), num: p });
    }
    // 以最大页尺寸为格基准（论文页通常同尺寸）
    let cellW = 0, cellH = 0;
    const vps = pages.map(({ page }) => page.getViewport({ scale: renderScale }));
    for (const vp of vps) {
      cellW = Math.max(cellW, vp.width);
      cellH = Math.max(cellH, vp.height);
    }
    cellW = Math.floor(cellW);
    cellH = Math.floor(cellH);
    const rows = Math.ceil(pages.length / cols);
    const gap = 8; // 格间距 px
    const canvas = document.createElement('canvas');
    canvas.width = cellW * cols + gap * (cols + 1);
    canvas.height = cellH * rows + gap * (rows + 1);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < pages.length; i++) {
      const { page, num } = pages[i];
      const vp = vps[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = gap + col * (cellW + gap);
      const y = gap + row * (cellH + gap);
      // 白底 + 页面渲染
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, cellW, cellH);
      try {
        // 用户T ∘ viewportT：viewportT 把页面顶部映射到 canvas y=0，
        // 页面底部映射到 y=vp.height。用 translate 让页面顶部落在格子顶部，
        // 再补偿 vp.height 与 cellH 的差使页面底部对齐格子底部。
        const ty = y + (cellH - vp.height);
        await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, x, ty] }).promise;
      } catch (e) { /* 单格失败不影响整体 */ }
      // 页码角标
      ctx.fillStyle = 'rgba(37, 99, 235, 0.9)';
      ctx.fillRect(x, y, 44, 20);
      ctx.fillStyle = '#fff';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('p.' + num, x + 22, y + 10);
    }
    return canvas.toDataURL('image/png');
  }

  // ── 对外接口 ─────────────────────────────
  return {
    init,
    loadPdf,
    zoomIn,
    zoomOut,
    setZoomMode,
    gotoPage,
    extractFullText,
    extractReflowBlocks,
    detectPageImages,
    renderRegionToPng,
    renderPageToPng,
    renderPagesToGrid,
    enterImageSelectMode,
    exitImageSelectMode,
    releaseDocument,
    get currentPage() { return currentPage; },
    get pageCount() { return pdfDoc ? pdfDoc.numPages : 0; },
    get zoomMode() { return zoomMode; },
    get zoom() { return scale; },
    set onTextSelect(fn) { onTextSelect = fn; },
    set onPdfLoaded(fn) { onPdfLoaded = fn; },
    set onProgress(fn) { onProgress = fn; },
  };
})();
