#!/bin/bash
#
# restart-webhook.sh — Restart webhook server & re-establish webhooks
#
# Kills the running webhook server (port 3199), starts a fresh one,
# then checks Trello webhook registrations and re-registers any that
# are missing. Does NOT touch the Cloudflare tunnel.
#
# Usage:
#   ./mcp/webhook-server/scripts/restart-webhook.sh
#   npm run webhook:restart
#
# Prerequisites:
#   - .env file with TRELLO_KEY, TRELLO_TOKEN, TRELLO_WEBHOOK_MODEL_IDS, etc.
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
PORT="${WEBHOOK_PORT:-3199}"

# Load env vars for direct use in this script
export "$(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | xargs)"

echo "🔄 Restarting webhook server..."

# ── Step 1: Kill existing webhook server ──
PID=$(lsof -ti:"$PORT" 2>/dev/null)
if [ -n "$PID" ]; then
  echo "   → Killing existing server (PID: $PID) on port $PORT..."
  kill "$PID" 2>/dev/null
  sleep 1
  # Force kill if still alive
  if kill -0 "$PID" 2>/dev/null; then
    echo "   → Force killing..."
    kill -9 "$PID" 2>/dev/null
    sleep 1
  fi
  echo "   ✅ Server stopped"
else
  echo "   → No server running on port $PORT"
fi

# ── Step 2: Start new webhook server ──
echo "   → Starting webhook server..."
node "$PROJECT_DIR/mcp/webhook-server/index.js" &
NEW_PID=$!
echo "   → Server PID: $NEW_PID"

# Wait for server to be ready
for i in $(seq 1 15); do
  if curl -sf "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "   ✅ Webhook server is ready (port $PORT)"
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "   ⚠️  Server not responding after 15s — check logs"
    exit 1
  fi
  sleep 1
done

# ── Step 3: Check and re-establish Trello webhooks ──
echo "   → Checking Trello webhook registrations..."
TRELLO_KEY="${TRELLO_KEY:-}"
TRELLO_TOKEN="${TRELLO_TOKEN:-}"
MODEL_IDS="${TRELLO_WEBHOOK_MODEL_IDS:-}"
WEBHOOK_URL="${WEBHOOK_BASE_URL:-http://localhost:$PORT}/webhooks/trello"

if [ -z "$TRELLO_KEY" ] || [ -z "$TRELLO_TOKEN" ]; then
  echo "   ⚠️  TRELLO_KEY or TRELLO_TOKEN not set — skipping webhook check"
else
  # Fetch existing webhooks from Trello
  EXISTING=$(curl -sf "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks?key=${TRELLO_KEY}" 2>/dev/null)
  EXISTING_IDS=$(echo "$EXISTING" | python3 -c "
import sys,json
try:
    hooks = json.load(sys.stdin)
    for h in hooks:
        print(h.get('idModel',''))
except: pass
" 2>/dev/null)

  MISSING=0
  IFS=',' read -ra BOARDS <<< "$MODEL_IDS"
  for board_id in "${BOARDS[@]}"; do
    board_id="$(echo "$board_id" | xargs)"
    [ -z "$board_id" ] && continue

    if echo "$EXISTING_IDS" | grep -q "$board_id"; then
      echo "   ✅ Webhook exists for board $board_id"
    else
      echo "   ⚠️  Webhook MISSING for board $board_id — registering..."
      REGISTERED=false
      for retry in $(seq 1 5); do
        [ "$retry" -gt 1 ] && echo "   🔄 Retry $retry/5..." && sleep 3
        RESP=$(curl -sf -X POST "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}" \
          -d "callbackURL=${WEBHOOK_URL}" \
          -d "idModel=${board_id}" \
          -d "description=Webhook for board ${board_id}" 2>/dev/null)
        if echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null | grep -q .; then
          REGISTERED=true
          break
        fi
      done
      if [ "$REGISTERED" = true ]; then
        echo "   ✅ Registered webhook for board $board_id"
      else
        echo "   ❌ Failed to register webhook for board $board_id after 5 attempts"
      fi
      MISSING=$((MISSING + 1))
    fi
  done

  if [ "$MISSING" -eq 0 ]; then
    echo "   ✅ All Trello webhooks are registered"
  fi
fi

echo ""
echo "✅ Webhook server restarted successfully"
echo "   URL: $WEBHOOK_URL"
echo "   Tunnel is unaffected"
