# Incident 017 — Approval Record (Gate A2)

Approver: Shanky Mittal (owner, shankymittal28@gmail.com)
Date: 2026-09-04
Approved artifact: Recovery Manifest, MANIFEST_HASH
c3714eaed33a9470572b88c881454eaff1cfd0995a9ccf501ff453e7bc39045c
(approver quoted prefix "c3714eae" — matches; full hash bound here)

Approval text (verbatim, from the owner's message):
"APPROVED — Manifest c3714eae. Approval is granted ONLY for Stage C exactly as
specified." Conditions: apply only this manifest; no app code changes; no schema
changes; no unrelated fixes; stop + predefined rollback on any verification
failure; full evidence immediately after the write; phones stay closed until
Stage C fully passes.

Per 05-ROLLBACK-SPEC.md §5, this approval PRE-AUTHORISES rollback (targeted
deletion of the 38 manifest identifiers) for any abort during or after
execution. Doing requires this approval; undoing never does.
