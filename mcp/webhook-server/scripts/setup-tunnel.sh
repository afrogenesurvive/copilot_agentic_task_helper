#!/bin/bash
#
# setup-tunnel.sh — Start Cloudflare Tunnel, update .env + GCloud Pub/Sub
#
# 1. Starts a Cloudflare Tunnel to expose the local webhook server
# 2. Updates WEBHOOK_BASE_URL in .env with the new tunnel URL
# 3. Updates the GCloud Pub/Sub push endpoint to point to the new URL
#
# Prerequisites:
#   - cloudflared installed (brew install cloudflared)
#   - gcloud CLI installed and authenticated
#   - .env file with WEBHOOK_PORT, GMAIL_PUBSUB_SUBSCRIPTION
#
# Usage:
#   ./mcp/webhook-server/scripts/setup-tunnel.sh
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# Load .env — read line by line to handle special chars safely
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key val || [ -n "$key" ]; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    export "$key=$val"
  done < "$ENV_FILE"
fi

PORT="${WEBHOOK_PORT:-3199}"
SUBSCRIPTION="${GMAIL_PUBSUB_SUBSCRIPTION:-}"
TOPIC="${GMAIL_TOPIC_NAME:-}"

# Check cloudflared
if ! command -v cloudflared &>/dev/null; then
  echo "❌ cloudflared not found. Install it:"
  echo "   brew install cloudflared"
  exit 1
fi

echo "=========================================="
echo "  Tunnel + Pub/Sub Setup"
echo "=========================================="
echo ""

# ── 1. Start Cloudflare Tunnel ──
echo "🚇 Starting Cloudflare Tunnel on port $PORT..."

tmpfile=$(mktemp)
cloudflared tunnel --url "http://localhost:$PORT" > "$tmpfile" 2>&1 &
TUNNEL_PID=$!

# Wait for tunnel URL
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oE 'https?://[-a-zA-Z0-9.]+(\.[-a-zA-Z0-9.]+)*\.trycloudflare\.com' "$tmpfile" 2>/dev/null | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 2
done

if [ -z "$TUNNEL_URL" ]; then
  echo "❌ Failed to get tunnel URL (waited 60s)"
  echo "   cloudflared output was:"
  cat "$tmpfile" 2>/dev/null | head -20
  kill $TUNNEL_PID 2>/dev/null
  rm -f "$tmpfile"
  exit 1
fi

echo "✅ Tunnel URL: $TUNNEL_URL"
echo ""

# ── 2. Update .env with new tunnel URL ──
if grep -q '^WEBHOOK_BASE_URL=' "$ENV_FILE"; then
  sed -i '' "s|^WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=$TUNNEL_URL|" "$ENV_FILE"
else
  echo "WEBHOOK_BASE_URL=$TUNNEL_URL" >> "$ENV_FILE"
fi
echo "✅ Updated WEBHOOK_BASE_URL in .env → $TUNNEL_URL"
echo ""

# ── 3. Update GCloud Pub/Sub push endpoint ──
if [ -n "$SUBSCRIPTION" ]; then
  PUSH_ENDPOINT="${TUNNEL_URL}/webhooks/gmail/push"
  echo "📧 Updating GCloud Pub/Sub subscription push endpoint..."
  echo "   Subscription: $SUBSCRIPTION"
  echo "   Push endpoint: $PUSH_ENDPOINT"

  if command -v gcloud &>/dev/null; then
    gcloud pubsub subscriptions update "$SUBSCRIPTION" \
      --push-endpoint="$PUSH_ENDPOINT" \
      --push-auth-service-account=""
    echo "✅ Pub/Sub push endpoint updated"
  else
    echo "⚠️  gcloud CLI not found — update manually:"
    echo "   gcloud pubsub subscriptions update $SUBSCRIPTION \\"
    echo "     --push-endpoint=$PUSH_ENDPOINT"
  fi
else
  echo "⚠️  GMAIL_PUBSUB_SUBSCRIPTION not set — skipping Pub/Sub update"
fi

echo ""
echo "=========================================="
echo "  Tunnel is running!"
echo "  URL:     $TUNNEL_URL"
echo "  Health:  $TUNNEL_URL/health"
echo "  Events:  $TUNNEL_URL/events"
echo "  PID:     $TUNNEL_PID"
echo "=========================================="
echo ""
echo "Press Ctrl+C to stop the tunnel"

# Cleanup on exit
cleanup() {
  echo ""
  echo "Shutting down tunnel..."
  kill $TUNNEL_PID 2>/dev/null
  rm -f "$tmpfile"
  exit 0
}
trap cleanup INT TERM

wait $TUNNEL_PID
