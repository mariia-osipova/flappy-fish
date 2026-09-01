import {
  COLLISION_DATA_VERSION,
  FISH_HIT_PIXELS,
  FISH_IMAGE_HEIGHT,
  FISH_IMAGE_WIDTH,
  FISH_ROTATIONS,
} from "./collision-data.js";

// Bump the manual rules version whenever physics, scoring, or PRNG changes.
export const RULES_VERSION = `manual-v1-181-${COLLISION_DATA_VERSION.slice(0, 12)}`;
export const TICK_RATE = 120;
export const MAX_BLOCK_TICKS = 1200;
export const INPUT_LEFT = 1;
export const INPUT_RIGHT = 2;
export const INPUT_FLAP = 4;
export const WIDTH = 1000;
export const HEIGHT = 600;
export const PIPE_WIDTH = 70;
export const PIPE_HEIGHT = 400;
export const GAP = 300;
export const PIPE_INTERVAL_TICKS = 181;
export const MAX_PIPES = 2;

const FISH_SIZE = 90;
const GRAVITY = 0.3;
const JUMP_STRENGTH = -10;
const MAX_FALL_SPEED = 100;
const PIPE_SPEED = 4;
const INPUT_MASK = INPUT_LEFT | INPUT_RIGHT | INPUT_FLAP;
const HIT_POINTS = FISH_HIT_PIXELS.map(([x, y]) => ({
  x: (x + 0.5) / FISH_IMAGE_WIDTH - 0.5,
  y: (y + 0.5) / FISH_IMAGE_HEIGHT - 0.5,
}));
const LOCAL_BOUNDS = {
  left: Math.min(...HIT_POINTS.map((point) => point.x)),
  right: Math.max(...HIT_POINTS.map((point) => point.x)),
  top: Math.min(...HIT_POINTS.map((point) => point.y)),
  bottom: Math.max(...HIT_POINTS.map((point) => point.y)),
};
const PAD_X = 0.5 / FISH_IMAGE_WIDTH;
const PAD_Y = 0.5 / FISH_IMAGE_HEIGHT;
const BOUNDS_CORNERS = [
  { x: LOCAL_BOUNDS.left - PAD_X, y: LOCAL_BOUNDS.top - PAD_Y },
  { x: LOCAL_BOUNDS.right + PAD_X, y: LOCAL_BOUNDS.top - PAD_Y },
  { x: LOCAL_BOUNDS.right + PAD_X, y: LOCAL_BOUNDS.bottom + PAD_Y },
  { x: LOCAL_BOUNDS.left - PAD_X, y: LOCAL_BOUNDS.bottom + PAD_Y },
];

function requireUint32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  }
}

function requireInput(input) {
  if (!Number.isInteger(input) || input < 0 || input > INPUT_MASK) {
    throw new RangeError("Input must contain only left, right, and flap bits");
  }
}

function rotationValues(fish) {
  const values = FISH_ROTATIONS[fish.velocity];
  if (!values) throw new RangeError("Fish velocity is not reachable under these rules");
  return values;
}

export function createInitialState(seed) {
  requireUint32(seed, "seed");
  return {
    tick: 0,
    seed,
    rngState: seed,
    started: false,
    fish: {
      x: 150,
      y: 300,
      width: FISH_SIZE,
      height: FISH_SIZE,
      velocity: 0,
      alive: true,
    },
    pipes: [],
    score: 0,
    dead: false,
    deathCause: null,
    pipeTicks: 0,
  };
}

export function fishRotation(fish) {
  return rotationValues(fish)[0];
}

export function fishRect(fish) {
  const [, cos, sin] = rotationValues(fish);
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const corner of BOUNDS_CORNERS) {
    const localX = corner.x * fish.width;
    const localY = corner.y * fish.height;
    const worldX = fish.x + localX * cos - localY * sin;
    const worldY = fish.y + localX * sin + localY * cos;
    left = Math.min(left, worldX);
    right = Math.max(right, worldX);
    top = Math.min(top, worldY);
    bottom = Math.max(bottom, worldY);
  }
  return { left, right, top, bottom, centerX: fish.x, centerY: fish.y };
}

