import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { replay } from '../shared/game-core.js';

parentPort.on('message', ({ id, snapshot, inputs }) => {
  const started = performance.now();
  try {
    const result = replay(snapshot, new Uint8Array(inputs));
    parentPort.postMessage({ id, ok: true, snapshot: result, elapsedMs: performance.now() - started });
  } catch {
    parentPort.postMessage({ id, ok: false, code: 'invalid_input' });
  }
});
parentPort.postMessage({ ready: true });
