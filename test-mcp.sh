#!/bin/bash
set -e

PORT=3009
BASE="http://localhost:$PORT/mcp"
HDRS=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

# Start server
cd "$(dirname "$0")"
MCP_PORT=$PORT node dist/index.js &
SERVER_PID=$!
sleep 2

cleanup() { kill $SERVER_PID 2>/dev/null; }
trap cleanup EXIT

echo "=== 1. Initialize ==="
INIT_OUT=$(curl -s -D /tmp/mcp_headers.txt "${HDRS[@]}" -X POST "$BASE" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}')
echo "$INIT_OUT" | grep 'data:' | sed 's/data: //'

SID=$(grep -i 'mcp-session-id' /tmp/mcp_headers.txt | tr -d '\r' | awk '{print $2}')
echo "Session ID: $SID"

echo ""
echo "=== 2. Send initialized notification ==="
curl -s -X POST "$BASE" "${HDRS[@]}" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
echo "(notification sent)"

echo ""
echo "=== 3. List tools ==="
curl -s -X POST "$BASE" "${HDRS[@]}" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | grep 'data:' | sed 's/data: //' \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
tools = d['result']['tools']
print(f'{len(tools)} tools registered:')
for t in tools:
    print(f'  - {t[\"name\"]}: {t[\"description\"][:60]}')
"

echo ""
echo "=== 4. Call list_nodes ==="
curl -s -X POST "$BASE" "${HDRS[@]}" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_nodes","arguments":{}}}' \
  | grep 'data:' | sed 's/data: //'

echo ""
echo "=== DONE ==="