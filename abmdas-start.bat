@echo off
rem Start ABMDAS: makes sure the supervisor is running, then opens the app.
start "" wscript "C:\abmdas-data\abmdas-supervisor.vbs"
timeout /t 6 /nobreak >nul
start "" "http://localhost:3000"
