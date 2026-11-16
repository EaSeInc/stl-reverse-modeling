@echo off
rem Ставит просмотрщик как приложение: автозапуск, сторож, ярлык.
rem Права администратора не нужны. Повторный запуск безопасен.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
