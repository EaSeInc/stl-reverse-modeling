@echo off
rem Останавливает сервер просмотрщика. Автозапуск и сторож остаются.
setlocal
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":9131 .*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo сервер на 9131 остановлен
endlocal
