// @ts-nocheck -- test harness: uses ad-hoc window test hooks (__calls, __override, ...)
// Test entry: mounts FinanceV3Module over the REAL client API (createFinanceApi) with an in-page fake RPC.
// The fake returns recorded outputs of the real database functions (fixtures.json) unless a test overrides a function.
import React from "react";
import { createRoot } from "react-dom/client";
import FinanceV3Module from "../FinanceV3Module.jsx";
import { createFinanceApi } from "../../api/phase6.js";

window.__calls = []; window.__override = {}; window.__delay = {};
const fx = window.__fixtures;
const rpc = async (name, args) => {
  window.__calls.push({ name, args });
  const d = window.__delay[name]; if (d) await new Promise((r) => setTimeout(r, d));
  const o = window.__override[name];
  if (o !== undefined) { const v = typeof o === "function" ? o(args) : o; if (v && v.__error) return { data: null, error: v.__error }; return { data: v, error: null }; }
  if (name in fx) return { data: JSON.parse(JSON.stringify(fx[name])), error: null };
  return { data: null, error: { code: "V3010", message: `No fixture for ${name}` } };
};
window.__mount = (opts = {}) => {
  const el = document.getElementById("root"); if (window.__root) window.__root.unmount(); window.__root = createRoot(el);
  const api = createFinanceApi(rpc);
  window.__downloads = []; window.__lastApi = api;
  window.__root.render(<FinanceV3Module api={api} organizationId={opts.org || "org-1"} payUrl={(t) => `https://example.test/pay?t=${t}`}
    downloadDocument={async (kind, id) => { window.__downloads.push({ kind, id }); }} />);
};
