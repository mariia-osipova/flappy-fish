// Only this script project may write the protected Games and Legacy sheets.
// Network callers authenticate before any SpreadsheetApp operation.
const STORE = Object.freeze({
  gamesSheet: "Games",
  legacySheet: "Legacy",
  sourceSheet: "Scores",
  gamesHeader: "Flappy Fish game JSON v1",
  legacyHeader: "Flappy Fish legacy JSON v1",
  maxActiveGames: 5,
  leaseMs: 120000,
  creationWindowMs: 60000,
  maxCreationsPerOwner: 50,
  signatureWindowMs: 60000,
  maxCheckpointTicks: 1200,
  tickRate: 120,
  clockToleranceMs: 1000,
  maxSnapshotBytes: 4096,
  maxRecordChars: 45000,
  lockWaitMs: 2000,
  gameRowCacheSeconds: 21600,
});

let currentStoreMutation = null;

function doGet() {
  return jsonResponse(storeFailure("forbidden", "Use the authenticated gateway.", 405));
}

function doPost(event) {
  try {
    const request = authenticateRequest(event);
    const handlers = {
      begin: beginGame,
      read: readGame,
      checkpoint: checkpointGame,
      resume: resumeGame,
      scores: readScores,
    };
    const handler = Object.prototype.hasOwnProperty.call(handlers, request.action) ? handlers[request.action] : null;
    if (!handler) fail("invalid_input", "Unknown gateway action.", 400);
    const mutation = request.action !== "read" && request.action !== "scores";
    // Opening the spreadsheet does not read or mutate state, so doing it before
    // ScriptLock shortens the serialized portion of every ranked mutation.
    // Read handlers still validate their input before opening the store.
    if (mutation) request.book = openStore(request);
    const run = function () { return handler(request); };
    const data = mutation ? withStoreLock(run) : run();
    if (request.diagnostic) logDiagnostic("ranked_admission", request.diagnostic);
    return jsonResponse({ ok: true, data: data });
  } catch (error) {
    if (!error || !error.storeCode || error.storeCode === "storage_unavailable") {
      logDiagnostic("storage_failure", { reason: classifyStorageFailure(error) });
    }
    return jsonResponse(error && error.storeCode
      ? storeFailure(error.storeCode, error.message, error.storeStatus, error.storeDetails)
      : storeFailure("storage_unavailable", "The score store is temporarily unavailable.", 503));
  }
}

function authenticateRequest(event) {
  const raw = event && event.postData && event.postData.contents;
  if (typeof raw !== "string" || raw.length > 100000) {
    fail("invalid_input", "A bounded JSON gateway envelope is required.", 400);
  }
  let envelope;
  try { envelope = JSON.parse(raw); } catch (_) {
    fail("invalid_input", "Invalid gateway envelope.", 400);
  }
  if (!plainObject(envelope) || envelope.version !== 1 ||
      typeof envelope.action !== "string" || !/^[a-z]+$/.test(envelope.action) ||
      typeof envelope.requestId !== "string" || !/^[^\r\n]{1,160}$/.test(envelope.requestId) ||
      typeof envelope.content !== "string" || envelope.content.length > 60000 ||
      typeof envelope.signature !== "string" || !/^[a-f0-9]{64}$/i.test(envelope.signature)) {
    fail("forbidden", "Request authentication failed.", 403);
  }
  const timestamp = Number(envelope.timestamp);
  if ((typeof envelope.timestamp !== "number" && typeof envelope.timestamp !== "string") ||
      !Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > STORE.signatureWindowMs) {
    fail("forbidden", "Request authentication failed.", 403);
  }
  // Fetch the small configuration set once. A fresh game needs the HMAC secret,
  // spreadsheet id and capacity setting; separate property calls made its hot
  // path needlessly serial and more variable.
  const properties = PropertiesService.getScriptProperties().getProperties();
  const secret = properties.GATEWAY_HMAC_KEY;
  if (!secret || secret.length < 32) {
    fail("storage_unavailable", "Gateway authentication is not configured.", 503);
  }
  const signed = [
    "flappy-fish-gateway-v1", envelope.action, envelope.requestId,
    String(envelope.timestamp), envelope.content,
  ].join("\n");
  const bytes = Utilities.computeHmacSha256Signature(signed, secret, Utilities.Charset.UTF_8);
  const expected = bytes.map(function (value) {
    return ("0" + (value & 255).toString(16)).slice(-2);
  }).join("");
  if (!constantTimeEqual(expected, envelope.signature.toLowerCase())) {
    fail("forbidden", "Request authentication failed.", 403);
  }
  let payload;
  try { payload = JSON.parse(envelope.content); } catch (_) {
    fail("invalid_input", "Invalid gateway content.", 400);
  }
  if (!plainObject(payload)) fail("invalid_input", "Gateway content must be an object.", 400);
  return { action: envelope.action, requestId: envelope.requestId, payload: payload, properties: properties };
}

