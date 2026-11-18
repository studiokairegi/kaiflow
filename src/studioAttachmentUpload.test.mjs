import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fn = readFileSync(new URL("../supabase/functions/studio-drive-upload/index.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.jsx", import.meta.url), "utf8");

test("studio-drive-upload caps attachments at 3 GB and never parses the file body", () => {
  assert.match(fn, /MAX_UPLOAD_BYTES = 3 \* 1024 \* 1024 \* 1024/);
  assert.doesNotMatch(fn, /formData\(\)/);
  assert.doesNotMatch(fn, /uploadFileToDrive/);
  assert.doesNotMatch(fn, /50 \* 1024 \* 1024/);
});

test("studio-drive-upload verifies the Drive file before recording it, and only once", () => {
  for (const needle of ["md5Verdict", "fingerprintMatches", "meta.parents", "alreadyRecorded", "append_shot_file"]) assert.ok(fn.includes(needle), needle);
});

test("shot attachment button uses the resumable client with the same 3 GB cap", () => {
  assert.match(app, /ATTACHMENT_MAX_BYTES = 3 \* 1024 \* 1024 \* 1024/);
  assert.match(app, /uploadResumableDriveFile\(\{\s*url: functionUrl\("studio-drive-upload"\)/);
  assert.doesNotMatch(app, /body\.append\("file", file\)/);
});
