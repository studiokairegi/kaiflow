import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./SettingsView.jsx", import.meta.url), "utf8");

test("Emma worker controls use only the local controller and expose start/stop", () => {
  assert.match(source, /http:\/\/127\.0\.0\.1:17843/);
  assert.match(source, /request\("\/api\/status"\)/);
  assert.match(source, /request\(`\/api\/\$\{action\}`/);
  assert.match(source, /"Start Emma"/);
  assert.match(source, /"Stop Emma"/);
  assert.match(source, /credentials: "omit"/);
});

test("starting Emma requires confirmation and explains that approved mail may send", () => {
  assert.match(source, /confirmAction\("Start Emma on this computer\?/);
  assert.match(source, /approved messages may be sent/);
});
