import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest is for NEW component / unit tests (jsdom). The existing ~1,370 tests use node:test
// (*.test.mjs, run by `npm test`) and must keep running there, so Vitest only picks up *.spec.*
// files and never touches *.test.mjs.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.{js,jsx}"],
    exclude: ["node_modules/**", "dist/**", "e2e/**", "**/*.test.mjs"],
    setupFiles: ["./vitest.setup.js"],
    restoreMocks: true,
    css: false,
  },
});
