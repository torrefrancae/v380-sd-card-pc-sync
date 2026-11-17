Set shell = CreateObject("Wscript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
Set env = shell.Environment("PROCESS")
env("V380_HOME") = root
env("V380_SUPERVISOR") = "1"
env("PATH") = root & "\runtime;" & env("PATH")
env("V380_NO_OPEN") = "1"
node = """" & root & "\runtime\node.exe"" """ & root & "\dist\server.mjs"""
opened = False
Do
  If Not opened Then
    shell.Run "cmd /c ping -n 3 127.0.0.1 >nul & start """" http://127.0.0.1:8787", 0, False
    opened = True
  End If
  code = shell.Run(node, 0, True)
  If code = 86 Then Exit Do
  WScript.Sleep 2000
Loop
