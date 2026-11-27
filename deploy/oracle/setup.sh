#!/usr/bin/env bash
# Run this ON the Oracle VM (Ubuntu 22.04) as ubuntu user.
# It installs Node, PM2, sets up the ABMDAS backend, and starts it.
set -euo pipefail

echo "=== ABMDAS Oracle Free Tier setup ==="

# 1. System packages
sudo apt-get update -y
sudo apt-get install -y curl unzip

# 2. Node.js (LTS via NodeSource)
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node --version)  npm: $(npm --version)"

# 3. PM2 (process manager, auto-restart on reboot)
sudo npm install -g pm2

# 4. App directory
APP_DIR=/home/ubuntu/abmdas
DATA_DIR=/home/ubuntu/abmdas-data
mkdir -p "$APP_DIR" "$DATA_DIR/uploads" "$DATA_DIR/backups"

# 5. Environment file
cat > "$APP_DIR/.env" <<'EOF'
ABMDAS_DATA_DIR=/home/ubuntu/abmdas-data
ABMDAS_ALLOWED_ORIGINS=https://abmdas.vercel.app
PORT=3000
EOF

# 6. Firewall (Oracle iptables + ufw)
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT 2>/dev/null || true
sudo ufw allow 3000/tcp 2>/dev/null || true
sudo netfilter-persistent save 2>/dev/null || true

# 7. PM2 ecosystem file
cat > "$APP_DIR/ecosystem.config.js" <<'EOF'
module.exports = {
  apps: [{
    name: 'abmdas',
    script: 'server/index.js',
    cwd: '/home/ubuntu/abmdas',
    env: {
      ABMDAS_DATA_DIR: '/home/ubuntu/abmdas-data',
      ABMDAS_ALLOWED_ORIGINS: 'https://abmdas.vercel.app',
      PORT: '3000',
      NODE_ENV: 'production',
    },
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
  }],
};
EOF

echo ""
echo "=== Setup complete. Next steps: ==="
echo "1. Copy server/, public/, and abmdas-data/ from your PC to this VM:"
echo "   scp -r server public /home/ubuntu/abmdas/"
echo "   scp -r C:\\abmdas-data/* ubuntu@<VM_IP>:/home/ubuntu/abmdas-data/"
echo ""
echo "2. Start the app:"
echo "   cd /home/ubuntu/abmdas && pm2 start ecosystem.config.js"
echo "   pm2 save && pm2 startup"
echo ""
echo "3. Test: curl http://localhost:3000/api/health"
echo "4. Update vercel.json rewrite URL to http://<VM_IP>:3000"
echo "5. (Optional) Set up Cloudflare Tunnel for HTTPS (see README.md)"