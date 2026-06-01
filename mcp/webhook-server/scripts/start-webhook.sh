#!/bin/bash
#
# start-webhook.sh — Start webhook server, verify Trello + Gmail connections
#
# 1. Starts the webhook Express server (or checks if already running)
# 2. Checks Trello webhook registration — registers if missing
# 3. Checks Gmail Pub/Sub watch — starts/renews if needed
#
# Prerequisites:
#   - npm dependencies installed in mcp/webhook-server/
#   - .env file with all required credentials
#   - WEBHOOK_BASE_URL set (run setup-tunnel.sh first, or set manually)
#
# Usage:
#   ./mcp/webhook-server/scripts/start-webhook.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# Load .env
export $(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | xargs)

PORT="${WEBHOOK_PORT:-3199}"
TRELLO_KEY="${TRELLO_KEY:-}"
TRELLO_TOKEN="${TRELLO_TOKEN:-}"
BASE_URL="${WEBHOOK_BASE_URL:-}"
MODEL_IDS="${TRELLO_WEBHOOK_MODEL_IDS:-}"

echo "=========================================="
echo "  Webhook Server Startup"
echo "=========================================="
echo ""

# ── 1. Check if webhook server is already running ──
echo "🔍 Checking webhook server on port $PORT..."
if lsof -i ":$PORT" &>/dev/null 2>&1; then
  echo "✅ Webhook server already running on port $PORT"
  WEBHOOK_PID=$(lsof -ti ":$PORT" 2>/dev/null | head -1)
  echo "   PID: $WEBHOOK_PID"
else
  echo "🚀 Starting webhook server on port $PORT..."
  cd "$SCRIPT_DIR/.."
  node index.js &
  WEBHOOK_PID=$!
  echo "   PID: $WEBHOOK_PID"

  # Wait for server to be ready
  for i in $(seq 1 10); do
    if curl -sf "http://localhost:$PORT/health" &>/dev/null; then
      echo "✅ Webhook server is up and healthy"
      break
    fi
    sleep 1
  done

  cd "$PROJECT_DIR"
fi

echo ""

# ── 2. Check Trello webhook registration ──
echo "📡 Checking Trello webhooks..."

if [ -z "$TRELLO_KEY" ] || [ -z "$TRELLO_TOKEN" ]; then
  echo "⚠️  TRELLO_KEY or TRELLO_TOKEN not set — skipping Trello check"
elif [ -z "$BASE_URL" ]; then
  echo "⚠️  WEBHOOK_BASE_URL not set — skipping Trello check (run setup-tunnel.sh first)"
else
  # Fetch existing webhooks
  WEBHOOKS=$(curl -sf "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}" 2>/dev/null || echo "[]")

  # Check each board in MODEL_IDS
  IFS=',' read -ra BOARDS <<< "$MODEL_IDS"
  for BOARD_ID in "${BOARDS[@]}"; do
    BOARD_ID="$(echo "$BOARD_ID" | xargs)"  # trim
    [ -z "$BOARD_ID" ] && continue

    # Check if this board already has a webhook pointing to our URL
    FOUND=$(echo "$WEBHOOKS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    if not isinstance(data, list): data = []
    for wh in data:
        if wh.get('idModel') == '$BOARD_ID':
            print(wh.get('callbackURL', ''))
            break
except: pass
" 2>/dev/null)

    if [ -n "$FOUND" ]; then
      if [ "$FOUND" = "${BASE_URL}/webhooks/trello" ]; then
        echo "✅ Board $BOARD_ID — webhook already registered and up to date"
      else
        echo "⚠️  Board $BOARD_ID — webhook exists but URL mismatch:"
        echo "   Current: $FOUND"
        echo "   Expected: ${BASE_URL}/webhooks/trello"
        echo "   Run: node mcp/webhook-server/scripts/update-push-endpoint.js"
      fi
    else
      echo "📝 Registering webhook for board $BOARD_ID..."
      RESP=$(curl -sf -X POST "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}" \
        -d "callbackURL=${BASE_URL}/webhooks/trello" \
        -d "idModel=${BOARD_ID}" \
        -d "description=Copilot agent webhook - ${BOARD_ID}" 2>/dev/null || echo "")

      if echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null | grep -q .; then
        echo "✅ Webhook registered for board $BOARD_ID"
      else
        echo "❌ Failed to register webhook for board $BOARD_ID: $RESP"
      fi
    fi
  done
fi

echo ""

# ── 3. Check Gmail Pub/Sub watch ──
echo "📧 Checking Gmail Pub/Sub watch..."

if [ -z "${GMAIL_CLIENT_ID:-}" ] || [ -z "${GMAIL_CLIENT_SECRET:-}" ] || [ -z "${GMAIL_REFRESH_TOKEN:-}" ]; then
  echo "⚠️  Gmail OAuth2 credentials not set — skipping Gmail watch check"
else
  node "$SCRIPT_DIR/check-gmail-watch.js" 2>&1 || echo "⚠️  Could not check Gmail watch"
fi

echo ""
echo "=========================================="
echo "  Startup complete!"
echo "  Webhook:  http://localhost:$PORT"
echo "  Health:   http://localhost:$PORT/health"
echo "  Events:   http://localhost:$PORT/events"
echo "=========================================="
