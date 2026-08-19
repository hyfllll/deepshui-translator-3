/**
 * deepshui-translator - Electron 主进程
 * 多引擎支持: 有道 / 百度 / 讯飞 / DeepL / Google Cloud (API Key)
 */

const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, safeStorage, session: electronSession } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');
const { DatabaseClient } = require('./main/database/client');
const { DocumentLibraryService } = require('./main/services/document-library');
const { DocumentTokenStore } = require('./main/services/document-tokens');
const { ConfigStore } = require('./main/services/config-store');
const { buildReflowAiMessages, parseReflowAiResponse } = require('./main/services/reflow-ai-contract');
const { registerLibraryIpc } = require('./main/ipc/library-ipc');
const { configureRuntimePaths } = require('./main/bootstrap/runtime-paths');
const { registerAppProtocol } = require('./main/protocol/app-protocol');

// GUI 程序被临时终端、调试器或第三方启动器拉起时，父进程可能先关闭日志管道。
// 仅吞掉已关闭管道产生的 EPIPE；其他流错误仍按异常处理，避免掩盖真实故障。
function guardBrokenPipe(stream) {
  if (!stream || typeof stream.on !== 'function') return;
  stream.on('error', (error) => {
    if (error && error.code === 'EPIPE') return;
    process.nextTick(() => { throw error; });
  });
}
guardBrokenPipe(process.stdout);
guardBrokenPipe(process.stderr);

// 当前 Windows 主机的 GPU 子进程在沙盒模式下异常退出；使用软件渲染保留沙盒边界。
if (process.platform === 'win32') app.disableHardwareAcceleration();

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// 3.0 在 Electron ready 前锁定独立目录。个人桌面版默认兼容模式，避免
// 当前 Windows 主机上 Chromium 沙盒/GPU 子进程无法启动而阻断阅读。
const runtimePaths = configureRuntimePaths(app);
const compatibilityMode = true;
app.commandLine.appendSwitch('no-sandbox');

// 配置文件: ~/.config/deepshui-translator/config.json (Linux)
const DEFAULT_CONFIG = () => ({
  engine: 'youdao',
  targetLang: 'zh-CN',
  youdao: { appKey: '', appSecret: '' },
  baidu: { appid: '', secretKey: '' },
  xunfei: { appid: '', apiKey: '', apiSecret: '' },
  deepl: { apiKey: '' },
  google: { apiKey: '' },
  ai: {
    provider: 'deepseek',
    providerKeys: { deepseek: '', qwen: '', doubao: '', kimi: '' },
    model: '',
    deepThink: 'off',   // off | low | high | max（默认关闭）
    showExplain: false,
    showAsk: false,
    isolateContext: true,  // 隔离解释与问答上下文（默认开启）
    multimodalEnabled: true,  // 多模态总开关（关闭后不允许上传图片，总结走文本提取）
    summaryStart: 1,   // AI 总结起始页（默认 1）
    summaryEnd: 16,    // AI 总结结束页（默认 16）
  },
});

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function normalizeConfig(cfg = {}) {
    const def = DEFAULT_CONFIG();
    const normalized = {
      ...def,
      ...cfg,
      youdao: { ...def.youdao, ...(cfg.youdao || {}) },
      baidu: { ...def.baidu, ...(cfg.baidu || {}) },
      xunfei: { ...def.xunfei, ...(cfg.xunfei || {}) },
      deepl: { ...def.deepl, ...(cfg.deepl || {}) },
      google: { ...def.google, ...(cfg.google || {}) },
      ai: (() => {
        const oldAi = cfg.ai || {};
        const merged = { ...def.ai, ...oldAi };
        // 兼容旧配置: thinkingEnabled + reasoningEffort → deepThink
        if (merged.deepThink === undefined && oldAi.thinkingEnabled !== undefined) {
          merged.deepThink = oldAi.thinkingEnabled ? (oldAi.reasoningEffort || 'high') : 'off';
        }
        // 兼容旧配置: apiKey → providerKeys.deepseek
        if (!merged.providerKeys) merged.providerKeys = { ...def.ai.providerKeys };
        if (oldAi.apiKey && !merged.providerKeys.deepseek) {
          merged.providerKeys.deepseek = oldAi.apiKey;
        }
        merged.apiKey = merged.providerKeys[merged.provider || 'deepseek'] || oldAi.apiKey || '';
        return merged;
      })(),
    };
    return normalized;
}

