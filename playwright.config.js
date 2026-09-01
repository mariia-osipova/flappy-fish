import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.spec.js",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [{
    command: "PORT=3100 node server.js",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    timeout: 30_000,
    // A developer's shell may already contain production credentials. This
    // server must stay local and cannot contact an Apps Script deployment.
    env: {
      HOST: "127.0.0.1",
      RANKED_ENABLED: "false",
      SESSION_HMAC_KEY: "",
      STATE_HMAC_KEY: "",
      GATEWAY_HMAC_KEY: "",
      APPS_SCRIPT_URL: "",
    },
  }, {
    command: "node tests/helpers/browser-server.js",
    url: "https://127.0.0.1:3101/api/health",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    timeout: 30_000,
    env: {
      SESSION_HMAC_KEY: "",
      STATE_HMAC_KEY: "",
      GATEWAY_HMAC_KEY: "",
      APPS_SCRIPT_URL: "",
    },
  }],
});
