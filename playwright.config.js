import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// SAFETY: the app is always built against a STUB Supabase URL (process env wins over any local .env),
// and e2e/fixtures.js aborts every request that is not to localhost / the stub. These tests can never
// reach production Supabase, Paystack, Resend or Google.
export const STUB_SUPABASE_URL = "http://127.0.0.1:54321";

// Optional: point at a Chromium you already have (e.g. in a locked-down environment).
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const launchOptions = executablePath
  ? { executablePath, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] }
  : {};

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    launchOptions,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions } },
    { name: "mobile", use: { ...devices["Pixel 5"], launchOptions } },
  ],
  webServer: {
    command: "npm run build && node ./node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      VITE_SUPABASE_URL: STUB_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: "e2e-stub-anon-key",
    },
  },
});