let configStore = null;

function loadConfig() {
  return configStore ? configStore.load() : normalizeConfig();
}

function saveConfig(cfg) {
  if (!configStore) throw new Error('配置存储尚未初始化');
  return configStore.save(cfg);
}

// ── 语言代码映射（统一代码 → 各引擎代码）────────────────
// 统一: zh-CN, en, ja, ko, fr, de
const LANG_MAP = {
  youdao: { 'zh-CN': 'zh-CHS', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de' },
  baidu:  { 'zh-CN': 'zh', en: 'en', ja: 'jp', ko: 'kor', fr: 'fra', de: 'de' },
  xunfei: { 'zh-CN': 'cn', en: 'en', ja: 'jp', ko: 'kor', fr: 'fra', de: 'de' },
  deepl:  { 'zh-CN': 'ZH', en: 'EN', ja: 'JA', ko: 'KO', fr: 'FR', de: 'DE' },
  google: { 'zh-CN': 'zh-CN', en: 'en', ja: 'ja', ko: 'ko', fr: 'fr', de: 'de' },
};

const ENGINE_NAMES = {
  youdao: '有道翻译', baidu: '百度翻译', xunfei: '讯飞翻译', deepl: 'DeepL', google: 'Google 翻译',
};

function mapLang(engine, lang) {
  if (!lang || lang === 'auto') return lang;
  return (LANG_MAP[engine] && LANG_MAP[engine][lang]) || lang;
}

// ── HTTP 工具 ────────────────────────────────────────────
function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', e => reject(new Error(`网络错误: ${e.message}`)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求超时 (15s)')); });
    if (body) req.write(body);
    req.end();
  });
}

// ── 有道翻译 ─────────────────────────────────────────────
function truncate(q) {
  const len = q.length;
  return len <= 20 ? q : q.substring(0, 10) + len + q.substring(len - 10);
}

async function translateYoudao(text, from, to, cred) {
  const { appKey, appSecret } = cred;
  const salt = String(Date.now());
  const curtime = String(Math.floor(Date.now() / 1000));
  const sign = crypto.createHash('sha256')
    .update(appKey + truncate(text) + salt + curtime + appSecret).digest('hex');

  const params = new URLSearchParams({
    q: text, from: mapLang('youdao', from), to: mapLang('youdao', to),
    appKey, salt, sign, signType: 'v3', curtime,
  });

  // POST（GET 超长文本会触发 URL 长度限制）
  const res = await httpRequest({
    hostname: 'openapi.youdao.com', path: '/api', method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(params.toString()),
      'User-Agent': 'DeepshuiTranslator/1.0',
    },
  }, params.toString());
  const parsed = JSON.parse(res.data);
  if (parsed.errorCode === '0') {
    return { ok: true, text: (parsed.translation || []).join('') };
  }
  return { ok: false, error: `有道错误码 ${parsed.errorCode} (${youdaoError(parsed.errorCode)})` };
}

function youdaoError(code) {
  const msgs = {
    '101': '缺少必填参数', '102': '不支持的语言类型', '103': '翻译文本过长',
    '108': 'appKey无效', '111': '开发者账号无效', '113': '查询为空',
    '202': '签名校验失败', '203': 'IP不在访问列表', '205': '请求太频繁',
    '401': '账户已欠费', '411': '访问频率受限',
  };
  return msgs[code] || '未知错误';
}

