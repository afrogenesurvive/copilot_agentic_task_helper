# 💬 WhatsApp (Meta Cloud API)

The operator can send/receive WhatsApp messages through the agent (VS Code MCP server and this
app's Chat tab) using the official **Meta WhatsApp Cloud API**. Tool definitions: `whatsapp_status`,
`whatsapp_list_numbers`, `whatsapp_list_messages` (read) and `whatsapp_send_text`,
`whatsapp_send_template`, `whatsapp_mark_read` (need approval in Chat).

One WhatsApp Business Account (WABA) can hold **two** numbers — the free Meta **test** number and a
real **burner** number — sharing one access token. The Config → **WhatsApp** section stores both IDs.

## Set up the free test number (no SIM needed)

1. Create a free **Meta developer account** → create an app with the **WhatsApp** use case →
   select/create a **Business Portfolio** (this is the WABA).
2. In the app's **WhatsApp → API Setup**, Meta auto-generates a **test number** and registers it.
   Copy the **WABA ID** and the test **phone number ID**.
3. **Business Settings → Users → System users → Add** → assign your app (Manage app) and the
   WhatsApp account (Manage WhatsApp Business accounts) → **Generate token** with permissions
   `business_management`, `whatsapp_business_messaging`, `whatsapp_business_management`.
4. Add recipient numbers (up to ~5 on a test number — use your own phone). Free-form text needs
   the recipient to message you first to open the 24‑hour window.

## Set up a real (burner) number

The burner must be a **fresh mobile number that can receive international SMS/voice** and has
**never been registered with WhatsApp Messenger** (Cloud API won't register a number in use on
WhatsApp; a banned number must be unbanned first).

1. **WhatsApp Manager** (`business.facebook.com` → WhatsApp Manager) or the app's **API Setup** →
   **Add phone number** → enter the burner, choose a display name, and set a **two-step PIN**.
2. **Verify** it via SMS/voice OTP — the dashboard does this for you, or via API
   (`POST /<phone_number_id>/request_code` then `POST /<phone_number_id>/verify_code`).
3. Confirm the number's status is **CONNECTED** before sending from it.

> Number cap: a new portfolio is limited to **2 registered** business phone numbers — exactly the
> test + burner pair above.

## Configure (⚙️ Config → WhatsApp)

| Key | Purpose |
| --- | ------- |
| `WHATSAPP_ACCESS_TOKEN` 🔒 | System-user token (both numbers) |
| `WHATSAPP_WABA_ID` | WhatsApp Business Account ID |
| `WHATSAPP_PHONE_NUMBER_ID` | **Active** "from" number (set to test or burner) |
| `WHATSAPP_TEST_PHONE_NUMBER_ID` | Free sandbox number ID |
| `WHATSAPP_API_VERSION` | Default `v25.0` |
| `WHATSAPP_APP_SECRET` 🔒 | Webhook signature verify |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` 🔒 | Webhook verify token |

Find number IDs under **🧰 Tools → WhatsApp → Numbers** (or ask the agent to run
`whatsapp_list_numbers`). Saves apply without a restart; the MCP service picks keys up from
`.env`/`config.json` on (re)start.

## Dashboard

The **📊 Dashboard** shows the **MCP whatsapp** service card. With a number configured it displays
the active phone number (test/live) and connected status, plus a **List numbers** helper so you can
copy the phone-number IDs into Config. Start/stop it like any other MCP service.

## Receiving messages (webhook)

1. Point your WhatsApp webhook at `https://<your-tunnel-domain>/webhooks/whatsapp/push` in the Meta
   app's **Webhooks** panel (verify token = `WHATSAPP_WEBHOOK_VERIFY_TOKEN`).
2. Inbound messages are signature-verified, sanitized, stored under `safe/whatsapp/inbox/`, logged
   (`logs/notifications/whatsapp/`), and land in the **🔴 Queue** → misc list — visible in the
   **📄 Logs** and **🔴 Queue** tabs.

## Notes & troubleshooting

- **Free-form text only works inside the 24‑hour window.** For business-initiated messages use an
  approved template (`whatsapp_send_template`; `hello_world` ships by default).
- Test number: ~5 recipients max; they should message you first.
- **Security:** repo is public — tokens/IDs live only in gitignored `config.json`/`.env`/`safe/`.
  All inbound text is sanitized before the agent sees it.
- Private runbook (setup detail + error codes): `docs/safe/whatsapp-mcp.md` (local).
