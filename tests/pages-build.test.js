import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildPages, pagesOutputPath } from "../scripts/build-pages.js";
import { createInitialState, step, fishRotation, INPUT_LEFT, INPUT_RIGHT, INPUT_FLAP } from "../src/shared/game-core.js";

let temporary;
let output;
before(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "flappy-fish-pages-"));
  output = await buildPages(path.join(temporary, "site"));
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

test("Pages output contains only public assets and resolves modules below a repository subpath", async () => {
  const entries = await readdir(output);
  assert.deepEqual(entries.sort(), [".flappy-fish-pages", ".nojekyll", "THIRD_PARTY_NOTICES.md", "app.js", "assets", "favicon.png", "index.html", "name-filter.js", "rank.html", "rank.js", "ranked-client.js", "shared", "styles.css"].sort());
  for (const filename of ["index.html", "rank.html"]) {
    const html = await readFile(path.join(output, filename), "utf8");
    assert.match(html, /<meta name="flappy-fish-mode" content="practice">/);
    assert.match(html, /practice-only/i);
    for (const [, resource] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      const resolved = new URL(resource, `https://example.github.io/flappy-fish/${filename}`);
      assert.ok(resolved.pathname.startsWith("/flappy-fish/"), resource);
      assert.ok((await stat(path.join(output, decodeURIComponent(resolved.pathname.slice("/flappy-fish/".length))))).isFile(), resource);
    }
  }
  for (const filename of ["app.js", "ranked-client.js", "shared/game-core.js"]) {
    const source = await readFile(path.join(output, filename), "utf8");
    for (const [, specifier] of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const resolved = new URL(specifier, `https://example.github.io/flappy-fish/${filename}`);
      assert.ok(resolved.pathname.startsWith("/flappy-fish/"), specifier);
      assert.ok((await stat(path.join(output, resolved.pathname.slice("/flappy-fish/".length)))).isFile(), specifier);
    }
  }
  assert.ok((await stat(path.join(output, "assets/img/fish1.png"))).isFile());
  assert.ok((await stat(path.join(output, "assets/font/StrangeFont-Regular.otf"))).isFile());
  assert.ok((await stat(path.join(output, "assets/audios/efecto bubble.ogg"))).isFile());
  assert.deepEqual((await readdir(path.join(output, "assets/audios"))).sort(), ["efecto bubble.ogg", "linkin park fondo.ogg"]);
});

test("building Pages leaves the default Node frontend and its shared imports unchanged", async () => {
  const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /name="flappy-fish-mode"/);
  assert.match(source, /from "\.\.\/shared\/game-core\.js"/);
  // Test real repository paths through the pure validator, never by invoking
  // a destructive operation on the checkout under test.
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  for (const directory of [repoRoot, path.resolve(repoRoot), path.dirname(path.resolve(repoRoot)), path.join(repoRoot, "src"), path.join(repoRoot, ".git")]) {
    assert.throws(() => pagesOutputPath(directory), /must not overwrite/);
  }
});

test("Pages rebuilds its own output but preserves unknown directories and symlinks", async () => {
  const rebuild = path.join(temporary, "rebuild");
  await buildPages(rebuild);
  await buildPages(rebuild);
  assert.match(await readFile(path.join(rebuild, "index.html"), "utf8"), /flappy-fish-mode/);
  const unrelated = path.join(temporary, "unrelated");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "keep.txt"), "preserve me");
  await assert.rejects(buildPages(unrelated), /not owned/);
  const alias = path.join(temporary, "alias");
  await symlink(unrelated, alias, "dir");
  await assert.rejects(buildPages(alias), /real directory/);
  assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "preserve me");
});

function staticRuntime() {
  const elements = new Map();
  const calls = [];
  const drawing = { setTransform() {}, drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(30 * 30 * 4) }) };
  const element = () => ({ value: "", hidden: false, textContent: "", dataset: {}, children: [], events: {},
    classList: { add() {}, remove() {} }, removeAttribute() {}, setAttribute() {}, focus() {}, select() {},
    addEventListener(name, callback) { this.events[name] = callback; },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
    getContext: () => drawing,
  });
  const document = { hidden: false, activeElement: null,
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelector: () => ({ content: "practice" }), createElement: element,
    addEventListener() {}, fonts: { load: async () => {}, ready: Promise.resolve() },
  };
  class FakeAudio { pause() {} play() { return Promise.resolve(); } }
  class FakeImage {
    naturalWidth = 30;
    naturalHeight = 30;
    set src(value) { this.url = value; queueMicrotask(() => this.onload()); }
  }
  class ForbiddenRankedClient {
    receipt = null;
    unfinished = false;
    running = false;
    async initialize() { calls.push("ranked.initialize"); }
    async start() { calls.push("ranked.start"); }
    async resume() { calls.push("ranked.resume"); }
    async pump() { calls.push("ranked.pump"); }
    async close() { calls.push("ranked.close"); }
  }
  const context = vm.createContext({ document, window: { addEventListener() {}, devicePixelRatio: 1, setTimeout, clearTimeout },
    navigator: { maxTouchPoints: 0 }, Audio: FakeAudio, Image: FakeImage, RankedClient: ForbiddenRankedClient,
    localStorage: { getItem: () => "", setItem() {} },
    fetch: async (...args) => { calls.push(args); throw new Error("Static pages must not call an API."); },
    createInitialState, stepManual: step, manualFishRotation: fishRotation, INPUT_LEFT, INPUT_RIGHT, INPUT_FLAP,
    performance: { now: () => 0 }, requestAnimationFrame() {}, crypto: globalThis.crypto, structuredClone,
    setTimeout, clearTimeout, queueMicrotask, URLSearchParams, console,
  });
  return { context, document, elements, calls };
}

test("static game starts and pauses practice without ranked initialization or score requests", async () => {
  const runtime = staticRuntime();
  const source = (await readFile(path.join(output, "app.js"), "utf8")).replace(/^import .*;\n/gm, "");
  vm.runInContext(source + "\nglobalThis.gameTest = { startSingle, togglePause, refreshPlayerBestFromRemote, state };", runtime.context);
  await new Promise((resolve) => setImmediate(resolve));
  runtime.document.getElementById("player-name").value = "Practice Fish";
  runtime.document.getElementById("name-form").events.submit({ preventDefault() {} });
  await runtime.context.gameTest.startSingle();
  runtime.context.gameTest.togglePause();
  await runtime.context.gameTest.refreshPlayerBestFromRemote("Practice Fish");
  assert.equal(runtime.context.gameTest.state.mode, "single");
  assert.equal(runtime.context.gameTest.state.paused, true);
  assert.equal(runtime.document.getElementById("ranked-start").hidden, true);
  assert.match(runtime.document.getElementById("ranked-notice").textContent, /Practice-only deployment/);
  assert.deepEqual(runtime.calls, []);
});

test("static Rank explains its limitation without fetching or searching the API", async () => {
  const runtime = staticRuntime();
  vm.runInContext(await readFile(path.join(output, "rank.js"), "utf8"), runtime.context);
  runtime.document.getElementById("rank-search").events.submit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.document.getElementById("rank-search").hidden, true);
  assert.match(runtime.document.getElementById("rank-list").children[0].textContent, /not available.*practice-only/);
  assert.deepEqual(runtime.calls, []);
});
