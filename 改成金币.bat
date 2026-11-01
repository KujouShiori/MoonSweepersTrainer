@echo off
chcp 65001 >nul
title Moon Sweepers money editor
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0MoonMoney.ps1" %*
echo.
pause
