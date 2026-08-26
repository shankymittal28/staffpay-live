# Mission 014 — Staff Module Cloud Cutover · Report

**Status: ENGINE IMPLEMENTED & LOGIC-VERIFIED — real-device acceptance pending (sandbox cannot reach Supabase).**

## Build
- Branch: `claude/warehouse-session-hang-3t3lov` (dev). NOT deployed to production.
- Modules: `staff-cloud.js` (cloud store + blob<->row translation + offline outbox + Supabase REST/Auth adapter). Reuses the `SPStore` seam and the verified `staff_` tables unchanged.
- Database: Supabase `mittal-hardware` (`bsjrihrekfsxmajdsyhc`), Postgres **17.6.1.127**.

## What was implemented (execution steps 1–4)
1. **Seam → Supabase**: `SPStore` delegates to `SPCloudStore`, backed by `SPNet` (Supabase REST + Auth).
2. **Offline intact**: in-memory mirror + `localStorage` cache + persisted outbox; app reads are synchronous from the mirror; writes queue when offline and flush on reconnect.
3. **Read path**: hydrate cloud rows → reconstruct the exact app blobs (payments/attendance/settlements from tables; registry/profiles/master/names/removed derived from `staff_employee`), preserving native id types and resolving `staffId` from the identity map.
4. **Write path**: whole-array `setRaw` is diffed against this device's mirror → row-level upsert/delete on the `staff_` tables, idempotent on `(owner_id, legacy_id)`.

## Verification results (logic, proven offline against a mock cloud)
All PASS:
- Hydrate + round-trip (rows → identical app blobs; id types preserved; staffId resolved; profiles/registry derived).
- Write path (whole-array add → single correct upsert).
- **Idempotency / no duplicate records** (re-save and re-flush create zero duplicates).
- Delete propagation (DP1 real delete).

## Offline test results (proven)
- Writes made while offline are held in the outbox, still readable locally by the app, and **auto-flush on reconnect** with no loss and no duplicates.

## Multi-device test results (proven by simulation)
- Two stores sharing one cloud: concurrent additions from each device **coexist** (neither clobbers the other), because a delete only fires for records THIS device had and removed; records another device added are never deletion candidates. After `pull()`, each device sees both.

## Remaining known limitations
1. **Concurrent edits to the SAME record** → last-write-wins (acceptable for a single owner; documented).
2. **Read staleness**: a device sees another device's new records only after a `pull()`/refresh (eventual consistency).
3. **One-time sign-in per device** is required (owner-only RLS). Session persists → invisible thereafter, but first-run is a one-time gate.
4. **NOT verified end-to-end on a real device / real network** — this build environment's egress to Supabase is blocked, so the running app talking to real Supabase, a real second phone, and a real offline→reconnect cycle could not be exercised here.

## Recommendation — is Candidate A ready for daily production use?
**Not yet — pending two steps, neither of which can be done from this sandbox:**
1. Wire `SPStore`→`SPCloudStore(SPNet)` into the shipping app with the async (hydrate-before-render) boot and the one-time sign-in, then
2. Run a real-device acceptance test (record a payment, mark attendance, settle; confirm it appears on a second device; airplane-mode → entry → reconnect → syncs; no duplicates).

The persistence **design and logic are sound and multi-device/offline-safe by construction** (proven above). Because `staffpay-live` currently holds no real production data, this final wiring + acceptance can be done safely whenever going live is desired. Until it passes on a real device, production must remain on the current local-storage build.
