import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  RULES_VERSION,
  MAX_BLOCK_TICKS,
  MAX_PIPES,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_FLAP,
  assertValidSnapshot,
  cloneState,
  createInitialState,
  fishIntersectsRect,
  fishRect,
  fishRotation,
  fishTouchesBounds,
  getFishDeathCause,
  intersects,
  replay,
  step,
} from "../src/shared/game-core.js";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/core-replays.json", import.meta.url), "utf8"));

function expandRuns(runs) {
  return Uint8Array.from(runs.flatMap(([input, count]) => Array(count).fill(input)));
}

function automaticInput(state) {
  const next = state.pipes.find((pipe) => pipe.x + 35 >= fishRect(state.fish).left);
  const target = next?.centerY ?? 300;
  return !state.started || (state.fish.y >= target + 70 && state.fish.velocity > 0)
    ? INPUT_FLAP : 0;
}

test("initial states validate uint32 seeds and do not share mutable state", () => {
  for (const seed of [-1, 0x100000000, 1.1, NaN, Infinity, "1", undefined]) {
    assert.throws(() => createInitialState(seed), /unsigned 32-bit/);
  }
  const first = createInitialState(0);
  const second = createInitialState(0);
  assert.deepEqual(first, second);
  assert.notEqual(first.fish, second.fish);
  assert.notEqual(first.pipes, second.pipes);
  assert.equal(assertValidSnapshot(first), first);
  assert.equal(createInitialState(0xffffffff).rngState, 0xffffffff);
});

test("pre-start arrows keep their original clamp and both-key behavior", () => {
  const initial = createInitialState(17);
  const moved = replay(initial, [INPUT_LEFT, INPUT_LEFT, INPUT_LEFT | INPUT_RIGHT, INPUT_RIGHT]);
  assert.equal(moved.fish.x, 145);
  assert.equal(moved.tick, 4);
  assert.equal(moved.started, false);
  assert.equal(moved.fish.y, 300);
  assert.equal(moved.fish.velocity, 0);
  assert.equal(moved.pipeTicks, 0);
  assert.equal(moved.rngState, 17);
  assert.deepEqual(moved.pipes, []);
  assert.equal(initial.fish.x, 150);

  const left = replay(moved, new Uint8Array(200).fill(INPUT_LEFT));
  assert.equal(left.fish.x, 40);
  step(left, INPUT_LEFT | INPUT_RIGHT);
  assert.equal(left.fish.x, 40);
  const right = replay(left, new Uint8Array(200).fill(INPUT_RIGHT));
  assert.equal(right.fish.x, 960);
  step(right, INPUT_LEFT | INPUT_RIGHT);
  assert.equal(right.fish.x, 960);
});

test("the first flap and movement apply before the original float physics", () => {
  const state = createInitialState(1);
  const returned = step(state, INPUT_FLAP | INPUT_RIGHT);
  assert.equal(returned, state);
  assert.equal(state.started, true);
  assert.equal(state.tick, 1);
  assert.equal(state.fish.x, 155);
  assert.equal(state.fish.velocity, -9.7);
  assert.equal(state.fish.y, 290.3);
  assert.equal(state.pipeTicks, 1);
  assert.equal(state.rngState, 1);
});

test("committed collision data still matches the PNG and deterministic rotation generator", () => {
  const output = execFileSync(process.execPath, ["scripts/generate-collision-data.mjs", "--check"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
  });
  assert.match(output, /matches the sprite/);
});