function constantTimeEqual(left, right) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function withStoreLock(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(STORE.lockWaitMs)) {
    fail("storage_unavailable", "The score store is busy; retry the same request.", 503);
  }
  const mutation = { pending: false };
  currentStoreMutation = mutation;
  try {
    return callback();
  } finally {
    currentStoreMutation = null;
    // A lost response after this commit is recovered by the stored request id.
    try {
      if (mutation.pending) SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
  }
}

function markStoreMutation() {
  if (!currentStoreMutation) {
    fail("storage_unavailable", "A score store mutation was attempted without its lock.", 503);
  }
  // Mark before the mutating API call because a transport failure can leave its
  // commit outcome unknown. Idempotent retries recover from the stored receipt.
  currentStoreMutation.pending = true;
}

function openStore(request) {
  const id = request && request.properties
    ? request.properties.SPREADSHEET_ID
    : PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!id) fail("storage_unavailable", "The score store is not configured.", 503);
  return SpreadsheetApp.openById(id);
}

function requireSheet(book, name, header) {
  const sheet = book.getSheetByName(name);
  if (!sheet || sheet.getRange(1, 1).getValues()[0][0] !== header) {
    fail("storage_unavailable", "Initialize the protected score store first.", 503);
  }
  return sheet;
}

function loadJsonRows(sheet, lastRow) {
  const count = (lastRow === undefined ? sheet.getLastRow() : lastRow) - 1;
  if (count <= 0) return [];
  return sheet.getRange(2, 1, count, 1).getValues().reduce(function (rows, values, index) {
    if (values[0] === "") return rows;
    let record;
    try { record = JSON.parse(values[0]); } catch (_) {
      fail("storage_unavailable", "A score store record is damaged.", 503);
    }
    if (!plainObject(record)) fail("storage_unavailable", "A score store record is damaged.", 503);
    rows.push({ row: index + 2, record: record });
    return rows;
  }, []);
}

function loadGames(book) {
  const sheet = book.getSheetByName(STORE.gamesSheet);
  if (!sheet) fail("storage_unavailable", "Initialize the protected score store first.", 503);
  // The header, last row and JSON records are all in one protected column.
  // One data-range read replaces three Spreadsheet service calls on begin.
  const values = sheet.getDataRange().getValues();
  if (!values.length || values[0][0] !== STORE.gamesHeader) {
    fail("storage_unavailable", "Initialize the protected score store first.", 503);
  }
  return loadGamesFromValues(sheet, values);
}

function loadGamesFromSheet(sheet, lastRow) {
  const rows = loadJsonRows(sheet, lastRow);
  return validateGames(sheet, rows, lastRow);
}

function loadGamesFromValues(sheet, values) {
  const rows = values.slice(1).reduce(function (parsed, row, index) {
    if (row[0] === "") return parsed;
    let record;
    try { record = JSON.parse(row[0]); } catch (_) {
      fail("storage_unavailable", "A score store record is damaged.", 503);
    }
    if (!plainObject(record)) fail("storage_unavailable", "A score store record is damaged.", 503);
    parsed.push({ row: index + 2, record: record });
    return parsed;
  }, []);
  return validateGames(sheet, rows, values.length);
}

