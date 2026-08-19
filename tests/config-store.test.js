'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore } = require('../main/services/config-store');

const fakeEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
};

function normalize(config = {}) {
  return {
    engine: config.engine || 'youdao',
    youdao: { appKey: '', appSecret: '', ...(config.youdao || {}) },
    baidu: { appid: '', secretKey: '', ...(config.baidu || {}) },
    xunfei: { appid: '', apiKey: '', apiSecret: '', ...(config.xunfei || {}) },
    deepl: { apiKey: '', ...(config.deepl || {}) },
    google: { apiKey: '', ...(config.google || {}) },
    ai: { provider: 'deepseek', providerKeys: {}, ...(config.ai || {}) },
  };
}

test('配置文件不落明文凭证，读取时透明恢复', async (t) => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepshui-config-'));
  t.after(() => fsp.rm(tempDir, { recursive: true, force: true }));
  const configPath = path.join(tempDir, 'config.json');
  const credentialsPath = path.join(tempDir, 'credentials.bin');
  const store = new ConfigStore({ configPath, credentialsPath, encryption: fakeEncryption, normalize });

  store.save({
    engine: 'youdao',
    youdao: { appKey: 'visible-id', appSecret: 'top-secret' },
    ai: { provider: 'deepseek', providerKeys: { deepseek: 'ai-secret' } },
  });
  const publicText = fs.readFileSync(configPath, 'utf8');
  assert.doesNotMatch(publicText, /top-secret|ai-secret|visible-id/);
  assert.match(fs.readFileSync(credentialsPath, 'utf8'), /^encrypted:/);
  const loaded = store.load();
  assert.equal(loaded.youdao.appSecret, 'top-secret');
  assert.equal(loaded.ai.providerKeys.deepseek, 'ai-secret');

  store.save({ ...loaded, youdao: { ...loaded.youdao, appSecret: 'rotated-secret' } });
  assert.equal(store.load().youdao.appSecret, 'rotated-secret');
  assert.doesNotMatch(fs.readFileSync(configPath, 'utf8'), /rotated-secret/);
});
