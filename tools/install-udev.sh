#!/usr/bin/env bash
# Installs the udev rule for the Ulanzi Stream Controller D200.
# Run with: sudo ./tools/install-udev.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
	echo "This script must be run with sudo." >&2
	exit 1
fi

RULE_FILE=/etc/udev/rules.d/70-ulanzi-d200.rules

cat > "$RULE_FILE" <<'EOF'
# Ulanzi Stream Controller D200 (HID mode, VID 2207 PID 0019)
KERNEL=="hidraw*", ATTRS{idVendor}=="2207", ATTRS{idProduct}=="0019", MODE="0660", GROUP="input", TAG+="uaccess"
SUBSYSTEM=="usb", ATTRS{idVendor}=="2207", ATTRS{idProduct}=="0019", MODE="0660", GROUP="input", TAG+="uaccess"
EOF

echo "Wrote $RULE_FILE"

udevadm control --reload-rules
udevadm trigger --attr-match=idVendor=2207 --attr-match=idProduct=0019 || true

echo "Rules reloaded. Unplug and replug the D200 (through the USB hub) for them to take effect."
echo "After replug, verify with: ls -la /dev/hidraw* | tail -2"
