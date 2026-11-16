# Ставит просмотрщик как приложение: автозапуск сервера, сторож, ярлык.
# Права администратора не нужны, повторный запуск безопасен.
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot          # ...\stl-reverse-modeling
$vbs  = Join-Path $PSScriptRoot 'ensure.vbs'
$ico  = Join-Path $repo 'web\icon.ico'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { $chrome = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }

$sh = New-Object -ComObject WScript.Shell

# 1. сторож: раз в 5 минут поднимает сервер, если тот упал
& schtasks /Create /F /TN "STL Viewer (watchdog)" /SC MINUTE /MO 5 /TR "wscript.exe //nologo $vbs" | Out-Null
Write-Host '[1/3] сторож в планировщике: STL Viewer (watchdog), каждые 5 минут'

# 2. автозапуск при входе в систему
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\STL Viewer.lnk'
$l = $sh.CreateShortcut($startup)
$l.TargetPath = 'wscript.exe'
$l.Arguments = '//nologo "' + $vbs + '"'
$l.WorkingDirectory = $PSScriptRoot
$l.IconLocation = $ico
$l.Description = 'Просмотрщик STL: фоновый сервер на 127.0.0.1:9131'
$l.Save()
Write-Host '[2/3] автозапуск при входе:' $startup

# 3. ярлык приложения на рабочем столе (отдельное окно без вкладок)
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'STL Viewer.lnk'
$l = $sh.CreateShortcut($lnk)
$l.TargetPath = $chrome
$l.Arguments = '--app=http://127.0.0.1:9131/ --window-size=1600,1000'
$l.WorkingDirectory = Split-Path -Parent $chrome
$l.IconLocation = $ico
$l.Description = 'Просмотрщик STL: отдельное окно'
$l.Save()
Write-Host '[3/3] ярлык приложения:' $lnk

# 4. сразу поднять сервер, чтобы ярлык не открывал пустоту
& wscript.exe //nologo $vbs
Start-Sleep -Seconds 2
$up = (Test-NetConnection -ComputerName 127.0.0.1 -Port 9131 -InformationLevel Quiet -WarningAction SilentlyContinue)
Write-Host ''
if ($up) { Write-Host 'Сервер работает: http://127.0.0.1:9131/' } else { Write-Host 'Сервер не поднялся — смотреть logs\server.log' }
