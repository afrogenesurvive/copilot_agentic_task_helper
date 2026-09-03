# 🔑 Licenses

The Licenses tab lists the **seat license records** that the frontdesk webapp uses for login.

## What you'll see

A table of seats with:

- **Seat** — the seat identifier (`sub`).
- **Status** — `valid`, `expired`, or `revoked`.
- **Expires** — an ISO date, or **unlimited** for non-expiring seats.
- **Enc** — `yes`/`no` whether the record carries encryption keys.

A **Refresh** button re-reads the records from disk.

## How status is decided

Status is derived from each record:

- `revoked` — the seat has been explicitly revoked.
- `valid` — not revoked and (for expiring seats) the expiry is still in the future.
- `expired` — not revoked but past the expiry date.
- A seat with no expiry is valid indefinitely.

## Where the data comes from

Records are collected by the shared license engine
(`scripts/frontdesk-license.mjs`), which reads the seat records (key files) managed for the
frontdesk. Issue/revoke operations happen outside this dashboard (key generation tooling), and
the results show up here after a refresh.

## Notes

- This tab is **read-only** — you cannot create or revoke licenses from here.
- Licenses gate webapp login; they are not required to run this operator app itself.
