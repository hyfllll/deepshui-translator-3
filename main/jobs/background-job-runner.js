'use strict';

const crypto = require('node:crypto');

class BackgroundJobRunner {
  constructor({ db, workerId = `worker-${crypto.randomUUID()}`, leaseMs = 30_000, pollMs = 1_000 }) {
    this.db = db;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.pollMs = pollMs;
    this.handlers = new Map();
    this.timer = null;
    this.running = false;
  }

  register(type, handler) {
    if (!type || typeof handler !== 'function') throw new Error('任务处理器无效');
    this.handlers.set(type, handler);
    return this;
  }

  async enqueue({ idempotencyKey, type, documentId = null, pageIndex = null, inputVersion, priority = 100, maxAttempts = 3, checkpoint = null }) {
    if (!idempotencyKey || !this.handlers.has(type)) throw new Error('任务类型或幂等键无效');
    return this.db.call('enqueueJob', {
      jobId: crypto.randomUUID(), idempotencyKey, type, documentId, pageIndex,
      inputVersion, priority, maxAttempts, checkpoint,
    });
  }

  async runOnce() {
    if (this.running || !this.handlers.size) return null;
    this.running = true;
    let job = null;
    try {
      job = await this.db.call('leaseNextJob', {
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        types: [...this.handlers.keys()],
      });
      if (!job) return null;
      const handler = this.handlers.get(job.type);
      const context = {
        job,
        heartbeat: () => this.db.call('heartbeatJob', {
          jobId: job.job_id, workerId: this.workerId, leaseMs: this.leaseMs,
        }),
        checkpoint: (checkpoint) => this.db.call('checkpointJob', {
          jobId: job.job_id, workerId: this.workerId, checkpoint,
        }),
        isCancelled: async () => {
          const latest = await this.db.call('getJob', { jobId: job.job_id });
          return !latest || latest.cancel_requested === 1 || latest.state === 'cancelled';
        },
      };
      const result = await handler(context);
      const completed = await this.db.call('completeJob', {
        jobId: job.job_id, workerId: this.workerId, result,
      });
      if (!completed.accepted) {
        await this.db.call('failJob', {
          jobId: job.job_id, workerId: this.workerId, errorCode: 'CANCELLED_OR_LEASE_LOST',
        });
      }
      return this.db.call('getJob', { jobId: job.job_id });
    } catch (error) {
      if (job) {
        await this.db.call('failJob', {
          jobId: job.job_id,
          workerId: this.workerId,
          errorCode: String(error.code || 'JOB_HANDLER_FAILED'),
        }).catch(() => {});
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      try { await this.runOnce(); } catch (error) { console.error('后台任务失败:', error.message); }
      if (this.timer) this.timer = setTimeout(tick, this.pollMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { BackgroundJobRunner };
