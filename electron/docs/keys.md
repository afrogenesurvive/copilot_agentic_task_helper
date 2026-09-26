# 🔑 Key Manager

Issue, revoke, unrevoke and validate **seat licences** — the credentials collaborators use to log
into the public chat webapp — bind an **identity claim** to a key, and manage the **master key
rings** that sign them.

> All key management lives in the sibling **personal_key_manager** repo. This tab is a front end
> that shells out to its `pkm` CLI (`--json`); no licence data or logic lives in this app.
>
> The store holds an **independent ring + seat ledger per registry** (consumer app), so the tab
> manages **every** registry in the store, not just `frontdesk-agent`.

## Why this matters

A seat licence gates **webapp login** for one collaborator, and it can also sign someone in to
**this** app (paste it into the sign-in screen's Secret field — see the Claims section). It is never
*required* here: the sign-in on launch takes an email + secret first, and a licence is only consulted
when that address is in neither `.env` nor the role registry. Revocation is read **live** by the
webhook server on every login attempt, so a revoke you click here is enforced on that seat's next
webapp login with **no restart and no rebuild**; on the operator app it lands at the next **sign-in**,
because a licence is a private key and is never stored.

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

### Export bundle

Rebuilds `export/devmon.json` — every registry, ring and seat, **metadata only** — and re-signs it
with the store's export authority key. This is the bundle the companion `dev_mon` app reads, so run
it after a change that app should see. The signing keypair is created on demand the first time, so
there is no separate “authority key” button. **Verify bundle** (see Checks) confirms the file matches
its signature afterwards.

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

## Claims — identity bound to a key

A **claim** is an optional field inside the licence's signed certificate, so a key can say *who holds
it*. pkm supports two:

| Claim | What it is |
| --- | --- |
| `email` | The mailbox the seat belongs to. Lower-cased and shape-validated — an identity label, never verified by delivery. It also decides the tier when a licence is used to sign in to Dev Centre: an address on the app's hidden admin list lands at `tier_1`, anything else at `tier_2`, and a key with **no** claim is refused |
| `pwdv` | A **scrypt password verifier** (`scrypt$N$r$p$salt$hash`). The password itself is never stored, logged, exported or printed |

Type a seat id into **Seat** and press **Show claims**. The panel shows the claim in **both** of the
places it lives, side by side, because the two can silently diverge:

| Copy | Written by | Read by | Authority |
| --- | --- | --- | --- |
| The signed cert | a resign | a consumer app, offline | **what an app enforces** |
| The ledger record | set / issue | pkm only | source of truth for the next resign |

A row turns amber where the two copies disagree, and the badge shows the drift state: `in-sync`,
`ledger-only` (set, awaiting a resign), `cert-only`, `mismatch` or `no-cert`.

### Setting claims

Type into **Email to set** and/or **Password to set** — a blank field means *leave this claim alone*,
matching pkm's own flags — then choose:

- **Apply to ledger** — writes the ledger record only. The cert keeps what it has until a resign.
- **Apply + resign** — writes the ledger **and re-signs the cert**. ⚠️ This **changes the licence
  string**, so the replacement is shown once in the same display-once modal an issue uses. Hand it to
  the seat owner: their old key keeps working, but it still carries the *old* claims.
- **Clear email** / **Clear password** — removes a claim (ledger only, like any set).
- **Push ledger → cert** — re-signs with the claims already stored, changing nothing about them.
  Reports “nothing to do” when the cert already carries them.
- **Reveal verifier** — shows the `pwdv` string exactly as pkm stores it. ⚠️ **Display-once
  material:** a verifier is offline-crackable by whoever holds it, which is why it is never rendered
  into the panel itself. Never reuse a real account password on a seat.

### Backfill

**Backfill emails (dry run)** previews what **Backfill emails** would do: for every seat with no email
claim, derive one from the seat id. It is **ledger-only** — pkm deliberately does not bulk re-sign,
because a resign invalidates the licence string you already handed someone. Each seat still needs its
own resign before its cert carries the claim.

### Test credentials…

Runs the login check **offline**, so “will this email + password actually work for this key?” is
answered *before* the key is handed over. Paste the licence, the email and the password:

| Verdict | Meaning |
| --- | --- |
| ✅ works | The key logs in with that email and password |
| `password_mismatch` | The password does not match the verifier on this key |
| `email_mismatch` | The email does not match the key's `email` claim — a key with **no** claim always reports this |
| `revoked_seat` | The seat is revoked, and revocation is checked before the signature |
| `malformed` | Not a well-formed `TA1` licence |

The password is passed to `pkm` on **stdin**, never on its command line, which `ps` can read.

## Audit log

**Show** lists the registry's append-only action log (issue / revoke / unrevoke / expiry) with
timestamps, newest first. This is the authoritative history of who was issued what, and when.

## Checks — “will this key actually log in?”

The checks below stay available whenever the CLI answers at all: a store you cannot change is still
one you can interrogate, and the question they answer matters most when issuing. Their output shares
one line, so each shows the result of the last check you ran.

| Check | Asks | A failure usually means |
| --- | --- | --- |
| **Challenge…** | You paste a licence and the seat signs a fresh nonce, exactly as a login does | The key is expired, revoked, or signed by a retired ring. Stronger than Validate, which only checks the signature |
| **Crypto self-test…** | An ECDH → AES-256-GCM round trip between the seat and the agent keypair | `FRONTDESK_AGENT_PUBKEY` (⚙️ Config and Netlify) does not match this registry's agent key — replies would fail to decrypt |
| **Revocation check** | That a revoked seat is refused, and that registries which embed the blocklist are in sync with it | A revoked seat is still accepted, or an embedded app needs a rebuild after a Sync |
| **Claims drift** | Whether every seat's signed cert matches its ledger record | A claim was set but never resigned (`ledger-only`), or the two copies were edited independently (`mismatch`). Resign the seat to push the ledger into the cert |
| **Test credentials…** | Whether an email + password completes a login for a given licence | A wrong password (`password_mismatch`), a mismatched or missing `email` claim, or a revoked seat. A claim-less key always reports `email_mismatch` |
| **Permissions** | Which key-store paths are readable by group or other | Loose file modes. **Fix** tightens them by `chmod` only — key material is never rewritten |
| **Verify bundle** | `export/devmon.json` against its signature | The bundle was edited by hand or signed by a key that is no longer present. A missing file is reported as missing, not as invalid |

## Notes

- **Operator-only.** This table lists *every* seat at once. A collaborator never sees it — each
  only logs into their own webapp chat with their own licence key.
- **Where the paths come from.** Nothing is hardcoded: `PKM_REPO` (checkout), `PKM_ROOT` (store),
  `PKM_REGISTRY` (default registry), `PKM_BIN` (CLI override), `PKM_NODE` (interpreter override) and
  `PKM_TIMEOUT_MS` (per-command timeout, default 20s) are read from ⚙️ Config on every click — the
  Key Manager picks up a change immediately, while the webhook server / runner need a restart.
- **Registry directories** come from the authoritative `registries/registry.json` index (`dir`
  field), so a registry whose directory differs from its id still resolves.
- **Still CLI-only:** creating or removing a whole **registry** (`pkm registry create|remove`) needs an
  app id and an engine choice that a dashboard click shouldn't guess, and registering a
  revocation-verifier target (`pkm registry set-verifier --lang ts|py --path <file>`) writes paths into
  another app's source. Both stay in `personal_key_manager` (see its own notes). Everything else has a
  control here, including `pkm export` (Export bundle), `pkm perms --fix` (Permissions → Fix) and the
  whole **claims** surface (`claims show` / `set` / `resign` / `backfill` / `verify` plus `creds-test`).
