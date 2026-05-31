#!/bin/bash
#
# tunnel-with-update.sh — Start Cloudflare Tunnel and update webhook endpoints
#
# Starts a Cloudflare Tunnel to expose the local webhook server,
# then updates Trello webhook endpoints to use the new tunnel URL.
#
# Prerequisites:
#   - cloudflared installed (brew install cloudflared)
#   - .env file with TRELLO_KEY, TRELLO_TOKEN, WEBHOOK_PORT
#
# Usage:
#   ./mcp/webhook-server/scripts/tunnel-with-update.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Load .env
if [ -f "$PROJECT_DIR/.env" ]; then
  export $(grep -v '^\s*#' "$PROJECT_DIR/.env" | grep -v '^\s*$' | xargs)
fi

PORT="${WEBHOOK_PORT:-3199}"

echo "🚇 Starting Cloudflare Tunnel on port $PORT..."
echo ""

# Start tunnel in background, capture URL
tmpfile=$(mktemp)
cloudflared tunnel --url "http://localhost:$PORT" > "$tmpfile" 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL
echo "Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$tmpfile" | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 2
done

if [ -z "$TUNNEL_URL" ]; then
  echo "❌ Failed to get tunnel URL"
  kill $TUNNEL_PID 2>/dev/null
  rm -f "$tmpfile"
  exit 1
fi

echo "✅ Tunnel URL: $TUNNEL_URL"
echo ""

# Update webhook endpoints
WEBHOOK_BASE_URL="$TUNNEL_URL" node "$SCRIPT_DIR/update-push-endpoint.js"

echo ""
echo "🌐 Tunnel running at: $TUNNEL_URL"
echo "   Webhook endpoint:  $TUNNEL_URL/webhooks/trello"
echo "   Gmail push:        $TUNNEL_URL/webhooks/gmail/push"
echo "   Health check:      $TUNNEL_URL/health"
echo ""
echo "Press Ctrl+C to stop tunnel"

# Cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down tunnel..."
  kill $TUNNEL_PID 2>/dev/null
  rm -f "$tmpfile"
  exit 0
}
trap cleanup INT TERM

# Wait for tunnel process
wait $TUNNEL_PID