// ── 百度翻译 ─────────────────────────────────────────────
async function translateBaidu(text, from, to, cred) {
  const { appid, secretKey } = cred;
  const salt = String(Date.now());
  const sign = crypto.createHash('md5')
    .update(appid + text + salt + secretKey).digest('hex');

  const params = new URLSearchParams({
    q: text, from: mapLang('baidu', from), to: mapLang('baidu', to),
    appid, salt, sign,
  });

  // POST（GET 超长文本会触发 URL 长度限制）
  const res = await httpRequest({
    hostname: 'api.fanyi.baidu.com', path: '/api/trans/vip/translate', method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(params.toString()),
      'User-Agent': 'DeepshuiTranslator/1.0',
    },
  }, params.toString());
  const parsed = JSON.parse(res.data);
  if (parsed.error_code === '0' || (!parsed.error_code && parsed.trans_result)) {
    return { ok: true, text: (parsed.trans_result || []).map(t => t.dst).join('\n') };
  }
  return { ok: false, error: `百度错误码 ${parsed.error_code} (${parsed.error_msg || '未知错误'})` };
}

// ── 讯飞翻译（WebAPI v2，HMAC 签名）──────────────────────
async function translateXunfei(text, from, to, cred) {
  const { appid, apiKey, apiSecret } = cred;
  const host = 'itrans.xfyun.cn';
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nrequest-line: POST /v2/its HTTP/1.1`;
  const signature = crypto.createHmac('sha256', apiSecret)
    .update(signatureOrigin).digest('base64');
  const authorization = `hmac username="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;

  const body = JSON.stringify({
    common: { app_id: appid },
    business: { from: mapLang('xunfei', from), to: mapLang('xunfei', to), type: 1 },
    data: { text: Buffer.from(text, 'utf8').toString('base64') },
  });

  const res = await httpRequest({
    hostname: host, path: '/v2/its', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Host': host,
      'Date': date,
      'Authorization': authorization,
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  const parsed = JSON.parse(res.data);
  if (parsed.code === 0) {
    const dst = parsed.data?.result?.trans_result?.dst || '';
    return { ok: true, text: dst };
  }
  return { ok: false, error: `讯飞错误码 ${parsed.code} (${parsed.message || '未知错误'})` };
}

// ── DeepL ────────────────────────────────────────────────
async function translateDeepL(text, from, to, cred) {
  const params = new URLSearchParams({ text });
  const t = mapLang('deepl', to);
  if (t) params.set('target_lang', t);
  const s = mapLang('deepl', from);
  if (s && s !== 'auto') params.set('source_lang', s);

  const res = await httpRequest({
    hostname: 'api-free.deepl.com', path: '/v2/translate', method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${cred.apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(params.toString()),
    },
  }, params.toString());
  const parsed = JSON.parse(res.data);
  if (parsed.translations) {
    return { ok: true, text: parsed.translations.map(t => t.text).join('\n') };
  }
  const msg = parsed.message || `DeepL HTTP ${res.status}`;
  return { ok: false, error: `DeepL 错误: ${msg}` };
}

// ── Google Cloud Translation (API Key) ───────────────────
async function translateGoogle(text, from, to, cred) {
  const body = JSON.stringify({
    q: text, target: mapLang('google', to), format: 'text',
  });
  const s = mapLang('google', from);
  if (s && s !== 'auto') body.q && Object.assign(JSON.parse(body), { source: s });

  const finalBody = JSON.stringify({
    q: text,
    target: mapLang('google', to),
    format: 'text',
    ...(s && s !== 'auto' ? { source: s } : {}),
  });

  const res = await httpRequest({
    hostname: 'translation.googleapis.com',
    path: '/language/translate/v2?key=' + encodeURIComponent(cred.apiKey),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(finalBody) },
  }, finalBody);
  const parsed = JSON.parse(res.data);
  if (parsed.data && parsed.data.translations) {
    return { ok: true, text: parsed.data.translations.map(t => t.translatedText).join('\n') };
  }
  const err = parsed.error?.message || `Google HTTP ${res.status}`;
  return { ok: false, error: `Google 错误: ${err}` };
}

// ── 引擎分发 ─────────────────────────────────────────────
const ENGINES = {
  youdao: { check: c => c.appKey && c.appSecret, translate: translateYoudao },
  baidu: { check: c => c.appid && c.secretKey, translate: translateBaidu },
  xunfei: { check: c => c.appid && c.apiKey && c.apiSecret, translate: translateXunfei },
  deepl: { check: c => c.apiKey, translate: translateDeepL },
  google: { check: c => c.apiKey, translate: translateGoogle },
};

function translateWith(engine, text, from, to, cfg) {
  const def = ENGINES[engine];
  if (!def) return Promise.resolve({ ok: false, error: `未知引擎: ${engine}` });
  const cred = cfg[engine] || {};
  if (!def.check(cred)) {
    return Promise.resolve({ ok: false, error: `未配置${ENGINE_NAMES[engine]}凭证，请到 ⚙️ 设置 中填写` });
  }
  return def.translate(text, from, to, cred);
}

// ── AI 提供商（DeepSeek / 千问 / 豆包 / Kimi）────────────
const AI_PROVIDERS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', chatPath: '/chat/completions', modelsPath: '/models' },
  qwen:     { label: '千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatPath: '/chat/completions', modelsPath: '/models' },
  doubao:   { label: '豆包', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', chatPath: '/chat/completions', modelsPath: '/models' },
  kimi:     { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', chatPath: '/chat/completions', modelsPath: '/models' },
};

function getAiProvider(name) {
  return AI_PROVIDERS[name] || AI_PROVIDERS.deepseek;
}

function providerEndpoints(provider) {
  const u = new URL(provider.baseUrl);
  const base = u.pathname.replace(/\/$/, '');
  return {
    hostname: u.hostname,
    chatPath: base + provider.chatPath,
    modelsPath: base + provider.modelsPath,
  };
}

// 拉取可用模型列表（返回带 status 的模型数组，豆包用于过滤停服模型）
function fetchAiModels(provider, apiKey) {
  const ep = providerEndpoints(provider);
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: ep.hostname, path: ep.modelsPath, method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'User-Agent': 'DeepshuiTranslator/2.1' },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // 非 200：透出真实错误（此前空响应体会被报成“解析失败”，误导排查）
        if (res.statusCode !== 200) {
          let msg = `HTTP ${res.statusCode}`;
          try {
            const j = JSON.parse(data);
            if (j.error?.message) msg += `: ${j.error.message}`;
            else if (j.message) msg += `: ${j.message}`;
          } catch { /* 空响应体等 */ }
          resolve({ ok: false, error: msg });
          return;
        }
        try {
          const j = JSON.parse(data);
          if (j.data && Array.isArray(j.data)) {
            // out 字段: 豆包特有的输出模态（过滤视频/图像/3D 模型用）
            resolve({ ok: true, models: j.data.map(m => ({ id: m.id, status: m.status, out: m.modalities?.output_modalities })) });
          } else {
            resolve({ ok: false, error: j.error?.message || '模型列表响应异常' });
          }
        } catch (e) { reject(new Error('模型列表解析失败')); }
      });
    });
    req.on('error', e => reject(new Error(`网络错误: ${e.message}`)));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('请求超时 (10s)')); });
  });
}