for (const fixture of fixtures.cases) {
  test(`original-game fixture: ${fixture.name}`, () => {
    assert.equal(RULES_VERSION, fixtures.rulesVersion);
    const inputs = expandRuns(fixture.inputRuns);
    const byTick = new Map(fixture.checkpoints.map((checkpoint) => [checkpoint.afterTicks, checkpoint.state]));
    let direct = createInitialState(fixture.seed);
    for (const input of inputs) {
      step(direct, input);
      if (byTick.has(direct.tick)) assert.deepEqual(direct, byTick.get(direct.tick));
    }
    assert.deepEqual(direct, fixture.expected);

    // Network blocks do not have to end on a pipe boundary or a round second.
    let checkpoint = createInitialState(fixture.seed);
    let offset = 0;
    let chunkIndex = 0;
    const sizes = [1, 179, 17, MAX_BLOCK_TICKS, 361, 53];
    while (offset < inputs.length) {
      const count = sizes[chunkIndex++ % sizes.length];
      const serialized = JSON.stringify(checkpoint);
      const roundTripped = JSON.parse(serialized);
      const before = structuredClone(roundTripped);
      checkpoint = replay(roundTripped, inputs.subarray(offset, offset + count));
      assert.deepEqual(roundTripped, before, "replay must not mutate its checkpoint");
      assert.equal(assertValidSnapshot(checkpoint), checkpoint);
      assert.ok(Buffer.byteLength(serialized) < 4096);
      offset += count;
    }
    assert.deepEqual(checkpoint, fixture.expected);
  });
}

test("the float-timer compatibility interval is 181 ticks and the seeded PRNG advances only on spawn", () => {
  const long = fixtures.cases.find((fixture) => fixture.name === "seeded-long-run");
  const at180 = long.checkpoints.find((checkpoint) => checkpoint.afterTicks === 180).state;
  const at181 = long.checkpoints.find((checkpoint) => checkpoint.afterTicks === 181).state;
  const at362 = long.checkpoints.find((checkpoint) => checkpoint.afterTicks === 362).state;
  assert.equal(at180.pipes.length, 0);
  assert.equal(at180.rngState, long.seed);
  assert.equal(at180.pipeTicks, 180);
  assert.equal(at181.pipeTicks, 0);
  assert.equal(at181.pipes[0].id, 181);
  assert.equal(at181.pipes[0].x, 996);
  assert.equal(at181.pipes[0].centerY, 230);
  assert.equal(at181.rngState, 0x6d2b79f5);
  assert.equal(at362.pipes.length, 2);
  assert.equal(at362.pipes[1].id, 362);
  assert.equal(at362.pipes[1].x, 996);
  assert.notEqual(at362.rngState, at181.rngState);
});

test("transparent sprite corners do not collide even inside the rotated broad-phase bounds", () => {
  const fish = createInitialState(0).fish;
  const transparent = { left: 109, right: 109.1, top: 259, bottom: 259.1 };
  assert.equal(intersects(fishRect(fish), transparent), true);
  assert.equal(fishIntersectsRect(fish, transparent), false);
  assert.equal(fishIntersectsRect(fish, { left: 150, right: 150.1, top: 300, bottom: 300.1 }), true);

  const rotated = createInitialState(0);
  step(rotated, INPUT_FLAP);
  rotated.fish.y = 50;
  assert.ok(fishRect(rotated.fish).top < 0);
  assert.equal(fishTouchesBounds(rotated.fish), false);
  rotated.fish.y = 20;
  assert.equal(fishTouchesBounds(rotated.fish), true);
});

test("a passed obstacle scores before a boundary death in the same tick", () => {
  const state = createInitialState(1);
  state.tick = 413;
  state.started = true;
  state.pipeTicks = 51;
  state.fish.x = 145;
  state.fish.y = 566.6;
  state.pipes = [{ x: 68, centerY: 450, gap: 300, speed: 4, passed: false, id: 181 }];
  assertValidSnapshot(state);
  assert.equal(getFishDeathCause(state), null);
  assert.equal(state.pipes[0].x + 35, fishRect(state.fish).left);

  step(state, INPUT_RIGHT);
  assert.equal(state.score, 1);
  assert.equal(state.pipes[0].passed, true);
  assert.equal(state.dead, true);
  assert.equal(state.fish.alive, false);
  assert.equal(state.deathCause, "bounds");
});

test("obstacle death is distinguished from bounds, which retain priority", () => {
  const state = createInitialState(1);
  state.tick = 200;
  state.started = true;
  state.pipes = [{ x: 148, centerY: 450, gap: 300, speed: 4, passed: false, id: 181 }];
  step(state, 0);
  assert.equal(state.dead, true);
  assert.equal(state.deathCause, "pipe");
  assert.equal(state.score, 0);
  state.fish.y = 599;
  assert.equal(getFishDeathCause(state), "bounds");
});

