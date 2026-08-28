const SCORES_KEY = "flappy-fish-scores-by-name";
const LAST_PLAYER_KEY = "flappy-fish-last-player";
const SCORE_RESET_KEY = "flappy-fish-rank-reset-2026-08-26";

const rankList = document.getElementById("rank-list");

function resetLocalRankOnce() {
  if (localStorage.getItem(SCORE_RESET_KEY) === "done") return;
  localStorage.removeItem(SCORES_KEY);
  localStorage.removeItem(LAST_PLAYER_KEY);
  localStorage.setItem(SCORE_RESET_KEY, "done");
}

function readScores() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCORES_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, score]) => Number.isFinite(Number(score)))
        .map(([name, score]) => [name, Math.max(0, Math.floor(Number(score)))])
    );
  } catch {
    return {};
  }
}

function localScores() {
  return Object.entries(readScores()).map(([name, bestScore]) => ({ name, bestScore }));
}

function scoreValue(score) {
  return Math.max(0, Math.floor(Number(score.bestScore ?? score.score ?? 0)));
}

function isBlockedPlayerName(name) {
  return Boolean(window.FLAPPY_FISH_NAME_FILTER?.containsProfanity?.(name));
}

function normalizeScores(scores) {
  const bestByName = new Map();

  for (const score of scores) {
    const name = String(score.name || "").trim();
    const bestScore = scoreValue(score);
    if (!name || isBlockedPlayerName(name)) continue;

    const key = name.toLowerCase();
    const current = bestByName.get(key);
    if (!current || bestScore > current.bestScore) {
      bestByName.set(key, { name, bestScore });
    }
  }

  return Array.from(bestByName.values())
    .sort((a, b) => b.bestScore - a.bestScore || a.name.localeCompare(b.name));
}

function renderRanking(scores) {
  const ranked = normalizeScores(scores);
  rankList.replaceChildren();

  if (!ranked.length) {
    const item = document.createElement("li");
    item.className = "rank-list__empty";
    item.textContent = "No scores yet";
    rankList.append(item);
    return;
  }

  for (const { name, bestScore } of ranked) {
    const item = document.createElement("li");
    const entry = document.createElement("span");
    entry.className = "rank-entry";
    const label = document.createElement("span");
    label.className = "rank-name";
    label.textContent = `${name}: `;
    entry.append(label, document.createTextNode(String(bestScore)));
    item.append(entry);
    rankList.append(item);
  }
}

function renderStatus(message) {
  rankList.replaceChildren();
  const item = document.createElement("li");
  item.className = "rank-list__empty";
  item.textContent = message;
  rankList.append(item);
}

async function loadServerScores() {
  try {
    const r = await fetch("/api/scores");
    const data = await r.json();
    return Array.isArray(data?.scores) ? data.scores : [];
  } catch {}

  return [];
}

async function loadScores() {
  const serverScores = await loadServerScores();
  if (serverScores.length > 0) {
    renderRanking(serverScores);
    return;
  }

  renderRanking(localScores());
}

resetLocalRankOnce();
renderStatus("Loading leaderboard...");
loadScores();
