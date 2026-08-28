import { createInitialState, step as stepManual, fishRotation as manualFishRotation, INPUT_LEFT, INPUT_RIGHT, INPUT_FLAP } from "../shared/game-core.js";
import { RankedClient } from "./ranked-client.js";

const PRACTICE_ONLY = document.querySelector('meta[name="flappy-fish-mode"]')?.content === "practice";

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
const TOUCH_MENU_HOLD_MS = 650;
const LAST_PLAYER_KEY = "flappy-fish-last-player";

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

const FISH_ALPHA_HIT_THRESHOLD = 32;
const ASSET_RETRY_VERSION = "20260828-hitmask-loader";
const optionalImageFallbacks = {
  ghost: "fish",
};
const fishHitMask = {
  points: [],
  imageWidth: 1,
  imageHeight: 1,
  localBounds: null,
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
let audioUnlocked = false;
let heldCanvasAction = null;

function gameFont(size) {
  return `${size}px "Strange Fish", fantasy`;
}

function normalizePlayerName(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 24);
}

function isBlockedPlayerName(name) {
  return Boolean(window.FLAPPY_FISH_NAME_FILTER?.containsProfanity?.(name));
}

// Only server responses contribute to the official best. Local storage remembers
// a nickname, never a score or a credential.
const officialBests = new Map();
let bestLookupTimer;

function getBestScore(name) {
  return officialBests.get(name.toLowerCase())?.bestScore ?? null;
}

