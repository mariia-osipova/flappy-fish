import { RULES_VERSION, MAX_BLOCK_TICKS, TICK_RATE, replay, step } from "../shared/game-core.js";

export const MAX_BUFFER_TICKS = TICK_RATE * 30;
const clone = (value) => structuredClone(value);
const terminal = (receipt) => receipt?.status === "completed";

export class RankedError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "RankedError";
    this.code = code;
    this.status = status;
  }
}

export function encodeInputs(inputs) {
  let bytes = "";
  for (const input of inputs) bytes += String.fromCharCode(input);
  return btoa(bytes);
}

export class IndexedGameStore {
  constructor(indexedDB = globalThis.indexedDB, lockManager = globalThis.navigator?.locks) {
    this.indexedDB = indexedDB;
    this.lockManager = lockManager;
    this.database = null;
    this.opening = null;
    this.releaseLock = null;
  }

  async open() {
    if (this.database) return this.database;
    if (this.opening) return this.opening;
    this.opening = this.openExclusive().finally(() => { this.opening = null; });
    return this.opening;
  }

  async openExclusive() {
    if (!this.indexedDB) throw new RankedError("local_storage", "Ranked play requires browser storage. Practice is still available.");
    if (!this.lockManager) throw new RankedError("local_storage", "This browser cannot safely coordinate ranked games between tabs. Practice is still available.");
    if (!this.releaseLock) {
      await new Promise((resolve, reject) => {
        this.lockManager.request("flappy-fish-ranked-owner", { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (!lock) {
            reject(new RankedError("other_tab", "A ranked game is open in another tab. Close that tab or choose practice here."));
            return;
          }
          await new Promise((release) => { this.releaseLock = release; resolve(); });
        }).catch(reject);
      });
    }
    this.database = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open("flappy-fish-ranked", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("games");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close other Flappy Fish tabs to open game storage."));
    });
    return this.database;
  }

  close() {
    this.database?.close();
    this.database = null;
    this.releaseLock?.();
    this.releaseLock = null;
  }

  async load() {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const request = database.transaction("games", "readonly").objectStore("games").get("current");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async save(value) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("games", "readwrite");
      transaction.objectStore("games").put(value, "current");
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error || new Error("Game storage failed."));
    });
  }
}

// The outbox is saved before a request is sent. Its acknowledgement and removal
// share one IndexedDB transaction, so a lost response can safely be reconciled.
export class RankedClient {
  constructor({ store = new IndexedGameStore(), fetcher = globalThis.fetch.bind(globalThis),
    requestId = () => crypto.randomUUID(), onChange = () => {}, now = () => Date.now(),
    retryDelay = 2500, automaticRetry = true } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.requestId = requestId;
    this.onChange = onChange;
    this.now = now;
    this.retryDelay = retryDelay;
    this.automaticRetry = automaticRetry;
    this.record = null;
    this.snapshot = null;
    this.running = false;
    this.status = "idle";
    this.error = null;
    this.saving = Promise.resolve();
    this.writer = null;
    this.pendingWrite = null;
    this.writeGeneration = 0;
    this.writeWaiters = [];
    this.pumping = null;
    this.retryTimer = null;
    this.persistScheduled = false;
    this.initialized = false;
    this.initializing = null;
    this.closed = false;
    this.controllers = new Set();
    this.lastSessionRefresh = 0;
    this.sessionTimer = null;
  }

  get bufferedTicks() {
    return (this.record?.pending.length || 0) + (this.record?.queue.reduce((sum, block) => sum + block.inputs.length, 0) || 0);
  }

  get receipt() { return this.record?.receipt || null; }
  get unfinished() { return Boolean(this.record && (!terminal(this.receipt) || this.record.queue.length)); }

  leaseExpired() {
    return this.receipt?.leaseExpired ?? (this.receipt?.leaseUntil <= this.now());
  }

