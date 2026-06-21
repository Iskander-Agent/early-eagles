#!/usr/bin/env bash
# connect.sh — generate a fresh Eagle sig and inject into Claude Code MCP config
#
# Usage:
#   EAGLE_PRIVATE_KEY=<hex> ./connect.sh          # inject + launch claude
#   EAGLE_PRIVATE_KEY=<hex> ./connect.sh --print  # just print the sig, don't launch

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="$HOME/.claude/settings.json"

if [[ -z "${EAGLE_PRIVATE_KEY:-}" ]]; then
  echo "Error: set EAGLE_PRIVATE_KEY env var" >&2
  exit 1
fi

SIG_JSON=$(node "$SCRIPT_DIR/gen-sig.mjs")
ADDRESS=$(echo "$SIG_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).address)")
SIG=$(echo "$SIG_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).sig)")
VALID_UNTIL=$(echo "$SIG_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).valid_until)")

echo "Eagle address : $ADDRESS"
echo "Sig valid until: $VALID_UNTIL"

if [[ "${1:-}" == "--print" ]]; then
  echo "$SIG_JSON"
  exit 0
fi

# Inject into settings.json (create mcpServers.eagle block)
node - "$SETTINGS" "$ADDRESS" "$SIG" <<'EOF'
const [,, settingsPath, address, sig] = process.argv;
const fs = require('fs');
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
settings.mcpServers = settings.mcpServers || {};
settings.mcpServers.eagle = {
  url: 'http://localhost:3141/mcp',
  headers: { 'X-Eagle-Address': address, 'X-Eagle-Sig': sig },
};
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('Settings updated: ~/.claude/settings.json → mcpServers.eagle');
EOF

echo "Launching claude..."
exec claude
