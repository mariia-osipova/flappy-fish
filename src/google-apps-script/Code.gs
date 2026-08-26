const SPREADSHEET_ID = "199bPYl_Z3sJnb-8XEMWIe-4u-GDvHuYlNkAzRyOM0uM";
const SHEET_NAME = "Scores";
const HEADERS = ["Name", "Score", "Best Score", "Updated At"];

function doPost(event) {
  try {
    const payload = parsePostPayload(event);
    const result = withScoreLock(function () {
      return saveScore(payload);
    });
    return respond({ ok: true, score: result });
  } catch (error) {
    return respond({ ok: false, error: String(error) });
  }
}

function doGet(event) {
  const parameter = (event && event.parameter) || {};
  const callback = parameter.callback || "";

  try {
    if (parameter.action === "save") {
      const result = withScoreLock(function () {
        return saveScore(parameter);
      });
      return respond({ ok: true, score: result }, callback);
    }

    return respond({ ok: true, scores: getScores() }, callback);
  } catch (error) {
    return respond({ ok: false, error: String(error) }, callback);
  }
}

function parsePostPayload(event) {
  const contents = (event && event.postData && event.postData.contents) || "";
  if (!contents) return (event && event.parameter) || {};

  try {
    return JSON.parse(contents);
  } catch (error) {
    return (event && event.parameter) || {};
  }
}

function withScoreLock(callback) {
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    lock.waitLock(3000);
    hasLock = true;
    return callback();
  } finally {
    if (hasLock) {
      lock.releaseLock();
    }
  }
}

function saveScore(payload) {
  const name = cleanName(payload.name);
  const rawScore = payload.score === undefined || payload.score === ""
    ? payload.bestScore
    : payload.score;
  const rawBestScore = payload.bestScore === undefined || payload.bestScore === ""
    ? rawScore
    : payload.bestScore;
  const score = cleanScore(rawScore);
  const bestScore = Math.max(score, cleanScore(rawBestScore));
  const updatedAt = payload.updatedAt || new Date().toISOString();
  const sheet = getScoresSheet();

  sheet.appendRow([name, score, bestScore, updatedAt]);

  return { name, score, bestScore, updatedAt };
}

function getScores() {
  const sheet = getScoresSheet();
  const values = sheet.getDataRange().getValues();
  const indexes = headerIndexes(values[0] || []);
  const bestByName = {};

  values.slice(1).forEach(function (row) {
    const name = String(row[indexes.name] || "").trim();
    if (!name) return;

    const score = cleanScore(row[indexes.score]);
    const bestScore = cleanScore(row[indexes.bestScore]);
    const value = Math.max(score, bestScore);
    const key = name.toLowerCase();
    const current = bestByName[key];

    if (!current || value > current.bestScore) {
      bestByName[key] = { name: name, bestScore: value };
    }
  });

  return Object.keys(bestByName)
    .map(function (key) {
      return bestByName[key];
    })
    .sort(function (a, b) {
      return b.bestScore - a.bestScore || a.name.localeCompare(b.name);
    });
}

function getScoresSheet() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
  }

  migrateHeaderIfNeeded(sheet);
  sheet.setFrozenRows(1);
  return sheet;
}

function migrateHeaderIfNeeded(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), HEADERS.length);
  const header = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const normalized = header.map(function (value) {
    return String(value || "").trim();
  });

  if (
    normalized[0] === "Name" &&
    normalized[1] === "Best Score" &&
    normalized[2] === "Updated At"
  ) {
    sheet.insertColumnAfter(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);

    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const oldBestScores = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
      sheet.getRange(2, 2, lastRow - 1, 1).setValues(oldBestScores);
    }
    return;
  }

  if (HEADERS.some(function (headerName, index) {
    return normalized[index] !== headerName;
  })) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

function headerIndexes(header) {
  const normalized = header.map(function (value) {
    return String(value || "").trim().toLowerCase();
  });

  const name = normalized.indexOf("name");
  const score = normalized.indexOf("score");
  const bestScore = normalized.indexOf("best score");

  return {
    name: name === -1 ? 0 : name,
    score: score === -1 ? 1 : score,
    bestScore: bestScore === -1 ? 1 : bestScore,
  };
}

function cleanName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
  if (!name) {
    throw new Error("Name is required");
  }
  return name;
}

function cleanScore(value) {
  return Math.max(0, Math.floor(Number(value || 0)));
}

function respond(data, callback) {
  const callbackName = cleanCallbackName(callback);
  const body = callbackName ? `${callbackName}(${JSON.stringify(data)});` : JSON.stringify(data);
  return ContentService
    .createTextOutput(body)
    .setMimeType(callbackName ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

function cleanCallbackName(value) {
  const callback = String(value || "").trim();
  const pattern = /^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$/;
  return pattern.test(callback) ? callback : "";
}
