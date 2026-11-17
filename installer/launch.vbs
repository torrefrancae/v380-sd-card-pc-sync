Set shell = CreateObject("Wscript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
Set env = shell.Environment("PROCESS")
env("V380_HOME") = root
env("PATH") = root & "\runtime;" & env("PATH")
shell.Run """" & root & "\runtime\node.exe"" """ & root & "\dist\server.mjs""", 0, False
