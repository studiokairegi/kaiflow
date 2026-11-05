import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { workerState } from "./logic.js";

test("Emma heartbeat status uses Emma branding", () => {
  assert.equal(workerState(30).label, "Emma is online");
  assert.equal(workerState(300).label, "Emma is quiet for 5 min");
  assert.equal(workerState(1200).label, "Emma is offline");
  assert.equal(workerState(null).label, "Emma has never connected");
});

test("dashboard exposes a guarded Intelligence quick action", async () => {
  const app = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /onGoToIntelligence=\{canAccessIntelligence\(intelAccess\)/);
  assert.match(app, /onGoToIntelligence && \[\"Intelligence\", onGoToIntelligence\]/);
  assert.match(app, /setCrmTab\(\"intelligence\"\); setWorkspace\(\"leads\"\)/);
});