  emit(status = this.status, error = null) {
    this.status = status;
    this.error = error;
    this.onChange({ status, error, running: this.running, receipt: this.receipt,
      name: this.record?.name, bufferedTicks: this.bufferedTicks, snapshot: this.snapshot });
  }

  async request(path, body) {
    if (this.closed) throw new RankedError("closed", "This game tab has been closed.");
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.fetcher(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      const data = await response.json();
      if (this.closed) throw new RankedError("closed", "This game tab has been closed.");
      if (!response.ok) {
        const error = new RankedError(data.error?.code || "request_failed", data.error?.message || "Ranked server is unavailable.", response.status);
        error.details = data.error?.details || data.details;
        throw error;
      }
      return data;
    } catch (error) {
      if (error instanceof RankedError) throw error;
      throw new RankedError("network", "Connection lost. Results have not been confirmed.");
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  persist() {
    return this.enqueueWrite(true);
  }

  enqueueWrite(barrier) {
    const generation = ++this.writeGeneration;
    // At most one write is in flight and one newer snapshot is retained. A
    // newer record contains all preceding outbox mutations, so it can satisfy
    // an earlier durability barrier without writing every rendered frame.
    this.pendingWrite = { generation, value: clone(this.record) };
    let promise;
    if (barrier) promise = new Promise((resolve, reject) => this.writeWaiters.push({ generation, resolve, reject }));
    this.startWriter();
    return promise;
  }

  startWriter() {
    if (this.writer || !this.pendingWrite) return;
    this.writer = this.writeLatest().finally(() => {
      this.writer = null;
      this.startWriter();
    });
    this.saving = this.writer;
  }

  async writeLatest() {
    try {
      while (this.pendingWrite) {
        const write = this.pendingWrite;
        this.pendingWrite = null;
        await this.store.save(write.value);
        const complete = this.writeWaiters.filter((waiter) => waiter.generation <= write.generation);
        this.writeWaiters = this.writeWaiters.filter((waiter) => waiter.generation > write.generation);
        for (const waiter of complete) waiter.resolve();
      }
    } catch {
      const error = new RankedError("local_storage", "Browser recovery storage failed. Ranked play is paused; keep this tab open and retry.");
      this.pendingWrite = null;
      const waiters = this.writeWaiters.splice(0);
      for (const waiter of waiters) waiter.reject(error);
      this.running = false;
      if (!this.closed) this.emit("storage_error", error);
    }
  }

  schedulePersist() {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      if (this.closed) return;
      this.enqueueWrite(false);
    });
  }

  checkReceipt(receipt) {
    if (!receipt?.checkpoint?.snapshot || !receipt.checkpointToken || receipt.rulesVersion !== RULES_VERSION) {
      throw new RankedError("rules_version", "This game uses different rules. Reload the page before continuing.");
    }
    return receipt;
  }

  rebuildSnapshot() {
    if (!this.receipt) return;
    let snapshot = clone(this.receipt.checkpoint.snapshot);
    for (const block of this.record.queue) {
      if (block.inputs.length) snapshot = replay(snapshot, Uint8Array.from(block.inputs));
    }
    if (this.record.pending.length) snapshot = replay(snapshot, Uint8Array.from(this.record.pending));
    this.snapshot = snapshot;
  }

