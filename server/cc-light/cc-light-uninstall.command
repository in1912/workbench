#!/bin/bash
# ============================================================
#  CC-LIGHT / Agent light - UNINSTALL (macOS)
#  Put this file in the same folder as daemon.py, double-click
#  (or: bash cc-light-uninstall.command).
#  Does: 1) turn board off  2) unload + delete LaunchAgent
#        3) stop daemon  4) remove hooks of all 9 agents
#  The folder itself can be deleted afterwards by hand.
# ============================================================
cd "$(dirname "$0")" || exit 1
echo "=== Agent light uninstaller (macOS) ==="
echo

# ---- 1. tell the board to go dark (best effort, daemon still alive) ----
command -v node >/dev/null 2>&1 && node ./send.js off
sleep 1

# ---- 2. unload + delete LaunchAgent ----
PLIST="$HOME/Library/LaunchAgents/com.cclight.daemon.plist"
launchctl unload "$PLIST" >/dev/null 2>&1
rm -f "$PLIST"
echo "[1/3] LaunchAgent removed."

# ---- 3. stop daemon ----
pkill -f "$PWD/daemon.py" >/dev/null 2>&1
echo "[2/3] Daemon stopped."

# ---- 4. remove hooks (all 9 agents) ----
if [ ! -f ./install-hooks.js ]; then
  echo "[!] install-hooks.js not found in this folder - agent hooks NOT removed."
fi
if command -v node >/dev/null 2>&1 && [ -f ./install-hooks.js ]; then
  node ./install-hooks.js --remove
  node ./install-hooks.js --codex-remove
  node ./install-hooks.js --workbuddy-remove
  node ./install-hooks.js --codebuddy-remove
  node ./install-hooks.js --cursor-remove
  node ./install-hooks.js --dsh-remove
  node ./install-hooks.js --hermes-remove
  node ./install-hooks.js --gemini-remove
  node ./install-hooks.js --qwen-remove
fi
echo "[3/3] Hooks removed (if they were installed)."

echo
echo "Uninstalled. You can delete this folder now."
echo "(Board keeps its firmware; to reuse later run cc-light-install.command again.)"
read -r -p "Press Enter to close..." X
