// Type-check ratchet for a JavaScript code base.
//
// Runs `tsc -p tsconfig.json`, counts errors per file, and compares with typecheck-baseline.json.
//   * a file with MORE errors than its baseline (or any error in a file not in the baseline) -> fail
//   * fewer errors -> pass, and tells you to refresh the baseline so the gain is locked in
//   node scripts/typecheck-ratchet.mjs --update   rewrites the baseline from the current state
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(root, "typecheck-baseline.json");
const update = process.argv.includes("--update");

const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc");
const run = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json", "--pretty", "false"], {
  cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
});
const output = `${run.stdout || ""}${run.stderr || ""}`;
if (run.error) { console.error("Could not run tsc:", run.error.message); process.exit(2); }

const counts = {};
let unparsed = 0;
for (const line of output.split(/\r?\n/)) {
  const m = line.match(/^(.+?)\(\d+,\d+\): error TS\d+:/);
  if (m) counts[m[1].replace(/\\/g, "/")] = (counts[m[1].replace(/\\/g, "/")] || 0) + 1;
  else if (/error TS\d+/.test(line)) unparsed += 1; // global errors such as a bad tsconfig
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (unparsed > 0) {
  console.error(`tsc reported ${unparsed} configuration-level error(s):\n${output}`);
  process.exit(2);
}
if (run.status !== 0 && run.status !== 2 && total === 0) { // 2 = errors found, 0 = clean
  console.error(`tsc exited with status ${run.status}:\n${output}`);
  process.exit(2);
}

if (update) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(baselinePath, JSON.stringify({ total, files: sorted }, null, 2) + "\n");
  console.log(`Baseline written: ${total} existing type errors in ${Object.keys(sorted).length} files.`);
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error("typecheck-baseline.json is missing. Run: node scripts/typecheck-ratchet.mjs --update");
  process.exit(2);
}
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")).files || {};

const worse = [];
const better = [];
for (const [file, n] of Object.entries(counts)) {
  const was = baseline[file] || 0;
  if (n > was) worse.push(`  ${file}: ${was} -> ${n}`);
}
for (const [file, was] of Object.entries(baseline)) {
  const n = counts[file] || 0;
  if (n < was) better.push(`  ${file}: ${was} -> ${n}`);
}

if (worse.length) {
  console.error(`Type check FAILED: new type errors introduced (baseline -> now)\n${worse.join("\n")}`);
  console.error("\nSee the details with: npx tsc -p tsconfig.json --pretty false | grep <file>");
  process.exit(1);
}
console.log(`Type check OK: ${total} errors, none beyond the baseline (${Object.keys(baseline).length} files with known errors).`);
if (better.length) {
  console.log(`\nImproved - run "npm run typecheck:update" to lock these gains in:\n${better.join("\n")}`);
}
