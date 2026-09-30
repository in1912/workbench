#!/bin/bash
# ============================================================
#  CC-LIGHT / Agent light - FIRMWARE FLASH (macOS)
#  One-time: flash MicroPython + main.py onto the ESP32-C3 via a
#  USB DATA cable. Put this file next to main.py and the .bin file.
#  Double-click, or: bash flash-firmware-mac.command
# ============================================================
cd "$(dirname "$0")" || exit 1
echo "=== Agent light firmware flash (macOS) ==="
echo

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "[X] python3 not found. Run: xcode-select --install"
  read -r -p "Press Enter to close..." X
  exit 1
fi

# ---- deps (esptool + mpremote, needs network) ----
if ! "$PY" -c "import esptool" 2>/dev/null || ! "$PY" -m mpremote --help >/dev/null 2>&1; then
  echo "Installing esptool + mpremote ..."
  "$PY" -m pip install --user --quiet esptool mpremote
fi

# ---- find firmware bin ----
BIN="$(ls ESP32_GENERIC_C3-*.bin 2>/dev/null | head -n 1)"
if [ -z "$BIN" ]; then
  echo "[X] No ESP32_GENERIC_C3-*.bin next to this script."
  read -r -p "Press Enter to close..." X
  exit 1
fi
echo "Firmware file: $BIN"

# ---- pick serial port ----
echo
echo "USB serial devices (plug the board in with a DATA cable first):"
ls /dev/cu.usb* 2>/dev/null || echo "  (none found - check the cable is a data cable)"
echo
read -r -p "Port to use (e.g. /dev/cu.usbmodem123456): " PORT
if [ ! -e "$PORT" ]; then
  echo "[X] $PORT does not exist."
  read -r -p "Press Enter to close..." X
  exit 1
fi

echo
read -r -p "This ERASES and flashes $PORT. Continue? [Y/N]: " ANS
case "$ANS" in
  Y|y) ;;
  *) echo "Aborted."; read -r -p "Press Enter to close..." X; exit 0 ;;
esac

echo
echo "---- erase_flash (if it keeps printing Connecting..., hold BOOT, tap RST, release BOOT) ----"
"$PY" -m esptool --chip esp32c3 --port "$PORT" erase_flash || { echo "[X] erase failed."; read -r -p "Press Enter to close..." X; exit 1; }

echo "---- write firmware ----"
"$PY" -m esptool --chip esp32c3 --port "$PORT" --baud 921600 write_flash 0x0 "$BIN" || { echo "[X] flash failed."; read -r -p "Press Enter to close..." X; exit 1; }

echo "---- upload main.py ----"
sleep 2
"$PY" -m mpremote connect "$PORT" cp main.py :main.py || { echo "[X] upload failed."; read -r -p "Press Enter to close..." X; exit 1; }
"$PY" -m mpremote connect "$PORT" exec 'import machine; machine.reset()'

echo
echo "[OK] Done - the board should now blink R->Y->G once and start the demo."
echo "Unplug the data cable, use any USB power supply from now on."
read -r -p "Press Enter to close..." X
