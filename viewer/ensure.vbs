' Скрытый запуск ensure.cmd — без мелькающего окна консоли.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & here & chr(92) & "ensure.cmd""", 0, False
