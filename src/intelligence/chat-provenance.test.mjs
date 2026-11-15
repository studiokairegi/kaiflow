import test from "node:test";
import assert from "node:assert/strict";
import { aiLabel, chatTurns } from "./logic.js";

test("a Gemini answer names Gemini and the exact model", () => {
  const s = aiLabel({ ai_mode: "ai", ai_provider: "gemini", ai_model: "gemini-3.8-flash", ai_latency_ms: 1234, kb_keys: ["pricing.principles"] });
  assert.match(s, /Answered by Gemini \(gemini-3\.8-flash\)/); assert.match(s, /1\.2 s/); assert.match(s, /pricing\.principles/);
});

test("an Ollama fallback never says Gemini and shows why", () => {
  const s = aiLabel({ ai_mode: "ai", ai_provider: "ollama", ai_model: "qwen2.5:3b-instruct", ai_route_reason: "gemini_backoff_rate_limit" });
  assert.doesNotMatch(s, /Gemini \(/); assert.match(s, /Ollama/); assert.match(s, /gemini_backoff_rate_limit/);
});

test("deterministic, draft and unavailable replies are not presented as AI answers", () => {
  assert.match(aiLabel({ ai_mode: "deterministic_fallback" }), /not written by an AI model/);
  assert.match(aiLabel({ ai_mode: "draft_handler" }), /not written by chat/);
  assert.match(aiLabel({ ai_mode: "unavailable" }), /No AI provider/);
});

test("rows written before provenance existed show no label, and chatTurns carries the label", () => {
  assert.equal(aiLabel({ role: "assistant" }), null); assert.equal(aiLabel(null), null);
  const turns = chatTurns([{ id: 1, role: "user", content: "hi" }, { id: 2, role: "assistant", reply_to: 1, content: "yo", status: "done", ai_mode: "ai", ai_provider: "gemini", ai_model: "m" }]);
  assert.match(turns[1].ai, /Gemini/); assert.equal(turns[0].ai, undefined);
});

test("a failed draft reply does not claim a draft was saved", () => {
  assert.doesNotMatch(aiLabel({ ai_mode: "draft_handler", status: "error" }), /^Draft saved/);
  assert.match(aiLabel({ ai_mode: "draft_handler", status: "error" }), /No draft was saved/);
  assert.match(aiLabel({ ai_mode: "draft_handler", status: "done" }), /^Draft saved/);
  const turns = chatTurns([{ id: 1, role: "user", content: "x" }, { id: 2, role: "assistant", reply_to: 1, content: "no", status: "error", ai_mode: "draft_handler" }]);
  assert.match(turns[1].ai, /No draft was saved/);
});

test("a suggestion chip does not clear the textarea", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./ChatView.jsx", import.meta.url), "utf8");
  assert.match(src, /if \(value == null\) setText\(""\)/);
  assert.doesNotMatch(src, /chatSend\([^\n]*\n\s*setText\(""\);/);
});

test("a tool used several times in one answer is listed once", () => {
  const turns = chatTurns([{ id: 1, role: "user", content: "x" },
    { id: 2, role: "tool", reply_to: 1, tool_name: "list_prospects" }, { id: 3, role: "tool", reply_to: 1, tool_name: "list_prospects" },
    { id: 4, role: "assistant", reply_to: 1, content: "ok", status: "done" }]);
  assert.deepEqual(turns[1].tools, ["Listed prospects"]);
});

test("New chat does not create another empty thread", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("./ChatView.jsx", import.meta.url), "utf8");
  assert.match(src, /const fresh = \(\) => run\(async \(\) => \{ const current = own\(msgs\.data\); if \(threadId && current && current\.length === 0\) return;/);
});