// ── 多模态自动检测 ────────────────────────────────────────
// 最小纯色 PNG 生成（128x128，Node zlib + CRC32）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function solidPng(r, g, b) {
  const W = 128, H = 128;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    for (let x = 0; x < W; x++) {
      const o = y * (1 + W * 3) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]).toString('base64');
}

// 单次探测：withImage=false 文本探测（验证模型已开通、真正可对话）
//           withImage=true  图像探测（验证多模态）
// 200/429 = 通过（429 说明模型存在仅被限流）；4xx/5xx/超时 = 不可用
// 注1: /models 列表含未开通模型（豆包返回 404，千问返回 400/403），必须实测
// 注2: 图像探测只看状态码——有的网关对文本模型静默丢弃图片仍返回 200
//      （实测: 千问列表里的 deepseek-r1），多模态标注可能误标，UI 已加提示
// 注3: 图像探测只认 200——429 限流时保守判不支持（误标多模态会把图发给文本模型导致报错，
//      漏标只是退化为文本总结，保守方向更安全）；文本探测 429 仍判存活
function probeModel(provider, apiKey, model, withImage, pngB64) {
  const ep = providerEndpoints(provider);
  const content = withImage
    ? [{ type: 'text', text: '描述这张图片' },
       { type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } }]
    : 'hi';
  const body = JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 1 });
  return new Promise((resolve) => {
    const req = https.request({ hostname: ep.hostname, path: ep.chatPath, method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200 || (!withImage && res.statusCode === 429)));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(15000, () => { req.destroy(); resolve(false); });
    req.write(body); req.end();
  });
}

