const rankList = document.getElementById("rank-list");
const rankSearch = document.getElementById("rank-search");
const rankName = document.getElementById("rank-name");
const rankPlayer = document.getElementById("rank-player");
const PRACTICE_ONLY = document.querySelector('meta[name="flappy-fish-mode"]')?.content === "practice";

function provenance(score) {
  return score.verified || score.source === "verified" ? "Server verified" : "Historical — not server verified";
}

function renderStatus(message) {
  rankList.replaceChildren();
  const item = document.createElement("li");
  item.className = "rank-list__empty";
  item.textContent = message;
  rankList.append(item);
}

function renderRanking(scores) {
  rankList.replaceChildren();
  if (!scores.length) return renderStatus("No scores yet");
  for (const score of scores) {
    const item = document.createElement("li");
    const entry = document.createElement("span");
    entry.className = "rank-entry";
    const label = document.createElement("span");
    label.className = "rank-name";
    label.textContent = `${score.name}: `;
    const origin = document.createElement("small");
    origin.className = "rank-provenance";
    origin.textContent = provenance(score);
    entry.append(label, document.createTextNode(String(score.bestScore)), origin);
    item.append(entry);
    rankList.append(item);
  }
}

async function loadScores(name = "") {
  if (PRACTICE_ONLY) {
    rankSearch.hidden = true;
    renderStatus("Leaderboard is not available on this practice-only deployment.");
    rankPlayer.textContent = "Manual play and Evolution work here without a server. No scores are sent or recorded.";
    return;
  }
  try {
    const response = await fetch(`/api/scores${name ? `?name=${encodeURIComponent(name)}` : ""}`, {
      cache: "no-store", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Leaderboard is temporarily unavailable. Please try again later.");
    const data = await response.json();
    if (!Array.isArray(data.scores)) throw new Error("The leaderboard response could not be read.");
    renderRanking(data.scores);
    rankPlayer.textContent = !name ? "Top 100 · updates may take 30 seconds" : data.player
      ? `#${data.player.rank} ${data.player.name}: ${data.player.bestScore} · ${provenance(data.player)}`
      : `No official record for ${name}.`;
  } catch (error) {
    renderStatus(error.message || "Leaderboard is temporarily unavailable.");
    rankPlayer.textContent = "Local practice scores are not part of this leaderboard.";
  }
}

rankSearch.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = rankName.value.trim().replace(/\s+/g, " ").slice(0, 24);
  rankPlayer.textContent = "Searching…";
  void loadScores(name);
});

renderStatus("Loading leaderboard…");
void loadScores();
