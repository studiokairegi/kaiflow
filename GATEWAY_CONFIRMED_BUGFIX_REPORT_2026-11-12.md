# Gmail / Zoho Gateway Confirmed Bug-Fix Report

Date: 2026-11-12

## Confirmed defect

The Zoho mailbox sync adapter emits a terminal checkpoint with `folders: []` after finishing the Inbox and Sent folders. On the next scheduled/manual sync, it previously treated any array (including an empty array) as a valid cached folder list. That caused the next run to fail with `Zoho did not return Inbox and Sent folders` instead of rediscovering the folders.

## Correction

- Treat a missing **or empty** checkpoint folder list as requiring a fresh folder discovery call.
- Preserve non-empty checkpoint folder lists while continuing pagination within a sync run.
- Add a regression test that completes a full Inbox/Sent pass, reuses the terminal checkpoint, and verifies the next sync rediscovers folders and starts normally.

## Verification

- Focused Gmail/Zoho adapter tests: 9 passed, 0 failed.
- Full Node test suite: 1,057 passed, 0 failed.
- Intelligence worker Python suite: 754 passed, 0 failed.
- Targeted strict TypeScript check for the shared adapter/OAuth/send modules: passed.

## Scope and limitations

- Existing Settings/Intelligence Gmail and Zoho connections, account UUIDs, encrypted credential storage and token-refresh lifecycle are unchanged and reused.
- SMTP/IMAP remain deferred and untouched.
- Zoho remains restricted to human-initiated business correspondence.
- The central registry continues to keep mailbox sync/folder capabilities disabled pending live Gmail/Zoho acceptance and native incremental sync implementation.
- No live provider calls, SQL migration execution, Deno runtime check or production deployment were performed.
- Vite was unavailable in this runtime, so the production build could not be run.

This report records the confirmed bug fixed in this pass. It does not claim that previously documented incomplete features are complete or that the overall email system is production-ready.
