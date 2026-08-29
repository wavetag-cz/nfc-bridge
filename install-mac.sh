#!/bin/sh
set -e

DIR=$(cd "$(dirname "$0")" && pwd)
PLIST="$HOME/Library/LaunchAgents/cz.wavetag.nfcbridge.plist"

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cz.wavetag.nfcbridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(which node)</string>
    <string>$DIR/index.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$DIR/bridge.log</string>
  <key>StandardErrorPath</key>
  <string>$DIR/bridge.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Done. The bridge is running and will start after login."
