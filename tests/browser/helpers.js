import { expect } from "@playwright/test";

export async function localTrafficOnly(page, origin = "http://127.0.0.1:3100") {
  const external = [];
  const errors = [];
  const apiRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      apiRequests.push({ path: new URL(request.url()).pathname, method: request.method() });
    }
  });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      return route.fallback();
    }
    external.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  return { external, errors, apiRequests };
}

// Observe public Canvas API calls instead of modifying the game's ESM module,
// exporting private state, or replacing its simulation with a test double.
export async function observeCanvas(page) {
  await page.addInitScript(() => {
    window.__canvasProbe = { fish: null, draws: 0, texts: [], pointerTypes: [] };
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
      if (this.canvas.id === "game-canvas" && image instanceof HTMLImageElement
          && new URL(image.currentSrc || image.src, location.href).pathname.endsWith("/fish1.png")
          && args[2] === 90 && args[3] === 90) {
        const transform = this.getTransform();
        const scale = Math.max(1, window.devicePixelRatio || 1);
        window.__canvasProbe.fish = { x: transform.e / scale, y: transform.f / scale };
        window.__canvasProbe.draws += 1;
      }
      return Reflect.apply(drawImage, this, [image, ...args]);
    };
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (this.canvas.id === "game-canvas" && !window.__canvasProbe.texts.includes(String(text))) {
        window.__canvasProbe.texts.push(String(text));
      }
      return Reflect.apply(fillText, this, [text, ...args]);
    };
    document.addEventListener("pointerdown", (event) => {
      if (event.target.id === "game-canvas") window.__canvasProbe.pointerTypes.push(event.pointerType);
    }, true);
  });
}

export async function enterGame(page, name = "Browser Fish") {
  await page.goto("/index.html");
  await expect(page.locator("#loading")).toHaveClass(/is-hidden/);
  await page.locator("#player-name").fill(name);
  await page.getByRole("button", { name: "Enter", exact: true }).click();
  await expect(page.locator("#name-gate")).toBeHidden();
}

export async function enterPractice(page, name) {
  await enterGame(page, name);
  await page.locator("#practice-start").click();
  await expect(page.locator("#ranked-notice")).toHaveAttribute("data-status", "practice");
  await expect.poll(() => page.evaluate(() => window.__canvasProbe.fish)).not.toBeNull();
}

export async function readCanvas(page) {
  return page.evaluate(() => structuredClone(window.__canvasProbe));
}

export function expectLocalAndHealthy(traffic) {
  expect(traffic.external, "the browser must never call Google or another external host").toEqual([]);
  expect(traffic.errors, "the page must not have unhandled script errors").toEqual([]);
}
