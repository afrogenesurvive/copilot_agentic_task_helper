# 🔑 Key Manager

Issue, revoke, unrevoke and validate **seat licences** — the credentials collaborators use to log
into the public chat webapp — and manage the **master key rings** that sign them.

> All key management lives in the sibling **personal_key_manager** repo. This tab is a front end
> that shells out to its `pkm` CLI (`--json`); no licence data or logic lives in this app.
>
> The store holds an **independent ring + seat ledger per registry** (consumer app), so the tab
> manages **every** registry in the store, not just `frontdesk-agent`.

## Why this matters

A seat licence gates **webapp login** for one collaborator — it is not required to run this
operator app. Revocation is read **live** by the webhook server on every login attempt, so a
revoke you click here is enforced on that seat's next login with **no restart and no rebuild**.

## The header

- **Badge** — seats in the selected registry, plus the active master ring id.
- **Store path** — the `personal_key_manager` store being read, the selected registry, its app id
  and signing engine, ring count, how many seats are blocked, and the per-command `pkm` timeout.
- If the store can't be found you'll see the path it looked for; fix it by setting `PKM_ROOT`
  (store location) or `PKM_REPO` (repo location) in ⚙️ Config.

### Registry picker

Every panel below is scoped to the registry selected here. Switching registry reloads the rings,
the seat table and the audit log for that app, and clears the audit view (which is per-registry).

Each option shows the registry's seat and ring counts, and the line beside the picker summarises
its **app id**, **engine**, ring/seat/revocation counts, and how its blocklist reaches the consumer
app — either *read live* (like `frontdesk-agent`) or **embedded** in source files (`transcription-agent`,
which then needs 🔄 Sync blocklist plus a rebuild).

`PKM_REGISTRY` in ⚙️ Config chooses the registry the *webhook server* verifies against — the picker
defaults to it but does not change it.

## The seats table

| Column | Meaning |
| --- | --- |
| **Seat** | The seat identifier (`sub`) |
| **Status** | `valid`, `expiring` (≤30 days), `expired`, or `revoked` |
| **kid** | The master ring that signed this licence |
| **Expires** | An ISO date, or **unlimited** |
| **Days** | Days until expiry (`—` for unlimited, negative = past) |
| **Enc** | `yes`/`no` — whether the licence carries the X25519 key needed for E2E chat |
| **Issued** | When the licence was minted |
| **Action** | **Revoke** (or **Unrevoke** if already revoked) |

## Toolbar actions

### ＋ Issue license

Ask for a **seat id** (the collaborator's email) and an **expiry** — a date like `2027-12-31`, or
the literal `unlimited`.

The new licence is shown **once**, in a modal with a **Copy** button.

> ⚠️ **The licence embeds the seat's private keys and is never shown again.** Copy it and hand it
> to the collaborator over a secure channel. This app does not store it or log it anywhere — the
> modal clears the moment you close it. If you lose it, revoke the seat and issue a new one.

### Revoke

Blocks the seat immediately. Any configuration or chat history stored under that seat's key
becomes unreadable. You'll be asked to confirm, and you can optionally record a reason.

### Unrevoke

Reinstates a revoked seat — the same licence key works again. Use this if you revoke by mistake.

### Validate…

Paste any licence string to check it against the live ring and revocation blocklist. Useful for
confirming a key before handing it out, or diagnosing a collaborator's failed login.

Results are explicit: `malformed`, `unknown_kid`, `retired_kid`, `revoked_seat`, `bad_signature`,
`key_mismatch`, `expired`, or a valid verdict showing the seat, ring, expiry and whether the
encryption key is present. Revocation is checked *before* the signature, so `revoked_seat` always
means blocked.

### Archive expired

Moves ledger records whose expiry has already passed into the `expired/` archive. This only
tidies already-expired records — it never revokes anything.

### 🔄 Sync blocklist

Only meaningful for registries that **embed** their blocklist in their own source files (the picker
line says so). Rewrites those files from the authoritative `revoked-seats.json`;
**the consumer app must be rebuilt afterwards** for the change to take effect. Registries that read
their blocklist live (`frontdesk-agent`) have nothing to sync, and the button says so.

### Refresh

Re-reads the registry's ring table and seat table. Note that the underlying `pkm check-exp` **does**
archive already-expired ledger records as a side effect (it never revokes anything) — the seat
summary tells you when a refresh archived something. Use **Archive expired** when you want that
to happen deliberately.

## Rings

The rings table lists every master key in the selected registry:

| Column | Meaning |
| --- | --- |
| **kid** | Ring identifier (`mk-2026-08`, `mk-dev`, …) |
| **Default** | The ring that signs newly issued seats (**Make default** switches it) |
| **Public key** | The published half (hover for the full value) |
| **Retires** | The `notAfter` date, plus a `retired` tag once it has passed |
| **Retire** | Sets `notAfter` so verifiers reject licences signed by this ring |

### ＋ New ring

Mints a new Ed25519 master keypair from a `kid` you choose. The private half is written `0600`
inside the key store and never leaves the machine. The registry's **first** ring automatically
becomes its default signing key.

### 🔑 Agent key

Regenerates the X25519 peer keypair used for E2E chat — only offered by `ed25519+x25519`
registries (`frontdesk-agent`). Existing webapp sessions stop decrypting until you copy the new
public key into `FRONTDESK_AGENT_PUBKEY` (⚙️ Config) and restart the webhook server. Registries on
plain `ed25519` (`transcription-agent`) have no agent key and the hint says so.

### Making a ring the default

Existing seats keep the ring that signed them; only **new** seats use the new default. Retiring a
ring does not invalidate the seats it already signed — they keep working until they expire or are
revoked.

## Audit log

**Show** lists the registry's append-only action log (issue / revoke / unrevoke / expiry) with
timestamps, newest first. This is the authoritative history of who was issued what, and when.

## Notes

- **Operator-only.** This table lists *every* seat at once. A collaborator never sees it — each
  only logs into their own webapp chat with their own licence key.
- **Where the paths come from.** Nothing is hardcoded: `PKM_REPO` (checkout), `PKM_ROOT` (store),
  `PKM_REGISTRY` (default registry), `PKM_BIN` (CLI override), `PKM_NODE` (interpreter override) and
  `PKM_TIMEOUT_MS` (per-command timeout, default 20s) are read from ⚙️ Config on every click — the
  Key Manager picks up a change immediately, while the webhook server / runner need a restart.
- **Registry directories** come from the authoritative `registries/registry.json` index (`dir`
  field), so a registry whose directory differs from its id still resolves.
- **Still CLI-only:** creating or removing a whole **registry** (`pkm registry create|remove`) needs
  an app id and an engine choice that a dashboard click shouldn't guess, so it stays in
  `personal_key_manager` (see its own notes), together with `pkm export` and `pkm perms`.
