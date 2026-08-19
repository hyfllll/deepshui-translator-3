'use strict';

const crypto = require('node:crypto');

function registerLibraryIpc({ ipcMain, dialog, getMainWindow, library, db, tokens, sessionPartition }) {
  function assertTrusted(event) {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
      throw new Error('拒绝不受信任的 IPC 调用');
    }
    const frameUrl = event.senderFrame && event.senderFrame.url;
    if (frameUrl && !frameUrl.startsWith('app://local/')) throw new Error('拒绝非应用页面的 IPC 调用');
  }

  async function choosePdf(title) {
    const mainWindow = getMainWindow();
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title,
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  }

  const handlers = {
    'library:list': async (event) => {
      assertTrusted(event);
      return library.listDocuments();
    },
    'library:import-dialog': async (event, mode) => {
      assertTrusted(event);
      const filePath = await choosePdf(mode === 'managed' ? '复制 PDF 到资料库' : '引用 PDF');
      if (!filePath) return null;
      return library.importFile(filePath, { mode });
    },
    'library:import-path': async (event, payload) => {
      assertTrusted(event);
      if (!payload || typeof payload.filePath !== 'string') throw new Error('无效的导入请求');
      return library.importFile(payload.filePath, { mode: payload.mode });
    },
    'library:open': async (event, payload) => {
      assertTrusted(event);
      const documentId = String(payload && payload.documentId || '');
      const generation = Number(payload && payload.generation || 0);
      if (!documentId || !Number.isSafeInteger(generation) || generation < 1) throw new Error('无效的文档打开请求');
      tokens.revokeFor(event.sender.id);
      const { document, location } = await library.resolveDocument(documentId);
      const progress = await db.call('beginDocumentSession', { documentId });
      const issued = tokens.issue({
        documentId,
        filePath: location.canonical_path,
        webContentsId: event.sender.id,
        sessionPartition,
        generation: progress.generation,
      });
      return {
        documentId,
        generation,
        serverGeneration: progress.generation,
        title: document.title,
        contentHash: document.content_hash,
        pageCount: document.page_count,
        url: issued.url,
        expiresAt: issued.expiresAt,
        progress,
      };
    },
    'library:revoke': async (event, generation) => {
      assertTrusted(event);
      tokens.revokeFor(event.sender.id);
      return true;
    },
    'library:set-favorite': async (event, payload) => {
      assertTrusted(event);
      await db.call('setFavorite', {
        documentId: String(payload && payload.documentId || ''),
        favorite: !!(payload && payload.favorite),
      });
      return true;
    },
    'library:relink-dialog': async (event, documentId) => {
      assertTrusted(event);
      const filePath = await choosePdf('重新定位 PDF');
      if (!filePath) return null;
      return library.relinkDocument(String(documentId || ''), filePath);
    },
    'library:get-progress': async (event, documentId) => {
      assertTrusted(event);
      return db.call('getProgress', { documentId: String(documentId || '') });
    },
    'library:save-progress': async (event, payload) => {
      assertTrusted(event);
      if (!payload || typeof payload.documentId !== 'string') throw new Error('无效的进度请求');
      return db.call('saveProgress', payload);
    },
    'reader:get-preferences': async (event, documentId) => {
      assertTrusted(event);
      if (typeof documentId !== 'string' || !documentId) throw new Error('文档 ID 无效');
      return db.call('getReaderPreferences', { documentId });
    },
    'reader:save-preferences': async (event, payload) => {
      assertTrusted(event);
      if (!payload || typeof payload.documentId !== 'string') throw new Error('阅读偏好请求无效');
      return db.call('saveReaderPreferences', payload);
    },
    'reflow:get': async (event, documentId) => {
      assertTrusted(event);
      if (typeof documentId !== 'string' || !documentId) throw new Error('文档 ID 无效');
      return db.call('getReflowDocument', { documentId });
    },
    'reflow:publish': async (event, payload) => {
      assertTrusted(event);
      if (!payload || typeof payload.documentId !== 'string' || typeof payload.sourceContentHash !== 'string') {
        throw new Error('本地排版结果无效');
      }
      return db.call('publishReflowDocument', payload, 60_000);
    },
    'settings:get-theme': async (event) => {
      assertTrusted(event);
      return (await db.call('getSetting', { key: 'theme' })) || 'system';
    },
    'settings:set-theme': async (event, theme) => {
      assertTrusted(event);
      if (!['system', 'light', 'dark'].includes(theme)) throw new Error('无效主题');
      await db.call('setSetting', { key: 'theme', value: theme });
      return theme;
    },
    'bookmarks:list': async (event, documentId) => {
      assertTrusted(event);
      if (typeof documentId !== 'string' || !documentId) throw new Error('文档 ID 无效');
      return db.call('listBookmarks', { documentId });
    },
    'bookmarks:toggle': async (event, payload) => {
      assertTrusted(event);
      if (!payload || typeof payload.documentId !== 'string') throw new Error('书签请求无效');
      return db.call('toggleBookmark', {
        bookmarkId: crypto.randomUUID(),
        documentId: payload.documentId,
        pageIndex: Number(payload.pageIndex),
        generation: Number(payload.generation),
        label: String(payload.label || ''),
      });
    },
    'annotations:list': async (event, payload) => {
      assertTrusted(event);
      if (!payload || typeof payload.documentId !== 'string') throw new Error('批注查询无效');
      return db.call('listAnnotations', {
        documentId: payload.documentId,
        pageIndex: Number.isSafeInteger(payload.pageIndex) ? payload.pageIndex : null,
      });
    },
    'annotations:create': async (event, payload) => {
      assertTrusted(event);
      if (!payload || typeof payload.documentId !== 'string') throw new Error('批注请求无效');
      return db.call('createAnnotation', { ...payload, annotationId: crypto.randomUUID() });
    },
    'annotations:update': async (event, payload) => {
      assertTrusted(event);
      if (!payload || typeof payload.annotationId !== 'string') throw new Error('批注请求无效');
      return db.call('updateAnnotation', payload);
    },
    'annotations:delete': async (event, payload) => {
      assertTrusted(event);
      if (!payload || typeof payload.annotationId !== 'string') throw new Error('批注请求无效');
      return db.call('deleteAnnotation', payload);
    },
  };

  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);

  return {
    assertTrusted,
    choosePdf,
    async importFromMenu(mode = 'reference') {
      const filePath = await choosePdf(mode === 'managed' ? '复制 PDF 到资料库' : '引用 PDF');
      if (!filePath) return null;
      return library.importFile(filePath, { mode });
    },
  };
}

module.exports = { registerLibraryIpc };
