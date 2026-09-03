# 09 — FINAL AUDIT

Reviewed as an external auditor with no stake in the design, hunting for hidden
assumptions, human-error exposure, missing evidence, trust violations,
determinism violations, rollback weakness, single points of failure, and weak
approvals. Findings that required redesign were fixed in the relevant document
and are recorded here.

---

## Findings

### AF-1 — Generator and checker share an author — **ACCEPTED RESIDUAL**
A shared conceptual error could pass Gate A1. Not eliminable in a single-engineer
operation. Mitigated by validator *diversity* rather than pretended away: Gate B
is judged by the database's own constraints, Gate C by an application written
before this manifest existed, Gate A2 and D by a human with business knowledge.
Correct control in a larger team: a second author for the checker. **Recorded in
§04 rather than hidden.**

### AF-2 — Manifest omits `owner_id` — **NOT A DEFECT; STRENGTH**
Initially flagged as an omission. On review it is a security property: rows are
stamped by the database default, so the manifest is structurally incapable of
addressing another account. Retained deliberately, and now documented as such in
§01 and §02.

### AF-3 — Attendance `staff_id` was specified as "linked" — **REDESIGNED**
The earlier architecture claimed attendance rows would carry staff-identifier
links. That was wrong: the link is a server-generated UUID, unknowable at
manifest time, and producing it would force the executor to read back and
re-transform — destroying both determinism and the executor's "does not think"
property. **Fixed:** `staff_id` stays `null`, which additionally makes each row
byte-identical to the phone's own queued operation and thereby guarantees the
later flush merges rather than duplicates. (§01 Step 5, recorded as an explicit
correction in the spec so no future reader inherits the earlier claim.)

### AF-4 — Rollback approval could deadlock — **REDESIGNED**
An earlier draft required owner approval for rollback. That would strand
production half-applied while waiting for a signature. **Fixed:** rollback is
pre-authorised by the same approval that authorises execution; the asymmetry
(doing needs approval, undoing never does) is now explicit in §05 §5.

### AF-5 — The freeze depends on human discipline — **MITIGATED, RESIDUAL NAMED**
The single largest exposure: nothing technically prevents a phone from opening
the app. **Fixed as far as it can be:** Gate D0 (a second physical capture,
diffed) converts an unverifiable assumption into a detected condition before any
device connects. The residual — that drift *between* D0 and the app opening
cannot be excluded — is bounded to minutes and is stated in §08 as the failure
this design most fears.

### AF-6 — Single point of failure on the backup — **REDESIGNED**
The recovery originally relied on the vault copy alone in practice. **Fixed:**
playbook Step 0 makes explicit confirmation of the owner's second (JSON) copy a
**blocking pre-condition (P5)**; F2 names the JSON copy as the documented
fallback source. Two independent copies, or the mission does not start.

### AF-7 — Hashing under-specified — **REDESIGNED**
"Hash the manifest" is not reproducible years later. **Fixed:** §02 §3–4 now fix
the algorithm (SHA-256, lowercase hex), the canonical serialisation to the byte,
and — critically — the exclusion of `generated_at` from the hash, without which
two runs could never prove determinism.

### AF-8 — Numeric determinism — **RESOLVED**
Float formatting varies across languages and could break byte-identity. All
business numbers in this data set are integers; §02 §3 rule 5 forbids
non-integral values outright, and a non-integral input is a tool ABORT rather
than a silent rounding decision.

### AF-9 — Summary-versus-raw trust — **RESOLVED, WITH PRECEDENT**
The backup page's summary card was **wrong once already in this incident** (it
counted legacy storage slots, which are empty, instead of the cache slots that
hold the live data); only the raw capture was correct. **Fixed:** §01 §4.3 bars
any gate from citing the tool's console summary as evidence, and §01 Step 2
states which keys are authoritative and why choosing wrong yields a silently
"successful" empty recovery. This is the single most dangerous mistake available
in this recovery, and it is now called out by name.

