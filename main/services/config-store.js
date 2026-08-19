'use strict';

const fs = require('fs');
const path = require('path');

const ENGINE_SECRET_FIELDS = {
  youdao: ['appKey', 'appSecret'],
  baidu: ['appid', 'secretKey'],
  xunfei: ['appid', 'apiKey', 'apiSecret'],
  deepl: ['apiKey'],
  google: ['apiKey'],
};

function readJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeAtomic(filePath, data, options = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, data, options);
  fs.renameSync(tempPath, filePath);
}

function extractSecrets(config) {
  const secrets = { engines: {}, providerKeys: {} };
  for (const [engine, fields] of Object.entries(ENGINE_SECRET_FIELDS)) {
    secrets.engines[engine] = {};
    for (const field of fields) secrets.engines[engine][field] = String(config[engine]?.[field] || '');
  }
  secrets.providerKeys = { ...(config.ai?.providerKeys || {}) };
  if (config.ai?.apiKey && !secrets.providerKeys.deepseek) secrets.providerKeys.deepseek = config.ai.apiKey;
  return secrets;
}

function redactSecrets(config) {
  const publicConfig = JSON.parse(JSON.stringify(config));
  for (const [engine, fields] of Object.entries(ENGINE_SECRET_FIELDS)) {
    publicConfig[engine] ||= {};
    for (const field of fields) delete publicConfig[engine][field];
  }
  if (publicConfig.ai) {
    delete publicConfig.ai.providerKeys;
    delete publicConfig.ai.apiKey;
  }
  return publicConfig;
}

function mergeSecrets(config, secrets) {
  const merged = JSON.parse(JSON.stringify(config || {}));
  for (const [engine, values] of Object.entries(secrets?.engines || {})) {
    merged[engine] = { ...(merged[engine] || {}), ...values };
  }
  merged.ai = { ...(merged.ai || {}), providerKeys: { ...(secrets?.providerKeys || {}) } };
  return merged;
}

class ConfigStore {
  constructor({ configPath, credentialsPath, encryption, normalize }) {
    this.configPath = configPath;
    this.credentialsPath = credentialsPath;
    this.encryption = encryption;
    this.normalize = normalize;
  }

  encryptionAvailable() {
    return !!this.encryption?.isEncryptionAvailable?.();
  }

  readEncryptedSecrets() {
    if (!fs.existsSync(this.credentialsPath) || !this.encryptionAvailable()) return null;
    try {
      const encrypted = fs.readFileSync(this.credentialsPath);
      return JSON.parse(this.encryption.decryptString(encrypted));
    } catch (error) {
      throw new Error(`本机凭证解密失败：${error.message}`);
    }
  }

  load() {
    const raw = readJson(this.configPath, {});
    const encryptedSecrets = this.readEncryptedSecrets();
    return this.normalize(encryptedSecrets ? mergeSecrets(raw, encryptedSecrets) : raw);
  }

  save(input) {
    const config = this.normalize(input || {});
    if (!this.encryptionAvailable()) throw new Error('Windows 安全存储当前不可用，未保存 API 凭证');
    const encrypted = this.encryption.encryptString(JSON.stringify(extractSecrets(config)));
    writeAtomic(this.credentialsPath, encrypted, { mode: 0o600 });
    writeAtomic(this.configPath, JSON.stringify(redactSecrets(config), null, 2), { mode: 0o600 });
    return this.load();
  }

  migrateLegacy() {
    if (!fs.existsSync(this.configPath) || fs.existsSync(this.credentialsPath)) return this.load();
    return this.save(this.normalize(readJson(this.configPath, {})));
  }
}

module.exports = {
  ConfigStore,
  extractSecrets,
  redactSecrets,
  mergeSecrets,
};
