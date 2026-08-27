const WIDTH = 1000;
const HEIGHT = 600;
const FPS_STEP = 1000 / 120;
const FRAME_RATE = 30;
const PIPE_INTERVAL = 1500;
const PIPE_WIDTH = 70;
const PIPE_HEIGHT = 400;
const GAP = 300;
const POPULATION_SIZE = 100;
const MAX_GENERATIONS = 50;
const EPOCH_SECONDS = 400;
const SUCCESS_SCORE = 50;
const REQUIRED_FISH = 50;
const SCREAMER_DURATION = 1200;
const SCREAMER_CHANCE = 0.25;
const SCORES_KEY = "flappy-fish-scores-by-name";
const LAST_PLAYER_KEY = "flappy-fish-last-player";
const SCORE_RESET_KEY = "flappy-fish-rank-reset-2026-08-26";
const DEFAULT_GOOGLE_SCORE_ENDPOINT = "https://script.google.com/macros/s/AKfycbx61g7C95a55gBJ63r1h58F2oeupmO54ommLPoIoc2vgQaMuq7B8r64q_hrYxXNxh4a7w/exec";
const LEGACY_GOOGLE_SCORE_ENDPOINTS = new Set([
  "https://script.google.com/macros/s/AKfycbyO3LwdrpR1Z4eSspiR-eiliyCS40fvxgAvO5dIh9_oaj9jvMGfmxaIEaZoX7mfVws0Fw/exec",
]);

const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");
const loading = document.getElementById("loading");
const bestScoreDisplay = document.getElementById("best-score-display");
const nameGate = document.getElementById("name-gate");
const nameForm = document.getElementById("name-form");
const playerNameInput = document.getElementById("player-name");
const nameBest = document.getElementById("name-best");

const assetPaths = {
  fish: "assets/img/fish1.png",
  pipe: "assets/img/alga2.png",
  seabed: "assets/img/pixil-frame-0.png",
  deadBackground: "assets/img/dead-fish.png",
  jumpScare: "assets/img/death2.png",
  ghost: "assets/img/death.png",
  learned: "assets/img/img_1.png",
  frames: Array.from({ length: 40 }, (_, index) => {
    return `assets/img/fondo_animado/frame_${String(index).padStart(3, "0")}.png`;
  }),
};

const audio = {
  flap: new Audio("assets/audios/efecto bubble.ogg"),
  music: new Audio("assets/audios/linkin park fondo.ogg"),
  scream: new Audio("assets/audios/scream.mp3"),
};

audio.music.loop = true;
audio.music.volume = 0.45;
audio.flap.volume = 0.45;
audio.scream.volume = 0.72;

const keys = new Set();
const images = {};
const pendingScorePings = new Set();
let audioUnlocked = false;

function gameFont(size) {
  return `${size}px "Strange Fish", fantasy`;
}

function normalizePlayerName(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 24);
}

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

function writeScores(scores) {
  localStorage.setItem(SCORES_KEY, JSON.stringify(scores));
}

function getBestScore(name) {
  if (!name) return 0;
  return readScores()[name] || 0;
}

function scoreEndpoint() {
  return String(window.FLAPPY_FISH_CONFIG?.scoreEndpoint || "").trim();
}

function isGoogleScoreEndpoint(endpoint) {
  return endpoint.includes("script.google.com/macros/s/");
}

function googleScoreEndpoint() {
  const config = window.FLAPPY_FISH_CONFIG || {};
  const explicitEndpoint = String(config.googleScoreEndpoint || "").trim();
  const configuredEndpoint = scoreEndpoint();

  if (explicitEndpoint && !LEGACY_GOOGLE_SCORE_ENDPOINTS.has(explicitEndpoint)) {
    return explicitEndpoint;
  }
  if (isGoogleScoreEndpoint(configuredEndpoint) && !LEGACY_GOOGLE_SCORE_ENDPOINTS.has(configuredEndpoint)) {
    return configuredEndpoint;
  }
  return DEFAULT_GOOGLE_SCORE_ENDPOINT;
}

function mergeRemoteBest(name, bestScore) {
  const remoteBest = Math.max(0, Math.floor(Number(bestScore ?? 0)));
  if (remoteBest <= getBestScore(name)) return;

  const scores = readScores();
  scores[name] = remoteBest;
  writeScores(scores);

  if (state.playerName === name) {
    state.highScore = remoteBest;
    updateNameBest(remoteBest);
    updateBestScoreDisplay(remoteBest);
  }
}

