# Run this ON YOUR WINDOWS PC to push code + data to the Oracle VM.
# Usage: .\deploy.ps1 -VmIp "1.2.3.4" -KeyPath "C:\path\to\oracle-key.pem"
param(
  [Parameter(Mandatory=$true)] [string]$VmIp,
  [Parameter(Mandatory=$true)] [string]$KeyPath,
  [string]$User = 'ubuntu'
)
$ErrorActionPreference = 'Stop'
$Project = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))

Write-Host "=== Deploying ABMDAS to Oracle VM $VmIp ===" -ForegroundColor Cyan

# 1. Ensure remote directories exist
ssh -i $KeyPath "$User@$VmIp" "mkdir -p /home/$User/abmdas /home/$User/abmdas-data/uploads /home/$User/abmdas-data/backups"

# 2. Copy server + public
Write-Host "Copying server/ and public/ ..." -ForegroundColor Yellow
scp -i $KeyPath -r "$Project\server" "$Project\public" "$User@$VmIp`:/home/$User/abmdas/"

# 3. Copy data (DB + uploads)
Write-Host "Copying abmdas-data/ ..." -ForegroundColor Yellow
scp -i $KeyPath -r "C:\abmdas-data\*" "$User@$VmIp`:/home/$User/abmdas-data/"

# 4. Restart the service
Write-Host "Restarting service ..." -ForegroundColor Yellow
ssh -i $KeyPath "$User@$VmIp" "cd /home/$User/abmdas && pm2 restart abmdas 2>/dev/null || (pm2 start ecosystem.config.js && pm2 save)"

# 5. Verify
Write-Host "Verifying health ..." -ForegroundColor Yellow
ssh -i $KeyPath "$User@$VmIp" "curl -s http://localhost:3000/api/health"

Write-Host ""
Write-Host "=== Done. Update vercel.json rewrite URL to http://$VmIp`:3000 ===" -ForegroundColor Green