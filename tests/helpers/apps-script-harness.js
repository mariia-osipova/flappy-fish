import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../../src/google-apps-script/Code.gs", import.meta.url), "utf8");
export const TEST_GATEWAY_SECRET = "test-only-gateway-secret-with-at-least-32-characters";
const clone = (value) => structuredClone(value);

/**
 * Runs the real Code.gs with deterministic clock and an in-memory SpreadsheetApp.
 * No Google APIs, credentials, external requests, or filesystem writes are used.
 */
export function createAppsScriptHarness({
  now = Date.now(), properties = {}, initialized = true, sheets: initialSheets = {},
} = {}) {
  let clock = now;
  let counter = 0;
  let locked = false;
  let failFlush = false;
  let failWrite = null;
  let busy = false;
  const propertyValues = {
    GATEWAY_HMAC_KEY: TEST_GATEWAY_SECRET,
    SPREADSHEET_ID: "test-spreadsheet",
    ...properties,
  };
  const calls = { opens: 0, reads: 0, writes: 0, flushes: 0, locks: 0, releases: 0, events: [] };
  const sheets = new Map();
  const logs = [];

  class FakeRange {
    constructor(sheet, row, column, rows = 1, columns = 1) {
      if (![row, column, rows, columns].every((value) => Number.isInteger(value) && value > 0)) {
        throw new Error("Invalid fake range.");
      }
      Object.assign(this, { sheet, row, column, rows, columns });
    }
    getValues() {
      calls.reads += 1;
      return Array.from({ length: this.rows }, (_, row) =>
        Array.from({ length: this.columns }, (_, column) =>
          clone(this.sheet.rows[this.row - 1 + row]?.[this.column - 1 + column] ?? "")));
    }
    setValues(values) {
      if (values.length !== this.rows || values.some((row) => row.length !== this.columns)) {
        throw new Error("Incorrect dimensions passed to setValues.");
      }
      if (!locked) throw new Error("A mutation occurred without ScriptLock.");
      const injected = failWrite;
      failWrite = null;
      if (injected && !injected.afterCommit) throw new Error("Injected failure before write.");
      calls.writes += 1;
      calls.events.push({ type: "write", sheet: this.sheet.name, row: this.row, values: clone(values) });
      values.forEach((row, rowIndex) => {
        const destination = this.row - 1 + rowIndex;
        this.sheet.rows[destination] ??= [];
        row.forEach((value, columnIndex) => {
          this.sheet.rows[destination][this.column - 1 + columnIndex] = clone(value);
        });
      });
      if (injected?.afterCommit) throw new Error("Injected failure after committed write.");
      return this;
    }
  }

  class FakeSheet {
    constructor(name, rows = []) { this.name = name; this.rows = clone(rows); }
    getName() { return this.name; }
    getRange(row, column, rows, columns) { return new FakeRange(this, row, column, rows, columns); }
    getLastRow() {
      for (let index = this.rows.length - 1; index >= 0; index -= 1) {
        if (this.rows[index]?.some((value) => value !== "" && value !== undefined && value !== null)) {
          return index + 1;
        }
      }
      return 0;
    }
    getLastColumn() {
      return Math.max(0, ...this.rows.map((row) => row?.length ?? 0));
    }
    getDataRange() {
      return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
    }
    setFrozenRows(count) {
      if (!locked) throw new Error("A sheet mutation occurred without ScriptLock.");
      this.frozenRows = count;
      return this;
    }
  }

  Object.entries(initialSheets).forEach(([name, rows]) => sheets.set(name, new FakeSheet(name, rows)));
  const book = {
    getSheetByName: (name) => sheets.get(name) ?? null,
    insertSheet(name) {
      if (!locked) throw new Error("A sheet was created without ScriptLock.");
      if (sheets.has(name)) throw new Error("Sheet already exists.");
      const sheet = new FakeSheet(name);
      sheets.set(name, sheet);
      calls.events.push({ type: "insertSheet", sheet: name });
      return sheet;
    },
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = vm.createContext({
    Date: ClockDate,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (name) => propertyValues[name] ?? null,
        setProperty: (name, value) => { propertyValues[name] = String(value); },
      }),
    },
    Utilities: {
      Charset: { UTF_8: "UTF-8" },
      computeHmacSha256Signature: (message, key) =>
        Array.from(createHmac("sha256", key).update(message, "utf8").digest(), (value) =>
          value > 127 ? value - 256 : value),
    },
    SpreadsheetApp: {
      openById(id) {
        calls.opens += 1;
        if (!id || id !== propertyValues.SPREADSHEET_ID) throw new Error("Unknown spreadsheet.");
        return book;
      },
      flush() {
        if (!locked) throw new Error("flush must occur before releasing ScriptLock.");
        calls.flushes += 1;
        calls.events.push({ type: "flush" });
        if (failFlush) { failFlush = false; throw new Error("Injected flush failure."); }
      },
    },
    LockService: {
      getScriptLock: () => ({
        tryLock() {
          calls.locks += 1;
          if (busy || locked) return false;
          locked = true;
          calls.events.push({ type: "lock" });
          return true;
        },
        releaseLock() {
          if (!locked) throw new Error("Lock was released twice.");
          locked = false;
          calls.releases += 1;
          calls.events.push({ type: "release" });
        },
      }),
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput: (text) => ({ text, setMimeType() { return this; }, getContent() { return text; } }),
    },
    Logger: { log: (value) => logs.push(String(value)) },
  });
  vm.runInContext(SOURCE, context, { filename: "Code.gs" });

  const harness = {
    calls, context, logs, properties: propertyValues,
    now: () => clock,
    advanceTime(milliseconds) { clock += milliseconds; return clock; },
    setTime(milliseconds) { clock = milliseconds; },
    getRows(name) { return clone(sheets.get(name)?.rows ?? []); },
    setRows(name, rows) {
      // Explicit fixture preparation, not an emulated application write.
      sheets.set(name, new FakeSheet(name, rows));
    },
    getRecord(gameId) {
      const records = harness.getRows("Games").slice(1)
        .filter((row) => row[0]).map((row) => JSON.parse(row[0]));
      return records.find((record) => record.gameId === gameId) ?? null;
    },
    runAdmin(name) {
      if (!["initializeStorage", "migrateLegacyScores"].includes(name)) throw new Error("Unknown admin function.");
      return clone(context[name]());
    },
    post(envelope) {
      const body = typeof envelope === "string" ? envelope : JSON.stringify(envelope);
      return JSON.parse(context.doPost({ postData: { contents: body } }).text);
    },
    get(parameters = {}) {
      return JSON.parse(context.doGet({ parameter: parameters }).text);
    },
    envelope(action, payload, options = {}) {
      const requestId = options.requestId ?? `request-${++counter}`;
      const timestamp = options.timestamp ?? clock;
      const content = options.content ?? JSON.stringify(payload);
      const signed = ["flappy-fish-gateway-v1", action, requestId, String(timestamp), content].join("\n");
      return {
        version: options.version ?? 1, action, requestId, timestamp, content,
        signature: options.signature ?? createHmac("sha256", propertyValues.GATEWAY_HMAC_KEY || TEST_GATEWAY_SECRET)
          .update(signed, "utf8").digest("hex"),
      };
    },
    invoke(action, payload, options = {}) {
      return harness.post(harness.envelope(action, payload, options));
    },
    failNextFlush() { failFlush = true; },
    failNextWrite(options = {}) { failWrite = { afterCommit: options.afterCommit ?? false }; },
    setBusy(value) { busy = value; },
    resetCalls() {
      for (const key of Object.keys(calls)) {
        if (key === "events") calls.events.length = 0;
        else calls[key] = 0;
      }
    },
  };
  if (initialized) harness.runAdmin("initializeStorage");
  harness.resetCalls();
  return harness;
}