function bestRemoteScoreForName(scores, playerName) {
  const key = playerName.toLowerCase();
  return scores.reduce((bestScore, score) => {
    const name = String(score.name || "").trim().toLowerCase();
    if (name !== key) return bestScore;
    const value = Math.max(0, Math.floor(Number(score.bestScore ?? score.score ?? 0)));
    return Math.max(bestScore, value);
  }, 0);
}

function loadJsonpScores(endpoint) {
  if (!endpoint) return Promise.resolve([]);

  return new Promise((resolve) => {
    const callbackName = `flappyFishScores${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const script = document.createElement("script");
    const separator = endpoint.includes("?") ? "&" : "?";
    let finished = false;

    const cleanup = () => {
      window.clearTimeout(timeout);
      script.remove();
      delete window[callbackName];
    };

    const finish = (scores) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(Array.isArray(scores) ? scores : []);
    };

    const timeout = window.setTimeout(() => finish([]), 5000);

    window[callbackName] = (data) => finish(data?.scores);
    script.onerror = () => finish([]);
    script.src = `${endpoint}${separator}callback=${encodeURIComponent(callbackName)}&t=${Date.now()}`;
    document.head.append(script);
  });
}

async function refreshPlayerBestFromRemote(name) {
  if (!name) return;

  const sources = ["/api/scores", googleScoreEndpoint()];
  for (const endpoint of sources) {
    try {
      const scores = endpoint === "/api/scores"
        ? await fetch(endpoint).then((response) => response.json()).then((data) => data?.scores || [])
        : await loadJsonpScores(endpoint);
      mergeRemoteBest(name, bestRemoteScoreForName(scores, name));
    } catch {
      /* Remote scores are optional. */
    }
  }
}

function syncScoreToGoogleSheet(name, bestScore, lastScore) {
  if (!name) return;
  const endpoint = googleScoreEndpoint();
  const updatedAt = new Date().toISOString();
  const attemptId = `${updatedAt}-${Math.random().toString(36).slice(2, 10)}`;

  const payload = {
    name,
    bestScore,
    score: lastScore,
    updatedAt,
    attemptId,
  };

  const sendDirectToSheet = () => {
    if (!endpoint) return;

    try {
      const query = new URLSearchParams({
        action: "save",
        name,
        bestScore: String(bestScore),
        score: String(lastScore),
        updatedAt,
        attemptId,
        t: attemptId,
      });
      const queryUrl = `${endpoint}${endpoint.includes("?") ? "&" : "?"}${query.toString()}`;
      const img = new Image();
      pendingScorePings.add(img);
      img.onload = img.onerror = () => pendingScorePings.delete(img);
      img.src = queryUrl;
    } catch {}
  };

  sendDirectToSheet();

  try {
    fetch("/api/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

function savePlayerScore(score) {
  if (!state.playerName) return;
  const scores = readScores();
  const best = scores[state.playerName] || 0;
  if (score > best) {
    scores[state.playerName] = score;
    writeScores(scores);
    state.highScore = score;
    updateNameBest(score);
    updateBestScoreDisplay(score);
  }
}

function recordGameResult(score) {
  if (!state.playerName) return;
  const scores = readScores();
  const previousBest = scores[state.playerName] || 0;
  const best = Math.max(previousBest, score);

  if (best > previousBest) {
    scores[state.playerName] = best;
    writeScores(scores);
    state.highScore = best;
    updateNameBest(best);
    updateBestScoreDisplay(best);
  }

  syncScoreToGoogleSheet(state.playerName, best, score);
}

function setPlayerName(name) {
  state.playerName = name;
  const scores = readScores();
  if (!(name in scores)) {
    scores[name] = 0;
    writeScores(scores);
  }
  state.highScore = scores[name];
  localStorage.setItem(LAST_PLAYER_KEY, name);
  updateNameBest(state.highScore);
  updateBestScoreDisplay(state.highScore);
  refreshPlayerBestFromRemote(name);
}

function updateNameBest(score = getBestScore(normalizePlayerName(playerNameInput.value))) {
  nameBest.textContent = `Best score: ${score}`;
}

function updateBestScoreDisplay(score = state.highScore) {
  bestScoreDisplay.textContent = `Best score: ${score}`;
}

function isNameGateOpen() {
  return !nameGate.hidden;
}

resetLocalRankOnce();

const state = {
  mode: "menu",
  running: true,
  paused: false,
  started: false,
  gameOver: false,
  score: 0,
  highScore: 0,
  playerName: "",
  frameIndex: 0,
  frameTimer: 0,
  pipeTimer: 0,
  jumpScareUntil: 0,
  fish: null,
  pipes: [],
  population: [],
  generation: 1,
  generationTimer: 0,
  populationWeights: [],
  fitnessHistory: [],
  ghosts: [],
  learnedCount: 0,
  learned: false,
  stats: {
    dy: 0,
    dx: 0,
    vy: 0,
    genomeAvg: [],
    genomeStd: [],
  },
};

function loadImage(path) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${path}`));
    img.src = path;
  });
}

