import { createHmac, randomUUID } from 'node:crypto';
import { ApiError, unavailable } from './errors.js';

export const GATEWAY_DOMAIN = 'flappy-fish-gateway-v1';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

async function limitedText(response) {
  const length = Number(response.headers?.get('content-length'));
  if (length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw unavailable();
  }
  if (!response.body) {
    // Supports simple injected test transports. Native fetch uses the bounded stream below.
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw unavailable();
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw unavailable(); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

export function gatewaySignature(key, { action, requestId, timestamp, content }) {
  return createHmac('sha256', key).update(`${GATEWAY_DOMAIN}\n${action}\n${requestId}\n${timestamp}\n${content}`).digest('hex');
}

export function validGatewayUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'script.google.com' && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export class AppsScriptGateway {
  constructor({ url, key, fetchImpl = fetch, now = Date.now, timeoutMs = 10000 }) {
    if (!validGatewayUrl(url)) throw new Error('Invalid APPS_SCRIPT_URL; expected an HTTPS Apps Script /exec deployment.');
    this.url = url;
    this.key = key;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  async call(action, payload, requestId = randomUUID()) {
    const envelope = { version: 1, action, requestId, timestamp: this.now(), content: JSON.stringify(payload) };
    envelope.signature = gatewaySignature(this.key, envelope);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(envelope), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow',
      });
      if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
      const raw = await limitedText(response);
      const result = JSON.parse(raw);
      if (result.ok !== true) {
        const error = result.error;
        if (!error || !Number.isInteger(error.status) || error.status < 400 || error.status > 599 || !/^[a-z_]+$/.test(error.code)) throw unavailable();
        throw new ApiError(error.status, error.code, error.message || 'Запрос отклонён хранилищем.', error.details);
      }
      return result.data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Never include the endpoint, envelope, nickname, cookie, or secret in logs/errors.
      throw unavailable();
    }
  }

  async ping() { return true; }

  async close() {}
}
