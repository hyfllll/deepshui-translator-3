/**
 * deepshui-translator - 渲染进程主逻辑
 * 划词翻译 + 多引擎设置面板 + 工具栏
 */

(() => {
  'use strict';

  // 引擎凭证字段定义（设置面板动态表单）
  const ENGINE_FIELDS = {
    youdao: [
      { key: 'appKey', label: '应用 ID', type: 'text', placeholder: '应用 ID' },
      { key: 'appSecret', label: '应用密钥', type: 'password', placeholder: '应用密钥' },
    ],
    baidu: [
      { key: 'appid', label: 'appid', type: 'text', placeholder: 'appid' },
      { key: 'secretKey', label: '密钥', type: 'password', placeholder: '密钥' },
    ],
    xunfei: [
      { key: 'appid', label: 'appid', type: 'text', placeholder: 'appid' },
      { key: 'apiKey', label: 'API Key', type: 'text', placeholder: 'API Key' },
      { key: 'apiSecret', label: 'API Secret', type: 'password', placeholder: 'API Secret' },
    ],
    deepl: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'DeepL API Key (免费版以 :fx 结尾)' },
    ],
    google: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'Google Cloud API Key' },
    ],
  };

  const ENGINE_HELP = {
    youdao: '注册: https://ai.youdao.com/',
    baidu: '注册: https://fanyi-api.baidu.com/',
    xunfei: '注册: https://www.xfyun.cn/services/its',
    deepl: '注册: https://www.deepl.com/pro-api (免费版 key 以 :fx 结尾)',
    google: '注册: https://cloud.google.com/translate (启用 Cloud Translation API 并创建 API Key)',
  };

  const ENGINE_LABELS = { youdao: '有道翻译', baidu: '百度翻译', xunfei: '讯飞翻译', deepl: 'DeepL', google: 'Google 翻译' };

  // DOM 引用
  const btnOpen = document.getElementById('btn-open');
  const btnOpenPlaceholder = document.getElementById('btn-open-placeholder');
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  const zoomModeSelect = document.getElementById('zoom-mode');
  const btnGoto = document.getElementById('btn-goto');
  const btnBookmark = document.getElementById('btn-bookmark');
  const btnReaderMode = document.getElementById('btn-reader-mode');
  const btnFocus = document.getElementById('btn-focus');
  const btnSidebar = document.getElementById('btn-sidebar');
  const readerView = document.getElementById('reader-view');
  const sidebar = document.getElementById('sidebar');
  const sidebarResizer = document.getElementById('sidebar-resizer');
  const reflowView = document.getElementById('reflow-view');
  const reflowContent = document.getElementById('reflow-content');
  const reflowStatus = document.getElementById('reflow-status');
  const reflowProgress = document.getElementById('reflow-progress');
  const btnReflowGenerate = document.getElementById('btn-reflow-generate');
  const btnReflowAiEnhance = document.getElementById('btn-reflow-ai-enhance');
  const btnReflowAiApply = document.getElementById('btn-reflow-ai-apply');
  const btnReflowAiDiscard = document.getElementById('btn-reflow-ai-discard');
  const btnReflowCancel = document.getElementById('btn-reflow-cancel');
  const pageInput = document.getElementById('page-input');
  const btnSettings = document.getElementById('btn-settings');
  const targetLang = document.getElementById('target-lang');
  const engineSelect = document.getElementById('engine-select');

  // 侧边栏
  const translatePlaceholder = document.getElementById('translate-placeholder');
  const translateResult = document.getElementById('translate-result');
  const translateLoading = document.getElementById('translate-loading');
  const translateError = document.getElementById('translate-error');
  const errorText = document.getElementById('error-text');
  const resultSource = document.getElementById('result-source');
  const resultTarget = document.getElementById('result-target');
  const resultEngine = document.getElementById('result-engine');
  const btnCopy = document.getElementById('btn-copy');

  // 设置面板
  const settingsOverlay = document.getElementById('settings-overlay');
  const btnSettingsClose = document.getElementById('btn-settings-close');
  const btnSettingsSave = document.getElementById('btn-settings-save');
  const btnSettingsTest = document.getElementById('btn-settings-test');
  const settingsStatus = document.getElementById('settings-status');
  const setEngine = document.getElementById('set-engine');
  const setLang = document.getElementById('set-lang');
  const engineFields = document.getElementById('engine-fields');
  const engineHelp = document.getElementById('engine-help');

  // ── 状态 ─────────────────────────────────
  let currentConfig = {};
  let translateTimer = null; // 防抖
  const fieldInputs = {};    // engine -> { key: inputEl }
  let currentDocumentId = null;
  let currentDocumentGeneration = 0;
  let currentServerGeneration = 0;
  let progressRevision = 0;
  let progressTimer = null;
  let pendingProgress = null;
  let currentContentHash = '';
  let readerPreferences = null;
  let readerPreferencesTimer = null;
  let reflowAbortController = null;
  let localReflowBlocks = [];
  let aiReflowPreview = null;
  let aiReflowRequestId = null;
  const reflowAssetUrls = new Set();
  const REFLOW_EXTRACTOR_VERSION = 'pdfjs-renderer-v2.2-assets';
  const REFLOW_VERSION = 'local-fidelity-v2.2';
  let currentBookmarks = [];

  function configuredAiKey(ai = {}) {
    return (ai.providerKeys || {})[ai.provider || 'deepseek'] || ai.apiKey || '';
  }

  // AI 状态
  let aiExplainRunning = false;  // 解释请求进行中
  let aiAskRunning = false;      // 问答请求进行中
  let askHistory = [];           // 问答多轮历史（不包含划线内容）
  let currentSelection = '';     // 当前划线文本
  let aiExplainTimer = null;     // 解释防抖
  let fullText = '';             // 当前 PDF 全文（AI 问答上下文）
  let pdfOpenCounter = 0;        // 防止并发总结
  let aiExplainShares = false;   // 解释是否并入问答上下文
  let explainPendingText = '';   // 当前解释对应的段落（并入历史用）
  let askCurrentAnswer = '';     // 本轮问答累积的回答（避免历史重复累积）

  // 确认框 DOM
  const confirmOverlay = document.getElementById('confirm-overlay');
  const btnConfirmCancel = document.getElementById('confirm-cancel');
  const btnConfirmDiscard = document.getElementById('confirm-discard');
  const btnConfirmSave = document.getElementById('confirm-save');

  // AI DOM
  const aiExplain = document.getElementById('ai-explain');
  const aiExplainStatus = document.getElementById('ai-explain-status');
  const aiExplainContent = document.getElementById('ai-explain-content');
  const aiAsk = document.getElementById('ai-ask');
  const aiAskStatus = document.getElementById('ai-ask-status');
  const aiAskContent = document.getElementById('ai-ask-content');
  const aiAskBox = document.getElementById('ai-ask-box');
  const aiAskSend = document.getElementById('ai-ask-send');
  const aiAskClear = document.getElementById('ai-ask-clear');
  const aiAskReset = document.getElementById('ai-ask-reset');
  const aiAskImage = document.getElementById('ai-ask-image');
  const aiAskImages = document.getElementById('ai-ask-images');
  const aiSummaryStart = document.getElementById('ai-summary-start');
  const aiSummaryEnd = document.getElementById('ai-summary-end');
  const fulltextProgress = document.getElementById('fulltext-progress');
  const fulltextProgressBar = document.getElementById('fulltext-progress-bar');
  const fulltextProgressText = document.getElementById('fulltext-progress-text');

  // 提问附件（PDF 中选中的图片）
  let askImages = [];   // [{ page, bbox, dataUrl, label }]
  let imageSelectMode = false;

  // 已发送图片的 dataUrl 表（问答区渲染用）：markdown 里只放占位图，
  // 渲染后按 alt 标记换回真实 dataUrl，避免 MB 级字符串参与每次流式重渲染
  let sentImageMap = new Map();  // 'askimg-N' -> dataUrl（随会话切换替换引用）
  let sentImgSeq = 0;
  const ASK_IMG_PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  // 按模型保存会话（内存版，绑定当前 PDF）: 'provider/model' -> 快照
  // 切换模型: 存当前会话 → 恢复目标会话（无则开新会话并自动总结）
  const sessionStore = new Map();
  let currentSessionKey = null;

  // 设置面板 AI DOM
  const setAiProvider = document.getElementById('set-ai-provider');
  const setAiKey = document.getElementById('set-ai-key');
  const setAiModel = document.getElementById('set-ai-model');
  const btnAiRefresh = document.getElementById('btn-ai-refresh');
  const setAiDeepThink = document.getElementById('set-ai-deepthink');
  const setAiExplain = document.getElementById('set-ai-explain');
  const setAiAsk = document.getElementById('set-ai-ask');
  const setAiIsolate = document.getElementById('set-ai-isolate');
  const setAiMm = document.getElementById('set-ai-multimodal');
  const aiSettingsStatus = document.getElementById('ai-settings-status');
  const btnAiTest = document.getElementById('btn-ai-test');
  const btnSettingsSaveAi = document.getElementById('btn-settings-save-ai');

  // 设置 tabs
  const settingsTabs = document.querySelectorAll('.settings-tab');
  const engineTab = document.getElementById('engine-tab');
  const aiTab = document.getElementById('ai-tab');

  // ── Markdown 渲染（marked + DOMPurify + KaTeX）─────────
  // AI 输出含 Markdown/LaTeX，渲染为富文本
  function renderMarkdownTo(el, text) {
    if (!text) {
      el.innerHTML = '';
      return;
    }
    try {
      // 0. 保护 LaTeX 分隔符（marked 会吞掉 \( 的反斜杠，导致 KaTeX 无法识别）
      const mathPlaceholders = [];
      const protectedText = text.replace(
        /(\\\[[\s\S]*?\\\])|(\\\([\s\S]*?\\\))|(\$\$[\s\S]*?\$\$)|(\$[^$\n]+?\$)/g,
        (m) => { mathPlaceholders.push(m); return `\u0000MATH${mathPlaceholders.length - 1}\u0000`; }
      );
      // 1. Markdown → HTML（禁用原始 HTML 直通，防注入）
      const rawHtml = marked.parse(protectedText, { breaks: true, gfm: true });
      // 1.5 还原公式
      const restoredHtml = rawHtml.replace(/\u0000MATH(\d+)\u0000/g, (_, i) => mathPlaceholders[+i]);
      // 2. DOMPurify 消毒
      const safeHtml = DOMPurify.sanitize(restoredHtml);
      el.innerHTML = safeHtml;
      // 3. KaTeX 渲染公式（\(...\)、$...$、\[...\]）
      try {
        renderMathInElement(el, {
          delimiters: [
            { left: '\\\\[', right: '\\\\]', display: true },
            { left: '\\\(', right: '\\\)', display: false },
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
          ],
          throwOnError: false,
        });
      } catch (e) { /* 公式渲染失败不影响正文 */ }
      // 4. 问答区已发送图片：占位图换回真实 dataUrl（见 sentImageMap）
      el.querySelectorAll('img[alt^="askimg-"]').forEach(im => {
        const real = sentImageMap.get(im.alt);
        if (real) im.src = real;
      });
    } catch (e) {
      // 渲染失败回退纯文本
      el.textContent = text;
    }
  }

  // 流式内容累积 + 节流渲染（throttle：至少每 300ms 渲染一次，保证流式可见）
  const MD_INTERVAL = 300;
  function appendAiContent(el, chunk) {
    el.__raw = (el.__raw || '') + chunk;
    const now = Date.now();
    const last = el.__lastRender || 0;
    if (now - last >= MD_INTERVAL) {
      // 距上次渲染足够久 → 立即渲染
      renderMarkdownTo(el, el.__raw);
      el.__lastRender = now;
      followBottom(el);
    } else if (!el.__pendingTimer) {
      // 安排一个兜底渲染（保证有输出可见）
      el.__pendingTimer = setTimeout(() => {
        el.__pendingTimer = null;
        renderMarkdownTo(el, el.__raw);
        el.__lastRender = Date.now();
        followBottom(el);
      }, MD_INTERVAL - (now - last));
    }
  }

  function finalizeAiContent(el) {
    clearTimeout(el.__pendingTimer);
    el.__pendingTimer = null;
    renderMarkdownTo(el, el.__raw || '');
    el.__lastRender = Date.now();
    followBottom(el);
  }

  function clearAiContent(el) {
    clearTimeout(el.__pendingTimer);
    el.__pendingTimer = null;
    el.__raw = '';
    el.__lastRender = 0;
    el.innerHTML = '';
  }

  // 仅当接近底部时才跟随滚动（不打扰用户回看历史）
  function followBottom(el) {
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }

  // ── AI 事件监听（主进程流式推送）─────────
  window.deepshui.onAiEvent(({ requestId, kind, type, text, seconds, usage, message }) => {
    if (kind === 'explain') handleExplainEvent(type, text, seconds, usage, message);
    else if (kind === 'ask') handleAskEvent(type, text, seconds, usage, message);
    else if (kind === 'test') handleTestEvent(type, text, message);
  });

  // AI 测试事件（独立于解释区）
  let testAnswer = '';
  function handleTestEvent(type, text, message) {
    switch (type) {
      case 'content':
        testAnswer += text;
        break;
      case 'done':
      case 'end':
        aiSettingsStatus.textContent = `✅ 连接成功: ${testAnswer || '正常'}`;
        aiSettingsStatus.className = 'ok';
        testAnswer = '';
        break;
      case 'error':
        aiSettingsStatus.textContent = `❌ 连接失败: ${message}`;
        aiSettingsStatus.className = 'err';
        testAnswer = '';
        break;
    }
  }

  // ── AI 解释 ───────────────────────────────
  function handleExplainEvent(type, text, seconds, usage, message) {
    switch (type) {
      case 'think-start':
        aiExplainStatus.textContent = '正在思考...';
        aiExplainStatus.className = 'ai-status thinking';
        break;
      case 'think-done':
        aiExplainStatus.textContent = `已思考（用时 ${seconds}s）`;
        aiExplainStatus.className = 'ai-status';
        break;
      case 'content':
        appendAiContent(aiExplainContent, text);
        break;
      case 'done':
      case 'end':
        if (aiExplainStatus.textContent === '正在思考...') {
          aiExplainStatus.textContent = '已思考';
        }
        aiExplainRunning = false;
        aiExplainStatus.className = 'ai-status';
        finalizeAiContent(aiExplainContent);
        // 不隔离模式：解释结果并入问答历史（上下文连续）
        if (aiExplainShares && explainPendingText) {
          askHistory.push({ role: 'user', content: '（划词解释）' + explainPendingText });
          askHistory.push({ role: 'assistant', content: aiExplainContent.__raw || aiExplainContent.textContent });
          aiExplainShares = false;
          explainPendingText = '';
        }
        break;
      case 'error':
        aiExplainRunning = false;
        aiExplainStatus.textContent = '';
        aiExplainStatus.className = 'ai-status';
        clearAiContent(aiExplainContent);
        aiExplainContent.textContent = '⚠️ ' + message;
        break;
    }
  }

  // 发起 AI 解释（默认隔离；关闭隔离时并入问答上下文）
  async function startExplain(text) {
    if (aiExplainRunning) return;
    aiExplainRunning = true;
    explainPendingText = text;
    clearAiContent(aiExplainContent);
    aiExplainStatus.textContent = '';
    aiExplainStatus.className = 'ai-status';
    aiExplain.classList.remove('hidden');

    const ai = currentConfig.ai || {};
    let messages;
    if (ai.isolateContext === false) {
      // 不隔离：解释放到问答上下文中运行（全文 + 问答历史 + 划线段落）
      aiExplainShares = true;
      messages = [];
      if (fullText) {
        messages.push({ role: 'system', content: '以下是用户打开的 PDF 全文，回答问题时请基于这篇文章：\n\n' + fullText });
      }
      messages.push({ role: 'system', content: '你是一个乐于助人的 AI 助手，请用中文回答。' });
      messages.push(...askHistory);
      messages.push({ role: 'user', content: '请用中文解释下面这段论文文本，包括核心意思、关键术语的含义、必要的背景知识：\n\n' + text });
    } else {
      // 隔离（默认）：独立会话，只带划线段落
      messages = [
        { role: 'system', content: '你是一个学术论文阅读助手。用户会划选一段论文文本，请用中文解释这段内容，包括：核心意思、关键术语的含义、必要的背景知识。回答要简洁清晰。' },
        { role: 'user', content: text },
      ];
    }
    // 主进程拒绝请求（未配置 key/模型等）时恢复状态并提示，否则解释锁死无提示
    let res;
    try {
      res = await window.deepshui.aiChat('explain', messages, 'explain');
    } catch (e) {
      res = { ok: false, error: e.message || '请求发送失败' };
    }
    if (!res.ok) {
      aiExplainRunning = false;
      aiExplainShares = false;
      explainPendingText = '';
      clearAiContent(aiExplainContent);
      aiExplainContent.textContent = '⚠️ ' + (res.error || '请求失败');
    }
  }

  // 打断 AI 解释（划线变化时调用）
  function cancelExplain() {
    if (aiExplainRunning) {
      window.deepshui.aiCancel('explain');
      aiExplainRunning = false;
      aiExplainStatus.textContent = '';
      aiExplainStatus.className = 'ai-status';
    }
  }

  // AI 问答
  let askTurnActive = false;    // 每轮问答只 finalize 一次（done 和 end 都会触发，防止重复入历史）
  function handleAskEvent(type, text, seconds, usage, message) {
    switch (type) {
      case 'think-start':
        aiAskStatus.textContent = '正在思考...';
        aiAskStatus.className = 'ai-status thinking';
        break;
      case 'think-done':
        aiAskStatus.textContent = `已思考（用时 ${seconds}s）`;
        aiAskStatus.className = 'ai-status';
        break;
      case 'content':
        appendAiContent(aiAskContent, text);
        askCurrentAnswer += text;
        break;
      case 'done':
      case 'end':
        if (!askTurnActive) break;  // done 之后还有 end，只处理一次
        askTurnActive = false;
        if (aiAskStatus.textContent === '正在思考...') {
          aiAskStatus.textContent = '已思考';
        }
        aiAskRunning = false;
        aiAskStatus.className = 'ai-status';
        aiAskSend.disabled = false;
        aiAskBox.disabled = false;
        finalizeAiContent(aiAskContent);
        // 只保存本轮回答到历史（修复历史重复累积）；空回答不入历史（Kimi 会拒绝空 assistant 消息）
        if (askCurrentAnswer.trim()) {
          askHistory.push({ role: 'assistant', content: askCurrentAnswer });
        }
        askCurrentAnswer = '';
        break;
      case 'error': {
        askTurnActive = false;
        aiAskRunning = false;
        aiAskStatus.textContent = '';
        aiAskStatus.className = 'ai-status';
        aiAskSend.disabled = false;
        aiAskBox.disabled = false;
        if (message !== '已取消') {
          appendAiContent(aiAskContent, '\n⚠️ ' + message);
          // 请求失败：移除历史中未获回答的用户消息，保持历史交替结构有效
          if (askHistory.length && askHistory[askHistory.length - 1].role === 'user') {
            askHistory.pop();
          }
        }
        askCurrentAnswer = '';
        break;
      }
    }
  }

  async function sendAsk(predefinedText, isInitial, images) {
    const q = (predefinedText !== undefined ? predefinedText : aiAskBox.value.trim());
    if (!q || aiAskRunning) return;
    aiAskRunning = true;
    aiAskSend.disabled = true;
    aiAskBox.disabled = true;

    // 追加用户问题（初始总结消息也算历史第一条）
    askHistory.push({ role: 'user', content: q });
    askCurrentAnswer = '';
    let display = isInitial
      ? '\n\n**AI 总结**: '
      : `\n\n**你**: ${q}\n\n**AI**: `;
    if (!isInitial && images && images.length) {
      // 随问题发送的图片渲染进问答区（占位图 + alt 标记，渲染后换真实 dataUrl）
      const imgMd = images.map(img => {
        const key = 'askimg-' + (++sentImgSeq);
        sentImageMap.set(key, img.dataUrl);
        return `![${key}](${ASK_IMG_PLACEHOLDER})`;
      }).join(' ');
      display = `\n\n**你**: ${q}\n\n${imgMd}\n\n**AI**: `;
    }
    aiAskContent.__raw = (aiAskContent.__raw || '') + display;
    renderMarkdownTo(aiAskContent, aiAskContent.__raw);
    aiAskBox.value = '';
    aiAskStatus.textContent = '';

    // 消息结构（全文固定在最前，前缀稳定 → 命中 prompt 缓存）:
    // [system: 全文] [system: 助手设定] [user: 总结指令/提问] [assistant: 回答] ...
    const messages = [];
    if (fullText) {
      messages.push({ role: 'system', content: '以下是用户打开的 PDF 全文，回答问题时请基于这篇文章：\n\n' + fullText });
    }
    messages.push({ role: 'system', content: '你是一个乐于助人的 AI 助手，请用中文回答用户的问题。' });
    const historyCopy = [...askHistory];
    // 带图提问：最后一条 user 消息换成 content 数组（OpenAI 兼容多模态格式）
    if (images && images.length) {
      const last = historyCopy[historyCopy.length - 1];
      historyCopy[historyCopy.length - 1] = {
        role: 'user',
        content: [
          { type: 'text', text: last.content },
          ...images.map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
        ],
      };
    }
    messages.push(...historyCopy);

    // 标记本轮进行中（handleAskEvent 据此防止 done/end 双重 finalize）
    askTurnActive = true;
    let res;
    try {
      res = await window.deepshui.aiChat('ask', messages, 'ask');
    } catch (e) {
      res = { ok: false, error: e.message || '请求发送失败' };
    }
    if (!res.ok) {
      // 主进程拒绝请求（未配置 key/模型等）：恢复状态并提示
      askTurnActive = false;
      aiAskRunning = false;
      aiAskSend.disabled = false;
      aiAskBox.disabled = false;
      appendAiContent(aiAskContent, '\n⚠️ ' + (res.error || '请求失败'));
      if (askHistory.length && askHistory[askHistory.length - 1].role === 'user') {
        askHistory.pop();
      }
    }
  }

  // 打断问答（新提问时替换旧回答）
  function cancelAsk() {
    if (aiAskRunning) {
      window.deepshui.aiCancel('ask');
      aiAskRunning = false;
      askTurnActive = false;   // 防止后续 end 事件重复 finalize
      askCurrentAnswer = '';   //  cancelled 轮的回答不入历史（aiCancel 的 error 事件不含内容）
      aiAskStatus.textContent = '';
      aiAskStatus.className = 'ai-status';
      aiAskSend.disabled = false;
      aiAskBox.disabled = false;
    }
  }

  // ── AI 设置面板 ───────────────────────────
  function applyAiVisibility() {
    const ai = currentConfig.ai || {};
    if (ai.showExplain) aiExplain.classList.remove('hidden');
    else { aiExplain.classList.add('hidden'); cancelExplain(); }
    if (ai.showAsk) aiAsk.classList.remove('hidden');
    else { aiAsk.classList.add('hidden'); cancelAsk(); }
    // 多模态开关关闭/模型不支持 → 隐藏选图按钮并退出选图模式
    updateImageBtnVisibility();
    if (!isCurrentModelMultimodal() && imageSelectMode) exitImageSelectMode();
  }

  // 选图按钮仅当前模型可用多模态时显示
  function updateImageBtnVisibility() {
    aiAskImage.classList.toggle('hidden', !isCurrentModelMultimodal());
  }

  // 回填 AI 设置表单
  function fillAiForm(ai) {
    setAiProvider.value = ai.provider || 'deepseek';
    // 每 provider 独立 key 槽位
    setAiKey.value = (ai.providerKeys || {})[ai.provider || 'deepseek'] || '';
    setAiDeepThink.value = ai.deepThink || 'off';
    setAiExplain.value = ai.showExplain === false ? 'off' : 'on';
    setAiAsk.value = ai.showAsk === false ? 'off' : 'on';
    setAiIsolate.value = ai.isolateContext === false ? 'off' : 'on';
    setAiMm.value = ai.multimodalEnabled === false ? 'off' : 'on';
    updateAiKeyPlaceholder(ai.provider || 'deepseek');
    // 总结页数范围回填（clamp 到 PDF 实际页数/多模态上限）
    const rc = clampSummaryRange(ai.summaryStart || 1, ai.summaryEnd || 16, false);
    aiSummaryStart.value = rc.start;
    aiSummaryEnd.value = rc.end;
    // 模型下拉：有已保存模型则选中，否则空提示
    if (ai.model) {
      if (![...setAiModel.options].some(o => o.value === ai.model)) {
        const opt = document.createElement('option');
        opt.value = ai.model;
        opt.textContent = ai.model;
        setAiModel.appendChild(opt);
      }
      setAiModel.value = ai.model;
      setAiModel.disabled = false;
    } else {
      setAiModel.innerHTML = '<option value="">先输入 API Key 再点击刷新</option>';
      setAiModel.disabled = true;
    }
  }

  // key 输入框占位提示随提供商变化
  const PROVIDER_HINTS = {
    deepseek: '粘贴 DeepSeek API Key 后点击右侧刷新拉取模型',
    qwen: '粘贴 阿里云百炼 API Key 后点击右侧刷新拉取模型',
    doubao: '粘贴 火山方舟 API Key 后点击右侧刷新拉取模型',
    kimi: '粘贴 Kimi API Key 后点击右侧刷新拉取模型',
  };
  function updateAiKeyPlaceholder(provider) {
    setAiKey.placeholder = PROVIDER_HINTS[provider] || '粘贴 API Key 后点击右侧刷新拉取模型';
  }

  async function refreshAiModels() {
    const key = setAiKey.value.trim();
    if (!key) {
      aiSettingsStatus.textContent = '⚠️ 请先输入 API Key';
      aiSettingsStatus.className = 'err';
      return;
    }
    btnAiRefresh.disabled = true;
    aiSettingsStatus.textContent = '拉取模型列表...';
    aiSettingsStatus.className = '';
    // 拉取/探测进度（设置面板内独立进度条）
    const progressEl = document.getElementById('ai-models-progress');
    const progressBar = document.getElementById('ai-models-progress-bar');
    const progressText = document.getElementById('ai-models-progress-text');
    progressEl.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = '正在拉取模型列表...';
    const res = await window.deepshui.aiModels(setAiProvider.value, key);
    btnAiRefresh.disabled = false;
    progressEl.classList.add('hidden');
    if (res.ok && res.models && res.models.length) {
      setAiModel.innerHTML = '';
      const multimodalMap = {};
      for (const m of res.models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        // Retiring 模型标注警告（官方下线中但可能仍可用）；多模态标注 ✅，value 保持纯模型名
        let label = m.id;
        if (m.retiring) label += ' ⚠️Retiring';
        if (m.multimodal) label += ' (多模态✅)';
        opt.textContent = label;
        setAiModel.appendChild(opt);
        if (m.multimodal) multimodalMap[m.id] = true;
      }
      setAiModel.disabled = false;
      // 保存多模态表到配置（选图按钮/多模态总结判断用）
      try {
        const cfg = await window.deepshui.getConfig();
        cfg.ai = { ...(cfg.ai || {}), multimodalMap };
        await window.deepshui.saveConfig(cfg);
        currentConfig = cfg;
      } catch (e) { /* 保存失败不影响模型列表 */ }
      const mmCount = res.models.filter(m => m.multimodal).length;
      aiSettingsStatus.textContent = `✅ ${res.models.length} 个可对话模型，其中 ${mmCount} 个支持多模态。部分模型可能被误标为支持多模态，请注意甄别`;
      aiSettingsStatus.className = 'ok';
      updateImageBtnVisibility();  // multimodalMap 更新后刷新选图按钮
    } else {
      setAiModel.innerHTML = '<option value="">拉取失败</option>';
      setAiModel.disabled = true;
      aiSettingsStatus.textContent = `❌ ${res.error || '拉取失败'}`;
      aiSettingsStatus.className = 'err';
    }
  }

  async function testAi() {
    const cfg = {
      ...currentConfig,
      ai: {
        ...currentConfig.ai,
        apiKey: setAiKey.value.trim(),
        model: setAiModel.value || '',
      },
    };
    if (!cfg.ai.apiKey) {
      aiSettingsStatus.textContent = '⚠️ 请先填写 API Key';
      aiSettingsStatus.className = 'err';
      return;
    }
    if (!cfg.ai.model) {
      aiSettingsStatus.textContent = '⚠️ 请先拉取并选择模型';
      aiSettingsStatus.className = 'err';
      return;
    }
    await window.deepshui.saveConfig(cfg);
    currentConfig = cfg;
    aiSettingsStatus.textContent = '测试中（需几秒）...';
    aiSettingsStatus.className = '';
    const res = await window.deepshui.aiChat('test', [
      { role: 'system', content: '你是一个乐于助人的 AI 助手。' },
      { role: 'user', content: '回复两个字：正常' },
    ], 'test');
    if (!res.ok) {
      aiSettingsStatus.textContent = `❌ ${res.error}`;
      aiSettingsStatus.className = 'err';
    } else {
      aiSettingsStatus.textContent = '测试中（需几秒）...';
      aiSettingsStatus.className = '';
    }
  }

  // ── 设置面板：动态凭证表单 ───────────────
  function renderEngineFields(engine) {
    engineFields.innerHTML = '';
    const fields = ENGINE_FIELDS[engine] || [];
    fieldInputs[engine] = {};

    for (const f of fields) {
      const row = document.createElement('div');
      row.className = 'form-row';

      const label = document.createElement('label');
      label.textContent = f.label;

      const input = document.createElement('input');
      input.type = f.type;
      input.placeholder = f.placeholder;
      input.dataset.key = f.key;

      row.appendChild(label);
      row.appendChild(input);
      engineFields.appendChild(row);
      fieldInputs[engine][f.key] = input;
    }

    // 回填已保存的凭证
    const cred = currentConfig[engine] || {};
    for (const [key, input] of Object.entries(fieldInputs[engine])) {
      input.value = cred[key] || '';
    }

    engineHelp.textContent = '获取凭证: ' + (ENGINE_HELP[engine] || '');
  }

  function collectCredentials(engine) {
    const cred = {};
    const inputs = fieldInputs[engine] || {};
    for (const [key, input] of Object.entries(inputs)) {
      cred[key] = input.value.trim();
    }
    return cred;
  }

  // ── 启动初始化 ───────────────────────────
  async function initConfig() {
    const cfg = await window.deepshui.getConfig();
    currentConfig = cfg;
    targetLang.value = cfg.targetLang || 'zh-CN';
    updateTranslatePlaceholder(targetLang.value);
    engineSelect.value = cfg.engine || 'youdao';
    setEngine.value = cfg.engine || 'youdao';
    setLang.value = cfg.targetLang || 'zh-CN';
    renderEngineFields(setEngine.value);

    // AI 配置回填
    fillAiForm(cfg.ai || {});
    applyAiVisibility();
    // 会话归属当前模型（按模型保存会话）
    currentSessionKey = (cfg.ai && cfg.ai.model) ? `${cfg.ai.provider || 'deepseek'}/${cfg.ai.model}` : null;

    // 检查默认引擎凭证
    const cred = cfg[cfg.engine] || {};
    const def = ENGINE_FIELDS[cfg.engine] || [];
    const missing = def.some(f => !cred[f.key]);
    if (missing) {
      showError(`首次使用：请先在 ⚙️ 设置 中配置 翻译引擎 API 凭证`);
    }
  }

  // ── PDF 打开 ─────────────────────────────
  async function openPdfViaDialog() {
    return window.deepshui.openPdfDialog();
  }

  async function flushProgress() {
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    const payload = pendingProgress && { ...pendingProgress, baseRevision: progressRevision };
    pendingProgress = null;
    if (!payload || payload.documentId !== currentDocumentId) return;
    try {
      const result = await window.deepshui.library.saveProgress(payload);
      if (result && result.accepted) progressRevision = Number(result.revision);
      else if (result && Number.isSafeInteger(result.currentRevision)) progressRevision = result.currentRevision;
    } catch (error) {
      console.error('保存阅读进度失败:', error);
    }
  }

  function queueProgress(progress) {
    if (!currentDocumentId || progress.generation !== currentDocumentGeneration) return;
    pendingProgress = {
      documentId: currentDocumentId,
      page: progress.page,
      scrollRatio: progress.scrollRatio,
      zoom: progress.zoom,
      sidebarMode: 'translation',
      generation: currentServerGeneration,
    };
    updateBookmarkButton(progress.page);
    clearTimeout(progressTimer);
    progressTimer = setTimeout(flushProgress, 700);
  }

  function updateBookmarkButton(page = PdfViewer.currentPage) {
    const pageIndex = Math.max(0, Number(page || 1) - 1);
    const active = currentBookmarks.some((bookmark) => bookmark.page_index === pageIndex);
    btnBookmark.textContent = active ? '★ 已书签' : '☆ 书签';
    btnBookmark.classList.toggle('active', active);
    btnBookmark.title = active ? '移除当前页书签' : '为当前页添加书签';
    btnBookmark.disabled = !currentDocumentId;
  }

  async function refreshBookmarks() {
    if (!currentDocumentId) {
      currentBookmarks = [];
      updateBookmarkButton();
      return;
    }
    currentBookmarks = await window.deepshui.bookmarks.list(currentDocumentId);
    updateBookmarkButton();
  }

  async function toggleCurrentBookmark() {
    if (!currentDocumentId || !currentServerGeneration) return;
    btnBookmark.disabled = true;
    try {
      await window.deepshui.bookmarks.toggle({
        documentId: currentDocumentId,
        pageIndex: Math.max(0, PdfViewer.currentPage - 1),
        generation: currentServerGeneration,
      });
      await refreshBookmarks();
    } catch (error) {
      alert('书签操作失败: ' + error.message);
    } finally {
      btnBookmark.disabled = false;
    }
  }

  function updateReaderControls() {
    const viewMode = readerPreferences?.view_mode || 'original';
    const sidebarCollapsed = !!readerPreferences?.sidebar_collapsed;
    const focusMode = !!readerPreferences?.focus_mode;
    readerView.classList.toggle('sidebar-collapsed', sidebarCollapsed);
    readerView.classList.toggle('focus-mode', focusMode);
    sidebar.style.width = `${Math.max(280, Math.min(640, Number(readerPreferences?.sidebar_width) || 360))}px`;
    zoomModeSelect.value = ['fit-width', 'fit-page', 'actual-size', 'manual'].includes(readerPreferences?.zoom_mode)
      ? readerPreferences.zoom_mode
      : (PdfViewer.zoomMode || 'fit-width');
    btnReaderMode.textContent = viewMode === 'reflow' ? '查看原文' : '智能排版';
    btnReaderMode.classList.toggle('active', viewMode === 'reflow');
    btnFocus.textContent = focusMode ? '退出专注' : '专注';
    btnFocus.classList.toggle('active', focusMode);
    btnSidebar.textContent = sidebarCollapsed ? '展开翻译' : '收起翻译';
    btnSidebar.classList.toggle('active', sidebarCollapsed);
    window.dispatchEvent(new Event('resize'));
  }

  async function saveReaderPreferences(changes = {}) {
    if (!currentDocumentId || !currentServerGeneration) return null;
    readerPreferences = { ...(readerPreferences || {}), ...changes };
    updateReaderControls();
    try {
      const saved = await window.deepshui.reader.savePreferences({
        documentId: currentDocumentId,
        generation: currentServerGeneration,
        viewMode: readerPreferences.view_mode,
        zoomMode: readerPreferences.zoom_mode,
        sidebarWidth: readerPreferences.sidebar_width,
        sidebarCollapsed: !!readerPreferences.sidebar_collapsed,
        focusMode: !!readerPreferences.focus_mode,
      });
      readerPreferences = saved;
      updateReaderControls();
      return saved;
    } catch (error) {
      console.error('保存阅读偏好失败:', error);
      return null;
    }
  }

  function queueReaderPreferences(changes = {}) {
    readerPreferences = { ...(readerPreferences || {}), ...changes };
    updateReaderControls();
    clearTimeout(readerPreferencesTimer);
    readerPreferencesTimer = setTimeout(() => saveReaderPreferences(), 350);
  }

  function setReflowAiActions() {
    const preview = aiReflowPreview;
    btnReflowAiEnhance.disabled = !!aiReflowRequestId;
    btnReflowAiApply.classList.toggle('hidden', !preview || preview.applied);
    btnReflowAiDiscard.classList.toggle('hidden', !preview);
    btnReflowAiDiscard.textContent = preview && preview.applied ? '撤销 AI 布局' : '放弃预览';
  }

  function clearReflowAssetUrls() {
    for (const url of reflowAssetUrls) URL.revokeObjectURL(url);
    reflowAssetUrls.clear();
  }

  function createReflowAssetUrl(asset) {
    if (!asset || !asset.bytes || !asset.mimeType) return '';
    let bytes = asset.bytes;
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    else if (!ArrayBuffer.isView(bytes) && Array.isArray(bytes.data)) bytes = Uint8Array.from(bytes.data);
    if (!ArrayBuffer.isView(bytes)) return '';
    const url = URL.createObjectURL(new Blob([bytes], { type: asset.mimeType }));
    reflowAssetUrls.add(url);
    return url;
  }

  function renderReflow(blocks, suggestions = []) {
    clearReflowAssetUrls();
    reflowContent.replaceChildren();
    if (!blocks.length) {
      const empty = document.createElement('p');
      empty.className = 'reflow-empty';
      empty.textContent = '未提取到可排版的文字。扫描件或复杂 PDF 请继续使用原文模式。';
      reflowContent.appendChild(empty);
      return;
    }
    const suggestionMap = new Map((suggestions || []).map((suggestion) => [Number(suggestion.blockIndex), suggestion]));
    for (const block of blocks) {
      const suggestion = suggestionMap.get(Number(block.block_index));
      const proposedType = suggestion && suggestion.blockType;
      const textTypes = ['heading', 'paragraph', 'list', 'code', 'caption', 'equation'];
      const assetTypes = ['figure', 'table', 'formula-image'];
      const type = textTypes.includes(proposedType)
        ? proposedType
        : [...textTypes, ...assetTypes].includes(block.block_type)
          ? block.block_type
        : 'paragraph';
      const isAsset = assetTypes.includes(type);
      const element = document.createElement(isAsset ? 'figure' : type === 'heading' ? 'h2' : 'p');
      element.className = `reflow-block ${type}`;
      if (!isAsset && suggestion) element.classList.add('ai-structure-suggestion');
      if (!isAsset && suggestion && suggestion.emphasis === 'lead') element.classList.add('ai-lead');
      if (isAsset) {
        const assetUrl = createReflowAssetUrl(block.asset);
        if (assetUrl) {
          const image = document.createElement('img');
          image.className = 'reflow-asset-image';
          image.src = assetUrl;
          image.alt = block.text_content || (type === 'formula-image' ? '原文公式' : '原文图像');
          image.loading = 'lazy';
          image.decoding = 'async';
          image.draggable = false;
          element.appendChild(image);
        } else {
          const fallback = document.createElement('p');
          fallback.className = 'reflow-asset-fallback';
          fallback.textContent = block.text_content || '资源暂时无法显示';
          element.appendChild(fallback);
        }
        const label = document.createElement('figcaption');
        label.className = 'reflow-asset-label';
        label.textContent = type === 'formula-image' ? '公式原貌' : type === 'table' ? '原文表格' : '原文图像';
        element.appendChild(label);
      } else {
        element.appendChild(document.createTextNode(block.text_content));
      }
      if (!isAsset && suggestion) {
        const marker = document.createElement('span');
        marker.className = 'reflow-ai-marker';
        marker.textContent = 'AI 结构建议';
        marker.title = 'AI 只调整本地阅读布局，不改写原文内容';
        element.appendChild(marker);
      }
      const origin = document.createElement('button');
      origin.className = 'reflow-origin';
      origin.type = 'button';
      origin.textContent = `原文 p.${Number(block.source_page_start) + 1}`;
      origin.title = '跳转到原始 PDF 对应页面';
      origin.addEventListener('click', async () => {
        await setReaderMode('original');
        await PdfViewer.gotoPage(Number(block.source_page_start) + 1);
      });
      element.appendChild(origin);
      reflowContent.appendChild(element);
    }
  }

  function setReflowProgress(message) {
    if (!message) {
      reflowProgress.classList.add('hidden');
      reflowProgress.textContent = '';
      return;
    }
    reflowProgress.classList.remove('hidden');
    reflowProgress.textContent = message;
  }

  function restoreLocalReflow(message) {
    aiReflowPreview = null;
    renderReflow(localReflowBlocks);
    reflowStatus.textContent = message || `本地排版已就绪 · ${localReflowBlocks.length} 个阅读块`;
    setReflowAiActions();
  }

  function renderCurrentReflow(localMessage) {
    if (!aiReflowPreview) {
      renderReflow(localReflowBlocks);
      reflowStatus.textContent = localMessage || `本地排版已就绪 · ${localReflowBlocks.length} 个阅读块`;
    } else {
      renderReflow(localReflowBlocks, aiReflowPreview.suggestions);
      reflowStatus.textContent = aiReflowPreview.applied
        ? '已应用 AI 布局到本次阅读会话；原文内容与本地缓存未修改'
        : `AI 结构预览 · ${aiReflowPreview.suggestions.length} 项建议，尚未应用`;
    }
    setReflowAiActions();
  }

  async function requestAiReflowEnhancement() {
    if (!currentDocumentId || !currentServerGeneration || aiReflowRequestId) return;
    if (!localReflowBlocks.length) await generateLocalReflow(false);
    if (!localReflowBlocks.length) return;
    const requestId = crypto.randomUUID();
    aiReflowRequestId = requestId;
    setReflowAiActions();
    btnReflowCancel.classList.remove('hidden');
    setReflowProgress('正在请求 AI 结构建议：仅发送本地提取的文字与页码，不上传 PDF、图片或文件路径…');
    reflowStatus.textContent = 'AI 优化由你主动触发，可在预览后应用或撤销';
    try {
      const result = await window.deepshui.reflow.aiEnhance({
        documentId: currentDocumentId,
        generation: currentServerGeneration,
        requestId,
      });
      if (requestId !== aiReflowRequestId || !currentDocumentId) return;
      const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
      if (!suggestions.length) {
        reflowStatus.textContent = 'AI 未建议更改布局，本地排版保持不变';
        return;
      }
      aiReflowPreview = { suggestions, applied: false };
      renderReflow(localReflowBlocks, suggestions);
      reflowStatus.textContent = `AI 结构预览 · ${suggestions.length} 项建议 · ${result.disclosure || '仅发送本地文字结构'}`;
    } catch (error) {
      if (String(error && error.message || '').includes('已取消')) {
        reflowStatus.textContent = '已取消 AI 结构优化，本地排版未改变';
      } else {
        reflowStatus.textContent = `AI 结构优化失败：${error.message}`;
        console.error('AI 结构优化失败:', error);
      }
    } finally {
      if (aiReflowRequestId === requestId) aiReflowRequestId = null;
      btnReflowCancel.classList.add('hidden');
      setReflowProgress('');
      setReflowAiActions();
    }
  }

  async function generateLocalReflow(force = false) {
    if (!currentDocumentId || !currentContentHash) return;
    if (reflowAbortController) return;
    if (!force) {
      const cached = await window.deepshui.reflow.get(currentDocumentId);
      const cacheIsCurrent = cached.reflow
        && cached.reflow.extractor_version === REFLOW_EXTRACTOR_VERSION
        && cached.reflow.reflow_version === REFLOW_VERSION;
      if (cached.state === 'ready' && cached.blocks.length && cacheIsCurrent) {
        localReflowBlocks = cached.blocks;
        renderCurrentReflow(`本地排版已就绪 · ${cached.blocks.length} 个阅读块`);
        return;
      }
    }
    const generation = currentDocumentGeneration;
    const serverGeneration = currentServerGeneration;
    if (force) {
      aiReflowPreview = null;
      setReflowAiActions();
    }
    const controller = new AbortController();
    reflowAbortController = controller;
    btnReflowGenerate.disabled = true;
    btnReflowCancel.classList.remove('hidden');
    setReflowProgress('正在从本地 PDF 提取版面结构、公式和图片…');
    reflowStatus.textContent = '仅在本机处理，不会上传 PDF';
    try {
      const blocks = await PdfViewer.extractReflowBlocks(({ current, total }) => {
        setReflowProgress(`正在本地整理第 ${current} / ${total} 页…`);
      }, controller.signal);
      if (generation !== currentDocumentGeneration || controller.signal.aborted) return;
      if (!blocks.length) throw new Error('未从 PDF 中提取到可排版内容');
      setReflowProgress(`正在安全保存 ${blocks.length} 个阅读块…`);
      const result = await window.deepshui.reflow.publish({
        documentId: currentDocumentId,
        generation: serverGeneration,
        sourceContentHash: currentContentHash,
        extractorVersion: REFLOW_EXTRACTOR_VERSION,
        reflowVersion: REFLOW_VERSION,
        blocks,
      });
      if (generation !== currentDocumentGeneration || controller.signal.aborted) return;
      localReflowBlocks = result.blocks || [];
      renderCurrentReflow(`本地排版完成 · ${localReflowBlocks.length} 个阅读块`);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        reflowStatus.textContent = '已取消本地排版，原文阅读不受影响';
      } else {
        reflowStatus.textContent = `本地排版失败：${error.message}`;
        console.error('本地排版失败:', error);
      }
    } finally {
      if (reflowAbortController === controller) reflowAbortController = null;
      btnReflowGenerate.disabled = false;
      btnReflowCancel.classList.add('hidden');
      setReflowProgress('');
    }
  }

  async function setReaderMode(mode, persist = true) {
    const viewMode = mode === 'reflow' ? 'reflow' : 'original';
    if (viewMode === 'reflow') {
      document.getElementById('pdf-viewer').classList.add('hidden');
      reflowView.classList.remove('hidden');
      await generateLocalReflow(false);
    } else {
      reflowView.classList.add('hidden');
      document.getElementById('pdf-viewer').classList.remove('hidden');
    }
    if (persist) await saveReaderPreferences({ view_mode: viewMode });
    else {
      readerPreferences = { ...(readerPreferences || {}), view_mode: viewMode };
      updateReaderControls();
    }
    updateTranslatePlaceholder(targetLang.value);
  }

  async function openPdfFile(payload) {
    const documentId = typeof payload === 'string' ? payload : payload && payload.documentId;
    if (!documentId) return;
    await flushProgress();
    const previousGeneration = currentDocumentGeneration;
    currentDocumentGeneration += 1;
    if (previousGeneration) await window.deepshui.library.revoke(previousGeneration).catch(() => {});
    const generation = currentDocumentGeneration;
    try {
      const opened = await window.deepshui.library.open(documentId, generation);
      if (generation !== currentDocumentGeneration) return;
      currentDocumentId = documentId;
      currentServerGeneration = Number(opened.serverGeneration);
      currentContentHash = String(opened.contentHash || '');
      clearReflowAssetUrls();
      localReflowBlocks = [];
      aiReflowPreview = null;
      aiReflowRequestId = null;
      setReflowAiActions();
      progressRevision = Number(opened.progress && opened.progress.revision) || 0;
      readerPreferences = await window.deepshui.reader.getPreferences(documentId);
      if (generation !== currentDocumentGeneration) return;
      LibraryUI.showReader(opened.title);
      updateReaderControls();
      const loaded = await PdfViewer.loadPdf(opened.url, opened.title, {
        generation,
        progress: opened.progress,
        readerState: readerPreferences,
      });
      if (!loaded) return;
      await refreshBookmarks();
      await setReaderMode(readerPreferences.view_mode || 'original', false);
    } catch (error) {
      alert('打开文献失败: ' + error.message);
      LibraryUI.showLibrary();
    }
  }

  async function returnToLibrary() {
    await flushProgress();
    if (reflowAbortController) reflowAbortController.abort();
    if (aiReflowRequestId) window.deepshui.reflow.cancelAiEnhance(aiReflowRequestId).catch(() => {});
    clearTimeout(readerPreferencesTimer);
    const generation = currentDocumentGeneration;
    currentDocumentGeneration += 1;
    currentDocumentId = null;
    currentServerGeneration = 0;
    currentContentHash = '';
    readerPreferences = null;
    clearReflowAssetUrls();
    localReflowBlocks = [];
    aiReflowPreview = null;
    aiReflowRequestId = null;
    setReflowAiActions();
    currentBookmarks = [];
    updateBookmarkButton();
    await PdfViewer.releaseDocument();
    if (generation) await window.deepshui.library.revoke(generation).catch(() => {});
    LibraryUI.showLibrary();
  }

  // PDF 打开后：提取全文（带进度）→ 重置问答历史 → 自动总结（若 AI 可用）
  async function handlePdfOpened(opts) {
    const keepSessions = !!(opts && opts.keepSessions);
    if (!keepSessions) sessionStore.clear();  // 真·新文档: 清空所有模型会话
    const myTurn = ++pdfOpenCounter;

    // 新文档: 页数输入框锁定实际页数(持久化); 清空已发送图片缓存
    clampSummaryInputsToDoc();
    sentImageMap.clear();

    // 重置问答历史（新文档新会话）
    askHistory = [];
    askCurrentAnswer = '';
    clearAiContent(aiAskContent);
    aiAskStatus.textContent = '';

    const ai = currentConfig.ai || {};
    if (!keepSessions) {
      currentSessionKey = ai.model ? `${ai.provider || 'deepseek'}/${ai.model}` : null;
    }
    // 防御: 起始/结束页锁定到实际页数（旧配置可能超出新文档，getPage 会抛异常）
    const pc = PdfViewer.pageCount || 1;
    const start = Math.min(Math.max(1, ai.summaryStart || 1), pc);
    const end = Math.max(start, Math.min(ai.summaryEnd || 16, pc));

    // 多模态模型：渲染页范围为网格图上传总结（不注入全文文本）
    // 多模态总开关关闭时走文本提取路径
    const isMultimodal = ai.multimodalEnabled !== false && !!(ai.model && (ai.multimodalMap || {})[ai.model]);
    if (isMultimodal && configuredAiKey(ai) && ai.model && ai.showAsk) {
      aiAsk.classList.remove('hidden');
      // 图片体积大：限制单次总结最多 16 页（4 页/张 × 4 张），超出提示缩小范围
      const MM_MAX_PAGES = 16;
      if (end - start + 1 > MM_MAX_PAGES) {
        clearAiContent(aiAskContent);
        aiAskContent.textContent =
          `⚠️ 多模态总结单次最多 ${MM_MAX_PAGES} 页（图片体积限制）。` +
          `当前范围 ${start}-${end} 共 ${end - start + 1} 页，请在下方「总结页数」处缩小范围后点击「重置对话」。`;
        return;
      }
      fulltextProgress.classList.remove('hidden');
      fulltextProgressBar.style.width = '0%';
      fulltextProgressText.textContent = '正在渲染页面 0%';
      const pageNums = [];
      for (let p = start; p <= end; p++) pageNums.push(p);
      const grids = [];
      const BATCH = 4; // 每 4 页拼一张网格图，控制图片数量
      try {
        for (let i = 0; i < pageNums.length; i += BATCH) {
          if (myTurn !== pdfOpenCounter) return;
          const batch = pageNums.slice(i, i + BATCH);
          fulltextProgressText.textContent =
            `正在渲染页面 ${batch[0]}-${batch[batch.length - 1]} (${Math.min(i + BATCH, pageNums.length)}/${pageNums.length})`;
          const grid = await PdfViewer.renderPagesToGrid(batch, 2, 1.0);
          if (grid) grids.push({ dataUrl: grid, label: `第${batch[0]}-${batch[batch.length - 1]}页` });
        }
      } catch (e) {
        if (myTurn !== pdfOpenCounter) return;
        fulltextProgress.classList.add('hidden');
        clearAiContent(aiAskContent);
        aiAskContent.textContent = '⚠️ 页面渲染失败: ' + e.message;
        return;
      }
      fulltextProgress.classList.add('hidden');
      if (myTurn !== pdfOpenCounter) return;
      fullText = ''; // 图片已含全部内容，不注入文本（避免双重内容）
      if (grids.length) {
        sendAsk('请阅读并理解上面的文章页面，然后用中文总结这些页面的核心内容，之后我会继续向你提问。', true, grids);
      } else {
        aiAskContent.textContent = '⚠️ 页面渲染失败，无法进行多模态总结';
      }
      return;
    }

    // 文本模型：按页数范围提取全文
    fulltextProgress.classList.remove('hidden');
    fulltextProgressBar.style.width = '0%';
    fulltextProgressText.textContent = '正在提取全文 0%';

    setTimeout(async () => {
      let text;
      try {
        text = await PdfViewer.extractFullText(({ current, total }) => {
          if (myTurn !== pdfOpenCounter) return;
          const pct = Math.round(current / total * 100);
          fulltextProgressBar.style.width = pct + '%';
          fulltextProgressText.textContent = `正在提取全文 ${current}/${total} (${pct}%)`;
        }, { start, end });
      } catch (e) {
        if (myTurn !== pdfOpenCounter) return;
        fulltextProgress.classList.add('hidden');
        clearAiContent(aiAskContent);
        aiAskContent.textContent = '⚠️ 全文提取失败: ' + e.message;
        return;
      }
      if (myTurn !== pdfOpenCounter) return; // 已打开新 PDF，丢弃
      fullText = text;
      fulltextProgress.classList.add('hidden');

      if (!fullText.trim()) {
        clearAiContent(aiAskContent);
        aiAskContent.textContent = '⚠️ 该 PDF 无可提取文本（可能是扫描版），全文问答不可用';
        return;
      }

      // 自动总结（AI 已配置 + 问答显示开启）——全文只放 system，避免双重注入
      if (configuredAiKey(ai) && ai.model && ai.showAsk) {
        aiAsk.classList.remove('hidden');
        sendAsk('请阅读并理解上面的文章，然后用中文总结这篇文章的核心内容，之后我会继续向你提问。', true);
      }
    }, 100);
  }

  // ── 选图模式（点击 PDF 中的图片上传）────────
  // 进入/退出选图模式：在 PDF 页面上显示蓝色热区，点击即截取该区域
  let selectTipEl = null;

  function isCurrentModelMultimodal() {
    const ai = currentConfig.ai || {};
    if (ai.multimodalEnabled === false) return false;  // 多模态总开关关闭
    if (!ai.model) return false;
    return !!(ai.multimodalMap || {})[ai.model];
  }

  // 页数范围 clamp：锚定 PDF 实际页数（超出调到最后一页）；多模态模型限 16 页
  function clampSummaryRange(start, end, warn = true) {
    const maxPage = PdfViewer.pageCount || 0;
    if (start < 1) start = 1;
    if (maxPage > 0) {
      if (start > maxPage) start = maxPage;
      if (end > maxPage) end = maxPage;
    }
    if (end < start) end = start;
    // 多模态总结单次最多 16 页（图片体积限制），超出自动收窄并警告
    if (isCurrentModelMultimodal() && end - start + 1 > 16) {
      end = maxPage > 0 ? Math.min(start + 15, maxPage) : start + 15;
      if (warn) {
        aiAskStatus.textContent = '⚠️ 多模态总结单次最多 16 页，已自动调整为起始页起 16 页';
        clearTimeout(clampSummaryRange._t);
        clampSummaryRange._t = setTimeout(() => {
          if (aiAskStatus.textContent.startsWith('⚠️ 多模态总结')) aiAskStatus.textContent = '';
        }, 5000);
      }
    }
    return { start, end };
  }

  // PDF 打开后：页数输入框锁定实际页数（max 属性 + 显示值 clamp + 持久化）
  function clampSummaryInputsToDoc() {
    const maxPage = PdfViewer.pageCount || 0;
    if (!maxPage) return;
    aiSummaryStart.max = maxPage;
    aiSummaryEnd.max = maxPage;
    const start = parseInt(aiSummaryStart.value) || 1;
    const end = parseInt(aiSummaryEnd.value) || 16;
    const c = clampSummaryRange(start, end, false);
    if (c.start !== start || c.end !== end) {
      aiSummaryStart.value = c.start;
      aiSummaryEnd.value = c.end;
      saveSummaryRange();
    }
  }

  async function enterImageSelectMode() {
    if (imageSelectMode) return;
    if (!PdfViewer.pageCount) {
      alert('请先打开 PDF 文件');
      return;
    }
    if (!isCurrentModelMultimodal()) {
      alert('当前 AI 模型不支持多模态，无法发送图片。\n请在 ⚙️ 设置 → AI 引擎 选择标注「(多模态✅)」的模型。');
      return;
    }
    imageSelectMode = true;
    // 顶部提示条（含退出按钮）
    selectTipEl = document.createElement('div');
    selectTipEl.id = 'image-select-tip';
    selectTipEl.innerHTML = '<span>🖼 点击蓝色区域选择位图，或直接拖拽框选任意区域（可多选）。部分模型标称的多模态并不能真正支持，多数模型必须填入提示词才能上传图片</span><button id="image-select-done">完成</button>';
    document.body.appendChild(selectTipEl);
    document.getElementById('image-select-done').addEventListener('click', exitImageSelectMode);

    PdfViewer.enterImageSelectMode(async (pageNum, bbox) => {
      aiAskStatus.textContent = '正在截取图片...';
      aiAskStatus.className = 'ai-status';
      try {
        const dataUrl = await PdfViewer.renderRegionToPng(pageNum, bbox, 2);
        if (dataUrl) {
          askImages.push({ page: pageNum, dataUrl, label: `第 ${pageNum} 页图片` });
          renderAskImages();
        }
      } catch (e) {
        console.error('截取图片失败:', e);
      }
      aiAskStatus.textContent = '';
    });
  }

  function exitImageSelectMode() {
    if (!imageSelectMode) return;
    imageSelectMode = false;
    PdfViewer.exitImageSelectMode();
    if (selectTipEl) {
      selectTipEl.remove();
      selectTipEl = null;
    }
  }

  // 渲染附件缩略图（仿 DeepSeek：输入框上方，可删除）
  function renderAskImages() {
    aiAskImages.innerHTML = '';
    if (askImages.length === 0) {
      aiAskImages.classList.add('hidden');
      return;
    }
    aiAskImages.classList.remove('hidden');
    askImages.forEach((img, idx) => {
      const item = document.createElement('div');
      item.className = 'ai-ask-image-item';
      const im = document.createElement('img');
      im.src = img.dataUrl;
      im.alt = img.label;
      const tag = document.createElement('div');
      tag.className = 'page-tag';
      tag.textContent = `p.${img.page}`;
      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.textContent = '✕';
      rm.title = '移除图片';
      rm.addEventListener('click', () => {
        askImages.splice(idx, 1);
        renderAskImages();
      });
      item.appendChild(im);
      item.appendChild(tag);
      item.appendChild(rm);
      aiAskImages.appendChild(item);
    });
  }

  // 发送时携带附件图片，发送后清空附件
  function takeAskImages() {
    if (askImages.length === 0) return null;
    const imgs = askImages.map(img => ({ dataUrl: img.dataUrl }));
    askImages = [];
    renderAskImages();
    return imgs;
  }

  // ── 划词翻译 + AI 解释联动 ───────────────
  function handleTextSelect(text) {
    if (text.length > 5000) text = text.substring(0, 5000);
    currentSelection = text;

    // 划线变化 → 立即打断旧解释
    if (aiExplainRunning) {
      cancelExplain();
    }

    // 目标语言为「不翻译」时跳过翻译流程
    const to = targetLang.value;
    if (to === 'none') {
      translatePlaceholder.classList.remove('hidden');
      translateResult.classList.add('hidden');
      translateLoading.classList.add('hidden');
      translateError.classList.add('hidden');
      updateTranslatePlaceholder('none');
    } else {
      showLoading();
      clearTimeout(translateTimer);
      translateTimer = setTimeout(async () => {
        const engine = engineSelect.value;
        const result = await window.deepshui.translate(text, 'auto', to, engine);

        if (result.ok) {
          showResult(text, result.text, result.engine);
        } else {
          showError(result.error);
        }
      }, 300);
    }

    // AI 解释（若开启且已配置 key）
    const ai = currentConfig.ai || {};
    if (ai.showExplain && configuredAiKey(ai)) {
      // 小防抖，避免连续划词频繁请求
      clearTimeout(aiExplainTimer);
      aiExplainTimer = setTimeout(() => {
        startExplain(text);
      }, 400);
    }
  }

  function handleReflowTextSelection() {
    if (readerPreferences?.view_mode !== 'reflow') return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!reflowContent.contains(range.commonAncestorContainer)) return;
    const text = selection.toString().trim();
    if (text) handleTextSelect(text);
  }

  // 占位提示文案：随目标语言模式变化
  function updateTranslatePlaceholder(mode) {
    const p = translatePlaceholder.querySelector('p');
    if (p) {
      p.textContent = mode === 'none'
        ? '不翻译模式：划词仅进行 AI 解释（如已开启）'
        : readerPreferences?.view_mode === 'reflow'
          ? '在智能排版中选中文本，翻译结果会显示在这里'
          : '在 PDF 中选中文本，翻译结果会显示在这里';
    }
  }

  function showLoading() {
    translatePlaceholder.classList.add('hidden');
    translateResult.classList.add('hidden');
    translateError.classList.add('hidden');
    translateLoading.classList.remove('hidden');
  }

  function showResult(source, target, engine) {
    translateLoading.classList.add('hidden');
    translateError.classList.add('hidden');
    resultSource.textContent = source;
    resultTarget.textContent = target;
    resultEngine.textContent = (ENGINE_LABELS[engine] || engine) + (engine !== currentConfig.engine ? '' : '');
    translateResult.classList.remove('hidden');
  }

  function showError(msg) {
    translateLoading.classList.add('hidden');
    translateResult.classList.add('hidden');
    errorText.textContent = msg;
    translateError.classList.remove('hidden');
  }

  // ── 复制 ─────────────────────────────────
  function copyResult() {
    const text = resultTarget.textContent;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      btnCopy.textContent = '✓ 已复制';
      setTimeout(() => { btnCopy.textContent = '📋'; }, 1500);
    });
  }

  // ── 设置面板 ─────────────────────────────
  async function openSettings() {
    const config = await window.deepshui.getConfig();
    currentConfig = config;
    setEngine.value = config.engine || 'youdao';
    setLang.value = config.targetLang || 'zh-CN';
    renderEngineFields(setEngine.value);

    // AI 字段回填
    fillAiForm(config.ai || {});

    settingsStatus.textContent = '';
    settingsStatus.className = '';
    aiSettingsStatus.textContent = '';
    aiSettingsStatus.className = '';
    settingsOverlay.classList.remove('hidden');
  }

  async function saveSettings() {
    // 翻译引擎保存：只更新翻译引擎相关字段，AI 配置原样保留（两者完全独立）
    const cfg = {
      ...currentConfig,   // 保留 AI 及其它所有字段
      engine: setEngine.value,
      targetLang: setLang.value,
      youdao: { ...currentConfig.youdao, ...(setEngine.value === 'youdao' ? collectCredentials('youdao') : {}) },
      baidu: { ...currentConfig.baidu, ...(setEngine.value === 'baidu' ? collectCredentials('baidu') : {}) },
      xunfei: { ...currentConfig.xunfei, ...(setEngine.value === 'xunfei' ? collectCredentials('xunfei') : {}) },
      deepl: { ...currentConfig.deepl, ...(setEngine.value === 'deepl' ? collectCredentials('deepl') : {}) },
      google: { ...currentConfig.google, ...(setEngine.value === 'google' ? collectCredentials('google') : {}) },
    };

    // 仅当「翻译引擎」tab 激活时才校验翻译引擎凭证；AI tab 保存不受翻译引擎凭证限制
    const engineTabActive = !engineTab.classList.contains('hidden');
    if (engineTabActive) {
      const def = ENGINE_FIELDS[cfg.engine] || [];
      const cred = cfg[cfg.engine] || {};
      const missing = def.filter(f => !cred[f.key]).map(f => f.label);
      if (missing.length > 0) {
        settingsStatus.textContent = `⚠️ 请填写 ${ENGINE_LABELS[cfg.engine]} 的: ${missing.join('、')}`;
        settingsStatus.className = 'err';
        return;
      }
    }

    await window.deepshui.saveConfig(cfg);
    currentConfig = cfg;
    // 同步侧边栏
    targetLang.value = cfg.targetLang;
    engineSelect.value = cfg.engine;
    settingsStatus.textContent = '✅ 配置已保存';
    settingsStatus.className = 'ok';
    applyAiVisibility();
  }

  async function testConnection() {
    const engine = setEngine.value;
    const cred = collectCredentials(engine);
    const def = ENGINE_FIELDS[engine] || [];
    const missing = def.filter(f => !cred[f.key]).map(f => f.label);
    if (missing.length > 0) {
      settingsStatus.textContent = `⚠️ 请先填写 ${ENGINE_LABELS[engine]} 的: ${missing.join('、')}`;
      settingsStatus.className = 'err';
      return;
    }

    // 临时保存再测试，保证用新凭证（保留 AI 等其它配置）
    const cfg = {
      ...currentConfig,
      engine: setEngine.value,
      targetLang: setLang.value,
      youdao: { ...currentConfig.youdao },
      baidu: { ...currentConfig.baidu },
      xunfei: { ...currentConfig.xunfei },
      deepl: { ...currentConfig.deepl },
      google: { ...currentConfig.google },
    };
    cfg[engine] = cred;
    await window.deepshui.saveConfig(cfg);

    settingsStatus.textContent = '测试中...';
    settingsStatus.className = '';
    const testText = 'Hello, this is a test for machine translation.';
    const result = await window.deepshui.translate(testText, 'auto', 'zh-CN', engine);
    if (result.ok) {
      settingsStatus.textContent = `✅ ${ENGINE_LABELS[engine]} 连接成功: ${result.text}`;
      settingsStatus.className = 'ok';
    } else {
      settingsStatus.textContent = `❌ ${ENGINE_LABELS[engine]} 连接失败: ${result.error}`;
      settingsStatus.className = 'err';
    }
  }

  // 按模型切换会话：保存旧模型会话 → 恢复新模型会话（无则开新会话自动总结）
  function switchSession(oldKey, newKey) {
    cancelAsk();
    cancelExplain();
    // 1. 保存当前会话快照
    if (oldKey) {
      sessionStore.set(oldKey, {
        askHistory, fullText, sentImageMap, askImages,
        raw: aiAskContent.__raw || '',
      });
    }
    // 2. 恢复目标会话（策略 A：原样恢复，不补充上下文）
    const s = sessionStore.get(newKey);
    if (s) {
      askHistory = s.askHistory;
      fullText = s.fullText;
      sentImageMap = s.sentImageMap;
      askImages = s.askImages;
      askCurrentAnswer = '';
      aiAskContent.__raw = s.raw;
      renderMarkdownTo(aiAskContent, s.raw);  // 含已发图片的 alt 标记回填
      aiAskContent.scrollTop = aiAskContent.scrollHeight;
      renderAskImages();
      const rounds = s.askHistory.filter(m => m.role === 'user').length;
      aiAskStatus.textContent = `已恢复该模型的会话（${rounds} 轮历史）`;
      setTimeout(() => {
        if (aiAskStatus.textContent.startsWith('已恢复')) aiAskStatus.textContent = '';
      }, 3000);
      return;
    }
    // 3. 无历史 → 开新会话：全新状态，复用文档打开流程自动总结
    //    （handlePdfOpened 会重建 askHistory/fullText/显示，并 bump pdfOpenCounter 打断旧渲染）
    askImages = [];
    renderAskImages();
    sentImageMap = new Map();
    if (PdfViewer.pageCount > 0) {
      handlePdfOpened({ keepSessions: true });
    } else {
      askHistory = [];
      askCurrentAnswer = '';
      fullText = '';
      clearAiContent(aiAskContent);
      aiAskStatus.textContent = '';
    }
  }

  // 配置保存后检查模型是否变化，变化则切换会话
  function maybeSwitchSession(cfg) {
    const newKey = cfg.ai && cfg.ai.model ? `${cfg.ai.provider || 'deepseek'}/${cfg.ai.model}` : null;
    if (newKey && newKey !== currentSessionKey) {
      switchSession(currentSessionKey, newKey);
      currentSessionKey = newKey;
    }
  }

  // 自动保存 AI 设置（表单改动即生效，无需手动保存）
  async function autoSaveAi() {
    const provider = setAiProvider.value;
    const providerKeys = { ...(currentConfig.ai?.providerKeys || {}) };
    providerKeys[provider] = setAiKey.value.trim();
    const cfg = {
      ...currentConfig,
      ai: {
        ...currentConfig.ai,
        provider,
        providerKeys,
        model: setAiModel.value || '',
        deepThink: setAiDeepThink.value,
        showExplain: setAiExplain.value === 'on',
        showAsk: setAiAsk.value === 'on',
        isolateContext: setAiIsolate.value !== 'off',
        multimodalEnabled: setAiMm.value === 'on',
      },
    };
    await window.deepshui.saveConfig(cfg);
    currentConfig = cfg;
    maybeSwitchSession(cfg);
    applyAiVisibility();
  }

  // 保存总结页数范围（提问框旁输入，clamp 到 PDF 实际页数/多模态上限）
  async function saveSummaryRange() {
    let start = parseInt(aiSummaryStart.value) || 1;
    let end = parseInt(aiSummaryEnd.value) || 16;
    const c = clampSummaryRange(start, end);
    start = c.start;
    end = c.end;
    // 回写 clamp 后的值，让用户看到生效范围
    aiSummaryStart.value = start;
    aiSummaryEnd.value = end;
    const ai = { ...(currentConfig.ai || {}) };
    if (ai.summaryStart === start && ai.summaryEnd === end) return;
    const cfg = { ...currentConfig, ai: { ...ai, summaryStart: start, summaryEnd: end } };
    await window.deepshui.saveConfig(cfg);
    currentConfig = cfg;
  }

  // 保存全部设置（翻译引擎 + AI，用于「保存并退出」）
  async function fullSave() {
    const provider = setAiProvider.value;
    const providerKeys = { ...(currentConfig.ai?.providerKeys || {}) };
    providerKeys[provider] = setAiKey.value.trim();
    const cfg = {
      ...currentConfig,
      engine: setEngine.value,
      targetLang: setLang.value,
      youdao: { ...currentConfig.youdao, ...(setEngine.value === 'youdao' ? collectCredentials('youdao') : {}) },
      baidu: { ...currentConfig.baidu, ...(setEngine.value === 'baidu' ? collectCredentials('baidu') : {}) },
      xunfei: { ...currentConfig.xunfei, ...(setEngine.value === 'xunfei' ? collectCredentials('xunfei') : {}) },
      deepl: { ...currentConfig.deepl, ...(setEngine.value === 'deepl' ? collectCredentials('deepl') : {}) },
      google: { ...currentConfig.google, ...(setEngine.value === 'google' ? collectCredentials('google') : {}) },
      ai: {
        ...currentConfig.ai,
        provider,
        providerKeys,
        model: setAiModel.value || '',
        deepThink: setAiDeepThink.value,
        showExplain: setAiExplain.value === 'on',
        showAsk: setAiAsk.value === 'on',
        isolateContext: setAiIsolate.value !== 'off',
        multimodalEnabled: setAiMm.value === 'on',
      },
    };
    await window.deepshui.saveConfig(cfg);
    currentConfig = cfg;
    targetLang.value = cfg.targetLang;
    engineSelect.value = cfg.engine;
    maybeSwitchSession(cfg);
    applyAiVisibility();
  }

  // 检测是否有未保存的更改（翻译引擎表单 + AI 表单 vs 已保存配置）
  function hasUnsavedChanges() {
    const ai = currentConfig.ai || {};
    const provider = setAiProvider.value;
    // AI 表单（自动保存，通常无差异，但 key 未失焦时可能未保存）
    const aiChanged =
      setAiProvider.value !== (ai.provider || 'deepseek') ||
      setAiKey.value.trim() !== ((ai.providerKeys || {})[provider] || '') ||
      setAiModel.value !== (ai.model || '') ||
      setAiDeepThink.value !== (ai.deepThink || 'off') ||
      (setAiExplain.value === 'on') !== (ai.showExplain !== false) ||
      (setAiAsk.value === 'on') !== (ai.showAsk !== false) ||
      (setAiIsolate.value !== 'off') !== (ai.isolateContext !== false) ||
      (setAiMm.value === 'on') !== (ai.multimodalEnabled !== false);
    // 翻译引擎表单（手动保存）
    const engineChanged =
      setEngine.value !== (currentConfig.engine || 'youdao') ||
      setLang.value !== (currentConfig.targetLang || 'zh-CN');
    // 引擎凭证字段
    let credChanged = false;
    const fields = ENGINE_FIELDS[setEngine.value] || [];
    const savedCred = currentConfig[setEngine.value] || {};
    for (const f of fields) {
      const input = fieldInputs[setEngine.value]?.[f.key];
      if (input && input.value.trim() !== (savedCred[f.key] || '')) {
        credChanged = true;
        break;
      }
    }
    return aiChanged || engineChanged || credChanged;
  }

  // 关闭设置：有未保存更改时弹三选项确认
  function closeSettings() {
    if (hasUnsavedChanges()) {
      confirmOverlay.classList.remove('hidden');
      return;
    }
    settingsOverlay.classList.add('hidden');
  }

  // ── 事件绑定 ─────────────────────────────
  btnOpen.addEventListener('click', openPdfViaDialog);
  btnOpenPlaceholder.addEventListener('click', openPdfViaDialog);
  btnZoomIn.addEventListener('click', () => {
    PdfViewer.zoomIn();
    queueReaderPreferences({ zoom_mode: 'manual' });
  });
  btnZoomOut.addEventListener('click', () => {
    PdfViewer.zoomOut();
    queueReaderPreferences({ zoom_mode: 'manual' });
  });
  zoomModeSelect.addEventListener('change', async () => {
    await PdfViewer.setZoomMode(zoomModeSelect.value);
    await saveReaderPreferences({ zoom_mode: zoomModeSelect.value });
  });
  btnReaderMode.addEventListener('click', () => setReaderMode(readerPreferences?.view_mode === 'reflow' ? 'original' : 'reflow'));
  btnFocus.addEventListener('click', () => saveReaderPreferences({ focus_mode: !readerPreferences?.focus_mode }));
  btnSidebar.addEventListener('click', () => saveReaderPreferences({ sidebar_collapsed: !readerPreferences?.sidebar_collapsed }));
  btnReflowGenerate.addEventListener('click', () => generateLocalReflow(true));
  btnReflowAiEnhance.addEventListener('click', requestAiReflowEnhancement);
  btnReflowAiApply.addEventListener('click', () => {
    if (!aiReflowPreview) return;
    aiReflowPreview.applied = true;
    renderReflow(localReflowBlocks, aiReflowPreview.suggestions);
    reflowStatus.textContent = '已应用 AI 布局到本次阅读会话；原文内容与本地缓存未修改';
    setReflowAiActions();
  });
  btnReflowAiDiscard.addEventListener('click', () => restoreLocalReflow('已撤销 AI 布局，本地排版保持不变'));
  btnReflowCancel.addEventListener('click', () => {
    if (reflowAbortController) reflowAbortController.abort();
    else if (aiReflowRequestId) window.deepshui.reflow.cancelAiEnhance(aiReflowRequestId).catch(() => {});
  });
  reflowContent.addEventListener('mouseup', () => setTimeout(handleReflowTextSelection, 0));

  sidebarResizer.addEventListener('pointerdown', (event) => {
    if (!currentDocumentId || readerPreferences?.sidebar_collapsed || readerPreferences?.focus_mode) return;
    event.preventDefault();
    document.body.classList.add('resizing-sidebar');
    sidebarResizer.setPointerCapture?.(event.pointerId);
    const onMove = (moveEvent) => {
      const mainRect = document.getElementById('main').getBoundingClientRect();
      const width = Math.max(280, Math.min(640, mainRect.right - moveEvent.clientX));
      readerPreferences = { ...(readerPreferences || {}), sidebar_width: Math.round(width) };
      updateReaderControls();
    };
    const onUp = async () => {
      document.body.classList.remove('resizing-sidebar');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      await saveReaderPreferences();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  });

  btnGoto.addEventListener('click', () => {
    const n = parseInt(pageInput.value);
    if (!isNaN(n)) PdfViewer.gotoPage(n);
  });

  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const n = parseInt(pageInput.value);
      if (!isNaN(n)) PdfViewer.gotoPage(n);
    }
  });

  btnSettings.addEventListener('click', openSettings);
  document.getElementById('btn-library').addEventListener('click', returnToLibrary);
  btnSettingsClose.addEventListener('click', closeSettings);
  btnSettingsSave.addEventListener('click', saveSettings);
  btnSettingsTest.addEventListener('click', testConnection);
  btnCopy.addEventListener('click', copyResult);

  // 未保存确认框
  btnConfirmCancel.addEventListener('click', () => confirmOverlay.classList.add('hidden'));
  btnConfirmDiscard.addEventListener('click', () => {
    confirmOverlay.classList.add('hidden');
    settingsOverlay.classList.add('hidden');
  });
  btnConfirmSave.addEventListener('click', async () => {
    confirmOverlay.classList.add('hidden');
    await fullSave();
    settingsOverlay.classList.add('hidden');
  });

  // 设置面板 tabs 切换
  settingsTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      settingsTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      engineTab.classList.toggle('hidden', target !== 'engine-tab');
      aiTab.classList.toggle('hidden', target !== 'ai-tab');
    });
  });

  // AI 设置：刷新模型列表 / 测试 / AI 保存按钮
  btnAiRefresh.addEventListener('click', refreshAiModels);
  btnAiTest.addEventListener('click', testAi);
  btnSettingsSaveAi.addEventListener('click', async () => {
    await autoSaveAi();
    aiSettingsStatus.textContent = '✅ AI 配置已保存';
    aiSettingsStatus.className = 'ok';
  });

  // AI 表单改动即自动保存（深度思考/显示开关/多模态开关/模型/Key/提供商）
  [setAiProvider, setAiDeepThink, setAiExplain, setAiAsk, setAiIsolate, setAiMm].forEach(el => {
    el.addEventListener('change', autoSaveAi);
  });
  setAiModel.addEventListener('change', autoSaveAi);
  setAiKey.addEventListener('change', autoSaveAi); // 失焦时保存

  // 切换提供商：加载该商的 key 到输入框 + 清空模型选择（不同商模型不通用）
  setAiProvider.addEventListener('change', () => {
    const ai = currentConfig.ai || {};
    setAiKey.value = (ai.providerKeys || {})[setAiProvider.value] || '';
    setAiModel.innerHTML = '<option value="">切换提供商后请重新拉取模型</option>';
    setAiModel.disabled = true;
    updateAiKeyPlaceholder(setAiProvider.value);
  });

  // 模型拉取进度（两阶段: 可用性探测 → 多模态探测，设置面板内进度条）
  window.deepshui.onAiModelsProgress(({ done, total, phase }) => {
    const bar = document.getElementById('ai-models-progress-bar');
    const text = document.getElementById('ai-models-progress-text');
    if (!bar || !text) return;
    const pct = Math.round(done / total * 100);
    bar.style.width = pct + '%';
    const label = phase === 'chat' ? '正在验证模型可用性' : '正在检测多模态';
    text.textContent = `${label} ${done}/${total} (${pct}%)`;
  });

  // AI 问答发送 / 清屏
  // 先校验再取图：空提示词直接返回，图片保留在附件区（修复空词发送吞图）
  function sendAskFromBox() {
    const q = aiAskBox.value.trim();
    if (!q || aiAskRunning) return;
    sendAsk(q, false, takeAskImages());
  }
  aiAskSend.addEventListener('click', sendAskFromBox);
  aiAskBox.addEventListener('keydown', (e) => {
    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAskFromBox();
    }
  });

  // 选图按钮：进入/退出选图模式
  aiAskImage.addEventListener('click', () => {
    if (imageSelectMode) exitImageSelectMode();
    else enterImageSelectMode();
  });

  // 总结页数范围：失焦保存
  aiSummaryStart.addEventListener('change', saveSummaryRange);
  aiSummaryEnd.addEventListener('change', saveSummaryRange);

  // 输入框随内容自动增高（上限 120px）
  aiAskBox.addEventListener('input', () => {
    aiAskBox.style.height = 'auto';
    aiAskBox.style.height = Math.min(aiAskBox.scrollHeight, 120) + 'px';
  });

  // 清屏：仅清空显示内容，上下文（askHistory）保留
  aiAskClear.addEventListener('click', () => {
    clearAiContent(aiAskContent);
    aiAskStatus.textContent = '';
    aiAskStatus.className = 'ai-status';
    // 重置输入框高度（BUG-14）
    aiAskBox.style.height = 'auto';
  });

  // 重置对话：清空历史并重新喂入全文让 AI 总结（应对历史无限增长）
  aiAskReset.addEventListener('click', async () => {
    cancelAsk();
    askHistory = [];
    askCurrentAnswer = '';
    sentImageMap.clear();
    clearAiContent(aiAskContent);
    aiAskStatus.textContent = '';
    aiAskStatus.className = 'ai-status';
    aiAskBox.style.height = 'auto';
    aiAskBox.disabled = false;
    aiAskSend.disabled = false;

    const ai = currentConfig.ai || {};
    if (configuredAiKey(ai) && ai.model && ai.showAsk && isCurrentModelMultimodal() && PdfViewer.pageCount) {
      // 多模态模型：重新渲染页范围图片并总结
      const MM_MAX_PAGES = 16;
      const start = Math.max(1, ai.summaryStart || 1);
      const end = Math.max(start, Math.min(ai.summaryEnd || 16, PdfViewer.pageCount));
      if (end - start + 1 > MM_MAX_PAGES) {
        clearAiContent(aiAskContent);
        aiAskContent.textContent =
          `⚠️ 多模态总结单次最多 ${MM_MAX_PAGES} 页（图片体积限制）。` +
          `当前范围 ${start}-${end} 共 ${end - start + 1} 页，请在下方「总结页数」处缩小范围后重试。`;
        return;
      }
      clearAiContent(aiAskContent);
      aiAskContent.textContent = '已重置对话，正在渲染页面...';
      const pc2 = PdfViewer.pageCount || 1;
      const startC = Math.min(start, pc2);
      const endC = Math.max(startC, Math.min(end, pc2));
      const pageNums = [];
      for (let p = startC; p <= endC; p++) pageNums.push(p);
      const grids = [];
      const BATCH = 4;
      try {
        for (let i = 0; i < pageNums.length; i += BATCH) {
          const batch = pageNums.slice(i, i + BATCH);
          aiAskContent.textContent = `已重置对话，正在渲染页面 ${batch[0]}-${batch[batch.length - 1]}...`;
          const grid = await PdfViewer.renderPagesToGrid(batch, 2, 1.0);
          if (grid) grids.push({ dataUrl: grid });
        }
      } catch (e) {
        clearAiContent(aiAskContent);
        aiAskContent.textContent = '⚠️ 页面渲染失败: ' + e.message;
        return;
      }
      if (grids.length) {
        sendAsk('请阅读并理解上面的文章页面，然后用中文总结这些页面的核心内容，之后我会继续向你提问。', true, grids);
      } else {
        aiAskContent.textContent = '⚠️ 页面渲染失败，请重试';
      }
    } else if (fullText && configuredAiKey(ai) && ai.model) {
      clearAiContent(aiAskContent);
      aiAskContent.textContent = '已重置对话，正在重新喂入全文...';
      // 重新喂全文：全文通过 system 注入（sendAsk 自动带上），只需发总结指令
      sendAsk('请阅读并理解上面的文章，然后用中文总结这篇文章的核心内容，之后我会继续向你提问。', true);
    } else if (fullText) {
      clearAiContent(aiAskContent);
      aiAskContent.textContent = '已重置对话。配置 AI 引擎后提问会自动带上全文。';
    } else {
      clearAiContent(aiAskContent);
      aiAskContent.textContent = '已重置对话。打开 PDF 后可进行全文问答。';
    }
  });

  // 设置面板切换引擎 → 动态表单
  setEngine.addEventListener('change', () => renderEngineFields(setEngine.value));

  // 侧边栏切换引擎 → 保存默认引擎
  engineSelect.addEventListener('change', async () => {
    const cfg = await window.deepshui.getConfig();
    cfg.engine = engineSelect.value;
    await window.deepshui.saveConfig(cfg);
    currentConfig = cfg;
  });

  // 侧边栏切换目标语言 → 立即保存 + 更新占位提示
  targetLang.addEventListener('change', async () => {
    updateTranslatePlaceholder(targetLang.value);
    const cfg = await window.deepshui.getConfig();
    cfg.targetLang = targetLang.value;
    await window.deepshui.saveConfig(cfg);
    currentConfig = cfg;
  });

  // 快捷键 Ctrl+O
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      openPdfViaDialog();
    }
  });

  // 主进程菜单触发打开
  window.deepshui.onOpenPdf((payload) => {
    openPdfFile(payload);
  });
  btnBookmark.addEventListener('click', toggleCurrentBookmark);

  // Esc 关闭设置 / 退出选图模式
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (imageSelectMode) {
        exitImageSelectMode();
        return;
      }
      if (!settingsOverlay.classList.contains('hidden')) {
        closeSettings();
      }
    }
  });

  // ── 初始化 ───────────────────────────────
  PdfViewer.init();
  PdfViewer.onTextSelect = handleTextSelect;
  PdfViewer.onPdfLoaded = handlePdfOpened;
  PdfViewer.onProgress = queueProgress;
  updateBookmarkButton();
  window.addEventListener('beforeunload', () => {
    if (pendingProgress) {
      window.deepshui.library.saveProgress({ ...pendingProgress, baseRevision: progressRevision }).catch(() => {});
    }
  });
  LibraryUI.init({
    onOpenDocument: openPdfFile,
    onShowSettings: openSettings,
  });
  window.deepshui.runtime.getStatus().then((status) => {
    const element = document.getElementById('runtime-security-status');
    if (!element) return;
    element.textContent = status.compatibilityMode
      ? `版本 ${status.version} · 兼容模式（Chromium 沙盒已关闭）`
      : `版本 ${status.version} · Chromium 沙盒已启用`;
    element.classList.toggle('warning', status.compatibilityMode);
  }).catch(() => {});
  initConfig();

})();