function validateGames(sheet, rows, lastRow) {
  const ids = new Set();
  rows.forEach(function (entry) {
    const game = entry.record;
    validateGameRecord(game);
    if (ids.has(game.gameId)) fail("storage_unavailable", "A game record is damaged.", 503);
    ids.add(game.gameId);
  });
  return { sheet: sheet, rows: rows, lastRow: lastRow };
}

function validateGameRecord(game) {
  if (typeof game.gameId !== "string" || typeof game.ownerId !== "string" ||
      typeof game.rankKey !== "string" || !["active", "paused", "completed"].includes(game.status) ||
      !Number.isSafeInteger(game.seq) || game.seq < 0 ||
      !Number.isSafeInteger(game.leaseEpoch) || game.leaseEpoch < 1 ||
      !Number.isFinite(game.leaseUntil) || !Number.isFinite(game.elapsedActiveMs) ||
      game.elapsedActiveMs < 0 || !plainObject(game.snapshot)) {
    fail("storage_unavailable", "A game record is damaged.", 503);
  }
}

function gameRowCacheKey(gameId) {
  // Game ids are bounded to 160 characters. Sanitizing keeps the key within
  // CacheService's limit; collisions are harmless because the row is verified.
  return "game-row-v1:" + gameId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function getStoreCache() {
  try { return CacheService.getScriptCache(); } catch (_) { return null; }
}

function rememberGameRow(gameId, row) {
  const cache = getStoreCache();
  if (!cache) return;
  try {
    cache.put(gameRowCacheKey(gameId), String(row), STORE.gameRowCacheSeconds);
  } catch (_) {
    // CacheService is only an optimization; Sheets remains authoritative.
  }
}

function cachedGameRow(gameId, lastRow) {
  const cache = getStoreCache();
  if (!cache) return null;
  try {
    // Games are append-only. If an administrator has changed a row, the
    // authoritative cell validation below rejects the stale hint and scans.
    const row = Number(cache.get(gameRowCacheKey(gameId)));
    return Number.isSafeInteger(row) && row >= 2 && row <= lastRow ? row : null;
  } catch (_) {
    return null;
  }
}

function readGameCell(sheet, row) {
  const raw = sheet.getRange(row, 1).getValues()[0][0];
  if (raw === "") return null;
  let record;
  try { record = JSON.parse(raw); } catch (_) { return null; }
  if (!plainObject(record)) return null;
  try { validateGameRecord(record); } catch (_) { return null; }
  return { row: row, record: record };
}

function loadOwnedGame(book, payload) {
  const sheet = requireSheet(book, STORE.gamesSheet, STORE.gamesHeader);
  const lastRow = sheet.getLastRow();
  const row = cachedGameRow(payload.gameId, lastRow);
  if (row !== null) {
    const cached = readGameCell(sheet, row);
    if (cached && cached.record.gameId === payload.gameId) {
      return { sheet: sheet, entry: requireOwnedGame(cached, payload), lastRow: lastRow };
    }
  }
  // A miss, stale hint, changed row count or damaged hinted cell falls back to
  // the full validation path. Capacity-sensitive operations always use it.
  const games = loadGamesFromSheet(sheet, lastRow);
  const entry = findOwnedGame(games.rows, payload);
  rememberGameRow(entry.record.gameId, entry.row);
  return { sheet: sheet, entry: entry, lastRow: lastRow };
}

function writeGame(sheet, row, record) {
  const serialized = JSON.stringify(record);
  if (serialized.length > STORE.maxRecordChars) {
    fail("invalid_input", "The checkpoint is too large.", 400);
  }
  // JSON begins with '{': names beginning with '=' cannot become formulas.
  // This one cell contains both terminal status and final score.
  markStoreMutation();
  sheet.getRange(row, 1).setValues([[serialized]]);
}

function beginGame(request) {
  const payload = request.payload;
  requireText(payload.ownerId, "ownerId", 160);
  requireHash(payload.requestHash, "requestHash");
  const book = request.book;
  const games = loadGames(book);
  const previous = games.rows.find(function (entry) {
    return entry.record.ownerId === payload.ownerId &&
      entry.record.beginRequestId === request.requestId;
  });
  if (previous) {
    if (previous.record.beginRequestHash !== payload.requestHash) {
      fail("conflict", "The begin request id was already used with different content.", 409);
    }
    return previous.record;
  }
  requireText(payload.gameId, "gameId", 160);
  requireText(payload.rulesVersion, "rulesVersion", 120);
  requireHash(payload.stateHash, "stateHash");
  validateSnapshot(payload.snapshot);
  const name = normalizeName(payload.name);
  if (payload.rankKey !== name.toLowerCase()) fail("invalid_input", "Invalid normalized name.", 400);
  if (!((typeof payload.seed === "string" && payload.seed.length > 0 && payload.seed.length <= 160) ||
      (Number.isSafeInteger(payload.seed) && payload.seed >= 0))) {
    fail("invalid_input", "Invalid game seed.", 400);
  }
  if (payload.snapshot.tick !== 0 || payload.snapshot.score !== 0 || payload.snapshot.dead) {
    fail("invalid_input", "A ranked game must begin from its initial state.", 400);
  }
  if (games.rows.some(function (entry) { return entry.record.gameId === payload.gameId; })) {
    fail("conflict", "The game id already exists.", 409);
  }
  const now = Date.now();
  const capacity = ensureCapacity(games.rows, payload.ownerId, null, now, request.properties);
  const recent = games.rows.filter(function (entry) {
    return entry.record.ownerId === payload.ownerId &&
      entry.record.createdAt > now - STORE.creationWindowMs;
  }).length;
  if (recent >= STORE.maxCreationsPerOwner) {
    fail("rate_limited", "Too many ranked games were started; try again later.", 429);
  }
  const game = {
    gameId: payload.gameId, ownerId: payload.ownerId, name: name, rankKey: payload.rankKey,
    beginRequestId: request.requestId, beginRequestHash: payload.requestHash,
    rulesVersion: payload.rulesVersion, seed: payload.seed, snapshot: payload.snapshot,
    seq: 0, stateHash: payload.stateHash, status: "active",
    leaseEpoch: 1, leaseUntil: now + STORE.leaseMs,
    createdAt: now, updatedAt: now, lastRequestId: request.requestId,
    lastRequestHash: payload.requestHash, lastAction: "begin",
    elapsedActiveMs: 0, activeSince: now,
  };
  const row = games.lastRow + 1;
  writeGame(games.sheet, row, game);
  // CacheService is advisory. Avoid an extra remote call while admitting a
  // game; the first owned-game read/checkpoint can populate the hint safely.
  request.diagnostic = { action: "begin", activeSlots: capacity.activeSlots, limit: capacity.limit };
  return game;
}

function readGame(request) {
  validateIdentity(request.payload);
  return loadOwnedGame(request.book || openStore(request), request.payload).entry.record;
}

function checkpointGame(request) {
  const payload = request.payload;
  validateIdentity(payload);
  requireHash(payload.requestHash, "requestHash");
  const games = loadOwnedGame(request.book, payload);
  const entry = games.entry;
  const game = entry.record;
  if (isDuplicate(game, request)) return game;
  requirePreviousCheckpoint(game, payload);
  if (game.status === "completed") fail("conflict", "The game has already completed.", 409);
  const now = Date.now();
  if (game.status !== "active" || now >= game.leaseUntil) {
    fail("lease_expired", "Resume the ranked game before sending another checkpoint.", 409);
  }
  validateSnapshot(payload.snapshot);
  requireHash(payload.stateHash, "stateHash");
  if (!Number.isSafeInteger(payload.inputTicks) || payload.inputTicks < 0 ||
      payload.inputTicks > STORE.maxCheckpointTicks || typeof payload.pause !== "boolean" ||
      payload.snapshot.tick !== game.snapshot.tick + payload.inputTicks ||
      payload.snapshot.score < game.snapshot.score) {
    fail("invalid_input", "Invalid checkpoint progression.", 400);
  }
  if (payload.inputTicks === 0 && payload.stateHash !== game.stateHash) {
    fail("invalid_input", "A zero-tick checkpoint cannot change the simulation.", 400);
  }
  const credit = activeCredit(game, now);
  if (payload.snapshot.tick * 1000 / STORE.tickRate >
      game.elapsedActiveMs + credit + STORE.clockToleranceMs) {
    fail("too_fast", "The replay is ahead of elapsed server time.", 409);
  }
  game.snapshot = payload.snapshot;
  game.stateHash = payload.stateHash;
  game.seq += 1;
  game.updatedAt = now;
  rememberRequest(game, request);
  if (payload.snapshot.dead || payload.pause) {
    game.elapsedActiveMs += credit;
    game.activeSince = null;
    game.leaseUntil = now;
    game.status = payload.snapshot.dead ? "completed" : "paused";
    if (payload.snapshot.dead) game.finalScore = payload.snapshot.score;
  } else if (payload.inputTicks > 0) {
    game.leaseUntil = now + STORE.leaseMs;
  }
  writeGame(games.sheet, entry.row, game);
  return game;
}

function resumeGame(request) {
  const payload = request.payload;
  validateIdentity(payload);
  requireHash(payload.requestHash, "requestHash");
  const games = loadGames(request.book);
  const entry = findOwnedGame(games.rows, payload);
  const game = entry.record;
  if (isDuplicate(game, request)) return game;
  requirePreviousCheckpoint(game, payload);
  const now = Date.now();
  if (game.status === "completed") fail("conflict", "The game has already completed.", 409);
  if (game.status === "active" && game.leaseUntil > now) {
    fail("conflict", "The ranked game is already active.", 409);
  }
  const capacity = ensureCapacity(games.rows, game.ownerId, game.gameId, now, request.properties);
  game.elapsedActiveMs += activeCredit(game, now);
  game.activeSince = now;
  game.leaseUntil = now + STORE.leaseMs;
  game.leaseEpoch += 1;
  game.status = "active";
  game.updatedAt = now;
  rememberRequest(game, request);
  writeGame(games.sheet, entry.row, game);
  rememberGameRow(game.gameId, entry.row);
  request.diagnostic = { action: "resume", activeSlots: capacity.activeSlots, limit: capacity.limit };
  return game;
}

function requirePreviousCheckpoint(game, payload) {
  if (!Number.isSafeInteger(payload.prevSeq) || !Number.isSafeInteger(payload.leaseEpoch) ||
      payload.prevSeq !== game.seq || payload.prevStateHash !== game.stateHash ||
      payload.leaseEpoch !== game.leaseEpoch) {
    fail("conflict", "The checkpoint is stale; reload the saved game.", 409);
  }
}

function isDuplicate(game, request) {
  if (game.lastRequestId !== request.requestId) return false;
  if (game.lastRequestHash !== request.payload.requestHash || game.lastAction !== request.action) {
    fail("conflict", "The request id was already used with different content.", 409);
  }
  return true;
}

function rememberRequest(game, request) {
  game.lastRequestId = request.requestId;
  game.lastRequestHash = request.payload.requestHash;
  game.lastAction = request.action;
}

function activeCredit(game, now) {
  return game.status === "active" && Number.isFinite(game.activeSince)
    ? Math.max(0, Math.min(now, game.leaseUntil) - game.activeSince)
    : 0;
}

function ensureCapacity(rows, ownerId, exceptGameId, now, properties) {
  const configured = properties
    ? properties.MAX_RANKED_GAMES
    : PropertiesService.getScriptProperties().getProperty("MAX_RANKED_GAMES");
  const maximum = configured === null || configured === undefined
    ? STORE.maxActiveGames : Number(String(configured).trim());
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 30 ||
      (configured !== null && configured !== undefined && !/^[1-9]\d*$/.test(String(configured).trim()))) {
    fail("storage_unavailable", "The ranked capacity setting is invalid.", 503);
  }
  const active = rows.filter(function (entry) {
    const game = entry.record;
    return game.gameId !== exceptGameId && game.status === "active" && game.leaseUntil > now;
  });
  const owned = active.find(function (entry) { return entry.record.ownerId === ownerId; });
  if (owned) {
    fail("active_game_exists", "This player already has an active ranked game.", 409, { gameId: owned.record.gameId });
  }
  if (active.length >= maximum) {
    fail("ranked_full", "All ranked places are occupied; training is still available.", 503);
  }
  return { activeSlots: active.length + 1, limit: maximum };
}

