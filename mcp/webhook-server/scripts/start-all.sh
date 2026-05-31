#!/bin/bash
#
# start-all.sh — Full startup: tunnel → webhook server → Trello + Gmail setup
#
# Order of operations:
#   1. Start Cloudflare Tunnel, get public URL
#   2. Update WEBHOOK_BASE_URL in .env
#   3. Start the webhook Express server
#   4. Register Trello webhooks (if missing)
#   5. Start/renew Gmail Pub/Sub watch
#   6. Update GCloud Pub/Sub push endpoint
#
# Usage:
#   ./mcp/webhook-server/scripts/start-all.sh
#   npm run webhook:start-all
#
# Prerequisites:
#   - cloudflared installed (brew install cloudflared)
#   - gcloud CLI installed and authenticated
#   - .env file with all required credentials
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
WEBHOOK_DIR="$SCRIPT_DIR/.."
PORT="${WEBHOOK_PORT:-3199}"

# ── Load .env ──
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key val || [ -n "$key" ]; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    export "$key=$val"
  done < "$ENV_FILE"
fi

# Check cloudflared
if ! command -v cloudflared &>/dev/null; then
  echo "❌ cloudflared not found. Install: brew install cloudflared"
  exit 1
fi

echo "=========================================="
echo "  Full Webhook Stack Startup"
echo "=========================================="
echo ""

# ═══════════════════════════════════════════════
# STEP 1: Start Cloudflare Tunnel
# ═══════════════════════════════════════════════
echo "🚇 [1/6] Starting Cloudflare Tunnel on port $PORT..."

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
  echo "   cloudflared output:"
  cat "$tmpfile" 2>/dev/null | head -10
  kill $TUNNEL_PID 2>/dev/null
  rm -f "$tmpfile"
  exit 1
fi

echo "   ✅ Tunnel URL: $TUNNEL_URL"
echo ""

# ═══════════════════════════════════════════════
# STEP 2: Update .env with tunnel URL
# ═══════════════════════════════════════════════
echo "📝 [2/6] Updating WEBHOOK_BASE_URL in .env..."
if grep -q '^WEBHOOK_BASE_URL=' "$ENV_FILE"; then
  sed -i '' "s|^WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=$TUNNEL_URL|" "$ENV_FILE"
else
  echo "WEBHOOK_BASE_URL=$TUNNEL_URL" >> "$ENV_FILE"
fi
export WEBHOOK_BASE_URL="$TUNNEL_URL"
echo "   ✅ .env updated → $TUNNEL_URL"
echo ""

# ═══════════════════════════════════════════════
# STEP 3: Start Webhook Server
# ═══════════════════════════════════════════════
echo "🌐 [3/6] Starting webhook server on port $PORT..."

# Kill existing if any
EXISTING=$(lsof -ti ":$PORT" 2>/dev/null)
if [ -n "$EXISTING" ]; then
  echo "   ⚠️  Port $PORT already in use (PID $EXISTING), not restarting"
else
  cd "$WEBHOOK_DIR"
  node index.js &
  WEBHOOK_PID=$!
  cd "$PROJECT_DIR"

  # Wait for server to be ready
  for i in $(seq 1 10); do
    if curl -sf "http://localhost:$PORT/health" &>/dev/null; then
      echo "   ✅ Webhook server is up (PID $WEBHOOK_PID)"
      break
    fi
    sleep 1
  done
fi
echo ""

# ═══════════════════════════════════════════════
# STEP 4: Register Trello Webhooks
# ═══════════════════════════════════════════════
echo "📡 [4/6] Checking Trello webhooks..."

TRELLO_KEY="${TRELLO_KEY:-}"
TRELLO_TOKEN="${TRELLO_TOKEN:-}"
MODEL_IDS="${TRELLO_WEBHOOK_MODEL_IDS:-}"

if [ -z "$TRELLO_KEY" ] || [ -z "$TRELLO_TOKEN" ]; then
  echo "   ⚠️  TRELLO_KEY or TRELLO_TOKEN not set — skipping"
elif [ -z "$MODEL_IDS" ]; then
  echo "   ⚠️  TRELLO_WEBHOOK_MODEL_IDS not set — skipping"
