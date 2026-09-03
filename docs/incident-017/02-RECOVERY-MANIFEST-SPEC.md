# 02 — RECOVERY MANIFEST SPECIFICATION

The manifest is **the** recovery artifact. Everything downstream pins to its
hash. It is written to be inspectable by an external auditor years from now,
without access to this conversation, this tool, or its author.

---

## 1. Contents

### 1.1 Provenance header (mandatory, complete)

| Field | Meaning |
|---|---|
| `incident` | `"017"` |
| `purpose` | One sentence, plain language: what this restores and why |
| `source.vault_row_id` | `b62e47f3-dda9-440a-93ce-77d829ad89ec` |
| `source.captured_at` | `2026-09-03T16:04:01.653Z` — when the phone was read |
| `source.backup_hash` | SHA-256 of the canonically serialised backup payload |
| `source.device` | User-agent string recorded by the backup page |
| `target.project` | `bsjrihrekfsxmajdsyhc` |
| `target.tables` | `["staff_employee", "staff_attendance"]` |
| `generator.name` / `.version` | `recover017` / semantic version |
| `generator.spec` | `docs/incident-017/01-RECOVERY-TOOL-SPEC.md` |
| `generated_at` | ISO timestamp — **header only, excluded from the hash** (§4) |

### 1.2 Row sets

- `staff` — 28 objects, fields exactly as enumerated in §01 4.2 Step 4, ordered ascending by `legacy_id`.
- `attendance` — 10 objects, fields verbatim from the queue, ordered ascending by `legacy_id`.
- No other row set. Payments and settlements are absent **because they never existed** — proven, not assumed (§README). Their absence is asserted explicitly so a future reader cannot mistake it for an omission.

### 1.3 Expectations block

`expected.staff_count` = 28 · `expected.attendance_count` = 10 ·
`expected.payment_count` = 0 · `expected.settlement_count` = 0 ·
`hashes.staff` and `hashes.attendance` — SHA-256 of each canonically serialised
row set. These are what Gate B compares the database against; they exist so
verification never has to re-derive anything from the backup.

### 1.4 What the manifest must NEVER contain

`owner_id` (supplied by database default — see §01, a security property) ·
`id` / any server-generated UUID · `created_at` / `updated_at` ·
credentials, tokens, or session material · anything read from a live phone ·
free-text notes that could be mistaken for instructions.

---

## 2. Deterministic identifier strategy

`legacy_id = "stf_" + canonical(name)` — canonicalisation defined in §01 4.2.

Properties this buys, all required:

- **Deterministic** — the same backup yields the same identifiers forever.
- **Human-auditable** — `stf_raj_swarnkar` is verifiable at a glance; a random
  token (`stf_m4x9q2_7k`, which is what the app itself would mint) is not.
- **Collision-detecting** — two names differing only by case or spacing abort the
  run rather than silently merging two people, which in this domain means merging
  two people's wages.
- **Stable under re-run** — a superseding manifest addresses the same rows, so
  re-application is an update, never a duplicate.

Attendance rows keep the identifiers already assigned by the phone
(`1788006866627` … `1788006879251`) **unchanged**. This is what makes the
eventual queue flush idempotent: the phone's pending operations target the exact
same rows.

---

## 3. Serialisation rules (determinism is a file-format property)

1. JSON, UTF-8, no BOM, LF line endings, single trailing newline.
2. Object keys sorted lexicographically at **every** level.
3. Arrays ordered by the rule stated for each row set (`legacy_id` ascending).
4. Two-space indentation; no trailing whitespace on any line.
5. Numbers: integers only, no exponent form, no `-0`. Every business number in
   this data set is an integer (salaries, opening balances). A non-integral value
   is an ABORT in the tool, not a rounding decision here.
6. `null` is written as `null`; absent is never used to mean null.
7. No locale-dependent formatting anywhere.

Two independent implementations following these rules must produce byte-identical
files. That is the acceptance test for the rules themselves.

---

## 4. Hashing

- Algorithm: **SHA-256**, lowercase hex, no separators.
- `MANIFEST_HASH` covers the canonical serialisation of the manifest **excluding
  the `generated_at` field**, which is metadata about the run rather than about
  the content. Excluding it is what allows two runs on different days to prove
  determinism by producing an identical hash. This exclusion must be stated in
  the manifest itself so an auditor can reproduce the computation.
- `BACKUP_HASH` covers the canonical serialisation of the backup payload.
- Row-set hashes cover each canonically serialised array.

Every hash is recorded in the incident log **before** any state-changing step.

---

## 5. Approval workflow

1. **DRAFT** — tool emits the manifest.
2. **CHECKED** — Gate A1: independent checker (different code path) re-derives
   expectations from the backup, diffs, and proves determinism by regenerating.
3. **PRESENTED** — the 28 names with salary, wage type and group are rendered as
   a plain human table (Appendix A format). No JSON is put in front of the
   approver; approval must be of business meaning, not of syntax.
4. **APPROVED** — the owner records a written approval that **quotes
   `MANIFEST_HASH`**. Approval of "the manifest" without a hash is void.
5. **EXECUTABLE** — only the hash named in an approval record may be applied.

The approval is stored as a **separate file** (`approval-record.md`), never
appended to the manifest — appending would change the manifest's bytes and
therefore its hash, invalidating the very thing being approved.

---

## 6. Immutability rules

- The manifest is content-addressed. It is never edited.
- A change of any kind produces a **new** manifest with a new hash and a new
  approval. The old one is retained and marked `SUPERSEDED BY <hash>`.
- Superseded manifests are never deleted: they are part of the audit trail.
- The manifest may not be regenerated "to fix" a failed gate. A failed gate means
  the evidence or the specification is wrong; both are amended in the open.

---

## 7. Lifecycle

```
DRAFT ──Gate A1──▶ CHECKED ──human──▶ APPROVED ──executor──▶ EXECUTED ──Gate E──▶ ARCHIVED
   │                   │                  │                      │
   └── ABORT ──────────┴── REJECTED ──────┴── ROLLED BACK ───────┘
                    (all terminal states are recorded, never deleted)
```

A manifest in any state other than `APPROVED` is not executable, and the executor
(§03) is required to refuse it.
