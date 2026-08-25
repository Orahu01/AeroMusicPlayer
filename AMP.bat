@echo off
title AeroMusic Player
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0amp-launch.ps1"
if errorlevel 1 pause
