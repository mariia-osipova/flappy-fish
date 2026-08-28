import { expect, test } from "@playwright/test";
import {
  localTrafficOnly, observeCanvas, enterGame, enterPractice, readCanvas, expectLocalAndHealthy,
} from "./helpers.js";

test("ranked-disabled fallback requires an explicit choice; keyboard and pause keep working", async ({ page }, testInfo) => {
  const traffic = await localTrafficOnly(page);
  await observeCanvas(page);
  await enterGame(page);
  const notice = page.locator("#ranked-notice");
  await expect(notice).toHaveAttribute("data-status", "unavailable");
  await page.locator("#ranked-start").click();
  await expect(notice).toHaveAttribute("data-status", "unavailable");
  await expect(page.locator("#game-pause")).toBeHidden();
  expect((await readCanvas(page)).fish).toBeNull();

  await page.locator("#practice-start").click();
  await expect(notice).toHaveAttribute("data-status", "practice");
  await expect(notice).toContainText("will not enter the leaderboard");
  await expect.poll(async () => (await readCanvas(page)).fish?.y).toBe(300);
  const before = (await readCanvas(page)).fish;
  await page.keyboard.down("ArrowLeft");
  await expect.poll(async () => (await readCanvas(page)).fish.x).toBeLessThan(before.x);
  await page.keyboard.up("ArrowLeft");
  expect((await readCanvas(page)).fish.y).toBe(300);

  await page.keyboard.press("Space");
  await expect.poll(async () => (await readCanvas(page)).fish.y).toBeLessThan(290);
  await page.keyboard.press("p");
  await expect(page.locator("#game-pause")).toHaveText("Resume");
  const paused = await readCanvas(page);
  await expect.poll(async () => (await readCanvas(page)).draws).toBeGreaterThan(paused.draws + 8);
  expect((await readCanvas(page)).fish).toEqual(paused.fish);
  await page.screenshot({ path: testInfo.outputPath("practice-paused.png"), fullPage: true });

  await page.keyboard.press("p");
  await expect(page.locator("#game-pause")).toHaveText("Pause");
  await expect.poll(async () => (await readCanvas(page)).texts.some((text) => text.includes("GAME OVER"))).toBe(true);
  await expect(page.locator("#game-pause")).toBeDisabled();
  expect(traffic.apiRequests.filter((request) => request.method === "POST" && request.path !== "/api/session")).toEqual([]);
  expectLocalAndHealthy(traffic);
});

test.describe("touch controls", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("a real touch pointer starts a practice flap and never submits a score", async ({ page }, testInfo) => {
    const traffic = await localTrafficOnly(page);
    await observeCanvas(page);
    await enterPractice(page, "Touch Fish");
    await expect.poll(async () => (await readCanvas(page)).fish?.y).toBe(300);
    const canvas = page.locator("#game-canvas");
    await canvas.tap();
    await expect.poll(async () => (await readCanvas(page)).fish.y).toBeLessThan(290);
    expect((await readCanvas(page)).pointerTypes).toContain("touch");
    await page.locator("#game-pause").tap();
    await expect(page.locator("#game-pause")).toHaveText("Resume");
    const paused = await readCanvas(page);
    await expect.poll(async () => (await readCanvas(page)).draws).toBeGreaterThan(paused.draws + 5);
    expect((await readCanvas(page)).fish).toEqual(paused.fish);
    await page.screenshot({ path: testInfo.outputPath("practice-touch.png"), fullPage: true });
    expect(traffic.apiRequests.filter((request) => request.method === "POST" && request.path !== "/api/session")).toEqual([]);
    expectLocalAndHealthy(traffic);
  });
});

test("official best and provenance come only from API responses, never poisoned localStorage", async ({ page }) => {
  const traffic = await localTrafficOnly(page);
  await page.addInitScript(() => {
    localStorage.setItem("flappy-fish-scores-by-name", JSON.stringify({ "Local Hero": 999999999, "Injected Fish": 888888888 }));
    localStorage.setItem("flappy-fish-last-player", "Local Hero");
  });
  let unavailable = false;
  await page.route("**/api/scores*", (route) => {
    if (unavailable) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable" } }) });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        scores: [
          { name: "Legacy Fish", bestScore: 99, source: "legacy", verified: false },
          { name: "Local Hero", bestScore: 7, source: "verified", verified: true },
        ],
        player: { name: "Local Hero", bestScore: 7, source: "verified", verified: true, rank: 2 },
      }),
    });
  });
  await enterGame(page, "Local Hero");
  await expect(page.locator("#best-score-display")).toHaveText("Official best: 7");
  await page.locator("#practice-start").click();
  await expect(page.locator("#ranked-notice")).toHaveAttribute("data-status", "practice");
  await expect(page.locator("#best-score-display")).toHaveText("Official best: 7");

  await page.getByRole("link", { name: "Rank", exact: true }).click();
  await expect(page.locator("#rank-list > li")).toHaveCount(2);
  await expect(page.locator("#rank-list > li").nth(0)).toContainText("Legacy Fish: 99");
  await expect(page.locator("#rank-list > li").nth(0)).toContainText("Historical — not server verified");
  await expect(page.locator("#rank-list > li").nth(1)).toContainText("Local Hero: 7");
  await expect(page.locator("#rank-list > li").nth(1)).toContainText("Server verified");
  await expect(page.locator("#rank-list")).not.toContainText("999999999");
  await expect(page.locator("#rank-list")).not.toContainText("Injected Fish");
  await page.locator("#rank-name").fill("Local Hero");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await expect(page.locator("#rank-player")).toContainText("#2 Local Hero: 7");
  await expect(page.locator("#rank-player")).toContainText("Server verified");

  unavailable = true;
  await page.reload();
  await expect(page.locator("#rank-list")).toContainText("Leaderboard is temporarily unavailable");
  await expect(page.locator("#rank-player")).toHaveText("Local practice scores are not part of this leaderboard.");
  await expect(page.locator("#rank-list")).not.toContainText("999999999");
  expectLocalAndHealthy(traffic);
});
