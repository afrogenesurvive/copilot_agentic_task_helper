# Collaborator Chat — Netlify Deployment

A static web app that lets a remote collaborator send messages to your
Copilot agent via Trello. Zero hosting cost on Netlify's free tier.

Uses a **two-list** Trello backend:

- `frontdesk_input` — messages from the webapp go here as cards
- `frontdesk_output` — agent replies appear here, shown in the chat window

The chat window shows the **last 15** inputs + outputs combined.

---

## Security

### 🔒 Trello API Proxy

The webapp never calls the Trello API directly from the browser. All requests
go through `/.netlify/functions/trello-proxy` — a Netlify function that keeps
`TRELLO_API_KEY` and `TRELLO_API_TOKEN` server-side. The browser only sees
list and board IDs.

### 🔐 HMAC Message Signing

When the proxy sends a comment to a frontdesk list, it signs the text with
`FRONTEND_SECRET` (HMAC-SHA256) and appends `[sig:...]` to the comment. The
webhook server verifies this signature, making it possible to detect direct
Trello API calls that bypass the webapp.

---

## Prerequisites

Create a Trello board with **two lists**:

- `frontdesk_input` — for incoming webapp messages
- `frontdesk_output` — for agent replies

---

## Deploy to Netlify

### Option A: Deploy via Git (recommended)

1. Push this repo to GitHub/GitLab
2. Log in to [app.netlify.com](https://app.netlify.com)
3. Click "Add new site" → "Import an existing project"
4. Connect your Git provider and pick this repository
5. Configure:
   - **Base directory**: `webapp`
   - **Publish directory**: `public`
6. Click "Deploy site"

### Option B: Deploy via Drag-and-Drop

1. Log in to [app.netlify.com](https://app.netlify.com)
2. Click "Add new site" → "Deploy manually"
3. Drag and drop the `webapp/public/` folder onto the dashed area

---

## Post-Deploy Setup

### 1. Set Environment Variables

Go to **Site settings** → **Environment variables** and add:

| Variable                        | Description                                      |
| ------------------------------- | ------------------------------------------------ |
| `TRELLO_API_KEY`                | Your Trello API key                              |
| `TRELLO_API_TOKEN`              | Your Trello API token                            |
| `TRELLO_BOARD_ID`               | Board ID                                         |
| `TRELLO_LIST_FRONTEDESK_INPUT`  | List ID for `frontdesk_input`                    |
| `TRELLO_LIST_FRONTEDESK_OUTPUT` | List ID for `frontdesk_output`                   |
| `FRONTEND_SECRET`               | HMAC key for message signing (any random string) |
| `USER_COLLABORATOR_HASH`        | SHA-256 of `"collaborator:password"`             |
| `USER_ADMIN_HASH`               | SHA-256 of `"admin:password"`                    |

> **Important**: `FRONTEND_SECRET` must be the **same value** in both Netlify
> environment variables AND the webhook server's `.env` file — this is what
> allows the proxy to sign messages and the webhook handler to verify them.
> Without this variable, messages still work but won't have origin verification.

### 2. Configure HTTPS

Netlify auto-provisions TLS certificates via Let's Encrypt.
