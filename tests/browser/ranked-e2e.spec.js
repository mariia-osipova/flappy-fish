import { expect, test } from "@playwright/test";
import {
  localTrafficOnly, observeCanvas, enterGame, readCanvas, expectLocalAndHealthy,
} from "./helpers.js";

test.use({ baseURL: "https://127.0.0.1:3101", ignoreHTTPSErrors: true });

async function storedGame(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("flappy-fish-ranked", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const record = await new Promise((resolve, reject) => {
        const request = database.transaction("games", "readonly").objectStore("games").get("current");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return record && {
        gameId: record.receipt?.gameId,
        status: record.receipt?.status,
        seq: record.receipt?.checkpoint.seq,
        leaseEpoch: record.receipt?.checkpoint.leaseEpoch,
        snapshot: record.receipt?.checkpoint.snapshot,
        queueLength: record.queue.length,
        pendingLength: record.pending.length,
      };
    } finally {
      database.close();
    }
  });
}

test("real ranked UI persists a partial pause, reloads with its secure identity, and saves a verified finish", async ({ page }, testInfo) => {
  // The real leaderboard cache has a 30-second TTL; do not advance or replace
  // either clock to make replay pacing checks pass artificially.
  test.setTimeout(60_000);
  const traffic = await localTrafficOnly(page, "https://127.0.0.1:3101");
  await observeCanvas(page);
  const name = `E2E ${testInfo.project.name} ${testInfo.repeatEachIndex}`;
  await enterGame(page, name);
  await expect(page.locator("#ranked-notice")).toHaveAttribute("data-status", "idle");

  const cookieMetadata = (await page.context().cookies()).filter((cookie) => cookie.name === "__Host-flappy_session")
    .map(({ name, httpOnly, secure, sameSite, path }) => ({ name, httpOnly, secure, sameSite, path }));
  expect(cookieMetadata).toEqual([{ name: "__Host-flappy_session", httpOnly: true, secure: true, sameSite: "Lax", path: "/" }]);
  expect(await page.evaluate(() => document.cookie.includes("__Host-flappy_session"))).toBe(false);

  const beginning = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/games" && response.request().method() === "POST");
  await page.locator("#ranked-start").click();
  const beginResponse = await beginning;
  expect(beginResponse.status()).toBe(200);
  const initial = await beginResponse.json();
  expect(initial.status).toBe("active");
  await expect(page.locator("#ranked-notice")).toHaveAttribute("data-status", "active");
  await expect.poll(async () => (await readCanvas(page)).fish?.y).toBe(300);

  await page.keyboard.down("ArrowLeft");
  await expect.poll(async () => (await readCanvas(page)).fish.x).toBeLessThan(140);
  await page.keyboard.up("ArrowLeft");
  const pausing = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/games/${initial.gameId}/checkpoints`);
  await page.locator("#game-pause").click();
  const pauseResponse = await pausing;
  expect(pauseResponse.status()).toBe(200);
  const pausedReceipt = await pauseResponse.json();
  expect(pausedReceipt.status).toBe("paused");
  expect(pausedReceipt.checkpoint.snapshot.started).toBe(false);
  expect(pausedReceipt.checkpoint.snapshot.fish.x).toBeLessThan(140);
  expect(pausedReceipt.checkpoint.snapshot.tick).toBeGreaterThan(0);
  expect(pausedReceipt.checkpoint.snapshot.tick).toBeLessThan(1200);
  await expect(page.locator("#ranked-notice")).toContainText("saved and paused. Your slot is free");
  const savedPause = await storedGame(page);
  expect(savedPause).toMatchObject({ gameId: initial.gameId, status: "paused", seq: 1, queueLength: 0, pendingLength: 0 });

  // Browser storage and the HttpOnly cookie are retained; no token, cookie, or
  // game state is injected by the test after navigation.
  await page.reload();
  await expect(page.locator("#loading")).toHaveClass(/is-hidden/);
  await expect(page.locator("#player-name")).toHaveValue(name);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.locator("#ranked-notice")).toContainText("saved and paused. Your slot is free");
  expect(await storedGame(page)).toEqual(savedPause);

  const resuming = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/games/${initial.gameId}/resume`);
  await page.locator("#ranked-resume").click();
  const resumeResponse = await resuming;
  expect(resumeResponse.status()).toBe(200);
  const resumed = await resumeResponse.json();
  expect(resumed.gameId).toBe(initial.gameId);
  expect(resumed.checkpoint.seq).toBe(savedPause.seq);
  expect(resumed.checkpoint.leaseEpoch).toBe(savedPause.leaseEpoch + 1);
  await expect(page.locator("#ranked-notice")).toHaveAttribute("data-status", "active");
  await expect.poll(async () => (await readCanvas(page)).fish?.x).toBe(savedPause.snapshot.fish.x);

  await page.keyboard.press("Space");
  await expect.poll(async () => (await readCanvas(page)).fish.y).toBeLessThan(290);
  await expect(page.locator("#ranked-notice")).toContainText("Verified result saved: 0");
  await expect(page.locator("#ranked-notice")).toHaveAttribute("data-status", "completed");
  const completed = await storedGame(page);
  expect(completed).toMatchObject({ gameId: initial.gameId, status: "completed", seq: savedPause.seq + 1,
    snapshot: { score: 0, dead: true }, queueLength: 0, pendingLength: 0 });
  const canonical = await page.evaluate(async (gameId) => {
    const response = await fetch(`/api/games/${gameId}`, { credentials: "same-origin" });
    const data = await response.json();
    return { httpStatus: response.status, status: data.status, verified: data.verified,
      finalScore: data.finalScore, gameId: data.gameId };
  }, initial.gameId);
  expect(canonical).toEqual({ httpStatus: 200, status: "completed", verified: true, finalScore: 0, gameId: initial.gameId });

  await expect.poll(() => page.evaluate(async (name) => {
    const response = await fetch(`/api/scores?name=${encodeURIComponent(name)}`, { cache: "no-store" });
    return response.ok ? (await response.json()).player : null;
  }, name), { timeout: 35_000, intervals: [100, 500, 1000] }).toMatchObject({ name, bestScore: 0, source: "verified" });

  await page.getByRole("link", { name: "Rank", exact: true }).click();
  const officialEntry = page.locator("#rank-list > li").filter({ hasText: name });
  await expect(officialEntry).toContainText(`${name}: 0`);
  await expect(officialEntry).toContainText("Server verified");
  await page.screenshot({ path: testInfo.outputPath("verified-leaderboard.png"), fullPage: true });
  expect(traffic.apiRequests.some((request) => request.path === "/api/scores" && request.method === "POST")).toBe(false);
  expectLocalAndHealthy(traffic);
});
