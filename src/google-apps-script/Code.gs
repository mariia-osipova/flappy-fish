const SPREADSHEET_ID = "199bPYl_Z3sJnb-8XEMWIe-4u-GDvHuYlNkAzRyOM0uM";
const SHEET_NAME = "Scores";

function doPost(event) {
  try {
    const payload = JSON.parse((event && event.postData && event.postData.contents) || "{}");
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
  const bestScore = Math.max(0, Math.floor(Number(payload.bestScore || payload.score || 0)));
  const updatedAt = payload.updatedAt || new Date().toISOString();
  const sheet = getScoresSheet();
  const values = sheet.getDataRange().getValues();
  let targetRow = -1;

  for (let index = 1; index < values.length; index += 1) {
    if (String(values[index][0]).trim().toLowerCase() === name.toLowerCase()) {
      targetRow = index + 1;
      break;
    }
  }

  if (targetRow === -1) {
    sheet.appendRow([name, bestScore, updatedAt]);
    return { name, bestScore, updatedAt };
  }

  const currentBest = Math.max(0, Math.floor(Number(sheet.getRange(targetRow, 2).getValue() || 0)));
  const nextBest = Math.max(currentBest, bestScore);
  sheet.getRange(targetRow, 1, 1, 3).setValues([[name, nextBest, updatedAt]]);
  return { name, bestScore: nextBest, updatedAt };
}

function getScores() {
  const sheet = getScoresSheet();
  const values = sheet.getDataRange().getValues().slice(1);
  return values
    .filter((row) => row[0] !== "")
    .map((row) => ({
      name: String(row[0]),
      bestScore: Math.max(0, Math.floor(Number(row[1] || 0))),
      updatedAt: row[2] ? String(row[2]) : "",
    }))
    .sort((a, b) => b.bestScore - a.bestScore || a.name.localeCompare(b.name));
}

function getScoresSheet() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
  }

  const header = sheet.getRange(1, 1, 1, 3).getValues()[0];
  if (header[0] !== "Name" || header[1] !== "Best Score" || header[2] !== "Updated At") {
    sheet.getRange(1, 1, 1, 3).setValues([["Name", "Best Score", "Updated At"]]);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function cleanName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
  if (!name) {
    throw new Error("Name is required");
  }
  return name;
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
