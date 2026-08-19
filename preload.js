/**
 * deepshui-translator - Preload 脚本
 * 通过 contextBridge 安全暴露 IPC 接口给渲染进程
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('deepshui', {
  // 翻译：text -> {ok, text|error, engine}
  translate: (text, from = 'auto', to = 'zh-CN', engine) =>
    ipcRenderer.invoke('translate', { text, from, to, engine }),

  // 打开 PDF 文件对话框
  openPdfDialog: () => ipcRenderer.invoke('open-pdf-dialog'),

  // 获取有道配置
  getConfig: () => ipcRenderer.invoke('get-config'),

  // 保存有道配置
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  // AI 引擎
  aiModels: (provider, apiKey) => ipcRenderer.invoke('ai-models', { provider, apiKey }),
  aiChat: (requestId, messages, kind) => ipcRenderer.invoke('ai-chat', { requestId, messages, kind }),
  aiCancel: (requestId) => ipcRenderer.invoke('ai-cancel', requestId),
  onAiEvent: (callback) => {
    ipcRenderer.on('ai-event', (event, data) => callback(data));
  },
  onAiModelsProgress: (callback) => {
    ipcRenderer.on('ai-models-progress', (event, data) => callback(data));
  },

  // 监听：主进程通知打开 PDF
  onOpenPdf: (callback) => {
    ipcRenderer.on('open-pdf', (event, payload) => callback(payload));
  },

  library: {
    list: () => ipcRenderer.invoke('library:list'),
    importDialog: (mode = 'reference') => ipcRenderer.invoke('library:import-dialog', mode),
    importDroppedFile: (file, mode = 'reference') => {
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) return Promise.reject(new Error('无法读取拖入文件路径'));
      return ipcRenderer.invoke('library:import-path', { filePath, mode });
    },
    open: (documentId, generation) => ipcRenderer.invoke('library:open', { documentId, generation }),
    revoke: (generation) => ipcRenderer.invoke('library:revoke', generation),
    setFavorite: (documentId, favorite) => ipcRenderer.invoke('library:set-favorite', { documentId, favorite }),
    relink: (documentId) => ipcRenderer.invoke('library:relink-dialog', documentId),
    getProgress: (documentId) => ipcRenderer.invoke('library:get-progress', documentId),
    saveProgress: (payload) => ipcRenderer.invoke('library:save-progress', payload),
  },

  reader: {
    getPreferences: (documentId) => ipcRenderer.invoke('reader:get-preferences', documentId),
    savePreferences: (payload) => ipcRenderer.invoke('reader:save-preferences', payload),
  },

  reflow: {
    get: (documentId) => ipcRenderer.invoke('reflow:get', documentId),
    publish: (payload) => ipcRenderer.invoke('reflow:publish', payload),
    aiEnhance: (payload) => ipcRenderer.invoke('reflow:ai-enhance', payload),
    cancelAiEnhance: (requestId) => ipcRenderer.invoke('reflow:ai-cancel', requestId),
  },

  theme: {
    get: () => ipcRenderer.invoke('settings:get-theme'),
    set: (theme) => ipcRenderer.invoke('settings:set-theme', theme),
  },
  bookmarks: {
    list: (documentId) => ipcRenderer.invoke('bookmarks:list', documentId),
    toggle: (payload) => ipcRenderer.invoke('bookmarks:toggle', payload),
  },
  annotations: {
    list: (payload) => ipcRenderer.invoke('annotations:list', payload),
    create: (payload) => ipcRenderer.invoke('annotations:create', payload),
    update: (payload) => ipcRenderer.invoke('annotations:update', payload),
    delete: (payload) => ipcRenderer.invoke('annotations:delete', payload),
  },
  runtime: {
    getStatus: () => ipcRenderer.invoke('runtime:get-status'),
  },
});