test("invalid input, oversize blocks, and trailing ticks after death are rejected", () => {
  const initial = createInitialState(9);
  const untouched = structuredClone(initial);
  for (const input of [-1, 8, 255, 0x100000000, 1.5, NaN, Infinity, "4", null, undefined]) {
    assert.throws(() => replay(initial, [input]), /Input must contain only/);
    assert.throws(() => step(initial, input), /Input must contain only/);
  }
  assert.deepEqual(initial, untouched);
  assert.throws(() => replay(initial, new Uint8Array(MAX_BLOCK_TICKS + 1)), /tick limit/);
  assert.throws(() => replay(initial, new Uint16Array(1)), /array or Uint8Array/);
  assert.throws(() => replay(initial, { length: 0 }), /array or Uint8Array/);

  const first = fixtures.cases.find((fixture) => fixture.name === "first-flap-falls");
  const inputs = expandRuns(first.inputRuns);
  const terminal = replay(createInitialState(first.seed), inputs);
  assert.equal(terminal.dead, true);
  assert.deepEqual(replay(terminal, []), terminal);
  assert.throws(() => replay(terminal, [0]), /completed game/);
  assert.throws(() => replay(createInitialState(first.seed), [...inputs, 0]), /completed game/);
  assert.throws(() => step(terminal, INPUT_FLAP), /completed game/);
});

test("snapshots reject non-finite values, unbounded arrays, and impossible state shapes", () => {
  const mutations = [
    (state) => { state.tick = 1.5; },
    (state) => { state.seed = -1; },
    (state) => { state.rngState = Infinity; },
    (state) => { state.score = 1; },
    (state) => { state.pipeTicks = 181; },
    (state) => { state.fish.x = 42; },
    (state) => { state.fish.y = NaN; },
    (state) => { state.fish.width = 91; },
    (state) => { state.fish.velocity = 0.1; },
    (state) => { state.fish.alive = false; },
    (state) => { state.dead = true; },
    (state) => { state.pipes = Array(3).fill({}); },
    (state) => { state.pipes = [{}]; },
    (state) => { state.rngState = 2; },
  ];
  for (const mutate of mutations) {
    const state = createInitialState(1);
    mutate(state);
    assert.throws(() => replay(state, []));
  }
  assert.throws(() => replay(null, []), /Invalid game snapshot/);
  const cloned = cloneState(createInitialState(1));
  assert.deepEqual(cloned, createInitialState(1));
});

test("replay does not use runtime randomness or transcendental math", () => {
  const old = { random: Math.random, sin: Math.sin, cos: Math.cos };
  const forbidden = () => { throw new Error("Runtime-dependent operation"); };
  try {
    Math.random = forbidden;
    Math.sin = forbidden;
    Math.cos = forbidden;
    const fixture = fixtures.cases.find((value) => value.name === "seeded-long-run");
    const state = replay(createInitialState(fixture.seed), expandRuns(fixture.inputRuns).subarray(0, MAX_BLOCK_TICKS));
    assert.equal(state.tick, MAX_BLOCK_TICKS);
    assert.equal(state.score, 5);
    assert.equal(typeof fishRotation(state.fish), "number");
  } finally {
    Object.assign(Math, old);
  }
});

test("ongoing games can exceed ten minutes while checkpoints remain bounded", () => {
  let live = createInitialState(0);
  let verified = cloneState(live);
  let largestSnapshot = 0;
  for (let block = 0; block < 65; block += 1) {
    const inputs = new Uint8Array(MAX_BLOCK_TICKS);
    for (let tick = 0; tick < inputs.length; tick += 1) {
      inputs[tick] = automaticInput(live);
      step(live, inputs[tick]);
      assert.ok(live.pipes.length <= MAX_PIPES);
    }
    verified = replay(JSON.parse(JSON.stringify(verified)), inputs);
    assert.deepEqual(verified, live);
    largestSnapshot = Math.max(largestSnapshot, Buffer.byteLength(JSON.stringify(verified)));
  }
  assert.equal(live.tick, 78_000);
  assert.equal(live.dead, false);
  assert.ok(live.score > 400);
  assert.ok(largestSnapshot < 4096);
});
