import { test, expect } from "./fixtures.js";

// Smoke tests: no credentials, no real backend. They answer "does the shipped bundle boot and render
// its public entry points without crashing?" - the failure mode a bad deploy actually produces.

test("the app boots and shows the sign-in screen when logged out", async ({ page, problems }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Kairil/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Forgot password?")).toBeVisible();
  expect(problems.pageErrors).toEqual([]);
  expect(problems.consoleErrors).toEqual([]);
});

test("sign-in form can switch to account creation and back", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Need an account? Sign up").click();
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  await page.getByText("Already have an account? Sign in").click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("public checkout page shows the 'unavailable' state for a malformed token (no backend needed)", async ({ page, problems }) => {
  await page.goto("/pay/not-a-real-token");
  await expect(page.locator(".kf-payment-result-body")).toBeVisible();
  expect(problems.pageErrors).toEqual([]);
});

test("public checkout 'return' route also renders without crashing", async ({ page, problems }) => {
  await page.goto("/pay/not-a-real-token/return");
  await expect(page.locator("#root")).not.toBeEmpty();
  await expect(page.locator(".kf-payment-result-body")).toBeVisible();
  expect(problems.pageErrors).toEqual([]);
});

test("public routes never crash the page (no uncaught exceptions, #root rendered)", async ({ page, problems }) => {
  const routes = [
    "/",
    "/pay/not-a-real-token",
    "/portfolio/not-a-real-token",
    "/?share=project&token=not-a-real-token",
    "/?share=shot&token=not-a-real-token",
    "/?share=contract&token=not-a-real-token",
    "/?share=nda&token=not-a-real-token",
    "/?guest-chat=1",
  ];
  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("#root")).not.toBeEmpty();
    // Both error boundaries (startup, and the per-screen one in src/lazy.jsx) render role="alert" when a
    // render throws or a chunk fails to load - they swallow the exception, so check for them explicitly.
    await expect(page.getByRole("alert"), `error boundary shown on ${route}`).toHaveCount(0);
  }
  expect(problems.pageErrors, `uncaught errors:\n${problems.pageErrors.join("\n")}`).toEqual([]);
  expect(problems.consoleErrors, `console errors:\n${problems.consoleErrors.join("\n")}`).toEqual([]);
});

test("booting never contacts real Supabase, Paystack or Resend hosts", async ({ page, problems }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  // The fixture aborts every non-local request and records it; none may be a real backend host.
  for (const url of problems.blocked) expect(url).not.toMatch(/supabase\.co|paystack|resend\.com/i);
});
