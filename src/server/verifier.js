import { Worker } from 'node:worker_threads';
import { ApiError } from './errors.js';

export class ReplayVerifier {
  constructor({ workers = 2, queueLimit = 10, budgetMs = 250, workerUrl = new URL('./replay-worker.js', import.meta.url) } = {}) {
    this.queueLimit = queueLimit;
    this.budgetMs = budgetMs;
    this.workerUrl = workerUrl;
    this.closed = false;
    this.jobs = [];
    this.nextId = 0;
    this.slots = Array.from({ length: workers }, () => ({ worker: null, ready: false, job: null, timer: null }));
    for (const slot of this.slots) this.spawn(slot);
  }

  spawn(slot) {
    if (this.closed) return;
    // Workers execute a fixed module, not the parent's CLI entry point. In
    // particular, inherited --input-type/--eval flags break embedded servers.
    const worker = new Worker(this.workerUrl, { execArgv: [] });
    slot.worker = worker;
    slot.ready = false;
    const startupTimer = setTimeout(() => this.fail(slot, 'verifier_unavailable'), 5000);
    startupTimer.unref();
    worker.on('message', message => {
      if (slot.worker !== worker || this.closed) return;
      if (message.ready) {
        clearTimeout(startupTimer);
        slot.ready = true;
        worker.unref();
        this.drain();
        return;
      }
      const job = slot.job;
      if (!job || job.id !== message.id) return;
      clearTimeout(slot.timer);
      slot.job = null;
      worker.unref();
      if (!message.ok) job.reject(new ApiError(400, 'invalid_input', 'Блок действий не прошёл проверку.'));
      else if (message.elapsedMs > this.budgetMs) job.reject(new ApiError(503, 'verification_timeout', 'Проверка превысила допустимое время. Повторите запрос.'));
      else job.resolve(message.snapshot);
      this.drain();
    });
    worker.on('error', () => { clearTimeout(startupTimer); if (slot.worker === worker) this.fail(slot, 'verifier_unavailable'); });
    worker.on('exit', () => { clearTimeout(startupTimer); if (!this.closed && slot.worker === worker) this.fail(slot, 'verifier_unavailable'); });
  }

  fail(slot, code) {
    if (this.closed) return;
    clearTimeout(slot.timer);
    const worker = slot.worker;
    slot.worker = null;
    slot.ready = false;
    if (slot.job) {
      slot.job.reject(new ApiError(503, code, 'Проверка временно недоступна. Повторите запрос.'));
      slot.job = null;
    }
    for (const job of this.jobs.splice(0)) job.reject(new ApiError(503, code, 'Проверка временно недоступна. Повторите запрос.'));
    if (worker) void worker.terminate();
    // A later request restarts failed slots; avoid an unbounded respawn loop.
  }

  verify(snapshot, inputs) {
    if (this.closed) return Promise.reject(new ApiError(503, 'verifier_unavailable', 'Проверка остановлена.'));
    const capacity = this.slots.length + this.queueLimit;
    const pending = this.jobs.length + this.slots.filter(slot => slot.job).length;
    if (pending >= capacity) return Promise.reject(new ApiError(503, 'verification_busy', 'Очередь проверки заполнена. Повторите запрос.'));
    for (const slot of this.slots) if (!slot.worker) this.spawn(slot);
    return new Promise((resolve, reject) => {
      this.jobs.push({ id: ++this.nextId, snapshot, inputs, resolve, reject });
      this.drain();
    });
  }

  drain() {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (!this.jobs.length) return;
      if (!slot.ready || slot.job) continue;
      const job = this.jobs.shift();
      slot.job = job;
      slot.worker.ref();
      slot.timer = setTimeout(() => this.fail(slot, 'verification_timeout'), this.budgetMs);
      slot.worker.postMessage({ id: job.id, snapshot: job.snapshot, inputs: job.inputs });
    }
  }

  async close() {
    this.closed = true;
    const error = new ApiError(503, 'verifier_unavailable', 'Проверка остановлена.');
    for (const job of this.jobs.splice(0)) job.reject(error);
    await Promise.all(this.slots.map(async slot => {
      clearTimeout(slot.timer);
      slot.job?.reject(error);
      if (slot.worker) await slot.worker.terminate();
    }));
  }
}
