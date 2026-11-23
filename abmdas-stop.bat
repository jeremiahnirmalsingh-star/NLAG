@echo off
rem Stop ABMDAS completely: stops the supervisor and the app server, and nothing else.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*abmdas-supervisor.ps1*' -or $_.CommandLine -like '*server\index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo ABMDAS stopped. Run abmdas-start.bat to start it again.
timeout /t 3 /nobreak >nul