else
  WEBHOOKS=$(curl -sf "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}" 2>/dev/null || echo "[]")

  IFS=',' read -ra BOARDS <<< "$MODEL_IDS"
  for BOARD_ID in "${BOARDS[@]}"; do
    BOARD_ID="$(echo "$BOARD_ID" | xargs)"
    [ -z "$BOARD_ID" ] && continue

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

    EXPECTED="${TUNNEL_URL}/webhooks/trello"

    if [ -n "$FOUND" ]; then
      if [ "$FOUND" = "$EXPECTED" ]; then
        echo "   ✅ Board $BOARD_ID — webhook up to date"
      else
        echo "   ⚠️  Board $BOARD_ID — URL mismatch, updating..."
        curl -sf -X PUT "https://api.trello.com/1/webhooks/$(echo "$WEBHOOKS" | python3 -c "
import sys,json; data=json.load(sys.stdin);
for wh in data:
    if wh.get('idModel')=='$BOARD_ID': print(wh['id']); break
" 2>/dev/null)?key=${TRELLO_KEY}" \
          -d "callbackURL=$EXPECTED" > /dev/null 2>&1 && echo "   ✅ Updated" || echo "   ❌ Update failed"
      fi
    else
      echo "   📝 Registering webhook for board $BOARD_ID..."
      curl -sf -X POST "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}" \
        -d "callbackURL=$EXPECTED" \
        -d "idModel=$BOARD_ID" \
        -d "description=Copilot agent - $BOARD_ID" > /dev/null 2>&1 \
        && echo "   ✅ Registered" || echo "   ❌ Registration failed"
    fi
  done
fi
echo ""

# ═══════════════════════════════════════════════
# STEP 5: Start/Renew Gmail Watch
# ═══════════════════════════════════════════════
echo "📧 [5/6] Checking Gmail Pub/Sub watch..."

if [ -z "${GMAIL_CLIENT_ID:-}" ] || [ -z "${GMAIL_CLIENT_SECRET:-}" ] || [ -z "${GMAIL_REFRESH_TOKEN:-}" ]; then
  echo "   ⚠️  Gmail OAuth2 credentials not set — skipping"
else
  cd "$WEBHOOK_DIR"
  node -e "
    import { ensureWatch, getWatchStatus } from './lib/gmail-watch.js';
    const status = getWatchStatus();
    if (status) {
      const expiresAt = new Date(parseInt(status.expiration, 10));
      const remaining = expiresAt - Date.now();
      console.log('   Watch: email=' + status.email + ', expires=' + expiresAt.toISOString() + ' (' + Math.round(remaining/1000/60) + 'm)');
      if (remaining < 60 * 60 * 1000) {
        console.log('   → Renewing...');
        await ensureWatch();
        const u = getWatchStatus();
        console.log('   ✅ Renewed — expires ' + new Date(parseInt(u.expiration, 10)).toISOString());
      } else {
        console.log('   ✅ Watch is valid');
      }
    } else {
      console.log('   → No watch active, starting...');
      await ensureWatch();
      const u = getWatchStatus();
      console.log('   ✅ Started — expires ' + new Date(parseInt(u.expiration, 10)).toISOString());
    }
  " 2>&1 || echo "   ⚠️  Could not check Gmail watch"
  cd "$PROJECT_DIR"
fi
echo ""

# ═══════════════════════════════════════════════
# STEP 6: Update GCloud Pub/Sub push endpoint
# ═══════════════════════════════════════════════
echo "☁️  [6/6] Updating GCloud Pub/Sub push endpoint..."

SUBSCRIPTION="${GMAIL_PUBSUB_SUBSCRIPTION:-}"
if [ -n "$SUBSCRIPTION" ]; then
  PUSH_ENDPOINT="${TUNNEL_URL}/webhooks/gmail/push"
  if command -v gcloud &>/dev/null; then
    gcloud pubsub subscriptions update "$SUBSCRIPTION" \
      --push-endpoint="$PUSH_ENDPOINT" \
      --push-auth-service-account="" > /dev/null 2>&1 \
      && echo "   ✅ Pub/Sub push endpoint updated" \
      || echo "   ⚠️  Pub/Sub update failed (check gcloud auth)"
  else
    echo "   ⚠️  gcloud CLI not found — update manually:"
    echo "   gcloud pubsub subscriptions update $SUBSCRIPTION --push-endpoint=$PUSH_ENDPOINT"
  fi
else
  echo "   ⚠️  GMAIL_PUBSUB_SUBSCRIPTION not set — skipping"
fi

echo ""
echo "=========================================="
echo "  ✅ All done!"
echo "  Tunnel:    $TUNNEL_URL"
echo "  Health:    $TUNNEL_URL/health"
echo "  Events:    $TUNNEL_URL/events"
echo "  Webhooks:  $TUNNEL_URL/webhooks/trello"
echo "  Gmail:     $TUNNEL_URL/webhooks/gmail/push"
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
