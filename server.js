import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = "0.0.0.0";

const GOOGLE_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzXpMNE7NNxZ5avz8GZzQYldIyszmpIiV11lq7gl3G3n0FeOh2wDPbr9vrn92X5tsvq_g/exec";

// In-memory scores store for session leaderboard
const scoresMap = new Map();

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

// Leaderboard API
app.get("/api/scores", (req, res) => {
  const scores = Array.from(scoresMap.entries())
    .map(([name, bestScore]) => ({ name, bestScore }))
    .sort((a, b) => b.bestScore - a.bestScore || a.name.localeCompare(b.name));

  const callback = req.query.callback;
  if (callback && typeof callback === "string") {
    res.type("text/javascript");
    return res.send(`${callback}(${JSON.stringify({ scores })});`);
  }

  res.json({ scores });
});

app.post("/api/scores", async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    if (body && body.name) {
      const name = String(body.name).trim().slice(0, 24);
      const score = Math.max(0, Math.floor(Number(body.bestScore || body.score || 0)));
      const existing = scoresMap.get(name) || 0;
      if (score >= existing) {
        scoresMap.set(name, score);
      }

      // 1. Send GET to Apps Script (which triggers doGet save)
      fetch(`${GOOGLE_APPS_SCRIPT_URL}?name=${encodeURIComponent(name)}&bestScore=${score}&score=${score}&t=${Date.now()}`, {
        redirect: "follow",
      }).catch((e) => console.error("Error forwarding GET to Apps Script:", e.message));

      // 2. Send POST to Apps Script (which triggers doPost save)
      fetch(GOOGLE_APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ name, bestScore: score, score }),
        redirect: "follow",
      }).catch((e) => console.error("Error forwarding POST to Apps Script:", e.message));
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