function findOwnedGame(rows, payload) {
  const entry = rows.find(function (value) { return value.record.gameId === payload.gameId; });
  if (!entry) fail("not_found", "The ranked game was not found.", 404);
  return requireOwnedGame(entry, payload);
}

function requireOwnedGame(entry, payload) {
  if (entry.record.ownerId !== payload.ownerId) {
    fail("forbidden", "This ranked game belongs to another session.", 403);
  }
  return entry;
}

function readScores(request) {
  if (request.payload.includeIndex !== undefined && typeof request.payload.includeIndex !== "boolean") {
    fail("invalid_input", "Invalid leaderboard index option.", 400);
  }
  const book = request.book || openStore(request);
  const games = loadGames(book).rows;
  const legacy = loadJsonRows(requireSheet(book, STORE.legacySheet, STORE.legacyHeader));
  const best = new Map();
  function consider(candidate) {
    const current = best.get(candidate.rankKey);
    if (!current || candidate.bestScore > current.bestScore ||
        (candidate.bestScore === current.bestScore && candidate.verified && !current.verified) ||
        (candidate.bestScore === current.bestScore && candidate.verified === current.verified &&
          String(candidate.updatedAt || "") > String(current.updatedAt || ""))) {
      best.set(candidate.rankKey, candidate);
      if (best.size > 100000) fail("storage_unavailable", "The leaderboard index is too large.", 503);
    }
  }
  legacy.forEach(function (entry) {
    const value = entry.record;
    if (typeof value.rankKey !== "string" || typeof value.name !== "string" ||
        !Number.isSafeInteger(value.bestScore) || value.bestScore < 0) {
      fail("storage_unavailable", "A legacy record is damaged.", 503);
    }
    consider({
      name: value.name, rankKey: value.rankKey, bestScore: value.bestScore,
      source: "legacy", verified: false, updatedAt: value.updatedAt || null,
    });
  });
  games.forEach(function (entry) {
    const game = entry.record;
    if (game.status !== "completed") return;
    if (!Number.isSafeInteger(game.finalScore) || game.finalScore < 0 ||
        game.snapshot.dead !== true || game.snapshot.score !== game.finalScore) {
      fail("storage_unavailable", "A completed game record is damaged.", 503);
    }
    consider({
      name: game.name, rankKey: game.rankKey, bestScore: game.finalScore,
      source: "verified", verified: true, updatedAt: new Date(game.updatedAt).toISOString(),
    });
  });
  const ranked = Array.from(best.values()).sort(function (left, right) {
    return right.bestScore - left.bestScore ||
      (left.rankKey < right.rankKey ? -1 : left.rankKey > right.rankKey ? 1 : 0);
  }).map(function (entry, index) {
    return {
      name: entry.name, bestScore: entry.bestScore, source: entry.source,
      verified: entry.verified, updatedAt: entry.updatedAt, rank: index + 1,
    };
  });
  const requested = request.payload.name === undefined ? null : normalizeName(request.payload.name).toLowerCase();
  const result = {
    scores: ranked.slice(0, 100),
    player: requested === null ? null : ranked.find(function (entry) {
      return entry.name.toLowerCase() === requested;
    }) || null,
    updatedAt: new Date(Date.now()).toISOString(),
  };
  // Authenticated Node-only cache payload; never expose this index directly.
  if (request.payload.includeIndex === true) result.index = ranked;
  return result;
}

