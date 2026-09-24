# 🧰 Tools

The Tools tab shows the **shared tool manifest** and offers a few **quick actions** for trying the
underlying APIs without leaving the app.

## Shared tool manifest

A list of every tool the agent stack knows about (from the shared manifest), grouped by server
(Trello, Gmail, Drive, Calendar, Photos, Web Search, Sheets, Frontdesk, WhatsApp, Netlify). Each
group is collapsible, and each entry shows:

- The **tool name** (e.g. `trello_list_cards`, `netlify_set_env`).
- Its **description**.
- The **parameters** it accepts.

This is a read-only inventory — handy for checking what a tool expects before you script or
prompt for it. It is built from `shared/tool-manifest.js`, the same array the MCP servers and the
operator chat advertise, so what you see here is what the agent can actually call.

## Quick actions

Four small experiment panels:

- **Trello**
  - **Boards** — list the boards on the account.
  - **Lists (of a board)** — prompts for a board ID, then lists its lists.
  - **Cards (of a list)** — prompts for a list ID, then lists its cards.
- **Gmail**
  - **Recent messages** — lists the 10 most recent message IDs.
- **WhatsApp**
  - **Status** — connectivity + the active "from" number's Cloud API status.
  - **Numbers (copy IDs)** — every number on the WABA, so you can copy the test/live IDs into
    ⚙️ Config → WhatsApp.
- **Netlify**
  - **Sites** — every site the token can see (name + URL).
  - **Env vars** — lists them all, or prompts for one name and fetches just that variable.
  - **Deploys** — recent deploys with state, branch and commit.

Results print below the buttons (first ~20 items).

## Notes

- Trello/Gmail/WhatsApp quick actions call the REST APIs directly from the main process using the
  **shared** credentials (Trello needs `TRELLO_KEY`/`TRELLO_TOKEN`; Gmail needs a connected Google
  account; WhatsApp needs `WHATSAPP_ACCESS_TOKEN`). Missing credentials show an error instead of
  results.
- The **Netlify** panel is the exception: it runs through the in-process MCP client and
  `mcp/netlify/index.js` (needs `NETLIFY_AUTH_TOKEN`). That makes it a live check that the MCP
  client can spawn and talk to a server — if Netlify works here, the operator chat's Netlify tools
  work too.
- These actions are read-only conveniences — no destructive operations are exposed here. (The
  operator chat *can* perform writes, but only behind an Approve/Deny card; see chat.md.)
