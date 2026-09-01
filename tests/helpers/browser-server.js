import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import { AppsScriptGateway } from "../../src/server/gateway.js";
import { createAppsScriptHarness, TEST_GATEWAY_SECRET } from "./apps-script-harness.js";

// This process intentionally reads no production environment configuration.
// HTTP, cookie signing, the replay worker, gateway signing, and Code.gs are real;
// only Google's SpreadsheetApp/LockService facilities run in the local VM.
const config = loadConfig({
  RANKED_ENABLED: "true",
  SESSION_HMAC_KEY: "browser-test-only-session-key-at-least-32-characters",
  STATE_HMAC_KEY: "browser-test-only-state-key-at-least-32-characters",
  GATEWAY_HMAC_KEY: TEST_GATEWAY_SECRET,
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/browser-test-only/exec",
});
const sheet = createAppsScriptHarness({ now: Date.now() });
const gateway = new AppsScriptGateway({
  url: config.gatewayUrl,
  key: config.gatewayKey,
  now: Date.now,
  fetchImpl: async (url, request) => {
    if (url !== config.gatewayUrl) throw new Error("Unexpected test gateway URL");
    sheet.setTime(Date.now());
    return new Response(JSON.stringify(sheet.post(JSON.parse(request.body))), { status: 200 });
  },
});
const app = createApp({ config, store: gateway, now: Date.now, logger: { info() {} } });

// HTTPS is needed to exercise the actual __Host- Secure HttpOnly cookie in
// WebKit as well as Chromium. The key/certificate exist only in this temp dir.
const certificateDirectory = await mkdtemp(path.join(tmpdir(), "flappy-fish-browser-"));
const keyPath = path.join(certificateDirectory, "key.pem");
const certPath = path.join(certificateDirectory, "cert.pem");
let server;
let closing;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
    await rm(certificateDirectory, { recursive: true, force: true });
  })();
  return closing;
}

try {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-keyout", keyPath, "-out", certPath, "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { stdio: "pipe" });
  server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, app);
  server.listen(3101, "127.0.0.1");
  await once(server, "listening");
  process.once("SIGTERM", () => { void close(); });
  process.once("SIGINT", () => { void close(); });
  console.info("Local HTTPS ranked browser fixture listening on 3101; Google access is replaced by the Code.gs VM.");
} catch (error) {
  await close();
  throw error;
}
