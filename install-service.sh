#!/bin/bash
# Segment Editor - Install & Restart
# Safe to run multiple times. Kills old instances, restarts service, reloads nginx.

set -e

SERVICE_FILE="/storage6/segment_editor/segment-editor.service"
NGINX_CONF="/storage6/segment_editor/nginx/segment-editor.conf"
NGINX_SITE="/etc/nginx/sites-enabled/platyserver.ddns.net"

echo "=== Segment Editor Service Setup ==="
echo ""

# 1. Kill any stray old instances on port 8765
echo "[1/4] Cleaning up old instances..."
OLD_PID=$(sudo lsof -t -i :8765 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
    sudo kill $OLD_PID 2>/dev/null || true
    sleep 1
    echo "  Killed old process(es): $OLD_PID"
else
    echo "  No old instances found."
fi

# 2. Install and restart systemd service
echo "[2/4] Installing systemd service..."
sudo cp "$SERVICE_FILE" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable segment-editor
sudo systemctl restart segment-editor
echo "  Done."

# 3. Add nginx include if not already present
echo "[3/4] Configuring nginx..."
if grep -q "segment-editor.conf" "$NGINX_SITE" 2>/dev/null; then
    echo "  Nginx config already included."
else
    sudo sed -i "/^}/i\\    include ${NGINX_CONF};" "$NGINX_SITE"
    echo "  Added include to nginx config."
fi
sudo nginx -t && sudo nginx -s reload
echo "  Nginx reloaded."

# 4. Verify
echo "[4/4] Verifying..."
sleep 2
if sudo systemctl is-active --quiet segment-editor; then
    echo "  Service is running."
else
    echo "  WARNING: Service may not have started."
    echo "  Check: sudo journalctl -u segment-editor -n 20"
fi

echo ""
echo "=== Done ==="
echo ""
echo "Bookmark this URL:"
echo "  https://platyserver.ddns.net/editor/"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status segment-editor    # check status"
echo "  sudo systemctl restart segment-editor   # restart after code changes"
echo "  sudo journalctl -u segment-editor -f    # view logs"
