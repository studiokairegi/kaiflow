Emma outreach language and brevity update

Changed files:
- intelligence-worker/kairflow_intel/drafting.py
  * Japanese animation-studio prospects (country Japan or researched language ja) receive a concise, natural Japanese initial outreach subject/body.
  * English initial outreach is condensed to one paragraph using short approved knowledge-base excerpts and the approved portfolio link.
  * Follow-ups and simple automated replies use concise language matching the prospect's Japanese/English locale.
  * Required initial/follow-up compliance footer remains present. Policy violations in approved service text are not hidden by excerpt truncation.
- intelligence-worker/tests/test_logic.py
  * Adds regression coverage for Japanese initial/follow-up/reply drafts and single-paragraph brevity.

Verification:
- python -m unittest discover -v (from intelligence-worker): 129 tests passed.
- python -m py_compile intelligence-worker/kairflow_intel/drafting.py intelligence-worker/tests/test_logic.py: passed.

No emails were sent. No production settings, database, or deployment were changed.