export function pipeRects(pipe) {
  return [
    {
      left: pipe.x - PIPE_WIDTH / 2,
      right: pipe.x + PIPE_WIDTH / 2,
      top: pipe.centerY - pipe.gap / 2 - PIPE_HEIGHT,
      bottom: pipe.centerY - pipe.gap / 2,
    },
    {
      left: pipe.x - PIPE_WIDTH / 2,
      right: pipe.x + PIPE_WIDTH / 2,
      top: pipe.centerY + pipe.gap / 2,
      bottom: pipe.centerY + pipe.gap / 2 + PIPE_HEIGHT,
    },
  ];
}

export function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function forEachFishHitPoint(fish, callback) {
  const [, cos, sin] = rotationValues(fish);
  const radius = Math.max(fish.width / FISH_IMAGE_WIDTH, fish.height / FISH_IMAGE_HEIGHT) / 2;
  for (const point of HIT_POINTS) {
    const localX = point.x * fish.width;
    const localY = point.y * fish.height;
    const worldX = fish.x + localX * cos - localY * sin;
    const worldY = fish.y + localX * sin + localY * cos;
    if (callback(worldX, worldY, radius)) return true;
  }
  return false;
}

export function fishTouchesBounds(fish) {
  return forEachFishHitPoint(fish, (x, y, radius) => y - radius <= 0 || y + radius >= HEIGHT);
}

export function fishIntersectsRect(fish, rect) {
  return forEachFishHitPoint(fish, (x, y, radius) => {
    return x + radius >= rect.left
      && x - radius <= rect.right
      && y + radius >= rect.top
      && y - radius <= rect.bottom;
  });
}

export function getFishDeathCause(state) {
  const rect = fishRect(state.fish);
  if ((rect.top <= 0 || rect.bottom >= HEIGHT) && fishTouchesBounds(state.fish)) {
    return "bounds";
  }
  for (const pipe of state.pipes) {
    if (pipeRects(pipe).some((pipeRect) => {
      return intersects(rect, pipeRect) && fishIntersectsRect(state.fish, pipeRect);
    })) return "pipe";
  }
  return null;
}