async function loadAssets() {
  const entries = Object.entries(assetPaths).filter(([key]) => key !== "frames");
  await Promise.all(entries.map(async ([key, path]) => {
    images[key] = await loadImage(path);
  }));
  images.frames = await Promise.all(assetPaths.frames.map(loadImage));
}

async function loadGameFont() {
  if (!document.fonts?.load) return;
  await document.fonts.load(gameFont(80));
  await document.fonts.ready;
}

function unlockAudio() {
  audioUnlocked = true;
}

function playSound(sound) {
  try {
    sound.currentTime = 0;
    sound.play().catch(() => {});
  } catch {
    /* Browser audio is optional. */
  }
}

function sharpenCanvas() {
  ctx.imageSmoothingEnabled = false;
  ctx.webkitImageSmoothingEnabled = false;
  ctx.mozImageSmoothingEnabled = false;
}

function configureCanvas() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(WIDTH * dpr);
  canvas.height = Math.round(HEIGHT * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sharpenCanvas();
}

function startMusic() {
  if (!audioUnlocked) return;
  audio.music.play().catch(() => {});
}

function stopMusic() {
  audio.music.pause();
  audio.music.currentTime = 0;
}

function randomBetween(low, high) {
  return low + Math.random() * (high - low);
}

function randomVector(low = -0.5, high = 0.5) {
  return Array.from({ length: 6 }, () => randomBetween(low, high));
}

function makePolicy(weights = randomVector()) {
  const w = [...weights];
  return {
    weights: w,
    decide(dy, dx, vy) {
      const dyN = dy / 400;
      const dxN = dx / 400;
      const vyN = vy / 300;
      const value = w[0]
        + w[1] * dyN
        + w[2] * dyN * dyN
        + w[3] * dxN
        + w[4] * dxN * dxN
        + w[5] * vyN;
      return value > 0;
    },
  };
}

function gaussianRandom() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function selectProportional(weights, fitnesses) {
  const positive = fitnesses.map((fitness) => Math.max(fitness, 0) ** 2);
  const total = positive.reduce((sum, fitness) => sum + fitness, 0);
  if (total === 0) {
    return weights[Math.floor(Math.random() * weights.length)];
  }

  let target = Math.random() * total;
  for (let index = 0; index < weights.length; index += 1) {
    target -= positive[index];
    if (target <= 0) return weights[index];
  }
  return weights[weights.length - 1];
}

function crossover(parentA, parentB) {
  const length = Math.min(parentA.length, parentB.length);
  const child = [];
  for (let index = 0; index < length; index += 1) {
    child.push(Math.random() < 0.5 ? parentA[index] : parentB[index]);
  }
  return child;
}

function mutate(weights, probability = 0.1, sigma = 0.05) {
  return weights.map((weight) => {
    return Math.random() < probability ? weight + gaussianRandom() * sigma : weight;
  });
}

function nextGeneration(weights, fitnesses, mutationProbability = 0.1, elitism = 2) {
  const ranked = weights
    .map((weight, index) => ({ weight, fitness: fitnesses[index] }))
    .sort((a, b) => b.fitness - a.fitness);
  const next = ranked.slice(0, elitism).map((item) => [...item.weight]);

  while (next.length < weights.length) {
    const parentA = selectProportional(weights, fitnesses);
    const parentB = selectProportional(weights, fitnesses);
    next.push(mutate(crossover(parentA, parentB), mutationProbability));
  }

  return next;
}

