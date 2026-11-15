import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRecipients, replySubject, forwardSubject, composeProblem, autoReadStamp } from "./lib/logic.js";

const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// --- #3 recipients with a comma inside a quoted display name
test("quoted display name containing a comma is ONE recipient", () => {
  assert.deepEqual(parseRecipients('"Doe, John" <john@x.com>, b@y.com'), { valid: ["john@x.com", "b@y.com"], invalid: [] });
  assert.deepEqual(parseRecipients('"Doe, John" <john@x.com>; "Roe, Jane" <jane@y.com>'), { valid: ["john@x.com", "jane@y.com"], invalid: [] });
  assert.equal(composeProblem({ accountId: "a", to: '"Doe, John" <john@x.com>', cc: "", bcc: "", subject: "s", body: "b" }), "");
});
test("recipient parsing keeps its old behaviour for plain lists, duplicates and junk; a line break and an unbalanced quote still recover", () => {
  assert.deepEqual(parseRecipients("A@x.com, Bob <b@y.com>; bad, a@x.com"), { valid: ["a@x.com", "b@y.com"], invalid: ["bad"] });
  assert.deepEqual(parseRecipients('"Unbalanced <a@x.com>\nb@y.com'), { valid: ["a@x.com", "b@y.com"], invalid: [] });
  assert.deepEqual(parseRecipients(""), { valid: [], invalid: [] });
});

// --- #7 reply prefixes must not stack
test("replySubject keeps an existing reply prefix (Re, Re[2], Aw, Sv, Antw) and adds Re: otherwise", () => {
  for (const s of ["Re: hi", "RE: hi", "Re[2]: hi", "AW: hi", "Sv: hi", "Antw: hi"]) assert.equal(replySubject(s), s);
  assert.equal(replySubject("hi"), "Re: hi");
  assert.equal(replySubject("Fwd: hi"), "Re: Fwd: hi");
  assert.equal(replySubject(""), "Re:");
  assert.equal(forwardSubject("Fwd: x"), "Fwd: x");
});

// --- #1 "Mark unread" must not be undone by the auto-mark-read effect
test("autoReadStamp: marks read once per open, not again after Mark unread, again for a new message", () => {
  const open = { id: "c1", unread_count: 2, message_count: 2 };
  let last = "";
  const first = autoReadStamp(open, last);
  assert.equal(first, "c1:2");           // opened with unread mail -> mark read
  last = first;
  assert.equal(autoReadStamp({ ...open, unread_count: 0 }, last), "");                    // after it was marked read
  assert.equal(autoReadStamp({ ...open, unread_count: 1 }, last), "");                    // user pressed "Mark unread": stays unread
  const arrived = autoReadStamp({ ...open, unread_count: 2, message_count: 3 }, last);    // a new message arrives while open
  assert.equal(arrived, "c1:3");
  assert.equal(autoReadStamp({ id: "c1", unread_count: 1, message_count: 3 }, ""), "c1:3"); // closed and reopened (ref reset) -> marked again
  assert.equal(autoReadStamp(null, ""), "");
});
test("InboxModule uses autoReadStamp and resets it when the selection changes", () => {
  const s = src("./InboxModule.jsx");
  assert.match(s, /autoReadStamp\(c, autoRead\.current\)/);
  assert.match(s, /useEffect\(\(\) => \{ autoRead\.current = ""; \}, \[selected\]\)/);
  assert.doesNotMatch(s, /\[thread\.data\?\.conversation\?\.id, thread\.data\?\.conversation\?\.unread_count\]/);
});

// --- #4 stale data must not be shown for a different selection
test("InboxModule only shows a thread / list that answers the current selection", () => {
  const s = src("./InboxModule.jsx");
  assert.match(s, /thread\.data\?\.id === selected/);                  // thread tagged with its conversation id
  assert.match(s, /list\.data\?\.key === listKey/);                    // list tagged with folder/search/account/provider
  assert.match(s, /selected && !t && threadNow &&/);                   // failed load for the new selection shows an error + Retry, not the old thread
  assert.doesNotMatch(s, /const rows = list\.data \|\| \[\]/);
});

// --- #2 / #5 / #6 compose dialog
test("ComposeDialog: backdrop and X go through a dirty check; cancelling Delete draft keeps the dialog open", () => {
  const s = src("./components/ComposeDialog.jsx");
  assert.match(s, /e\.target === e\.currentTarget\) requestClose\(\)/);
  assert.match(s, /onClick=\{requestClose\} aria-label="Close"/);
  assert.doesNotMatch(s, /e\.target === e\.currentTarget\) onClose\(\)/);
  assert.match(s, /const requestClose = \(\) => \{\s*if \(sendState\.busy\) return;\s*if \(!dirty \|\| confirmAction\(/);
  assert.match(s, /if \(!confirmAction\("Delete this draft\?"\)\) return;/);   // cancel -> return, not onClose()
  assert.match(s, /savedSig\.current = formSig;/);                          // a saved draft is no longer "unsaved work"
});
test("ComposeDialog: saving a draft with an invalid address is refused instead of silently dropping it", () => {
  const s = src("./components/ComposeDialog.jsx");
  const save = s.slice(s.indexOf("const saveDraft"), s.indexOf("const send = "));
  assert.match(save, /parseRecipients\(text\)\.invalid\[0\]/);
  assert.match(save, /throw new Error\(/);
  assert.ok(save.indexOf("throw new Error(") < save.indexOf("emailApi.saveDraft"));   // refuses BEFORE calling the server
});