// 并发批量探测，onProgress(done, total) 回调
async function probeModelsBatch(provider, apiKey, modelIds, withImage, onProgress, concurrency = 8) {
  const png = withImage ? solidPng(200, 30, 30) : null;
  const results = [];
  let idx = 0, done = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= modelIds.length) break;
      const id = modelIds[i];
      const ok = await probeModel(provider, apiKey, id, withImage, png);
      results.push({ id, ok });
      done++;
      if (onProgress) onProgress(done, modelIds.length);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, modelIds.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

// 流式对话：通过 onEvent 回调推送事件
// onEvent: {type:'thinking',text} | {type:'content',text} | {type:'think-done',seconds}
//          | {type:'done',usage} | {type:'error',message}
// deepThink: 'off' | 'low' | 'high' | 'max'
function aiChatStream({ provider, apiKey, model, messages, deepThink, signal, onEvent }) {
  const ep = providerEndpoints(provider);
  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(deepThink && deepThink !== 'off'
      ? { thinking: { type: 'enabled' }, reasoning_effort: deepThink }
      : { thinking: { type: 'disabled' } }),
  });

  const startTime = Date.now();
  let thinkingActive = false;
  // 终态事件(done/end/error)只发一次——此前 done 后还会发 end，渲染层重复 finalize，
  // 且取消后迟到的 end 会竞态打断新轮次
  let terminated = false;
  const terminate = (evt) => {
    if (terminated) return;
    terminated = true;
    onEvent(evt);
  };

  const req = https.request({
    hostname: ep.hostname, path: ep.chatPath, method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'DeepshuiTranslator/1.2',
    },
    signal,
  }, res => {
    // 非 200 响应：读取错误正文并作为 error 事件上报（此前会被当 SSE 解析而静默吞掉）
    if (res.statusCode !== 200) {
      let errBuf = '';
      res.setEncoding('utf8');
      res.on('data', c => errBuf += c);
      res.on('end', () => {
        let msg = `HTTP ${res.statusCode}`;
        try {
          const j = JSON.parse(errBuf);
          if (j.error?.message) msg += `: ${j.error.message}`;
          else if (j.message) msg += `: ${j.message}`;
        } catch {
          if (errBuf.trim()) msg += `: ${errBuf.slice(0, 300)}`;
        }
        terminate({ type: 'error', message: msg });
      });
      return;
    }
    let buffer = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      if (terminated) return;
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          terminate({ type: 'done' });
          break;
        }
        try {
          const j = JSON.parse(payload);
          // 流式响应中也可能嵌入错误对象（此前被静默忽略）
          if (j.error) {
            terminate({ type: 'error', message: j.error.message || 'API 返回错误' });
            break;
          }
          const delta = j.choices?.[0]?.delta || {};
          if (delta.reasoning_content) {
            if (!thinkingActive) {
              thinkingActive = true;
              onEvent({ type: 'think-start' });
            }
            onEvent({ type: 'thinking', text: delta.reasoning_content });
          }
          if (delta.content) {
            if (thinkingActive) {
              thinkingActive = false;
              onEvent({ type: 'think-done', seconds: ((Date.now() - startTime) / 1000).toFixed(1) });
            }
            onEvent({ type: 'content', text: delta.content });
          }
          if (j.usage) onEvent({ type: 'usage', usage: j.usage });
        } catch (e) { /* 忽略无法解析的块 */ }
      }
    });
    res.on('end', () => {
      if (terminated) return;
      if (thinkingActive) {
        thinkingActive = false;
        onEvent({ type: 'think-done', seconds: ((Date.now() - startTime) / 1000).toFixed(1) });
      }
      terminate({ type: 'end' });
    });
  });

  req.on('error', e => {
    if (e.name === 'AbortError') {
      terminate({ type: 'error', message: '已取消' });
    } else {
      terminate({ type: 'error', message: `网络错误: ${e.message}` });
    }
  });
  // socket 空闲计时（有数据流动自动重置）：大图总结服务端处理较慢，放宽到 180s
  req.setTimeout(180000, () => { req.destroy(new Error('请求超时 (180s)')); });
  req.write(body);
  req.end();
}

