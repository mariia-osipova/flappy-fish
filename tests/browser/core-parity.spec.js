import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createInitialState, replay, step, fishRect, fishIntersectsRect, fishTouchesBounds,
  getFishDeathCause, intersects, RULES_VERSION,
} from "../../src/shared/game-core.js";
import { localTrafficOnly, expectLocalAndHealthy } from "./helpers.js";

const fixtures = JSON.parse(readFileSync(new URL("../fixtures/core-replays.json", import.meta.url), "utf8"));

async function openCoreHarness(page) {
  const traffic = await localTrafficOnly(page);
  await page.route("**/__core-harness__", (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html><head><title>Local deterministic-core test</title></head><body></body></html>",
  }));
  await page.goto("/__core-harness__");
  return traffic;
}

for (const fixture of fixtures.cases) {
  test(`exact Node/browser JSON parity: ${fixture.name}`, async ({ page }) => {
    const traffic = await openCoreHarness(page);
    const inputs = fixture.inputRuns.flatMap(([input, count]) => Array(count).fill(input));
    const sizes = [1, 179, 17, 1200, 361, 53];
    const expected = [];
    let nodeState = createInitialState(fixture.seed);
    for (let offset = 0, chunk = 0; offset < inputs.length; chunk += 1) {
      const count = sizes[chunk % sizes.length];
      nodeState = replay(JSON.parse(JSON.stringify(nodeState)), Uint8Array.from(inputs.slice(offset, offset + count)));
      expected.push(JSON.stringify(nodeState));
      offset += count;
    }
    expect(nodeState).toEqual(fixture.expected);

    const actual = await page.evaluate(async ({ seed, inputs, sizes }) => {
      const core = await import("/shared/game-core.js");
      let state = core.createInitialState(seed);
      const snapshots = [];
      for (let offset = 0, chunk = 0; offset < inputs.length; chunk += 1) {
        const count = sizes[chunk % sizes.length];
        state = core.replay(JSON.parse(JSON.stringify(state)), Uint8Array.from(inputs.slice(offset, offset + count)));
        snapshots.push(JSON.stringify(state));
        offset += count;
      }
      let rejectedTail = false;
      try { core.replay(state, [0]); } catch { rejectedTail = true; }
      return { rulesVersion: core.RULES_VERSION, snapshots, rejectedTail };
    }, { seed: fixture.seed, inputs, sizes });

    expect(actual.rulesVersion).toBe(RULES_VERSION);
    expect(actual.snapshots).toEqual(expected);
    expect(actual.rejectedTail).toBe(true);
    expectLocalAndHealthy(traffic);
  });
}

test("transparent collisions and score-on-death have exact cross-runtime parity", async ({ page }) => {
  const traffic = await openCoreHarness(page);
  const transparent = { left: 109, right: 109.1, top: 259, bottom: 259.1 };
  const fish = createInitialState(0).fish;
  const rotated = createInitialState(0);
  step(rotated, 4);
  rotated.fish.y = 50;
  const dying = createInitialState(1);
  Object.assign(dying, { tick: 413, started: true, pipeTicks: 51 });
  Object.assign(dying.fish, { x: 145, y: 566.6 });
  dying.pipes = [{ x: 68, centerY: 450, gap: 300, speed: 4, passed: false, id: 181 }];
  const expected = {
    broadPhase: intersects(fishRect(fish), transparent),
    actualHit: fishIntersectsRect(fish, transparent),
    rotatedBounds: fishRect(rotated.fish),
    rotatedHitsBounds: fishTouchesBounds(rotated.fish),
    priorCause: getFishDeathCause(dying),
    terminal: step(dying, 2),
  };

  const actual = await page.evaluate(async () => {
    const core = await import("/shared/game-core.js");
    const transparent = { left: 109, right: 109.1, top: 259, bottom: 259.1 };
    const fish = core.createInitialState(0).fish;
    const rotated = core.createInitialState(0);
    core.step(rotated, 4);
    rotated.fish.y = 50;
    const dying = core.createInitialState(1);
    Object.assign(dying, { tick: 413, started: true, pipeTicks: 51 });
    Object.assign(dying.fish, { x: 145, y: 566.6 });
    dying.pipes = [{ x: 68, centerY: 450, gap: 300, speed: 4, passed: false, id: 181 }];
    const result = {
      broadPhase: core.intersects(core.fishRect(fish), transparent),
      actualHit: core.fishIntersectsRect(fish, transparent),
      rotatedBounds: core.fishRect(rotated.fish),
      rotatedHitsBounds: core.fishTouchesBounds(rotated.fish),
      priorCause: core.getFishDeathCause(dying),
      terminal: core.step(dying, 2),
    };
    return JSON.stringify(result);
  });

  expect(actual).toBe(JSON.stringify(expected));
  expect(expected).toMatchObject({ broadPhase: true, actualHit: false, rotatedHitsBounds: false,
    priorCause: null, terminal: { score: 1, dead: true, deathCause: "bounds" } });
  expectLocalAndHealthy(traffic);
});
