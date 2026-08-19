/**
 * 本地文献库首页：只负责展示、导入和主题，不直接接触文件系统路径。
 */
const LibraryUI = (() => {
  'use strict';

  const view = document.getElementById('library-view');
  const readerView = document.getElementById('reader-view');
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  const summary = document.getElementById('library-summary');
  const title = document.getElementById('library-title');
  const message = document.getElementById('library-message');
  const themeSelect = document.getElementById('theme-select');
  const readerTitle = document.getElementById('reader-document-title');
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  let documents = [];
  let filter = 'all';
  let callbacks = {};
  let themePreference = 'system';

  function effectiveTheme() {
    return themePreference === 'system' ? (media.matches ? 'dark' : 'light') : themePreference;
  }

  function applyTheme() {
    document.documentElement.dataset.theme = effectiveTheme();
    document.documentElement.dataset.themePreference = themePreference;
  }

  function formatDate(value) {
    if (!value) return '尚未阅读';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '尚未阅读';
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
  }

  function showMessage(text, kind = 'info') {
    message.textContent = text;
    message.className = `library-message ${kind}`;
    window.setTimeout(() => message.classList.add('hidden'), 4200);
  }

  function filteredDocuments() {
    if (filter === 'favorite') return documents.filter((doc) => !!doc.favorite);
    if (filter === 'recent') return documents.filter((doc) => !!doc.last_opened_at);
    return documents;
  }

  function render() {
    const items = filteredDocuments();
    const labels = { all: '全部文献', recent: '最近阅读', favorite: '收藏' };
    title.textContent = labels[filter];
    summary.textContent = `${items.length} 篇文献 · 数据仅保存在本机`;
    grid.innerHTML = '';
    empty.classList.toggle('hidden', items.length !== 0);

    for (const doc of items) {
      const card = document.createElement('article');
      card.className = `document-card${doc.file_path ? '' : ' unavailable'}`;
      card.dataset.documentId = doc.document_id;
      const progress = Math.max(0, Math.min(100, Math.round(Number(doc.scroll_ratio || 0) * 100)));
      const typeLabel = doc.location_kind === 'managed' ? '库内副本' : (doc.file_path ? '原文件引用' : '文件待定位');
      card.innerHTML = `
        <div class="document-cover"><span>PDF</span><i>${progress}%</i></div>
        <div class="document-meta">
          <div class="document-title-row">
            <h3></h3>
            <button class="favorite-button" title="${doc.favorite ? '取消收藏' : '收藏'}">${doc.favorite ? '★' : '☆'}</button>
          </div>
          <p class="document-kind">${typeLabel}</p>
          <div class="progress-track"><span style="width:${progress}%"></span></div>
          <div class="document-footer"><span>第 ${doc.current_page || 1} 页</span><span>${formatDate(doc.last_opened_at)}</span></div>
        </div>`;
      card.querySelector('h3').textContent = doc.title || '未命名文献';
      card.querySelector('.favorite-button').addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await window.deepshui.library.setFavorite(doc.document_id, !doc.favorite);
          await refresh();
        } catch (error) {
          showMessage(error.message, 'error');
        }
      });
      card.addEventListener('click', async () => {
        if (!doc.file_path) {
          try {
            const relinked = await window.deepshui.library.relink(doc.document_id);
            if (relinked) {
              showMessage('文件已重新定位', 'success');
              await refresh();
            }
          } catch (error) {
            showMessage(error.message, 'error');
          }
          return;
        }
        if (callbacks.onOpenDocument) callbacks.onOpenDocument(doc.document_id);
      });
      grid.appendChild(card);
    }
  }

  async function refresh() {
    try {
      documents = await window.deepshui.library.list();
      render();
    } catch (error) {
      showMessage(`读取文献库失败：${error.message}`, 'error');
      summary.textContent = '文献库暂时不可用';
    }
  }

  async function importPdf(mode) {
    try {
      const result = await window.deepshui.library.importDialog(mode);
      if (!result) return;
      showMessage(mode === 'managed' ? '已复制到本地文献库' : '已引用原文件', 'success');
      await refresh();
      if (callbacks.onOpenDocument) callbacks.onOpenDocument(result.document_id);
    } catch (error) {
      showMessage(`导入失败：${error.message}`, 'error');
    }
  }

  async function importDroppedFile(file) {
    try {
      const result = await window.deepshui.library.importDroppedFile(file, 'reference');
      showMessage('已引用拖入的 PDF', 'success');
      await refresh();
      if (callbacks.onOpenDocument) callbacks.onOpenDocument(result.document_id);
    } catch (error) {
      showMessage(`导入失败：${error.message}`, 'error');
    }
  }

  function showLibrary() {
    readerView.classList.add('hidden');
    view.classList.remove('hidden');
    document.title = '深水翻译 · 本地文献库';
    refresh();
  }

  function showReader(documentTitle) {
    readerTitle.textContent = documentTitle || '未命名文献';
    view.classList.add('hidden');
    readerView.classList.remove('hidden');
  }

  async function init(options = {}) {
    callbacks = options;
    document.querySelectorAll('.library-filter').forEach((button) => {
      button.addEventListener('click', () => {
        document.querySelectorAll('.library-filter').forEach((item) => item.classList.remove('active'));
        button.classList.add('active');
        filter = button.dataset.filter;
        render();
      });
    });
    document.getElementById('import-reference').addEventListener('click', () => importPdf('reference'));
    document.getElementById('empty-import-reference').addEventListener('click', () => importPdf('reference'));
    document.getElementById('import-managed').addEventListener('click', () => importPdf('managed'));
    document.getElementById('empty-import-managed').addEventListener('click', () => importPdf('managed'));
    document.getElementById('library-settings').addEventListener('click', () => callbacks.onShowSettings?.());

    themePreference = await window.deepshui.theme.get();
    themeSelect.value = themePreference;
    applyTheme();
    themeSelect.addEventListener('change', async () => {
      themePreference = await window.deepshui.theme.set(themeSelect.value);
      applyTheme();
    });
    media.addEventListener('change', () => {
      if (themePreference === 'system') applyTheme();
    });

    document.addEventListener('dragover', (event) => {
      if ([...(event.dataTransfer?.items || [])].some((item) => item.kind === 'file')) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        showMessage('请拖入 PDF 文件', 'error');
        return;
      }
      importDroppedFile(file);
    });

    await refresh();
  }

  return { init, refresh, showLibrary, showReader, importPdf };
})();