function createFish(x = 150, y = 300, size = 90) {
  return {
    x,
    y,
    width: size,
    height: size,
    velocity: 0,
    gravity: 0.3,
    jumpStrength: -10,
    maxFallSpeed: 100,
    alive: true,
  };
}

function resetFish(fish, x = 150, y = 300) {
  fish.x = x;
  fish.y = y;
  fish.velocity = 0;
  fish.alive = true;
}

function flapFish(fish) {
  fish.velocity = fish.jumpStrength;
}

function updateFish(fish) {
  fish.velocity += fish.gravity;
  if (fish.velocity > fish.maxFallSpeed) {
    fish.velocity = fish.maxFallSpeed;
  }
  fish.y += fish.velocity;
}

function fishRect(fish) {
  return {
    left: fish.x - fish.width / 2,
    right: fish.x + fish.width / 2,
    top: fish.y - fish.height / 2,
    bottom: fish.y + fish.height / 2,
    centerX: fish.x,
    centerY: fish.y,
  };
}

function createPipe() {
  const centerY = Math.floor(randomBetween(150, 451));
  return {
    x: WIDTH,
    gapY: centerY,
    gap: GAP,
    speed: 4,
    passed: false,
    id: globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`,
  };
}

function pipeRects(pipe) {
  return [
    {
      left: pipe.x - PIPE_WIDTH / 2,
      right: pipe.x + PIPE_WIDTH / 2,
      top: pipe.gapY - pipe.gap / 2 - PIPE_HEIGHT,
      bottom: pipe.gapY - pipe.gap / 2,
    },
    {
      left: pipe.x - PIPE_WIDTH / 2,
      right: pipe.x + PIPE_WIDTH / 2,
      top: pipe.gapY + pipe.gap / 2,
      bottom: pipe.gapY + pipe.gap / 2 + PIPE_HEIGHT,
    },
  ];
}

function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function nextPipeFor(fish) {
  const rect = fishRect(fish);
  return state.pipes.find((pipe) => pipe.x + PIPE_WIDTH / 2 >= rect.left);
}

function calculateState(fish) {
  const rect = fishRect(fish);
  const pipe = nextPipeFor(fish);
  if (!pipe) {
    return {
      dy: rect.centerY - HEIGHT / 2,
      dx: 200,
      vy: fish.velocity,
    };
  }
  return {
    dy: rect.centerY - pipe.gapY,
    dx: pipe.x - PIPE_WIDTH / 2 - rect.right,
    vy: fish.velocity,
  };
}

function getFishDeathCause(fish) {
  const rect = fishRect(fish);
  if (rect.top <= 0 || rect.bottom >= HEIGHT) {
    return "bounds";
  }

  for (const pipe of state.pipes) {
    if (pipeRects(pipe).some((pipeRect) => intersects(rect, pipeRect))) {
      return "pipe";
    }
  }

  return null;
}

function handleManualScoring() {
  const rect = fishRect(state.fish);
  for (const pipe of state.pipes) {
    if (pipe.x + PIPE_WIDTH / 2 < rect.left && !pipe.passed) {
      state.score += 1;
      pipe.passed = true;
      savePlayerScore(state.score);
    }
  }
}

function resetShared() {
  state.started = false;
  state.gameOver = false;
  state.paused = false;
  state.score = 0;
  state.pipeTimer = 0;
  state.jumpScareUntil = 0;
  state.pipes = [];
  state.population = [];
  state.ghosts = [];
  state.learned = false;
  state.learnedCount = 0;
  state.stats = {
    dy: 0,
    dx: 0,
    vy: 0,
    genomeAvg: [],
    genomeStd: [],
  };
}

function showMenu() {
  resetShared();
  state.mode = "menu";
  state.fish = createFish(150, 300, 90);
  stopMusic();
}

function startSingle() {
  resetShared();
  state.mode = "single";
  state.fish = createFish(150, 300, 90);
  startMusic();
}

function restartSingle() {
  resetShared();
  state.mode = "single";
  resetFish(state.fish || createFish(150, 300, 90));
  if (!state.fish) state.fish = createFish(150, 300, 90);
  startMusic();
}

function makeAgent(weights) {
  const policy = makePolicy(weights);
  return {
    fish: createFish(150, 300, 30),
    weights: policy.weights,
    decide: policy.decide,
    alive: true,
    score: 0,
    timeAlive: 0,
    passed: new Set(),
  };
}

function createPopulation(weights) {
  return weights.map(makeAgent);
}

function startEvolution() {
  resetShared();
  state.mode = "evolution";
  state.started = true;
  state.generation = 1;
  state.populationWeights = Array.from({ length: POPULATION_SIZE }, () => randomVector());
  state.population = createPopulation(state.populationWeights);
  stopMusic();
}

function evolveFromCurrent() {
  const weights = state.population.map((agent) => agent.weights);
  const fitnesses = state.population.map((agent) => agent.score * 1000 + agent.timeAlive);
  const best = Math.max(...fitnesses);
  state.fitnessHistory.push(best);
  if (state.fitnessHistory.length > 30) {
    state.fitnessHistory.shift();
  }

  if (state.generation >= MAX_GENERATIONS) {
    state.mode = "learned";
    return;
  }

  state.populationWeights = nextGeneration(weights, fitnesses, 0.1, 2);
  state.generation += 1;
  state.population = createPopulation(state.populationWeights);
  state.pipes = [];
  state.pipeTimer = 0;
  state.generationTimer = 0;
  state.score = 0;
  state.ghosts = [];
}

function spawnPipes(delta) {
  if (!state.started || state.gameOver || state.paused) return;
  state.pipeTimer += delta;
  if (state.pipeTimer >= PIPE_INTERVAL) {
    state.pipeTimer = 0;
    state.pipes.push(createPipe());
  }
}

function updatePipes() {
  for (const pipe of state.pipes) {
    pipe.x -= pipe.speed;
  }
  state.pipes = state.pipes.filter((pipe) => pipe.x > -PIPE_WIDTH);
}

function togglePause() {
  if (state.mode !== "single" && state.mode !== "evolution") return;
  state.paused = !state.paused;
  if (state.paused) {
    audio.music.pause();
  } else if (state.mode === "single" && state.started && !state.gameOver) {
    startMusic();
  }
}

function manualInput() {
  if (keys.has("ArrowLeft")) {
    state.fish.x -= 5;
  }
  if (keys.has("ArrowRight")) {
    state.fish.x += 5;
  }
  state.fish.x = Math.max(40, Math.min(WIDTH - 40, state.fish.x));
}

function performFlap() {
  if (state.mode !== "single" || state.paused) return;
  if (state.gameOver) return;
  if (!state.started) {
    state.started = true;
    startMusic();
  }
  flapFish(state.fish);
  playSound(audio.flap);
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
  };
}

function handleCanvasPress(event) {
  if (isNameGateOpen()) return;
  unlockAudio();

  if (state.mode === "menu") {
    const point = canvasPoint(event);
    if (point.y > HEIGHT * 0.43 && point.y < HEIGHT * 0.54) {
      startSingle();
      return;
    }
    if (point.y > HEIGHT * 0.56 && point.y < HEIGHT * 0.68) {
      startEvolution();
      return;
    }
  }

  performFlap();
}

function updateSingle(delta, now) {
  if (state.paused || state.gameOver) return;

  manualInput();
  spawnPipes(delta);

  if (!state.started) return;

  updateFish(state.fish);
  updatePipes();
  handleManualScoring();

  const deathCause = getFishDeathCause(state.fish);
  if (deathCause) {
    state.gameOver = true;
    recordGameResult(state.score);
    stopMusic();
    if (Math.random() < SCREAMER_CHANCE) {
      state.jumpScareUntil = now + SCREAMER_DURATION;
      playSound(audio.scream);
    }
  }
}

function updateGenomeStats() {
  const weights = state.population.map((agent) => agent.weights);
  if (!weights.length) {
    state.stats.genomeAvg = [];
    state.stats.genomeStd = [];
    return;
  }

  const length = weights[0].length;
  const averages = [];
  const stds = [];

  for (let index = 0; index < length; index += 1) {
    const values = weights.map((weight) => weight[index]);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    averages.push(mean);
    stds.push(Math.sqrt(variance));
  }

  state.stats.genomeAvg = averages;
  state.stats.genomeStd = stds;
}

function updateEvolution(delta) {
  if (state.paused || state.mode !== "evolution") return;

  spawnPipes(delta);
  state.generationTimer += delta / 1000;
  updatePipes();

  let aliveCount = 0;
  let bestScore = 0;
  let learnedCount = 0;

  for (const agent of state.population) {
    if (!agent.alive) continue;
    aliveCount += 1;
    agent.timeAlive += delta / 1000;

    const sensors = calculateState(agent.fish);
    if (agent.decide(sensors.dy, sensors.dx, sensors.vy)) {
      flapFish(agent.fish);
    }

    updateFish(agent.fish);
    const rect = fishRect(agent.fish);

    for (const pipe of state.pipes) {
      if (pipe.x + PIPE_WIDTH / 2 < rect.left && !agent.passed.has(pipe.id)) {
        agent.score += 1;
        agent.passed.add(pipe.id);
      }
    }

    if (getFishDeathCause(agent.fish)) {
      agent.alive = false;
      state.ghosts.push({ x: agent.fish.x, y: agent.fish.y });
    } else {
      bestScore = Math.max(bestScore, agent.score);
      if (agent.score >= SUCCESS_SCORE) learnedCount += 1;
    }
  }

  if (state.ghosts.length > 500) {
    state.ghosts = state.ghosts.slice(-500);
  }

  state.score = Math.max(state.score, bestScore);
  state.learnedCount = learnedCount;
  updateGenomeStats();

  const alive = state.population.filter((agent) => agent.alive);
  if (alive[0]) {
    state.stats = {
      ...state.stats,
      ...calculateState(alive[0].fish),
    };
  }

  if (learnedCount >= REQUIRED_FISH) {
    state.learned = true;
    state.mode = "learned";
    return;
  }

  if (aliveCount === 0 || state.generationTimer > EPOCH_SECONDS) {
    evolveFromCurrent();
  }
}

function drawBackground() {
  const frame = images.frames[state.frameIndex] || images.seabed;
  ctx.drawImage(frame, 0, 0, WIDTH, HEIGHT);
  ctx.drawImage(images.seabed, 0, 0, WIDTH, HEIGHT);
}

function drawText(text, x, y, size, color = "white", align = "center", maxWidth = null) {
  ctx.save();
  let fontSize = size;
  ctx.font = gameFont(fontSize);
  if (maxWidth) {
    while (fontSize > 18 && ctx.measureText(text).width > maxWidth) {
      fontSize -= 1;
      ctx.font = gameFont(fontSize);
    }
  }
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0, 10, 20, 0.88)";
  ctx.lineWidth = Math.max(4, fontSize * 0.08);
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawFish(fish, alpha = 1) {
  const angle = Math.max(-30, Math.min(90, fish.velocity * 3)) * Math.PI / 180;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(fish.x, fish.y);
  ctx.rotate(-angle);
  ctx.drawImage(images.fish, -fish.width / 2, -fish.height / 2, fish.width, fish.height);
  ctx.restore();
}

function drawPipe(pipe) {
  const x = pipe.x - PIPE_WIDTH / 2;
  const topBottom = pipe.gapY - pipe.gap / 2;
  const bottomTop = pipe.gapY + pipe.gap / 2;

  ctx.save();
  ctx.translate(x + PIPE_WIDTH / 2, topBottom - PIPE_HEIGHT / 2);
  ctx.scale(1, -1);
  ctx.drawImage(images.pipe, -PIPE_WIDTH / 2, -PIPE_HEIGHT / 2, PIPE_WIDTH, PIPE_HEIGHT);
  ctx.restore();

  ctx.drawImage(images.pipe, x, bottomTop, PIPE_WIDTH, PIPE_HEIGHT);
}

function drawScore() {
  drawText(String(state.score), 42, 62, 64, "rgb(250, 255, 246)", "left");
}

function drawMenu() {
  drawBackground();
  drawText("FLAPPY FISH!", WIDTH / 2, HEIGHT * 0.25, 100, "rgb(253, 231, 91)");
  drawText("1. Single Player (Manual Game)", WIDTH / 2, HEIGHT * 0.49, 50, "white", "center", 900);
  drawText("2. Simulation (Evolutionary Algorithm)", WIDTH / 2, HEIGHT * 0.61, 50, "white", "center", 900);
  drawText("GROUP 4: Osipova, Zanoni and Scofano", WIDTH / 2, HEIGHT - 52, 30, "rgb(233, 255, 244)", "center", 880);
}

function drawStartPrompt() {
  drawText("Press SPACE to begin!", WIDTH / 2, HEIGHT / 2, 36, "white", "center", 860);
}

function drawGameOver() {
  ctx.drawImage(images.deadBackground, 0, 0, WIDTH, HEIGHT);
  drawText("- GAME OVER -", WIDTH / 2, HEIGHT / 2 - 70, 80, "rgb(255, 61, 52)", "center", 900);
  drawText(`Total score: ${state.score}`, WIDTH / 2, HEIGHT / 2 + 10, 36, "white", "center", 850);
  drawText("Press SPACE to restart or M to return to Menu!", WIDTH / 2, HEIGHT / 2 + 58, 36, "white", "center", 940);
}

function drawStatsPanel() {
  const x = WIDTH - 340;
  ctx.save();
  ctx.fillStyle = "rgba(4, 12, 18, 0.82)";
  ctx.fillRect(x, 0, 340, HEIGHT);
  ctx.fillStyle = "rgb(254, 226, 76)";
  ctx.font = gameFont(26);
  ctx.fillText("GA Statistics", x + 20, 34);

  ctx.fillStyle = "white";
  ctx.font = gameFont(26);
  const alive = state.population.filter((agent) => agent.alive).length;
  const lines = [
    `Generation: ${state.generation}`,
    `Dx = ${state.stats.dx.toFixed(1)}`,
    `Dy = ${state.stats.dy.toFixed(1)}`,
    `Velocity = ${state.stats.vy.toFixed(3)}`,
    `Alive = ${alive}/${POPULATION_SIZE}`,
    `Tubes = ${state.pipes.length}`,
  ];
  lines.forEach((line, index) => {
    ctx.fillText(line, x + 20, 84 + index * 28);
  });

  ctx.fillStyle = "rgb(213, 226, 226)";
  ctx.fillText("Genome (Avg +/- Std)", x + 20, 276);

  const averages = state.stats.genomeAvg;
  const stds = state.stats.genomeStd;
  const maxAbs = Math.max(1, ...averages.map((avg, index) => Math.abs(avg) + stds[index]));
  averages.forEach((avg, index) => {
    const y = 306 + index * 24;
    const barX = x + 80;
    const barW = 170;
    const zeroX = barX + barW / 2;
    ctx.fillStyle = "rgb(190, 203, 203)";
    ctx.fillText(`w${index}:`, x + 20, y + 10);
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
    ctx.fillRect(barX, y, barW, 10);
    const stdW = Math.min((Math.abs(stds[index]) / maxAbs) * (barW / 2), barW / 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.24)";
    ctx.fillRect(zeroX - stdW, y, stdW * 2, 10);
    const valueW = Math.min((Math.abs(avg) / maxAbs) * (barW / 2), barW / 2);
    ctx.fillStyle = avg >= 0 ? "rgb(85, 202, 111)" : "rgb(224, 84, 75)";
    ctx.fillRect(avg >= 0 ? zeroX : zeroX - valueW, y, valueW, 10);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.strokeRect(barX, y, barW, 10);
    ctx.fillStyle = "rgb(190, 203, 203)";
    ctx.fillText(avg.toFixed(3), x + 262, y + 10);
  });

  drawFitnessGraph(x + 15, HEIGHT - 86, 310, 70);
  ctx.restore();
}

function drawFitnessGraph(x, y, w, h) {
  ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.78)";
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "rgb(220, 230, 226)";
  ctx.font = gameFont(20);
  ctx.fillText("Fitness Progress", x + 8, y + 18);

  if (state.fitnessHistory.length < 2) return;

  const values = state.fitnessHistory;
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) max = min + 1;

  ctx.beginPath();
  values.forEach((value, index) => {
    const px = x + 5 + (index / (values.length - 1)) * (w - 10);
    const norm = (value - min) / (max - min);
    const py = y + h - 6 - norm * (h - 28);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = "rgb(254, 226, 76)";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawLearned() {
  drawBackground();
  ctx.drawImage(images.learned, WIDTH / 2 - 185, HEIGHT / 2 - 192, 370, 288);
  const message = state.learned
    ? `Learning complete: ${state.learnedCount} fish scored ${SUCCESS_SCORE}+`
    : `Simulation complete after ${MAX_GENERATIONS} generations`;
  drawText(message, WIDTH / 2, HEIGHT / 2 + 140, 31);
  drawText("Press M for Menu", WIDTH / 2, HEIGHT / 2 + 182, 29);
}

function drawJumpScare(now) {
  if (state.jumpScareUntil <= now) return;
  ctx.drawImage(images.jumpScare, 0, 0, WIDTH, HEIGHT);
}

function drawGame(now) {
  sharpenCanvas();

  if (state.mode === "menu") {
    drawMenu();
    return;
  }

  if (state.mode === "learned") {
    drawLearned();
    return;
  }

  if (state.gameOver && state.mode === "single") {
    drawGameOver();
    drawJumpScare(now);
    return;
  }

  drawBackground();
  for (const pipe of state.pipes) drawPipe(pipe);

  if (state.mode === "single") {
    drawFish(state.fish);
    if (state.started) drawScore();
    else drawStartPrompt();
  }

  if (state.mode === "evolution") {
    for (const ghost of state.ghosts) {
      ctx.save();
      ctx.globalAlpha = 0.38;
      ctx.drawImage(images.ghost, ghost.x - 15, ghost.y - 15, 30, 30);
      ctx.restore();
    }
    for (const agent of state.population) {
      if (agent.alive) drawFish(agent.fish, 0.72);
    }
    drawScore();
    drawStatsPanel();
  }

  if (state.paused) {
    ctx.save();
    ctx.fillStyle = "rgba(3, 11, 20, 0.42)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.restore();
    drawText("Paused", WIDTH / 2, HEIGHT / 2, 64, "rgb(254, 226, 76)");
  }
}

let lastTime = performance.now();
let accumulator = 0;

function tick(now) {
  const frameDelta = Math.min(60, now - lastTime);
  lastTime = now;
  accumulator += frameDelta;

  state.frameTimer += frameDelta;
  if (state.frameTimer >= 1000 / FRAME_RATE) {
    state.frameTimer = 0;
    state.frameIndex = (state.frameIndex + 1) % images.frames.length;
  }

  while (accumulator >= FPS_STEP) {
    if (state.mode === "single") {
      updateSingle(FPS_STEP, now);
    } else if (state.mode === "evolution") {
      updateEvolution(FPS_STEP);
    }
    accumulator -= FPS_STEP;
  }

  drawGame(now);
  requestAnimationFrame(tick);
}

window.addEventListener("keydown", (event) => {
  const activeTag = document.activeElement?.tagName;

  if (isNameGateOpen()) {
    return;
  }

  if (activeTag === "INPUT") {
    return;
  }

  if (activeTag === "BUTTON" && (event.code === "Space" || event.code === "Enter")) {
    return;
  }

  if (event.repeat) return;
  keys.add(event.code);
  unlockAudio();

  if (state.mode === "menu") {
    if (event.key === "1") startSingle();
    if (event.key === "2") startEvolution();
    return;
  }

  if (event.code === "Space") {
    event.preventDefault();
    if (state.gameOver) {
      restartSingle();
    } else {
      performFlap();
    }
  } else if (event.key.toLowerCase() === "m" || event.key === "Escape") {
    showMenu();
  } else if (event.key.toLowerCase() === "p") {
    togglePause();
  }
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

window.addEventListener("resize", configureCanvas);

canvas.addEventListener("pointerdown", handleCanvasPress);

playerNameInput.addEventListener("input", () => {
  updateNameBest();
  updateBestScoreDisplay(getBestScore(normalizePlayerName(playerNameInput.value)));
});

nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = normalizePlayerName(playerNameInput.value);
  if (!name) {
    playerNameInput.focus();
    return;
  }
  setPlayerName(name);
  nameGate.hidden = true;
  canvas.focus();
});

Promise.all([loadAssets(), loadGameFont()]).then(() => {
  configureCanvas();
  state.fish = createFish(150, 300, 90);
  const lastPlayer = localStorage.getItem(LAST_PLAYER_KEY) || "";
  playerNameInput.value = lastPlayer;
  updateNameBest();
  updateBestScoreDisplay(getBestScore(normalizePlayerName(lastPlayer)));
  loading.classList.add("is-hidden");
  playerNameInput.focus();
  requestAnimationFrame(tick);
}).catch((error) => {
  loading.textContent = error.message;
});
