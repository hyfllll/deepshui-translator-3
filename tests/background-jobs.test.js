'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseClient } = require('../main/database/client');
const { BackgroundJobRunner } = require('../main/jobs/background-job-runner');

test('后台任务支持幂等、租约、重试、checkpoint 和取消', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepshui-jobs-'));
  const client = new DatabaseClient(path.join(tempDir, 'library.sqlite'), { appVersion: 'test' });
  t.after(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  await client.start();
  let attempts = 0;
  const runner = new BackgroundJobRunner({ db: client, workerId: 'test-worker', leaseMs: 5_000 });
  runner.register('fixture', async ({ checkpoint, isCancelled }) => {
    attempts += 1;
    assert.equal(await isCancelled(), false);
    await checkpoint({ stage: attempts });
    if (attempts === 1) throw Object.assign(new Error('retry'), { code: 'TRANSIENT' });
    return { ok: true };
  });
  const first = await runner.enqueue({ idempotencyKey: 'same-input', type: 'fixture', inputVersion: 'v1', priority: 10 });
  const duplicate = await runner.enqueue({ idempotencyKey: 'same-input', type: 'fixture', inputVersion: 'v1', priority: 10 });
  assert.equal(duplicate.job_id, first.job_id);
  await assert.rejects(() => runner.runOnce(), /retry/);
  assert.equal((await client.call('getJob', { jobId: first.job_id })).state, 'queued');
  const completed = await runner.runOnce();
  assert.equal(completed.state, 'completed');
  assert.equal(JSON.parse(completed.checkpoint_json).ok, true);

  const cancelled = await runner.enqueue({ idempotencyKey: 'cancel-me', type: 'fixture', inputVersion: 'v1' });
  const cancellation = await client.call('requestJobCancel', { jobId: cancelled.job_id });
  assert.equal(cancellation.state, 'cancelled');
  assert.equal(await runner.runOnce(), null);
});
