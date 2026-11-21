import { test as base, expect } from "@playwright/test";

const isLocal = (u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);
const isStubBackend = (u) => /^https?:\/\/127\.0\.0\.1:54321\//.test(u);
const isNetworkNoise = (text) => /Failed to load resource|net::ERR_|ERR_BLOCKED|ERR_FAILED/i.test(text);

// Every test gets: (1) a hard block on non-local traffic, (2) a canned stub backend,
// (3) collection of uncaught page errors and console errors.
export const test = base.extend({
  problems: async ({ page }, use) => {
    const problems = { pageErrors: [], consoleErrors: [], blocked: [] };

    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      if (isStubBackend(url)) {
        if (url.includes("/functions/v1/")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ found: false }) });
        if (url.includes("/rest/v1/")) return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      if (isLocal(url)) return route.continue();
      problems.blocked.push(url);
      return route.abort();
    });

    page.on("pageerror", (err) => problems.pageErrors.push(String(err.message || err)));
    page.on("console", (msg) => {
      if (msg.type() === "error" && !isNetworkNoise(msg.text())) problems.consoleErrors.push(msg.text());
    });

    await use(problems);
  },
});

export { expect };