async function refreshPlayerBestFromRemote(name) {
  if (PRACTICE_ONLY || !name) return;
  try {
    const response = await fetch(`/api/scores?name=${encodeURIComponent(name)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Leaderboard unavailable");
    const data = await response.json();
    officialBests.set(name.toLowerCase(), data.player || { bestScore: 0 });
    if (state.playerName.toLowerCase() === name.toLowerCase()) {
      state.highScore = getBestScore(name);
      updateBestScoreDisplay();
    }
    if (normalizePlayerName(playerNameInput.value).toLowerCase() === name.toLowerCase()) updateNameBest();
  } catch {
    // A failed lookup must not turn a browser-local record into an official one.
  }
}

function setPlayerName(name) {
  state.playerName = name;
  state.highScore = getBestScore(name);
  try { localStorage.setItem(LAST_PLAYER_KEY, name); } catch { /* Nickname persistence is optional. */ }
  updateNameBest(state.highScore);
  updateBestScoreDisplay();
  void refreshPlayerBestFromRemote(name);
}

function updateNameBest(score = getBestScore(normalizePlayerName(playerNameInput.value))) {
  nameBest.classList.remove("is-error");
  playerNameInput.removeAttribute("aria-invalid");
  nameBest.textContent = PRACTICE_ONLY ? "Practice only — no leaderboard" : score === null ? "Official best: unavailable" : `Official best: ${score}`;
}

function showNameError(message) {
  nameBest.classList.add("is-error");
  playerNameInput.setAttribute("aria-invalid", "true");
  nameBest.textContent = message;
}

function updateBestScoreDisplay(score = state.highScore) {
  bestScoreDisplay.textContent = PRACTICE_ONLY ? "Practice only — no leaderboard" : score === null ? "Official best: unavailable" : `Official best: ${score}`;
}

function isNameGateOpen() {
  return !nameGate.hidden;
}

const state = {
  mode: "menu",
  running: true,
  paused: false,
  started: false,
  gameOver: false,
  score: 0,
  highScore: null,
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

let manualKind = null;
let manualSnapshot = null;
let pendingFlap = false;
let startingGame = false;
let lastRankedEvent = { status: "idle" };
let refreshedGameId = null;
const rankedNotice = document.getElementById("ranked-notice");
const rankedStartButton = document.getElementById("ranked-start");
const rankedResumeButton = document.getElementById("ranked-resume");
const pauseButton = document.getElementById("game-pause");
const practiceButton = document.getElementById("practice-start");
const ranked = new RankedClient({ onChange(event) {
  lastRankedEvent = event;
  if (manualKind === "ranked" && event.snapshot) {
    mirrorManual(event.snapshot);
    if (!event.running) audio.music.pause();
  }
  if (event.status === "completed" && event.receipt?.gameId !== refreshedGameId) {
    refreshedGameId = event.receipt.gameId;
    void refreshPlayerBestFromRemote(event.name);
  }
  updateRankedNotice();
} });

function updateRankedNotice() {
  const event = lastRankedEvent;
  let message;
  if (PRACTICE_ONLY) {
    message = "Practice-only deployment. Manual play and Evolution are available; no scores are sent or added to the leaderboard.";
  } else if (manualKind === "practice") {
    message = "Practice — this game will not enter the leaderboard.";
  } else if (state.mode === "evolution" || state.mode === "learned") {
    message = "Evolution simulation — no ranked scores are submitted.";
  } else if (event.status === "completed") {
    message = `Verified result saved: ${event.receipt.checkpoint.snapshot.score}. It may take 30 seconds to appear in Rank; reopen Rank to refresh.`;
  } else if (event.status === "active") {
    message = `Ranked: ${event.name}. Inputs are checked every 10 seconds. Only completed games enter the leaderboard.`;
  } else if (event.status === "saving") {
    message = "Game over. Waiting for the server to confirm your result…";
  } else if (event.status === "pausing") {
    message = "Paused locally. Waiting to save the remaining inputs and release your ranked slot…";
  } else if (event.status === "paused" && event.receipt?.status === "paused" && !event.bufferedTicks && !event.error) {
    message = `Ranked game for ${event.name} is saved and paused. Your slot is free. Resume when a slot is available.`;
  } else if (event.status === "buffer_full") {
    message = "Paused: 30 seconds of unconfirmed inputs are buffered. Waiting for the connection; your result is not yet saved.";
  } else if (event.status === "reconnecting") {
    message = `Connection interrupted. ${Math.ceil((event.bufferedTicks || 0) / 120)} seconds of inputs await confirmation. The game pauses when the buffer reaches 30 seconds.`;
  } else if (event.status === "full") {
    message = "All ranked slots are busy. Wait and retry, or explicitly choose practice.";
  } else if (event.status === "connecting") {
    message = "Connecting to the ranked server…";
  } else if (event.error) {
    message = `${event.error.message} You can choose practice; it does not enter the leaderboard.`;
  } else if (event.status === "paused" || ranked.unfinished) {
    message = "A ranked game is waiting to resume. Unconfirmed inputs are kept in this browser.";
  } else {
    message = "Play ranked, or choose practice. Names are shared: the leaderboard does not verify who owns a nickname.";
  }
  rankedNotice.textContent = message;
  rankedNotice.dataset.status = PRACTICE_ONLY || manualKind === "practice" ? "practice" : event.status;
  rankedStartButton.disabled = startingGame || event.status === "connecting";
  rankedStartButton.hidden = PRACTICE_ONLY || Boolean(ranked.unfinished && ranked.receipt) || (manualKind === "ranked" && !state.gameOver);
  rankedResumeButton.hidden = PRACTICE_ONLY || !ranked.unfinished || !ranked.receipt || (manualKind === "ranked" && ranked.running);
  rankedResumeButton.disabled = startingGame || event.status === "connecting" || event.status === "conflict" || event.status === "storage_error";
  rankedResumeButton.textContent = event.status === "full" ? "Retry ranked slot" : "Resume / retry ranked";
  pauseButton.hidden = state.mode !== "single" && state.mode !== "evolution";
  pauseButton.disabled = state.gameOver || startingGame;
  pauseButton.textContent = state.paused ? "Resume" : "Pause";
  practiceButton.disabled = startingGame;
  practiceButton.textContent = manualKind === "ranked" && !state.gameOver ? "Continue as practice" : "Practice (unranked)";
}

async function resumeRanked() {
  if (PRACTICE_ONLY) return startPractice();
  if (startingGame || isNameGateOpen()) return;
  startingGame = true;
  try {
    const snapshot = await ranked.resume();
    installManual(snapshot, "ranked");
  } catch {
    updateRankedNotice();
  } finally {
    startingGame = false;
    updateRankedNotice();
  }
}

function cacheBustedPath(path) {
  return `${path}${path.includes("?") ? "&" : "?"}v=${ASSET_RETRY_VERSION}`;
}

function loadImage(path, retryCache = true) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      if (retryCache) {
        loadImage(cacheBustedPath(path), false).then(resolve, () => {
          reject(new Error(`Could not load ${path}`));
        });
        return;
      }
      reject(new Error(`Could not load ${path}`));
    };
    img.src = path;
  });
}

async function loadAssets() {
  const entries = Object.entries(assetPaths).filter(([key]) => key !== "frames");
  const requiredEntries = entries.filter(([key]) => !(key in optionalImageFallbacks));
  const optionalEntries = entries.filter(([key]) => key in optionalImageFallbacks);

  await Promise.all(requiredEntries.map(async ([key, path]) => {
    images[key] = await loadImage(path);
  }));
  await Promise.all(optionalEntries.map(async ([key, path]) => {
    try {
      images[key] = await loadImage(path);
    } catch (error) {
      console.warn(error.message);
      images[key] = images[optionalImageFallbacks[key]];
    }
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

function fishRotation(fish) {
  return -Math.max(-30, Math.min(90, fish.velocity * 3)) * Math.PI / 180;
}

function buildFishHitMask() {
  const image = images.fish;
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  if (!imageWidth || !imageHeight) return;

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = imageWidth;
  maskCanvas.height = imageHeight;
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
  if (!maskCtx) return;

  try {
    maskCtx.drawImage(image, 0, 0);
    const { data } = maskCtx.getImageData(0, 0, imageWidth, imageHeight);
    const points = [];
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;

    for (let y = 0; y < imageHeight; y += 1) {
      for (let x = 0; x < imageWidth; x += 1) {
        const alpha = data[(y * imageWidth + x) * 4 + 3];
        if (alpha <= FISH_ALPHA_HIT_THRESHOLD) continue;

        const localX = (x + 0.5) / imageWidth - 0.5;
        const localY = (y + 0.5) / imageHeight - 0.5;
        points.push({ x: localX, y: localY });
        left = Math.min(left, localX);
        right = Math.max(right, localX);
        top = Math.min(top, localY);
        bottom = Math.max(bottom, localY);
      }
    }

    if (!points.length) return;

    fishHitMask.points = points;
    fishHitMask.imageWidth = imageWidth;
    fishHitMask.imageHeight = imageHeight;
    fishHitMask.localBounds = { left, right, top, bottom };
  } catch {
    fishHitMask.points = [];
    fishHitMask.localBounds = null;
  }
}

function fallbackFishRect(fish) {
  return {
    left: fish.x - fish.width / 2,
    right: fish.x + fish.width / 2,
    top: fish.y - fish.height / 2,
    bottom: fish.y + fish.height / 2,
    centerX: fish.x,
    centerY: fish.y,
  };
}

function fishRect(fish) {
  const bounds = fishHitMask.localBounds;
  if (!bounds) return fallbackFishRect(fish);

  const rotation = fishRotation(fish);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const padX = 0.5 / fishHitMask.imageWidth;
  const padY = 0.5 / fishHitMask.imageHeight;
  const corners = [
    { x: bounds.left - padX, y: bounds.top - padY },
    { x: bounds.right + padX, y: bounds.top - padY },
    { x: bounds.right + padX, y: bounds.bottom + padY },
    { x: bounds.left - padX, y: bounds.bottom + padY },
  ];
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;

  for (const corner of corners) {
    const localX = corner.x * fish.width;
    const localY = corner.y * fish.height;
    const worldX = fish.x + localX * cos - localY * sin;
    const worldY = fish.y + localX * sin + localY * cos;
    left = Math.min(left, worldX);
    right = Math.max(right, worldX);
    top = Math.min(top, worldY);
    bottom = Math.max(bottom, worldY);
  }

  return {
    left,
    right,
    top,
    bottom,
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

function fishSampleRadius(fish) {
  return Math.max(fish.width / fishHitMask.imageWidth, fish.height / fishHitMask.imageHeight) / 2;
}

function forEachFishHitPoint(fish, callback) {
  const points = fishHitMask.points;
  if (!points.length) return false;

  const rotation = fishRotation(fish);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const radius = fishSampleRadius(fish);

  for (const point of points) {
    const localX = point.x * fish.width;
    const localY = point.y * fish.height;
    const worldX = fish.x + localX * cos - localY * sin;
    const worldY = fish.y + localX * sin + localY * cos;
    if (callback(worldX, worldY, radius)) return true;
  }

  return false;
}

function fishTouchesBounds(fish) {
  if (!fishHitMask.points.length) {
    const rect = fallbackFishRect(fish);
    return rect.top <= 0 || rect.bottom >= HEIGHT;
  }

  return forEachFishHitPoint(fish, (x, y, radius) => {
    return y - radius <= 0 || y + radius >= HEIGHT;
  });
}

function fishIntersectsRect(fish, rect) {
  if (!fishHitMask.points.length) {
    return intersects(fallbackFishRect(fish), rect);
  }

  return forEachFishHitPoint(fish, (x, y, radius) => {
    return x + radius >= rect.left
      && x - radius <= rect.right
      && y + radius >= rect.top
      && y - radius <= rect.bottom;
  });
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
  if ((rect.top <= 0 || rect.bottom >= HEIGHT) && fishTouchesBounds(fish)) {
    return "bounds";
  }

  for (const pipe of state.pipes) {
    if (pipeRects(pipe).some((pipeRect) => {
      return intersects(rect, pipeRect) && fishIntersectsRect(fish, pipeRect);
    })) {
      return "pipe";
    }
  }

  return null;
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
  if (manualKind === "ranked" && !state.gameOver) void ranked.pause();
  manualKind = null;
  pendingFlap = false;
  resetShared();
  state.mode = "menu";
  state.fish = createFish(150, 300, 90);
  stopMusic();
  updateRankedNotice();
}

function installManual(snapshot, kind) {
  resetShared();
  state.mode = "single";
  manualKind = kind;
  manualSnapshot = snapshot;
  pendingFlap = false;
  mirrorManual(snapshot);
  canvas.focus();
  if (!state.paused && !state.gameOver) startMusic();
  updateRankedNotice();
}

function mirrorManual(snapshot) {
  manualSnapshot = snapshot;
  state.fish = snapshot.fish;
  // Presentation aliases do not become part of the signed physical state.
  state.pipes = snapshot.pipes.map((pipe) => ({ ...pipe, gapY: pipe.centerY }));
  state.started = snapshot.started;
  state.score = snapshot.score;
  state.gameOver = snapshot.dead;
  if (manualKind === "ranked") state.paused = !ranked.running && !snapshot.dead;
}

async function startSingle() {
  if (PRACTICE_ONLY) return startPractice();
  if (startingGame || isNameGateOpen()) return;
  startingGame = true;
  try {
    if (manualKind === "ranked" && manualSnapshot?.dead && ranked.unfinished) {
      await ranked.pump();
      if (ranked.unfinished) return;
    }
    let snapshot;
    if (ranked.receipt && ranked.unfinished) snapshot = await ranked.resume();
    else snapshot = await ranked.start(state.playerName);
    installManual(snapshot, "ranked");
  } catch {
    updateRankedNotice();
  } finally {
    startingGame = false;
    updateRankedNotice();
  }
}

function startPractice() {
  if (isNameGateOpen()) return;
  const continuation = manualKind === "ranked" && manualSnapshot && !manualSnapshot.dead
    ? structuredClone(manualSnapshot) : null;
  if (manualKind === "ranked") void ranked.pause();
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  installManual(continuation || createInitialState(seed), "practice");
}

function restartSingle() {
  if (manualKind === "practice") startPractice();
  else void startSingle();
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
  if (manualKind === "ranked") void ranked.pause();
  manualKind = null;
  resetShared();
  state.mode = "evolution";
  state.started = true;
  state.generation = 1;
  state.populationWeights = Array.from({ length: POPULATION_SIZE }, () => randomVector());
  state.population = createPopulation(state.populationWeights);
  stopMusic();
  updateRankedNotice();
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
  pendingFlap = false;
  keys.clear();
  if (manualKind === "ranked") {
    if (state.gameOver) return;
    if (state.paused) void resumeRanked();
    else {
      state.paused = true;
      audio.music.pause();
      void ranked.pause();
    }
    return;
  }
  state.paused = !state.paused;
  if (state.paused) audio.music.pause();
  else {
    canvas.focus();
    if (state.mode === "single" && state.started && !state.gameOver) startMusic();
  }
  updateRankedNotice();
}

function performFlap() {
  if (state.mode !== "single" || state.paused || state.gameOver) return;
  pendingFlap = true;
}

function usesTouchControls() {
  return Boolean(
    navigator.maxTouchPoints > 0 ||
    window.matchMedia?.("(pointer: coarse)")?.matches
  );
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * HEIGHT,
  };
}

function clearHeldCanvasAction() {
  if (heldCanvasAction?.timer) {
    window.clearTimeout(heldCanvasAction.timer);
  }
  heldCanvasAction = null;
}

function startHeldCanvasAction(event, action) {
  clearHeldCanvasAction();
  heldCanvasAction = {
    action,
    handled: false,
    pointerId: event.pointerId,
    timer: window.setTimeout(() => {
      if (!heldCanvasAction || heldCanvasAction.pointerId !== event.pointerId) return;
      heldCanvasAction.handled = true;
      showMenu();
    }, TOUCH_MENU_HOLD_MS),
  };
}

function handleCanvasPointerDown(event) {
  if (event.isPrimary === false) return;
  if (isNameGateOpen()) return;
  event.preventDefault();
  unlockAudio();

  canvas.setPointerCapture?.(event.pointerId);

  if (state.mode === "single" && state.gameOver) {
    startHeldCanvasAction(event, "restart");
    return;
  }

  if (state.mode === "learned") {
    showMenu();
    return;
  }

  if (state.mode === "evolution") {
    startHeldCanvasAction(event, "menu");
    return;
  }

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

function handleCanvasPointerUp(event) {
  if (!heldCanvasAction || heldCanvasAction.pointerId !== event.pointerId) return;
  const { action, handled } = heldCanvasAction;
  clearHeldCanvasAction();

  if (handled) return;
  if (action === "restart" && state.mode === "single" && state.gameOver) {
    restartSingle();
  }
}

function updateSingle(delta, now) {
  if (state.paused || state.gameOver || !manualSnapshot) return;
  let input = 0;
  if (keys.has("ArrowLeft")) input |= INPUT_LEFT;
  if (keys.has("ArrowRight")) input |= INPUT_RIGHT;
  if (pendingFlap) input |= INPUT_FLAP;
  pendingFlap = false;
  const snapshot = manualKind === "ranked"
    ? ranked.advance(input) : stepManual(manualSnapshot, input);
  if (!snapshot) {
    state.paused = true;
    return;
  }
  mirrorManual(snapshot);
  if (input & INPUT_FLAP) {
    startMusic();
    playSound(audio.flap);
  }
  if (snapshot.dead) {
    stopMusic();
    if (manualKind === "practice") updateRankedNotice();
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
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(fish.x, fish.y);
  ctx.rotate(manualKind && state.mode === "single" ? manualFishRotation(fish) : fishRotation(fish));
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
  drawText(PRACTICE_ONLY ? "1. Single Player (Practice)" : "1. Single Player (Ranked Game)", WIDTH / 2, HEIGHT * 0.49, 50, "white", "center", 900);
  drawText("2. Simulation (Evolutionary Algorithm)", WIDTH / 2, HEIGHT * 0.61, 50, "white", "center", 900);
  drawText("GROUP 4: Osipova, Zanoni and Scofano", WIDTH / 2, HEIGHT - 52, 30, "rgb(233, 255, 244)", "center", 880);
}

function drawStartPrompt() {
  const message = usesTouchControls() ? "Tap to begin!" : "Press SPACE to begin!";
  drawText(message, WIDTH / 2, HEIGHT / 2, 36, "white", "center", 860);
}

function drawGameOver() {
  ctx.drawImage(images.deadBackground, 0, 0, WIDTH, HEIGHT);
  drawText("- GAME OVER -", WIDTH / 2, HEIGHT / 2 - 70, 80, "rgb(255, 61, 52)", "center", 900);
  drawText(`Total score: ${state.score}`, WIDTH / 2, HEIGHT / 2 + 10, 36, "white", "center", 850);
  const message = usesTouchControls()
    ? "Tap to restart or hold to return to Menu!"
    : "Press SPACE to restart or M to return to Menu!";
  drawText(message, WIDTH / 2, HEIGHT / 2 + 58, 36, "white", "center", 940);
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
  drawText(usesTouchControls() ? "Tap for Menu" : "Press M for Menu", WIDTH / 2, HEIGHT / 2 + 182, 29);
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
  if (event.code === "ArrowLeft" || event.code === "ArrowRight") event.preventDefault();
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

window.addEventListener("blur", () => {
  keys.clear();
  pendingFlap = false;
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && state.mode === "single" && !state.gameOver && !state.paused) {
    state.paused = true;
    pendingFlap = false;
    keys.clear();
    audio.music.pause();
    if (manualKind === "ranked") void ranked.pause();
    updateRankedNotice();
  }
});

window.addEventListener("online", () => { if (!PRACTICE_ONLY) void ranked.pump(); });
window.addEventListener("pagehide", () => {
  if (!PRACTICE_ONLY) void ranked.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

rankedStartButton.addEventListener("click", () => { unlockAudio(); void startSingle(); });
rankedResumeButton.addEventListener("click", () => { unlockAudio(); void resumeRanked(); });
practiceButton.addEventListener("click", () => { unlockAudio(); startPractice(); });
pauseButton.addEventListener("click", () => { unlockAudio(); togglePause(); });

window.addEventListener("resize", configureCanvas);

canvas.addEventListener("pointerdown", handleCanvasPointerDown);
canvas.addEventListener("pointerup", handleCanvasPointerUp);
canvas.addEventListener("pointercancel", clearHeldCanvasAction);

playerNameInput.addEventListener("input", () => {
  updateNameBest();
  clearTimeout(bestLookupTimer);
  bestLookupTimer = setTimeout(() => void refreshPlayerBestFromRemote(normalizePlayerName(playerNameInput.value)), 350);
});

nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = normalizePlayerName(playerNameInput.value);
  if (!name) {
    playerNameInput.focus();
    return;
  }
  if (isBlockedPlayerName(name)) {
    showNameError("Please choose another name.");
    playerNameInput.select();
    return;
  }
  setPlayerName(name);
  nameGate.hidden = true;
  canvas.focus();
});

Promise.all([loadAssets(), loadGameFont()]).then(() => {
  buildFishHitMask();
  configureCanvas();
  state.fish = createFish(150, 300, 90);
  let lastPlayer = "";
  try { lastPlayer = localStorage.getItem(LAST_PLAYER_KEY) || ""; } catch { /* Optional nickname. */ }
  playerNameInput.value = lastPlayer;
  updateNameBest();
  updateBestScoreDisplay(getBestScore(normalizePlayerName(lastPlayer)));
  loading.classList.add("is-hidden");
  playerNameInput.focus();
  if (lastPlayer) void refreshPlayerBestFromRemote(normalizePlayerName(lastPlayer));
  if (!PRACTICE_ONLY) void ranked.initialize().catch(() => {});
  updateRankedNotice();
  requestAnimationFrame(tick);
}).catch((error) => {
  loading.textContent = error.message;
});
