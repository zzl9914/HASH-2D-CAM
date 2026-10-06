@echo off
chcp 65001 >nul
cd /d "%~dp0"
node src\tools\serve.js
if errorlevel 1 pause
