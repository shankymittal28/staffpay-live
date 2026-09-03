# 06 — RECOVERY EVIDENCE PACKAGE

Everything listed here must exist, in the repository, before Incident 017 may be
declared closed. The test of sufficiency: **an auditor with this folder and no
other context can reconstruct what was done, why, by whom, and prove it was
correct.**

Location: `docs/incident-017/evidence/`

---

## 1. Required files

### Source evidence
| File | Contents |
|---|---|
| `backup-reference.md` | Vault row id, capture timestamp, device string, `BACKUP_HASH`, and confirmation that the owner's JSON copy exists |
| `backup-inventory.md` | All 28 storage keys with type, size, record count, first/last example — the raw forensic inventory |

### Recovery artifacts
| File | Contents |
|---|---|
| `manifest.json` | The approved manifest (§02) |
| `manifest.sha256` | `MANIFEST_HASH` |
| `rollback-list.txt` | The 38 identifiers, hash-linked to the manifest |
| `roster-table.md` | The human-readable 28-staff table exactly as presented for approval |

### Approval records
| File | Contents |
|---|---|
| `approval-record.md` | Owner's written approval quoting `MANIFEST_HASH`; states that rollback is pre-authorised |
| `recovery-complete-declaration.md` | Owner's Gate C declaration that recovery is complete |
| `incident-closed-declaration.md` | Owner's Gate E closure, including the authority-transfer (sunset) statement |

### Verification reports (one per gate, no exceptions)
`gate-A1-report.txt` · `gate-A2-report.txt` · `gate-B-report.txt` ·
`gate-C-report.txt` · `gate-D0-report.txt` · `gate-D-report.txt` ·
`gate-E-report.txt`

Each states: gate id, timestamp, validator, inputs (with hashes), the assertions
evaluated, pass/fail per assertion, and the disposition.

### Execution records
| File | Contents |
|---|---|
| `execution-log.txt` | Executor's append-only log (§03 §6) |
| `rollback-rehearsal-report.txt` | Proof the rollback path was exercised before use |
| `rollback-log.txt` | Present **only if** rollback occurred; its absence is itself evidence |

### Tooling, frozen
| File | Contents |
|---|---|
| `tools/recover017.*` | The generator as executed, marked `EXECUTED` with both hashes |
| `tools/check017.*` | The independent checker as executed |
| `tools/apply017.*` | The executor as executed |
| `tools/rollback017.*` | The rollback executor as executed |

### Final report
| File | Contents |
|---|---|
| `INCIDENT-017-FINAL-REPORT.md` | Timeline, root cause, actions, evidence index, residual risks, doctrine changes |

---

## 2. Retention and integrity rules

1. **Append-only.** No file in the evidence folder is ever edited after its gate
   closes. Corrections are new files that reference what they supersede.
2. **Hash-linked.** Every artifact names the hash of the artifact it derives from,
   forming an unbroken chain: backup → manifest → approval → execution → gates.
3. **No secrets, ever.** No tokens, passwords, session material, or personal
   contact data. The backup page already redacts the auth session; the same rule
   binds every file here.
4. **Committed to the repository**, not held in a session, a chat, or a laptop.
   The repository is the durable record; anything else is transient.
5. **Retention: permanent.** This folder outlives the tools, the incident, and
   the people involved.

## 3. Sufficiency test (apply before closing)

An engineer who has never seen this system must be able to answer, from this
folder alone:

- What broke, and what proved it? → `INCIDENT-017-FINAL-REPORT.md`, `backup-inventory.md`
- Where did the restored data come from? → `backup-reference.md` + `manifest.json`
- Why is it exactly this data and not something else? → `01`, `02` + `gate-A1-report.txt`
- Who authorised it, and to what precisely? → `approval-record.md` (hash-quoted)
- What actually happened to production? → `execution-log.txt` + `gate-B-report.txt`
- How was it proven correct, independently? → the seven gate reports
- Could it have been undone, and was that ever exercised? → `05`, `rollback-rehearsal-report.txt`
- What risk remains, and who owns it? → final report, risk section

If any question cannot be answered from the folder, the package is incomplete and
the incident stays open.