// ── 窗口管理 ─────────────────────────────────────────────
let mainWindow = null;
let databaseClient = null;
let documentLibrary = null;
let documentTokens = null;
let libraryIpc = null;
let isClosingDatabase = false;
async function initializeCoreServices() {
  const userDataPath = app.getPath('userData');
  fs.mkdirSync(userDataPath, { recursive: true });
  configStore = new ConfigStore({
    configPath: getConfigPath(),
    credentialsPath: path.join(userDataPath, 'credentials.bin'),
    encryption: safeStorage,
    normalize: normalizeConfig,
  });
  if (fs.existsSync(getConfigPath())) configStore.migrateLegacy();
  databaseClient = new DatabaseClient(path.join(userDataPath, 'library.sqlite'), { appVersion: app.getVersion() });
  await databaseClient.start();
  documentLibrary = new DocumentLibraryService({ db: databaseClient, userDataPath });
  await documentLibrary.init();
  documentTokens = new DocumentTokenStore();
  const mainSession = electronSession.fromPartition(runtimePaths.partition);
  registerAppProtocol({
    session: mainSession,
    rendererRoot: path.join(__dirname, 'renderer'),
    tokens: documentTokens,
    sessionPartition: runtimePaths.partition,
  });
  libraryIpc = registerLibraryIpc({
    ipcMain,
    dialog,
    getMainWindow: () => mainWindow,
    library: documentLibrary,
    db: databaseClient,
    tokens: documentTokens,
    sessionPartition: runtimePaths.partition,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepShui Translator 3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      partition: runtimePaths.partition,
      webSecurity: true,
    },
  });

  mainWindow.loadURL('app://local/index.html');
  mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
    console.error(`页面加载失败 (${code}): ${description}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('渲染进程异常退出:', details);
    if (documentTokens) documentTokens.revokeFor(mainWindow.webContents.id);
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame && documentTokens) documentTokens.revokeFor(mainWindow.webContents.id);
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  const webContentsId = mainWindow.webContents.id;
  mainWindow.on('closed', () => {
    if (documentTokens) documentTokens.revokeFor(webContentsId);
    mainWindow = null;
  });
}

// ── 菜单 ─────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开 PDF...',
          accelerator: 'CmdOrCtrl+O',
          click: () => openPdfDialog(),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '重置缩放' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openPdfDialog() {
  if (!libraryIpc) throw new Error('资料库尚未初始化');
  const document = await libraryIpc.importFromMenu('reference');
  if (document && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('open-pdf', { documentId: document.document_id });
  }
  return document;
}

// ── IPC 处理 ─────────────────────────────────────────────
ipcMain.handle('translate', async (event, { text, from, to, engine }) => {
  libraryIpc.assertTrusted(event);
  const cfg = loadConfig();
  const eng = engine || cfg.engine || 'youdao';
  try {
    const result = await translateWith(eng, text, from, to, cfg);
    // 业务错误（凭证缺失/错误码）不重试，直接返回
    if (!result.ok) return { ...result, engine: eng };
    return { ...result, engine: eng };
  } catch (e) {
    // 网络异常/超时：重试 1 次
    try {
      const retry = await translateWith(eng, text, from, to, cfg);
      return { ...retry, engine: eng };
    } catch (e2) {
      return { ok: false, error: e2.message, engine: eng };
    }
  }
});

ipcMain.handle('open-pdf-dialog', async (event) => {
  libraryIpc.assertTrusted(event);
  return openPdfDialog();
});

ipcMain.handle('get-config', async (event) => {
  libraryIpc.assertTrusted(event);
  return loadConfig();
});

ipcMain.handle('save-config', async (event, cfg) => {
  libraryIpc.assertTrusted(event);
  return saveConfig(cfg);
});

// ── AI 引擎 IPC ──────────────────────────────────────────
// 进行中的流式请求表: requestId -> AbortController
const aiAborters = new Map();
const reflowAiAborters = new Map();

function collectAiContent(options) {
  return new Promise((resolve, reject) => {
    let content = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    aiChatStream({
      ...options,
      onEvent: (event) => {
        if (event.type === 'content') content += event.text || '';
        if (event.type === 'error') finish(reject, new Error(event.message || 'AI 请求失败'));
        if (event.type === 'done' || event.type === 'end') finish(resolve, content);
      },
    });
  });
}

// 拉取 AI 提供商可用模型列表 + 自动多模态检测
// key 优先用渲染层传入的，其次配置的 providerKeys
ipcMain.handle('ai-models', async (event, { provider, apiKey } = {}) => {
  libraryIpc.assertTrusted(event);
  const cfg = loadConfig();
  const prov = provider || cfg.ai.provider || 'deepseek';
  const key = apiKey || cfg.ai.providerKeys?.[prov] || cfg.ai.apiKey;
  if (!key) return { ok: false, error: '未配置 API Key，请到 设置 → AI 引擎 填写' };
  try {
    const providerCfg = getAiProvider(prov);
    const list = await fetchAiModels(providerCfg, key);
    if (!list.ok) return list;

    // 过滤停服模型（Shutdown 实测全灭直接排除；Retiring 实测可能仍可用，保留并交给探测兜底）
    let candidates = list.models.filter(m => m.status !== 'Shutdown');
    // 记录 Retiring 模型，渲染层标注 ⚠️Retiring
    const retiringSet = new Set(candidates.filter(m => m.status === 'Retiring').map(m => m.id));
    // 过滤非对话模型（豆包/千问的列表会混入视频/图像/3D/向量/语音模型）：
    // 1) output_modalities 存在且不含 text → 非对话
    // 2) 名称含已知非对话类型 → 非对话
    const NON_CHAT_PATTERN = /seedance|seedream|embedding|hyper3d|hitem3d|seed3d|3d-gen|rerank|(^|[-_])(image|tts|asr|audio|ocr)([-_.]|$)/i;
    candidates = candidates.filter(m => {
      if (Array.isArray(m.out) && m.out.length && !m.out.includes('text')) return false;
      if (NON_CHAT_PATTERN.test(m.id)) return false;
      return true;
    });
    const ids = candidates.map(m => m.id);

    const sender = event.sender;
    // 阶段1: 文本探测——列表含未开通/无权限模型（实测: 豆包 23 个候选仅 1 个已开通，
    // 千问也有大量未开通返回 400/403），只保留真正能对话的
    const chatResults = await probeModelsBatch(providerCfg, key, ids, false, (done, total) => {
      if (!sender.isDestroyed()) sender.send('ai-models-progress', { phase: 'chat', done, total });
    });
    const chatOkIds = chatResults.filter(r => r.ok).map(r => r.id);
    if (chatOkIds.length === 0) {
      return { ok: false, error: '没有可对话的模型（模型可能未在控制台开通，或 API Key 无权限）' };
    }
    // 阶段2: 图像探测——在可对话模型中标注多模态
    const mmResults = await probeModelsBatch(providerCfg, key, chatOkIds, true, (done, total) => {
      if (!sender.isDestroyed()) sender.send('ai-models-progress', { phase: 'multimodal', done, total });
    });
    // 按字典序返回（不区分大小写）
    const models = mmResults
      .map(r => ({ id: r.id, multimodal: r.ok, retiring: retiringSet.has(r.id) }))
      .sort((a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
    return { ok: true, models };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 发起流式 AI 对话（解释/问答通用），事件通过 webContents.send('ai-event') 推送
ipcMain.handle('ai-chat', async (event, { requestId, messages, kind }) => {
  libraryIpc.assertTrusted(event);
  const cfg = loadConfig();
  const ai = cfg.ai;
  const prov = ai.provider || 'deepseek';
  const apiKey = ai.providerKeys?.[prov] || ai.apiKey;
  if (!apiKey) return { ok: false, error: '未配置 API Key，请到 设置 → AI 引擎 填写' };
  if (!ai.model) return { ok: false, error: '未选择模型，请到 设置 → AI 引擎 拉取并选择模型' };

  const sender = event.sender;
  const ac = new AbortController();
  aiAborters.set(requestId, ac);

  const emit = (evt) => {
    if (!sender.isDestroyed()) sender.send('ai-event', { requestId, kind, ...evt });
  };

  aiChatStream({
    provider: getAiProvider(prov),
    apiKey,
    model: ai.model,
    messages,
    deepThink: ai.deepThink || 'high',
    signal: ac.signal,
    onEvent: emit,
  });

  // 请求结束时清理
  const cleanup = () => aiAborters.delete(requestId);
  ac.signal.addEventListener('abort', cleanup, { once: true });
  setTimeout(cleanup, 90000); // 兜底清理

  return { ok: true, requestId };
});

// 取消进行中的 AI 请求
ipcMain.handle('ai-cancel', async (event, requestId) => {
  libraryIpc.assertTrusted(event);
  const ac = aiAborters.get(requestId);
  if (ac) ac.abort();
  return true;
});

// ── 启动 ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    await initializeCoreServices();
  } catch (error) {
    console.error('资料库初始化失败:', error);
    dialog.showErrorBox('资料库初始化失败', error.message || String(error));
    app.quit();
    return;
  }
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// M2b：仅从本地排版缓存读取文本和页码，AI 只能返回结构建议，绝不接收 PDF/图片。
ipcMain.handle('reflow:ai-enhance', async (event, payload) => {
  libraryIpc.assertTrusted(event);
  const documentId = String(payload && payload.documentId || '');
  const generation = Number(payload && payload.generation);
  const requestId = String(payload && payload.requestId || '');
  if (!documentId || !Number.isSafeInteger(generation) || generation < 1 || !/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) {
    throw new Error('AI 排版请求无效');
  }
  if (reflowAiAborters.has(requestId)) throw new Error('AI 排版请求已在进行中');
  await databaseClient.call('validateDocumentGeneration', { documentId, generation });
  const reflow = await databaseClient.call('getReflowDocument', { documentId });
  if (reflow.state !== 'ready' || !reflow.blocks.length) throw new Error('请先完成本地智能排版');
  const cfg = loadConfig();
  const ai = cfg.ai || {};
  const provider = ai.provider || 'deepseek';
  const apiKey = ai.providerKeys?.[provider] || ai.apiKey;
  if (!apiKey) throw new Error('未配置 API Key，请到 设置 → AI 引擎 填写');
  if (!ai.model) throw new Error('未选择模型，请到 设置 → AI 引擎 拉取并选择模型');
  const request = buildReflowAiMessages(reflow.blocks);
  const controller = new AbortController();
  reflowAiAborters.set(requestId, controller);
  try {
    const raw = await collectAiContent({
      provider: getAiProvider(provider),
      apiKey,
      model: ai.model,
      messages: request.messages,
      deepThink: 'off',
      signal: controller.signal,
    });
    await databaseClient.call('validateDocumentGeneration', { documentId, generation });
    const parsed = parseReflowAiResponse(raw, request.selectedBlockIndexes);
    return {
      suggestions: parsed.suggestions,
      reviewedBlockCount: request.reviewedBlockCount,
      disclosure: '仅发送本地提取的文字与页码结构；未发送 PDF、页面图像或文件路径。',
    };
  } finally {
    reflowAiAborters.delete(requestId);
  }
});

ipcMain.handle('reflow:ai-cancel', async (event, requestId) => {
  libraryIpc.assertTrusted(event);
  const controller = reflowAiAborters.get(String(requestId || ''));
  if (controller) controller.abort();
  return true;
});

ipcMain.handle('runtime:get-status', async (event) => {
  libraryIpc.assertTrusted(event);
  return {
    version: app.getVersion(),
    compatibilityMode,
    sandboxed: !compatibilityMode,
    userData: runtimePaths.userData,
  };
});

app.on('before-quit', (event) => {
  if (!databaseClient || isClosingDatabase) return;
  event.preventDefault();
  isClosingDatabase = true;
  databaseClient.close().finally(() => app.quit());
});
