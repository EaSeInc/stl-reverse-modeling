@echo off
rem Просмотрщик STL: окно без адресной строки + локальный сервер.
rem Питон берём из venv проекта, если он есть, иначе из PATH.
cd /d "%~dp0.."

set PY=%~dp0..\venv\Scripts\python.exe
if not exist "%PY%" set PY=C:/Users/boot8/tools/meshrev/venv/Scripts/python.exe
if not exist "%PY%" set PY=python

"%PY%" "%~dp0server.py" --port 9131 --open --root "%~dp0.." --root "C:/Users/boot8/cad"
pause
