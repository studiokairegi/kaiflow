import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { lazyWithSuspense } from "./lazy.jsx";

describe("lazyWithSuspense", () => {
  it("shows the fallback label, then the loaded component", async () => {
    const Page = () => <p>Loaded page</p>;
    const Lazy = lazyWithSuspense(() => Promise.resolve({ default: Page }), { label: "Loading page…" });
    render(<Lazy />);
    expect(screen.getByRole("status").textContent).toBe("Loading page…");
    expect(await screen.findByText("Loaded page")).toBeTruthy();
  });

  it("picks a named export when `pick` is given", async () => {
    const Named = () => <p>Named export</p>;
    // `pick` is supported at runtime but missing from the inferred options type in lazy.jsx.
    const options = /** @type {any} */ ({ pick: "Named" });
    const Lazy = lazyWithSuspense(() => Promise.resolve({ Named }), options);
    render(<Lazy />);
    expect(await screen.findByText("Named export")).toBeTruthy();
  });

  it("shows a readable error with a Reload button when the chunk fails to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Lazy = lazyWithSuspense(() => Promise.reject(new Error("chunk 404")), { label: "Reports…" });
    render(<Lazy />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Reports couldn't load.");
    expect(alert.textContent).toContain("chunk 404");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });
});
