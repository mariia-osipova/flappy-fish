const SPREADSHEET_ID = "199bPYl_Z3sJnb-8XEMWIe-4u-GDvHuYlNkAzRyOM0uM";
const SHEET_NAME = "Scores";

function doPost(event) {
  try {
    const payload = JSON.parse(event.postData.contents || "{}");
    const result = saveScore(payload);
    return respond({ ok: true, score: result });
  } catch (error) {
    return respond({ ok: false, error: String(error) });
  }
}

function doGet(event) {
  const callback = event.parameter.callback || "";
  return respond({ ok: true, scores: getScores() }, callback);
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
  const body = callback ? `${callback}(${JSON.stringify(data)});` : JSON.stringify(data);
  return ContentService
    .createTextOutput(body)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}