// Run these two administrative functions from the Apps Script editor only.
// They are intentionally absent from the HTTP action allowlist.
function initializeStorage() {
  return withStoreLock(function () {
    const book = openStore();
    [
      [STORE.gamesSheet, STORE.gamesHeader],
      [STORE.legacySheet, STORE.legacyHeader],
    ].forEach(function (item) {
      let sheet = book.getSheetByName(item[0]);
      if (!sheet) {
        markStoreMutation();
        sheet = book.insertSheet(item[0]);
      }
      if (sheet.getLastRow() === 0) {
        markStoreMutation();
        sheet.getRange(1, 1).setValues([[item[1]]]);
      }
      else if (sheet.getRange(1, 1).getValues()[0][0] !== item[1]) {
        fail("storage_unavailable", "A protected sheet has an unexpected schema.", 503);
      }
      markStoreMutation();
      sheet.setFrozenRows(1);
    });
    return { initialized: true };
  });
}

function migrateLegacyScores() {
  return withStoreLock(function () {
    const book = openStore();
    const source = book.getSheetByName(STORE.sourceSheet);
    if (!source) fail("not_found", "The original Scores sheet was not found.", 404);
    const values = source.getDataRange().getValues();
    const headers = (values[0] || []).map(function (value) { return String(value).trim().toLowerCase(); });
    const nameIndex = headers.indexOf("name");
    const scoreIndex = headers.indexOf("score");
    const bestIndex = headers.indexOf("best score");
    const timeIndex = headers.indexOf("updated at");
    if (nameIndex < 0 || (scoreIndex < 0 && bestIndex < 0)) {
      fail("invalid_input", "The original Scores headers are not recognized.", 400);
    }
    const best = new Map();
    const invalidRows = [];
    const warnings = [];
    values.slice(1).forEach(function (row, index) {
      const sourceRow = index + 2;
      if (row.every(function (value) { return value === ""; })) return;
      try {
        const rawName = row[nameIndex];
        if (typeof rawName !== "string" && !(typeof rawName === "number" && Number.isFinite(rawName))) {
          fail("invalid_input", "Invalid name.", 400);
        }
        const name = normalizeName(String(rawName));
        const candidates = [scoreIndex, bestIndex].filter(function (position) { return position >= 0; })
          .map(function (position) { return row[position]; })
          .filter(function (value) { return value !== "" && value !== null && value !== undefined; });
        if (!candidates.length) fail("invalid_input", "Missing score.", 400);
        const scores = candidates.map(function (value) {
          if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.0+)?$/.test(value.trim()))) {
            fail("invalid_input", "Invalid score.", 400);
          }
          const parsed = Number(value);
          if (!Number.isSafeInteger(parsed) || parsed < 0) fail("invalid_input", "Invalid score.", 400);
          return parsed;
        });
        let updatedAt = null;
        const rawTime = timeIndex < 0 ? null : row[timeIndex];
        if (rawTime !== undefined && rawTime !== null && rawTime !== "") {
          const time = new Date(rawTime).getTime();
          if (Number.isFinite(time)) updatedAt = new Date(time).toISOString();
          else warnings.push({ row: sourceRow, reason: "Invalid timestamp; score retained." });
        }
        const record = {
          name: name, rankKey: name.toLowerCase(), bestScore: Math.max.apply(null, scores),
          source: "legacy", verified: false, updatedAt: updatedAt, sourceRow: sourceRow,
        };
        const current = best.get(record.rankKey);
        if (!current || record.bestScore > current.bestScore ||
            (record.bestScore === current.bestScore && String(record.updatedAt || "") > String(current.updatedAt || ""))) {
          best.set(record.rankKey, record);
        }
      } catch (error) {
        invalidRows.push({ row: sourceRow, reason: error.message || "Invalid legacy record." });
      }
    });
    const records = Array.from(best.values()).sort(function (left, right) {
      return left.rankKey < right.rankKey ? -1 : left.rankKey > right.rankKey ? 1 : 0;
    });
    const target = requireSheet(book, STORE.legacySheet, STORE.legacyHeader);
    const count = Math.max(target.getLastRow(), records.length + 1);
    const replacement = Array.from({ length: count }, function (_, index) {
      return [index === 0 ? STORE.legacyHeader :
        index <= records.length ? JSON.stringify(records[index - 1]) : ""];
    });
    // Replace in one range operation; never clear the original Scores sheet.
    markStoreMutation();
    target.getRange(1, 1, replacement.length, 1).setValues(replacement);
    const report = {
      sourceSheet: STORE.sourceSheet, sourceRows: Math.max(0, values.length - 1),
      importedNames: records.length, invalidRows: invalidRows, warnings: warnings,
    };
    if (typeof Logger !== "undefined") Logger.log(JSON.stringify(report));
    return report;
  });
}

