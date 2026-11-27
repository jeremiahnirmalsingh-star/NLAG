# Deploy ABMDAS to Oracle Cloud Free Tier

## Prerequisites
- Oracle Cloud account (free, requires card verification, no charge)
- SSH key pair (generated in Oracle Console or locally)
- Your Windows PC with the project + `C:\abmdas-data`

## One-time Oracle setup (web console)
1. Sign up at https://cloud.oracle.com
2. Create a VCN (Virtual Cloud Network) with a public subnet
3. Launch an instance:
   - **Shape:** `VM.Standard.A1.Flex` (ARM, Always Free) — 2 OCPU, 12 GB RAM
   - **Image:** Ubuntu 22.04 (Canonical)
   - **Boot volume:** 50 GB
   - **SSH key:** paste your public key
4. Note the **public IP** of the instance
5. Add a security list ingress rule: TCP port 3000 from 0.0.0.0/0 (or use Cloudflare Tunnel — see below)

## Deploy (from your PC)
```powershell
# 1. Run setup on the VM (first time only)
scp -i oracle-key.pem deploy\oracle\setup.sh ubuntu@<VM_IP>:/tmp/
ssh -i oracle-key.pem ubuntu@<VM_IP> "bash /tmp/setup.sh"

# 2. Push code + data
.\deploy\oracle\deploy.ps1 -VmIp <VM_IP> -KeyPath C:\path\to\oracle-key.pem

# 3. Update Vercel rewrite URL
# Edit vercel.json: change destination to http://<VM_IP>:3000/api/:path*
# Then: git add vercel.json && git commit -m "Point API to Oracle VM" && git push
```

## HTTPS via Cloudflare Tunnel (optional, free, no port opening)
```bash
# On the VM:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared
chmod +x cloudflared
./cloudflared tunnel --url http://localhost:3000
# Gives you https://random-words.trycloudflare.com
```
Update vercel.json to use that URL. For a stable URL, create a free Cloudflare account and a named tunnel.

## Updating the app later
Just re-run `deploy.ps1` — it copies fresh code and restarts PM2.

## Monitoring
```bash
ssh ubuntu@<VM_IP> "pm2 status && pm2 logs abmdas --lines 20"
```

## Backup
The DB is at `/home/ubuntu/abmdas-data/abmdas.db`. Back it up with:
```bash
ssh ubuntu@<VM_IP> "cp /home/ubuntu/abmdas-data/abmdas.db /home/ubuntu/abmdas-data/backups/abmdas-\$(date +%F).db"
```