import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = "0.0.0.0";
const GOOGLE_SCORE_ENDPOINT = String(process.env.GOOGLE_SCORE_ENDPOINT || "").trim();
const SCORE_WRITE_SECRET = String(process.env.SCORE_WRITE_SECRET || "").trim();
const GOOGLE_SCORE_TIMEOUT_MS = 5000;

// In-memory scores store for session leaderboard
const scoresMap = new Map();

function normalizeScoreValue(value) {
  return Math.max(0, Math.floor(Number(value || 0)));
}

function cleanScorePayload(payload) {
  if (!payload || typeof payload !== "object") return null;

  const name = String(payload.name || "").trim().replace(/\s+/g, " ").slice(0, 24);
  if (!name) return null;

  const score = normalizeScoreValue(payload.score);
  const bestScore = Math.max(score, normalizeScoreValue(payload.bestScore ?? score));
  const updatedAt = String(payload.updatedAt || new Date().toISOString());
  const attemptId = String(
    payload.attemptId || `${updatedAt}-${Math.random().toString(36).slice(2, 10)}`
  ).slice(0, 100);

  return { name, score, bestScore, updatedAt, attemptId };
}

function parseRequestBody(req) {
  let body = req.body;
  if (typeof body !== "string") return body;

  try {
    return JSON.parse(body);
  } catch {
    return req.query || {};
  }
}

function normalizeScores(scores) {
  const bestByName = new Map();

  for (const score of scores) {
    const cleanScore = cleanScorePayload(score);
    if (!cleanScore) continue;

    const key = cleanScore.name.toLowerCase();
    const current = bestByName.get(key);
    if (!current || cleanScore.bestScore > current.bestScore) {
      bestByName.set(key, {
        name: cleanScore.name,
        bestScore: cleanScore.bestScore,
      });
    }
  }

  return Array.from(bestByName.values())
    .sort((a, b) => b.bestScore - a.bestScore || a.name.localeCompare(b.name));
}

function localScores() {
  return Array.from(scoresMap.entries())
    .map(([name, bestScore]) => ({ name, bestScore }));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_SCORE_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function loadGoogleScores() {
  if (!GOOGLE_SCORE_ENDPOINT) return [];

  try {
    const url = new URL(GOOGLE_SCORE_ENDPOINT);
    url.searchParams.set("t", String(Date.now()));
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`Google score endpoint returned ${response.status}`);
    }
    const data = await response.json();
    return Array.isArray(data?.scores) ? data.scores : [];
  } catch (error) {
    console.warn(`Could not load Google scores: ${error.message}`);
    return [];
  }
}

async function forwardScoreToGoogleSheet(score) {
  if (!GOOGLE_SCORE_ENDPOINT || !SCORE_WRITE_SECRET) return false;

  try {
    const response = await fetchWithTimeout(GOOGLE_SCORE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...score,
        secret: SCORE_WRITE_SECRET,
      }),
    });

    if (!response.ok) {
      throw new Error(`Google score endpoint returned ${response.status}`);
    }

    return true;
  } catch (error) {
    console.warn(`Could not forward score to Google Sheets: ${error.message}`);
    return false;
  }
}

// Middlewares
app.use(express.json());
app.use(express.text({ type: "*/*" }));

// Enable CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/favicon.ico", (req, res) => {
  res.type("png").sendFile(path.join(__dirname, "src/web/favicon.png"));
});

// Leaderboard API
app.get("/api/scores", async (req, res) => {
  const googleScores = await loadGoogleScores();
  const storedScores = localScores();
  const scores = normalizeScores([
    ...googleScores,
    ...storedScores,
  ]);

  const callback = req.query.callback;
  if (callback && typeof callback === "string") {
    res.type("text/javascript");
    return res.send(`${callback}(${JSON.stringify({ scores })});`);
  }

  res.json({ scores });
});

app.post("/api/scores", async (req, res) => {
  try {
    const score = cleanScorePayload(parseRequestBody(req));
    if (score) {
      const existing = scoresMap.get(score.name) || 0;
      if (score.bestScore >= existing) {
        scoresMap.set(score.name, score.bestScore);
      }
      await forwardScoreToGoogleSheet(score);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "Invalid payload" });
  }
});

// Static assets from /data mounted at /assets
app.use("/assets", express.static(path.join(__dirname, "data")));

// Static web files from /src/web
app.use(express.static(path.join(__dirname, "src/web")));

// Fallback to index.html for SPA routing
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "src/web", "index.html"));
});

app.listen(PORT, HOST, () => {
  console.log(`Flappy Fish server running at http://${HOST}:${PORT}`);
});