function validateIdentity(payload) {
  requireText(payload.ownerId, "ownerId", 160);
  requireText(payload.gameId, "gameId", 160);
}

function validateSnapshot(snapshot) {
  if (!plainObject(snapshot) || !Number.isSafeInteger(snapshot.tick) || snapshot.tick < 0 ||
      !Number.isSafeInteger(snapshot.score) || snapshot.score < 0 ||
      typeof snapshot.dead !== "boolean" || utf8Length(JSON.stringify(snapshot)) > STORE.maxSnapshotBytes) {
    fail("invalid_input", "Invalid bounded simulation snapshot.", 400);
  }
}

function utf8Length(value) {
  return encodeURIComponent(value).replace(/%[A-Fa-f\d]{2}/g, "x").length;
}

function normalizeName(value) {
  if (typeof value !== "string") fail("invalid_input", "A player name is required.", 400);
  const name = value.trim().replace(/\s+/g, " ").slice(0, 24);
  if (!name) fail("invalid_input", "A player name is required.", 400);
  return name;
}

function requireText(value, field, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum || /[\r\n]/.test(value)) {
    fail("invalid_input", "Invalid " + field + ".", 400);
  }
}

function requireHash(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("invalid_input", "Invalid " + field + ".", 400);
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(code, message, status, details) {
  const error = new Error(message);
  error.storeCode = code;
  error.storeStatus = status;
  error.storeDetails = details;
  throw error;
}

function storeFailure(code, message, status, details) {
  const error = { code: code, message: message, status: status };
  if (details !== undefined) error.details = details;
  return { ok: false, error: error };
}

function jsonResponse(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function classifyStorageFailure(error) {
  const message = String(error && error.message || "").toLowerCase();
  if (/quota|too many times|limit exceeded/.test(message)) return "quota";
  if (message.includes("busy")) return "busy";
  if (/not configured|setting is invalid|initialize|schema/.test(message)) return "configuration";
  if (message.includes("damaged")) return "corrupt_record";
  return "backend";
}

function logDiagnostic(event, fields) {
  try {
    // Successful admission is already durable in Sheets. Suppress its optional
    // execution log so it cannot add latency to the player-facing hot path.
    if (event === "ranked_admission") return;
    if (typeof Logger !== "undefined") {
      Logger.log(JSON.stringify({
        component: "flappy-fish-store", event: event,
        action: fields.action, activeSlots: fields.activeSlots, limit: fields.limit, reason: fields.reason,
      }));
    }
  } catch (_) {
    // Telemetry must never change the outcome of a game mutation.
  }
}
