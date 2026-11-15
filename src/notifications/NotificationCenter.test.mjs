// Source-level guards for NotificationCenter.jsx (no DOM in the test runner).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "NotificationCenter.jsx"), "utf8");

test("an item is consumed only after navigation succeeds", () => {
  const body = src.slice(src.indexOf("const handleItem"), src.indexOf("const label"));
  const nav = body.indexOf("await onNavigate(n)");
  const consume = body.indexOf("eng.openItem(n.id)");
  assert.ok(nav > -1 && consume > nav, "openItem must run after onNavigate");
  assert.match(body, /if \(res\.ok\) \{[\s\S]*eng\.openItem\(n\.id\)[\s\S]*close\(false\)/);
  assert.doesNotMatch(body.slice(0, nav), /openItem/);
});

test("opening the panel dismisses the reminder toast", () => {
  const body = src.slice(src.indexOf("const openPanel"), src.indexOf("// Focus the panel"));
  assert.match(body, /eng\.dismissToast\(\)/);
});
