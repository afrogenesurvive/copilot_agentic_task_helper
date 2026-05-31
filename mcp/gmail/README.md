# Gmail MCP Server

MCP server providing Gmail API access for GitHub Copilot.

## Tools

### `gmail_list_messages`

List Gmail messages matching a search query.

| Parameter    | Type   | Description                                    |
| ------------ | ------ | ---------------------------------------------- |
| `query`      | string | Gmail search query (same syntax as search box) |
| `maxResults` | number | Max results (default 10, max 100)              |

### `gmail_get_message`

Get a single Gmail message by ID with full body content.

| Parameter | Type   | Description                                                                               |
| --------- | ------ | ----------------------------------------------------------------------------------------- |
| `id`      | string | Message ID (required)                                                                     |
| `format`  | string | `"full"` (default) returns decoded body + headers; `"metadata"` returns headers + snippet |

Returns: `id`, `threadId`, `labelIds`, `internalDate`, `snippet`, `headers` (From, To, Cc, Bcc, Subject, Date), and `body` (decoded plain text, stripped HTML, or snippet).

### `gmail_send_message`

Send a plain text email.

| Parameter | Type   | Description                        |
| --------- | ------ | ---------------------------------- |
| `to`      | string | Recipient email address (required) |
| `subject` | string | Email subject (required)           |
| `body`    | string | Email body text (required)         |

## Setup

1. Create OAuth2 credentials in Google Cloud Console (Gmail API enabled)
2. Run `node scripts/gmail-auth.js` to get a refresh token
3. Set env vars: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_USER`
