# Push Notifications Architecture

The webhook server (`mcp/webhook-server/`) listens for push notifications from Trello and Gmail and relays them to the Copilot agent.

## Flow

```
Trello/Gmail → Webhook (ngrok URL) → Webhook Server → Log file
                                                       ↕
                                              Pending tool calls queue
                                                       ↕
                                              Copilot agent processes
```

## Gmail Push

- Uses Gmail API push notifications via Pub/Sub or direct watch
- Setup: `node mcp/webhook-server/scripts/setup-gmail-watch.js`
- Requires OAuth2 credentials

## Trello Push

- Uses Trello webhooks
- Setup: `node mcp/webhook-server/scripts/setup-trello-webhook.js`
- Requires Trello API key and token

## Logging

- All notifications are logged to `logs/notifications/<source>/YYYY-MM-DD.jsonl`
- Webhook events logged to `logs/webhook/YYYY-MM-DD.log`
- Tool calls logged to `logs/tool_call/YYYY-MM-DD.log`
