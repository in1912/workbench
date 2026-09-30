#!/bin/bash
# ============================================================
#  CC-LIGHT / Agent light - INSTALL (macOS)
#  Put this file in the same folder as daemon.py (the cc-light
#  folder from cc-light-mac.zip), then double-click.
#  If double-click says "cannot be executed", run in Terminal:
#    bash cc-light-install.command
#  Does: 1) find python3  2) pip install bleak (if missing)
#        3) register LaunchAgent (autostart)  4) start daemon now
#        5) optionally install hooks for Claude Code / Codex /
#           WorkBuddy / CodeBuddy / Cursor / DeepSeek Harness (dsh) /
#           Hermes / Gemini CLI / Qwen Code
# ============================================================
cd "$(dirname "$0")" || exit 1
echo "=== Agent light installer (macOS) ==="
echo

# ---- 1. python3 ----
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "[X] python3 not found. Install Xcode Command Line Tools first:"
  echo "    xcode-select --install"
  read -r -p "Press Enter to close..." X
  exit 1
fi
echo "[1/5] Python found: $PY"

# ---- 2. bleak dependency (needs network; macOS uses pure-python deps, no wheels dir needed) ----
if "$PY" -c "import bleak" 2>/dev/null; then
  echo "[2/5] bleak OK"
else
  echo "[2/5] Installing bleak ..."
  "$PY" -m pip install --user --quiet bleak
  "$PY" -c "import bleak" 2>/dev/null || {
    echo "[X] bleak install failed, check network. (If pip refuses system python, install python.org Python 3.12.)"
    read -r -p "Press Enter to close..." X
    exit 1
  }
fi

# ---- 3. LaunchAgent (logon autostart) ----
PLIST="$HOME/Library/LaunchAgents/com.cclight.daemon.plist"
mkdir -p "$HOME/Library/LaunchAgents"
launchctl unload "$PLIST" >/dev/null 2>&1
pkill -f "$PWD/daemon.py" >/dev/null 2>&1
sleep 1
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cclight.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$PWD/daemon.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PWD/daemon.log</string>
  <key>StandardErrPath</key><string>$PWD/daemon.log</string>
</dict>
</plist>
EOF
launchctl load -w "$PLIST" >/dev/null 2>&1 || launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1
echo "[3/5] LaunchAgent registered: $PLIST"

# ---- 4. start daemon now ----
launchctl start com.cclight.daemon >/dev/null 2>&1 || "$PY" daemon.py >/dev/null 2>&1 &
echo "[4/5] Daemon started (first run macOS asks for Bluetooth permission - click Allow)."

# ---- 5. CLI hooks (optional, needs Node.js) ----
ask_install() {
  prompt="$1"; flag="$2"
  read -r -p "$prompt [Y/N]: " ANS
  case "$ANS" in
    Y|y) node ./install-hooks.js "$flag" ;;
    *) echo "  skipped." ;;
  esac
}
if command -v node >/dev/null 2>&1; then
  ask_install "Also install Claude Code hooks" ""
  [ -d "$HOME/.codex" ] && ask_install "Also install Codex CLI hooks (needs /hooks trust once)" "--codex"
  [ -f "$HOME/.workbuddy/plugins/installed_plugins.json" ] && ask_install "Also install WorkBuddy plugin hooks (needs full restart)" "--workbuddy"
  [ -d "$HOME/.codebuddy" ] && ask_install "Also install CodeBuddy Code hooks" "--codebuddy"
  [ -d "$HOME/.cursor" ] && ask_install "Also install Cursor hooks (auto hot-reload)" "--cursor"
  command -v dsh >/dev/null 2>&1 && ask_install "Also install DeepSeek Harness (dsh) plugin (restart dsh to load)" "--dsh"
  [ -d "$HOME/.hermes" ] && ask_install "Also install Hermes Agent plugin" "--hermes"
  [ -d "$HOME/.gemini" ] && ask_install "Also install Gemini CLI hooks" "--gemini"
  [ -d "$HOME/.qwen" ] && ask_install "Also install Qwen Code hooks (async, zero blocking)" "--qwen"
else
  echo "[5/5] Node.js not found, skip all CLI hooks."
fi

echo
echo "=== Verifying (wait 8s) ==="
sleep 8
if [ -f daemon.log ]; then
  echo "---- last lines of daemon.log ----"
  tail -n 4 daemon.log
  echo "---------------------------------"
  grep -q "BLE connected" daemon.log && echo '[OK] Connected to board "Agent light".'
fi
echo
echo "Notes:"
echo "- First run: if macOS asked \"...would like to use Bluetooth\", click Allow."
echo "- If the light stays dark: run \"$PY daemon.py\" once in Terminal, allow"
echo "  Bluetooth when prompted, Ctrl+C, then: launchctl start com.cclight.daemon"
echo "Uninstall: bash cc-light-uninstall.command"
read -r -p "Press Enter to close..." X
