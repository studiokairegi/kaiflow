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
  assert.match(source, /Authorization: `Bearer \${token}`/);
  assert.match(source, /controller\.token/);
  assert.match(source, /setControllerToken/);
  assert.match(source, /localStorage\.getItem\(CONTROLLER_TOKEN_STORAGE_KEY\)/);
  assert.match(source, /localStorage\.setItem\(CONTROLLER_TOKEN_STORAGE_KEY/);
  assert.match(source, /This browser is paired/);
});

test("starting Emma requires confirmation and explains that approved mail may send", () => {
  assert.match(source, /confirmAction\("Start Emma on this computer\?/);
  assert.match(source, /approved messages may be sent/);
});
