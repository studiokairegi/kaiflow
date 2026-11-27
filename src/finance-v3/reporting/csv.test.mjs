import test from "node:test";
import assert from "node:assert/strict";
import { toCsv, csvEscape, neutraliseCell, exportFileName } from "./csv.js";

test("quotes commas, quotes and line breaks (RFC 4180)", () => {
  assert.equal(csvEscape("a,b"), '"a,b"'); assert.equal(csvEscape('say "hi"'), '"say ""hi"""'); assert.equal(csvEscape("l1\nl2"), '"l1\nl2"'); assert.equal(csvEscape("plain"), "plain");
});
test("formula-looking text is defused with a leading apostrophe", () => {
  for (const t of ["=SUM(A1:A2)", "+1+1", "-2+3", "@cmd", "\t=1", "\r=1", "  =1+1", '=HYPERLINK("http://evil")']) assert.ok(neutraliseCell(t).startsWith("'"), t);
  assert.equal(csvEscape('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
});
test("real numbers, including negative amounts, are not altered", () => {
  for (const n of ["12", "-12.50", "0.00", "1500000.00"]) assert.equal(neutraliseCell(n), n);
  assert.equal(neutraliseCell(5), "5"); assert.equal(neutraliseCell(-5), "-5");
});
test("null and undefined become empty cells; booleans and objects are text", () => {
  assert.equal(csvEscape(null), ""); assert.equal(csvEscape(undefined), ""); assert.equal(csvEscape(true), "true");
});
test("the whole file: header, CRLF line ends, BOM, defused cells", () => {
  const csv = toCsv(["name", "amount"], [["Acme, Inc", "10.00"], ["=BAD()", "-3.50"]]);
  assert.equal(csv, '﻿name,amount\r\n"Acme, Inc",10.00\r\n\'=BAD(),-3.50\r\n');
  assert.equal(toCsv(["a"], [], { bom: false }), "a\r\n");
  assert.throws(() => toCsv("a", []), TypeError);
});
test("a header cannot carry a formula either", () => { assert.ok(toCsv(["=x"], []).includes("'=x")); });
test("file names are safe and say what the file is", () => {
  assert.equal(exportFileName("invoices", "Studio / A", "2026-01-01", "2026-01-31"), "finance-invoices-studio-a-2026-01-01_2026-01-31.csv");
  assert.equal(exportFileName("audit", "../../etc", null, null, new Date("2026-02-03T10:00:00Z")), "finance-audit-etc-2026-02-03.csv");
});
