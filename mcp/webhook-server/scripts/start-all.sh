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
echo "🚇 [1/8] Starting Cloudflare Tunnel on port $PORT..."

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
echo "📝 [2/8] Updating WEBHOOK_BASE_URL in .env..."
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
echo "🌐 [3/8] Starting webhook server on port $PORT..."

# Kill existing if any (fresh start ensures clean state)
EXISTING=$(lsof -ti ":$PORT" 2>/dev/null)
if [ -n "$EXISTING" ]; then
  echo "   ⚠️  Port $PORT already in use (PID $EXISTING) — restarting..."
  kill "$EXISTING" 2>/dev/null
  sleep 2
  # Force kill if still alive
  if lsof -ti ":$PORT" &>/dev/null; then
    kill -9 "$EXISTING" 2>/dev/null
    sleep 1
  fi
fi

nohup node "$WEBHOOK_DIR/index.js" > "$WEBHOOK_DIR/server.log" 2>&1 &
WEBHOOK_PID=$!

# Wait for server to be ready (up to 30s — first start may need time)
echo "   Waiting for server to be ready..."
SERVER_READY=false
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/health" &>/dev/null; then
    SERVER_READY=true
    echo "   ✅ Webhook server is up (PID $WEBHOOK_PID)"
    echo "   📄 Server logs: $WEBHOOK_DIR/server.log"
    break
  fi
  sleep 1
done

if [ "$SERVER_READY" = false ]; then
  echo "   ❌ Webhook server failed to start within 30s. Check logs:"
  tail -20 "$WEBHOOK_DIR/server.log" 2>/dev/null || true
  echo ""
  echo "   💡 Common causes: missing .env, missing dependencies, port conflict"
  echo "   Run 'npm install' in project root and ensure .env is present."
  kill $TUNNEL_PID 2>/dev/null
  rm -f "$tmpfile"
  exit 1
fi
echo ""

# ═══════════════════════════════════════════════
# STEP 4: Register Trello Webhooks
# ═══════════════════════════════════════════════
echo "📡 [4/8] Checking Trello webhooks..."

TRELLO_KEY="${TRELLO_KEY:-}"
TRELLO_TOKEN="${TRELLO_TOKEN:-}"
MODEL_IDS="${TRELLO_WEBHOOK_MODEL_IDS:-}"

if [ -z "$TRELLO_KEY" ] || [ -z "$TRELLO_TOKEN" ]; then
  echo "   ⚠️  TRELLO_KEY or TRELLO_TOKEN not set — skipping"
elif [ -z "$MODEL_IDS" ]; then
  echo "   ⚠️  TRELLO_WEBHOOK_MODEL_IDS not set — skipping"
