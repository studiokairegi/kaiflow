import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

// Policy: CI fails on things that are almost always real bugs (undefined variables,
// broken hooks, duplicate keys, unreachable code). Style / hygiene findings are reported
// as warnings so the existing code base never blocks a deploy. Tighten over time by moving
// rules from "warn" to "error" once their warning count reaches zero.
export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
      "supabase/functions/**", // Deno / TypeScript runtime: not browser code
      "supabase/.temp/**",
      "intelligence-worker/**", // Python
      "docs/**", // archived backups and reference snippets
      "patches/**",
    ],
  },

  js.configs.recommended,

  // Browser app code
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "18.3" } },
    rules: {
      // --- real-bug rules: errors ---
      "no-undef": "error",
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-dupe-class-members": "error",
      "no-unreachable": "error",
      "no-const-assign": "error",
      "no-import-assign": "error",
      "no-self-assign": "error",
      "no-unsafe-finally": "error",
      "use-isnan": "error",
      "valid-typeof": "error",
      "react/jsx-no-undef": "error",
      "react/jsx-key": "error",
      "react/jsx-no-duplicate-props": "error",
      "react/no-direct-mutation-state": "error",
      "react/no-unknown-property": "error",
      "react-hooks/rules-of-hooks": "error",

      // --- hygiene: warnings only ---
      "react-hooks/exhaustive-deps": "warn",
      "react/jsx-uses-vars": "warn",
      "react/jsx-uses-react": "off", // new JSX transform
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-prototype-builtins": "warn",
      "no-case-declarations": "warn",
      "no-control-regex": "warn",
      "no-fallthrough": "warn",
      "no-async-promise-executor": "warn",
      "no-cond-assign": ["warn", "except-parens"],
      "no-inner-declarations": "warn",
      "no-misleading-character-class": "warn",
      "no-sparse-arrays": "warn",
      "no-redeclare": "warn",
      "no-regex-spaces": "warn",
    },
  },

  // Node-run tests and tooling (node:test files, config files, e2e)
  {
    files: ["**/*.mjs", "*.config.js", "e2e/**/*.js", "src/**/*.test.{js,mjs}", "src/**/*.spec.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
      "no-prototype-builtins": "warn",
      "no-case-declarations": "warn",
      "no-fallthrough": "warn",
      "no-cond-assign": ["warn", "except-parens"],
      "no-regex-spaces": "warn",
    },
  },

  // Vitest specs may use JSX
  {
    files: ["src/**/*.spec.{js,jsx}"],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
  },

  // Service worker
  {
    files: ["public/sw.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "script", globals: { ...globals.serviceworker } },
    rules: { "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }] },
  },
];
