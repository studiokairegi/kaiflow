import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./SettingsView.jsx", import.meta.url), "utf8");

test("Emma status is presented using Emma's name", () => {
  assert.match(source, /running \? "Emma is online" : "Emma is offline"/);
  assert.doesNotMatch(source, /running \? "Worker running" : "Worker stopped"/);
});

test("Emma controls still use the local controller and expose start/stop", () => {
  assert.match(source, /http:\/\/127\.0\.0\.1:17843/);
  assert.match(source, /"Start Emma"/);
  assert.match(source, /"Stop Emma"/);
});

test("Emma controller access requires an in-memory per-install token", () => {
  assert.match(source, /Authorization: `Bearer \${token}`/);
  assert.match(source, /controller\.token/);
});
