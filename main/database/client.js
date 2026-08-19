'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { randomUUID } = require('crypto');

class DatabaseClient {
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.timeoutMs = options.timeoutMs || 15000;
    this.worker = null;
    this.pending = new Map();
    this.closed = false;
    this.appVersion = options.appVersion || 'unknown';
  }

  async start() {
    if (this.worker) return this.call('init');
    this.closed = false;
    this.worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { dbPath: this.dbPath, appVersion: this.appVersion },
    });
    this.worker.on('message', (message) => this.handleMessage(message));
    this.worker.on('error', (error) => this.handleFailure(error));
    this.worker.on('exit', (code) => {
      const wasClosing = this.closed;
      this.worker = null;
      if (!wasClosing && code !== 0) this.handleFailure(new Error(`数据库 Worker 异常退出: ${code}`));
    });
    return this.call('init');
  }

  handleMessage(message) {
    const entry = this.pending.get(message.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.requestId);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || '数据库请求失败'));
  }

  handleFailure(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  call(method, payload = {}, timeoutMs = this.timeoutMs) {
    if (!this.worker) return Promise.reject(new Error('数据库 Worker 未启动'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`数据库请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer, method });
      this.worker.postMessage({ requestId, method, payload });
    });
  }

  async close() {
    if (!this.worker) return;
    this.closed = true;
    try { await this.call('close', {}, 5000); } catch {}
    const worker = this.worker;
    this.worker = null;
    await worker.terminate();
    this.handleFailure(new Error('数据库已关闭'));
  }
}

module.exports = { DatabaseClient };