  async initialize() {
    if (this.initialized) return this.record;
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeOnce().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async initializeOnce() {
    this.emit("connecting");
    try {
      this.record = await this.store.load();
      if (this.record && (this.record.version !== 1 || !Array.isArray(this.record.queue) || !Array.isArray(this.record.pending))) {
        throw new RankedError("local_storage", "Stored game cannot be read. Practice remains available.");
      }
      if (terminal(this.receipt) && !this.record.queue.length && !this.record.pending.length) {
        // The outbox is only needed until the terminal receipt is durable.
        // Official history lives on the server, not in an old browser cookie.
        this.record = null;
        this.snapshot = null;
        await this.persist();
      }
      if (this.receipt) {
        this.checkReceipt(this.receipt);
        // Do not replace a lost/expired identity before checking whether it
        // still owns the durable game. A different cookie cannot recover it.
        await this.recover();
      }
      // The Node server issues the HttpOnly session cookie with index.html.
      // Avoid another hosted request here; start() renews and retries once if
      // an old page, an expired cookie, or browser policy left it unavailable.
      this.lastSessionRefresh = this.now();
      this.initialized = true;
      this.scheduleSessionRenewal();
      if (this.receipt) {
        this.rebuildSnapshot();
        if (!terminal(this.receipt) && (this.receipt.status !== "paused" || this.bufferedTicks)) {
          // Reloading never silently resumes a moving fish.
          this.flush(true);
          await this.persist();
          void this.pump();
        }
      }
      this.emit(terminal(this.receipt) ? "completed" : this.record ? "paused" : "idle");
      return this.record;
    } catch (error) {
      this.running = false;
      if (this.closed) this.store.close?.();
      this.emit("unavailable", error);
      throw error;
    }
  }

  async begin(body) {
    try {
      return await this.request("/api/games", body);
    } catch (error) {
      if (this.receipt || !["session_required", "session_expired"].includes(error.code)) throw error;
      await this.request("/api/session", {});
      this.lastSessionRefresh = this.now();
      return this.request("/api/games", body);
    }
  }

  async renewSession() {
    if (this.closed || this.now() - this.lastSessionRefresh < 24 * 60 * 60 * 1000) return;
    if (this.receipt && this.unfinished) {
      await this.request(`/api/games/${encodeURIComponent(this.receipt.gameId)}`);
    }
    await this.request("/api/session", {});
    this.lastSessionRefresh = this.now();
  }

  scheduleSessionRenewal() {
    if (!this.automaticRetry || this.sessionTimer || this.closed) return;
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      void this.renewSession().catch((error) => {
        if (error.status === 401 || error.status === 403) this.running = false;
        if (!this.closed) this.emit(this.running ? "reconnecting" : "paused", error);
      }).finally(() => this.scheduleSessionRenewal());
    }, 6 * 60 * 60 * 1000);
    this.sessionTimer.unref?.();
  }

  async start(name) {
    try {
      if (!this.initialized) await this.initialize();
      await this.renewSession();
      if (this.receipt && !terminal(this.receipt)) {
        throw new RankedError("existing_game", "A saved ranked game is available. Resume it or choose practice.");
      }
      this.emit("connecting");
      if (!this.record || this.receipt) {
        this.record = { version: 1, name, beginRequestId: this.requestId(), receipt: null, queue: [], pending: [], resume: null };
        await this.persist();
      }
      const receipt = this.checkReceipt(await this.begin({
        name: this.record.name, requestId: this.record.beginRequestId,
      }));
      this.record.receipt = receipt;
      await this.persist();
      this.rebuildSnapshot();
      if (!terminal(this.receipt) && (this.receipt.status === "paused" || this.leaseExpired())) {
        // A retried create can refer to a game whose original lease expired
        // while its response was lost. It must obtain a slot before playing.
        await this.reacquire();
      }
      this.running = this.receipt.status === "active";
      this.emit(this.running ? "active" : "paused");
      return this.snapshot;
    } catch (error) {
      this.running = false;
      if (error.code === "active_game_exists" && error.details?.gameId && !this.receipt) {
        const receipt = this.checkReceipt(await this.request(`/api/games/${encodeURIComponent(error.details.gameId)}`));
        this.record.receipt = receipt;
        this.record.name = receipt.name || this.record.name;
        this.rebuildSnapshot();
        this.flush(true);
        await this.persist();
        void this.pump();
        this.emit("paused");
        return this.snapshot;
      }
      this.emit(error.code === "ranked_full" ? "full" : "unavailable", error);
      throw error;
    }
  }

  advance(input) {
    if (!this.running || !this.snapshot || this.snapshot.dead) return null;
    if (this.bufferedTicks >= MAX_BUFFER_TICKS) {
      void this.pause("buffer_full");
      return null;
    }
    step(this.snapshot, input);
    this.record.pending.push(input);
    if (this.record.pending.length === MAX_BLOCK_TICKS) this.flush(false);
    if (this.snapshot.dead) {
      this.running = false;
      this.flush(false);
      this.emit("saving");
    } else if (this.bufferedTicks >= MAX_BUFFER_TICKS) {
      this.running = false;
      this.flush(true);
      this.emit("buffer_full");
    }
    this.schedulePersist();
    if (this.record.queue.length) void this.pump();
    return this.snapshot;
  }

  flush(pause) {
    if (!this.receipt || terminal(this.receipt)) return;
    if (this.snapshot?.dead) pause = false;
    if (pause && this.receipt.status === "paused" && !this.record.pending.length && !this.record.queue.length) return;
    if (!this.record.pending.length && !pause) return;
    const tail = this.record.queue.at(-1);
    if (pause && !this.record.pending.length && tail?.pause) return;
    this.record.queue.push({ requestId: this.requestId(), inputs: this.record.pending.splice(0), pause, bound: null });
  }

  async pause(reason = "pausing") {
    this.running = false;
    if (!this.receipt || terminal(this.receipt)) return;
    this.flush(true);
    this.emit(reason);
    try {
      await this.persist();
      await this.pump();
    } catch (error) {
      this.emit("storage_error", error);
    }
  }

  // Reconcile exactly one uncertain in-flight block. An unrelated newer branch
  // is a conflict, never a reason to discard or rewrite the recorded inputs.
  async recover() {
    if (!this.receipt) return;
    const canonical = this.checkReceipt(await this.request(`/api/games/${encodeURIComponent(this.receipt.gameId)}`));
    const head = this.record.queue[0];
    if (head?.bound) {
      if (canonical.lastRequestId === head.requestId && canonical.checkpoint.seq === head.bound.seq) {
        this.record.queue.shift();
      } else if (canonical.checkpoint.seq !== head.bound.seq - 1 || canonical.checkpoint.stateHash !== head.bound.previousHash) {
        throw new RankedError("conflict", "Another game branch was saved. Your unconfirmed inputs were kept; ranked play is paused.", 409);
      } else if (canonical.checkpoint.leaseEpoch !== this.receipt.checkpoint.leaseEpoch) {
        head.bound = null;
      }
    } else if (canonical.checkpoint.seq !== this.receipt.checkpoint.seq || canonical.checkpoint.stateHash !== this.receipt.checkpoint.stateHash) {
      throw new RankedError("conflict", "Saved game changed in another tab. Ranked play is paused.", 409);
    }
    if (this.record.resume && canonical.lastRequestId === this.record.resume.requestId && canonical.lastAction === "resume") {
      this.record.resume = null;
      this.record.forceResume = false;
    }
    if (canonical.checkpoint.leaseEpoch !== this.receipt.checkpoint.leaseEpoch) this.record.forceResume = false;
    this.record.receipt = canonical;
    await this.persist();
    return canonical;
  }

  async reacquire() {
    if (!this.record.resume) {
      this.record.resume = { requestId: this.requestId(), checkpointToken: this.receipt.checkpointToken };
      await this.persist();
    }
    const receipt = this.checkReceipt(await this.request(`/api/games/${encodeURIComponent(this.receipt.gameId)}/resume`, this.record.resume));
    this.record.receipt = receipt;
    this.record.resume = null;
    this.record.forceResume = false;
    // A previous epoch may only be replaced when recover() proved no progress.
    if (this.record.queue[0]?.bound) this.record.queue[0].bound = null;
    await this.persist();
    if (this.leaseExpired()) throw new RankedError("lease_expired", "The ranked slot expired while reconnecting. Retry to obtain a new slot.", 409);
    return receipt;
  }

  async resume() {
    this.running = false;
    this.emit("connecting");
    try {
      if (!this.initialized) await this.initialize();
      await this.renewSession();
      if (!this.receipt) return await this.start(this.record?.name || "");
      await this.pump();
      await this.recover();
      if (terminal(this.receipt)) {
        this.rebuildSnapshot();
        this.emit("completed");
        return this.snapshot;
      }
      if (this.record.queue.length) throw this.error || new RankedError("network", "Waiting to confirm the stored inputs.");
      if (this.receipt.status !== "active" || this.leaseExpired()) await this.reacquire();
      this.rebuildSnapshot();
      this.running = true;
      this.emit("active");
      return this.snapshot;
    } catch (error) {
      this.emit(error.code === "ranked_full" ? "full" : "paused", error);
      throw error;
    }
  }

  async pump() {
    if (this.pumping) return this.pumping;
    this.pumping = this.drain().finally(() => { this.pumping = null; });
    return this.pumping;
  }

  async drain() {
    try {
      while (this.record?.queue.length && !this.closed) {
        if (terminal(this.receipt)) throw new RankedError("conflict", "Unexpected inputs after the saved game ended.");
        if (this.record.uncertain) {
          await this.recover();
          this.record.uncertain = false;
          await this.persist();
          if (!this.record.queue.length) break;
        }
        if (this.record.forceResume || this.receipt.status === "paused" || this.leaseExpired()) {
          await this.reacquire();
        }
        const block = this.record.queue[0];
        if (!block.bound) {
          block.bound = { seq: this.receipt.checkpoint.seq + 1,
            checkpointToken: this.receipt.checkpointToken, previousHash: this.receipt.checkpoint.stateHash };
        }
        // Even a browser crash between fetch and response leaves an uncertain
        // request marker, with its original id, in durable storage.
        this.record.uncertain = true;
        await this.persist();
        const receipt = this.checkReceipt(await this.request(`/api/games/${encodeURIComponent(this.receipt.gameId)}/checkpoints`, {
          requestId: block.requestId, checkpointToken: block.bound.checkpointToken,
          seq: block.bound.seq, inputsBase64: encodeInputs(block.inputs), pause: block.pause,
        }));
        if (this.closed) return;
        if (receipt.lastRequestId !== block.requestId || receipt.checkpoint.seq !== block.bound.seq) {
          throw new RankedError("conflict", "The saved acknowledgement did not match this input block.");
        }
        this.record.receipt = receipt;
        this.record.queue.shift();
        this.record.uncertain = false;
        await this.persist();
      }
      if (terminal(this.receipt)) {
        this.running = false;
        this.emit("completed");
      } else if (this.receipt?.status === "paused") {
        this.running = false;
        this.emit("paused");
      } else if (this.running) {
        this.emit("active");
      }
    } catch (error) {
      if (this.closed) return;
      if (error.code === "lease_expired") {
        this.record.forceResume = true;
        await this.persist().catch(() => {});
      }
      const fatal = ["conflict", "forbidden", "not_found", "rules_version", "rules_changed", "invalid_input",
        "invalid_token", "invalid_signature", "local_storage", "game_completed", "session_required", "session_expired"].includes(error.code);
      if (fatal || error.code === "ranked_full") this.running = false;
      this.emit(fatal ? "conflict" : error.code === "ranked_full" ? "full" : "reconnecting", error);
      if (!fatal && this.automaticRetry && !this.retryTimer && !this.closed) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          void this.pump();
        }, error.status === 429 ? Math.max(this.retryDelay, 5000) : this.retryDelay);
      }
    }
  }

  async close() {
    this.closed = true;
    this.running = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.sessionTimer);
    for (const controller of this.controllers) controller.abort();
    if (this.record) {
      this.flush(true);
      await this.persist().catch(() => {});
    }
    this.store.close?.();
  }
}