else
  WEBHOOKS=$(curl -sf "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}" 2>/dev/null || echo "[]")

  # ── Cleanup: only remove webhooks for boards NOT in our list ──
  # Keep webhooks with old URLs — they're better than nothing if registration fails
  IFS=',' read -ra BOARDS <<< "$MODEL_IDS"
  EXPECTED_URL="${TUNNEL_URL}/webhooks/trello"

  BOARDS_PATTERN=$(printf "|%s" "${BOARDS[@]}")
  BOARDS_PATTERN="(${BOARDS_PATTERN:1})"

  CLEANUP_TARGETS=$(echo "$WEBHOOKS" | python3 -c "
import sys, json, re
data = json.load(sys.stdin)
if not isinstance(data, list): data = []
boards_pattern = '$BOARDS_PATTERN'
for wh in data:
    wh_id = wh.get('id', '')
    board_id = wh.get('idModel', '')
    # Only delete if board is NOT in our list (orphaned)
    if not re.search(boards_pattern, board_id):
        print(wh_id)
" 2>/dev/null)

  if [ -n "$CLEANUP_TARGETS" ]; then
    while IFS= read -r WH_ID; do
      [ -z "$WH_ID" ] && continue
      echo "   🧹 Removing orphaned webhook $WH_ID (board no longer tracked)..."
      curl -sf -X DELETE "https://api.trello.com/1/webhooks/${WH_ID}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}" > /dev/null 2>&1 \
        && echo "   ✅ Removed" \
        || echo "   ⚠️  Could not remove $WH_ID"
    done <<< "$CLEANUP_TARGETS"
    # Re-fetch webhooks after cleanup
    WEBHOOKS=$(curl -sf "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}" 2>/dev/null || echo "[]")
  fi
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
        WEBHOOK_ID=$(echo "$WEBHOOKS" | python3 -c "
import sys,json; data=json.load(sys.stdin);
for wh in data:
    if wh.get('idModel')=='$BOARD_ID': print(wh['id']); break
" 2>/dev/null)
        if [ -n "$WEBHOOK_ID" ]; then
          # Retry up to 5 times with backoff — Trello's proxy validation can be flaky
          UPDATE_OK=false
          for retry in $(seq 1 5); do
            [ "$retry" -gt 1 ] && echo "   🔄 Retry $retry/5..." && sleep 5
            RESPONSE=$(curl -s -X PUT "https://api.trello.com/1/webhooks/${WEBHOOK_ID}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}" \
              -d "callbackURL=$EXPECTED" 2>&1)
            if echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('id') else 1)" 2>/dev/null; then
              UPDATE_OK=true
              break
            fi
          done
          if [ "$UPDATE_OK" = true ]; then
            echo "   ✅ Updated"
          elif echo "$RESPONSE" | grep -q "VALIDATOR_URL_NOT_REACHABLE"; then
            echo "   ⚠️  Trello cannot verify the tunnel URL (proxy issue). Keeping existing webhook as-is."
            echo "   ℹ️  Old webhook still registered — events may not arrive until URL is reachable."
          else
            echo "   ❌ Update failed: $(echo "$RESPONSE" | head -c 300)"
            echo "   🔄 Falling back — deleting and recreating webhook..."
            curl -sf -X DELETE "https://api.trello.com/1/webhooks/${WEBHOOK_ID}?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}" > /dev/null 2>&1
            sleep 2
            REG_RESP=$(curl -s -X POST "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}" \
              -d "callbackURL=$EXPECTED" \
              -d "idModel=$BOARD_ID" \
              -d "description=Copilot agent - $BOARD_ID" 2>&1)
            if echo "$REG_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('id') else 1)" 2>/dev/null; then
              echo "   ✅ Recreated successfully"
            else
              echo "   ❌ Recreation failed: $(echo "$REG_RESP" | head -c 300)"
            fi
          fi
        else
          echo "   ❌ Could not find webhook ID for board $BOARD_ID"
        fi
      fi
    else
      echo "   📝 Registering webhook for board $BOARD_ID..."
      # Retry up to 5 times with backoff
      REG_OK=false
      for retry in $(seq 1 5); do
        [ "$retry" -gt 1 ] && echo "   🔄 Retry $retry/5..." && sleep 5
        REG_RESP=$(curl -s -X POST "https://api.trello.com/1/tokens/${TRELLO_TOKEN}/webhooks/?key=${TRELLO_KEY}" \
          -d "callbackURL=$EXPECTED" \
          -d "idModel=$BOARD_ID" \
          -d "description=Copilot agent - $BOARD_ID" 2>&1)
        if echo "$REG_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('id') else 1)" 2>/dev/null; then
          REG_OK=true
          break
        fi
      done
      if [ "$REG_OK" = true ]; then
        echo "   ✅ Registered"
      elif echo "$REG_RESP" | grep -q "VALIDATOR_URL_NOT_REACHABLE"; then
        echo "   ⚠️  Trello cannot verify the tunnel URL (proxy issue). Webhook not registered."
        echo "   ℹ️  Try using a public domain instead of Cloudflare tunnel."
      else
        echo "   ❌ Registration failed: $(echo "$REG_RESP" | head -c 300)"
      fi
    fi
  done
fi
echo ""

# ═══════════════════════════════════════════════
# STEP 5.5: Start/Renew Drive Watch
# ═══════════════════════════════════════════════
echo "📁 [5.5/8] Setting up Google Drive change watch..."

if [ -z "${GMAIL_CLIENT_ID:-}" ] || [ -z "${GMAIL_CLIENT_SECRET:-}" ] || [ -z "${GMAIL_REFRESH_TOKEN:-}" ]; then
  echo "   ⚠️  Google OAuth2 credentials not set — skipping Drive watch"
else
  node "$WEBHOOK_DIR/scripts/setup-drive-watch.js" 2>&1 || echo "   ⚠️  Could not set up Drive watch"
fi
echo ""

# ═══════════════════════════════════════════════
# STEP 5.7: Start/Renew Calendar Watch
# ═══════════════════════════════════════════════
echo "📅 [5.7/8] Setting up Google Calendar change watch..."

if [ -z "${GMAIL_CLIENT_ID:-}" ] || [ -z "${GMAIL_CLIENT_SECRET:-}" ] || [ -z "${GMAIL_REFRESH_TOKEN:-}" ]; then
  echo "   ⚠️  Google OAuth2 credentials not set — skipping Calendar watch"
else
  node "$WEBHOOK_DIR/scripts/setup-calendar-watch.js" 2>&1 || echo "   ⚠️  Could not set up Calendar watch"
fi
echo ""

# ═══════════════════════════════════════════════
# STEP 6: Start/Renew Gmail Watch
# ═══════════════════════════════════════════════
echo "📧 [6/8] Checking Gmail services Pub/Sub watch..."

if [ -z "${GMAIL_CLIENT_ID:-}" ] || [ -z "${GMAIL_CLIENT_SECRET:-}" ] || [ -z "${GMAIL_REFRESH_TOKEN:-}" ]; then
  echo "   ⚠️  Gmail OAuth2 credentials not set — skipping"
else
  echo "   Running check..."
  node "$WEBHOOK_DIR/scripts/check-gmail-watch.js" 2>&1 || echo "   ⚠️  Could not check Gmail watch"
fi
echo ""

# ═══════════════════════════════════════════════
# STEP 7: Update GCloud Pub/Sub push endpoint
# ═══════════════════════════════════════════════
echo "☁️  [7/8] Updating GCloud Pub/Sub push endpoint..."

SUBSCRIPTION="${GMAIL_PUBSUB_SUBSCRIPTION:-}"
if [ -n "$SUBSCRIPTION" ]; then
  node "$WEBHOOK_DIR/scripts/update-pubsub-endpoint.js" 2>&1 || \
    echo "   ⚠️  Pub/Sub update failed — check GOOGLE_APPLICATION_CREDENTIALS"
else
  echo "   ⚠️  GMAIL_PUBSUB_SUBSCRIPTION not set — skipping"
fi
echo ""

# ═══════════════════════════════════════════════
# STEP 8: Build reference maps (calendars + drive directories)
# ═══════════════════════════════════════════════
echo "🗂️  [8/8] Building reference maps for calendar names and drive paths..."

PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ -n "${GMAIL_CLIENT_ID:-}" ] && [ -n "${GMAIL_CLIENT_SECRET:-}" ] && [ -n "${GMAIL_REFRESH_TOKEN:-}" ]; then
  node "$PROJECT_DIR/scripts/setup-calendar-ref.js" 2>&1 || echo "   ⚠️  Could not build calendar reference"
  node "$PROJECT_DIR/scripts/setup-drive-ref.js" 2>&1 || echo "   ⚠️  Could not build drive directory reference"