function nextRandom(state) {
  // Mulberry32. Only obstacle generation advances this stream.
  state.rngState = (state.rngState + 0x6d2b79f5) >>> 0;
  let value = state.rngState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

/** Advance exactly one unpaused simulation tick. Input is sampled at its start. */
export function step(state, input) {
  requireInput(input);
  if (state.dead) throw new RangeError("Cannot advance a completed game");
  if (!Number.isSafeInteger(state.tick) || state.tick < 0 || state.tick === Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Invalid simulation tick");
  }

  state.tick += 1;
  if (input & INPUT_FLAP) {
    state.started = true;
    state.fish.velocity = JUMP_STRENGTH;
  }

  // Horizontal controls already work while waiting for the first flap.
  if (input & INPUT_LEFT) state.fish.x -= 5;
  if (input & INPUT_RIGHT) state.fish.x += 5;
  state.fish.x = Math.max(40, Math.min(WIDTH - 40, state.fish.x));
  if (!state.started) return state;

  state.pipeTicks += 1;
  // Repeated additions of 1000/120 in the original game reached 1500ms on
  // tick 181. Preserve that observed interval, rather than changing to 180.
  if (state.pipeTicks >= PIPE_INTERVAL_TICKS) {
    state.pipeTicks = 0;
    state.pipes.push({
      x: WIDTH,
      centerY: Math.floor(150 + nextRandom(state) * 301),
      gap: GAP,
      speed: PIPE_SPEED,
      passed: false,
      id: state.tick,
    });
  }

  state.fish.velocity += GRAVITY;
  if (state.fish.velocity > MAX_FALL_SPEED) state.fish.velocity = MAX_FALL_SPEED;
  state.fish.y += state.fish.velocity;
  for (const pipe of state.pipes) pipe.x -= pipe.speed;
  state.pipes = state.pipes.filter((pipe) => pipe.x > -PIPE_WIDTH);

  // Preserve the original scoring-before-collision behavior on the death tick.
  const rect = fishRect(state.fish);
  for (const pipe of state.pipes) {
    if (pipe.x + PIPE_WIDTH / 2 < rect.left && !pipe.passed) {
      state.score += 1;
      pipe.passed = true;
    }
  }
  state.deathCause = getFishDeathCause(state);
  if (state.deathCause) {
    state.dead = true;
    state.fish.alive = false;
  }
  return state;
}

/** Validate the bounded, JSON-safe state shape before replaying a signed snapshot. */
export function assertValidSnapshot(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("Invalid game snapshot");
  }
  requireUint32(state.seed, "snapshot seed");
  requireUint32(state.rngState, "snapshot rngState");
  if (!Number.isSafeInteger(state.tick) || state.tick < 0
      || !Number.isSafeInteger(state.score) || state.score < 0
      || state.score > Math.floor(state.tick / PIPE_INTERVAL_TICKS)
      || typeof state.started !== "boolean" || typeof state.dead !== "boolean"
      || !Number.isInteger(state.pipeTicks) || state.pipeTicks < 0 || state.pipeTicks >= PIPE_INTERVAL_TICKS
      || ![null, "bounds", "pipe"].includes(state.deathCause)
      || state.dead !== (state.deathCause !== null)) {
    throw new RangeError("Invalid game snapshot counters or status");
  }
  const fish = state.fish;
  if (!fish || typeof fish !== "object" || Array.isArray(fish)
      || fish.width !== FISH_SIZE || fish.height !== FISH_SIZE
      || !Number.isFinite(fish.x) || fish.x < 40 || fish.x > WIDTH - 40 || fish.x % 5 !== 0
      || !Number.isFinite(fish.y) || fish.y < -100 || fish.y > HEIGHT + MAX_FALL_SPEED
      || !Number.isFinite(fish.velocity) || fish.velocity < JUMP_STRENGTH || fish.velocity > MAX_FALL_SPEED
      || !Object.hasOwn(FISH_ROTATIONS, fish.velocity)
      || typeof fish.alive !== "boolean" || fish.alive === state.dead) {
    throw new RangeError("Invalid snapshot fish");
  }
  if (!Array.isArray(state.pipes) || state.pipes.length > MAX_PIPES) {
    throw new RangeError("Invalid snapshot obstacles");
  }
  let previousId = -1;
  let previousX = -Infinity;
  for (const pipe of state.pipes) {
    if (!pipe || typeof pipe !== "object" || Array.isArray(pipe)
        || !Number.isInteger(pipe.x) || pipe.x <= -PIPE_WIDTH || pipe.x > WIDTH - PIPE_SPEED || pipe.x % PIPE_SPEED !== 0
        || !Number.isInteger(pipe.centerY) || pipe.centerY < 150 || pipe.centerY > 450
        || pipe.gap !== GAP || pipe.speed !== PIPE_SPEED || typeof pipe.passed !== "boolean"
        || !Number.isSafeInteger(pipe.id) || pipe.id <= previousId || pipe.id < 1 || pipe.id > state.tick
        || pipe.x <= previousX) {
      throw new RangeError("Invalid snapshot obstacle");
    }
    previousId = pipe.id;
    previousX = pipe.x;
  }
  if (!state.started && (state.dead || state.score !== 0 || state.pipeTicks !== 0
      || state.pipes.length !== 0 || state.rngState !== state.seed
      || fish.y !== 300 || fish.velocity !== 0)) {
    throw new RangeError("Invalid pre-start snapshot");
  }
  return state;
}

export function cloneState(snapshot) {
  assertValidSnapshot(snapshot);
  return {
    tick: snapshot.tick,
    seed: snapshot.seed,
    rngState: snapshot.rngState,
    started: snapshot.started,
    fish: {
      x: snapshot.fish.x,
      y: snapshot.fish.y,
      width: snapshot.fish.width,
      height: snapshot.fish.height,
      velocity: snapshot.fish.velocity,
      alive: snapshot.fish.alive,
    },
    pipes: snapshot.pipes.map((pipe) => ({
      x: pipe.x,
      centerY: pipe.centerY,
      gap: pipe.gap,
      speed: pipe.speed,
      passed: pipe.passed,
      id: pipe.id,
    })),
    score: snapshot.score,
    dead: snapshot.dead,
    deathCause: snapshot.deathCause,
    pipeTicks: snapshot.pipeTicks,
  };
}

/** Replay one bounded input block without mutating its starting checkpoint. */
export function replay(snapshot, inputs) {
  if (!Array.isArray(inputs) && !(inputs instanceof Uint8Array)) {
    throw new TypeError("Replay inputs must be an array or Uint8Array");
  }
  if (inputs.length > MAX_BLOCK_TICKS) throw new RangeError("Replay block exceeds the tick limit");
  const state = cloneState(snapshot);
  for (const input of inputs) step(state, input);
  return state;
}