### AF-10 — Scope creep into code changes — **RESOLVED BY RULE**
Every prior plan drifted toward shipping fixes alongside recovery. Rule 8
(separate missions) plus §06's requirement that RC work be opened as separate
missions after closure removes the temptation structurally. The RC5 triage
stands: registry self-heal **REMOVED** (obsolete once the cloud is populated —
every device rebuilds its registry from the cloud on load, which is the original
design working); empty-cloud overwrite guard and honest migration marker
**POSTPONED** to one small, separately-proven RC.

### AF-11 — "Backup is the source of truth" has no expiry — **REDESIGNED**
Left unbounded, this doctrine would license a future engineer to restore stale
data over live data while citing this package. **Fixed:** the sunset clause
(§README) transfers authority to the cloud at Gate E, recorded in the closure
declaration, and F30 names package reuse as a failure mode.

### AF-12 — Approval could be given on syntax rather than meaning — **RESOLVED**
Presenting JSON to a non-technical approver would produce a rubber stamp. §04
Gate A2 requires a plain-language roster table and forbids presenting JSON; §02
§5 voids any approval that does not quote the hash. Both halves are necessary:
the table makes approval meaningful, the hash makes it binding.

---

## Determinism verdict

Satisfied, and *provably* so: pure function of a hash-verified input; no clock,
randomness, locale, or environment in the output; canonical serialisation fixed
to the byte; determinism demonstrated at Gate A1 by regeneration rather than
asserted. The competing approach fails here on inspection — the application's own
`newStaffId()` derives identifiers from `Date.now()` and `Math.random()`, so
migration logic cannot satisfy Rule 5 under any configuration.

## Reversibility verdict

Satisfied and structural: one state-changing step; additive writes into a
proven-empty target; every written row enumerated in advance; the rollback list
derived from the applied manifest rather than re-derived; the path rehearsed
before use (P6); the backup immutable by grant design (insert/select only, no
update or delete). Reversibility does not depend on anyone behaving well under
pressure.

## Single points of failure

| Candidate | Verdict |
|---|---|
| Vault backup | Not single — owner's JSON copy is a blocking pre-condition (AF-6) |
| The manifest | Not single — regenerable deterministically from the backup |
| The engineer | **Partially single** — mitigated by this package being written for a stranger; the sufficiency test (§06 §3) is the acceptance criterion |
| The owner as sole approver | **Single by design** — he is the only holder of business truth; correct, not a defect |
| The freeze | **Single, human** — the accepted residual, bounded by Gate D0 |

---

## Auditor's conclusion

**APPROVED — conditionally.** I would sign the production recovery report for
this package, provided all eight conditions below are satisfied at execution.
Absent any one of them, I would not sign.

1. **Total freeze** on both phones — online and offline — in force from now until Gate D is announced.
2. **Two backup copies confirmed** in hand before execution begins (vault + owner's JSON) — pre-condition P5.
3. **Hash-pinned execution:** the executor applies only the manifest whose hash appears in a written owner approval; no override exists.
4. **Owner-stamp assertion** included in Gate B — every restored row proven to belong to the owner's account.
5. **Rollback rehearsed** in the sealed harness before any production write — pre-condition P6.
6. **Gate D0 drift check** executed immediately before any phone opens the app.
7. **Recovery declared complete at Gate C**, with reintegration run as a separate mission under its own go/no-go.
8. **Full evidence package** (§06) committed to the repository, passing the sufficiency test, before the incident is closed — including the authority-transfer statement.

**What I am explicitly not certifying:** that no data was created on the phones
after the backup capture (unprovable; detected, not prevented, by Gate D0); that
the shared owner account is an adequate long-term security posture (it is not —
a separate mission is required now that a second operator exists); and that the
latent empty-cloud overwrite defect has been fixed (it has not — it is
deliberately postponed to its own mission, and remains a hazard for any *future*
fresh device until then).

Signed in the capacity of the engineer who would personally answer for this
recovery.