else
  echo "   ⚠️  Google OAuth2 credentials not set — skipping"
fi
echo ""

echo "=========================================="
echo "  ✅ All setup complete!"
echo "  Tunnel:    $TUNNEL_URL"
echo "  Health:    $TUNNEL_URL/health"
echo "  Events:    $TUNNEL_URL/events"
echo "  Trello:    $TUNNEL_URL/webhooks/trello"
echo "  Drive:     $TUNNEL_URL/webhooks/drive/push"
echo "  Calendar:  $TUNNEL_URL/webhooks/calendar/push"
echo "  Gmail:     $TUNNEL_URL/webhooks/gmail/push"
echo "=========================================="
echo ""
echo "🔄 Restarting webhook server in foreground (interactive mode)..."
echo "   Type 'help' for commands, 'ls' to list queue items."
echo "   Press Ctrl+C to stop everything."
echo ""

# Kill the nohup'd server (we restart in foreground for the interactive terminal)
kill $WEBHOOK_PID 2>/dev/null
# Wait for port to be free
for i in $(seq 1 10); do
  if ! lsof -ti ":$PORT" &>/dev/null; then
    break
  fi
  sleep 1
done

# Cleanup on exit — kills tunnel when user hits Ctrl+C
cleanup() {
  echo ""
  echo "Shutting down tunnel..."
  kill $TUNNEL_PID 2>/dev/null
  rm -f "$tmpfile"
  echo "Done."
  exit 0
}
trap cleanup INT TERM

# Start server in foreground — interactive readline prompt works here
node "$WEBHOOK_DIR/index.js"
