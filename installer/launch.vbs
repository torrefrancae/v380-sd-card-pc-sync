Set shell = CreateObject("Wscript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
Set env = shell.Environment("PROCESS")
env("V380_HOME") = root
env("V380_SUPERVISOR") = "1"
env("PATH") = root & "\runtime;" & env("PATH")
node = """" & root & "\runtime\node.exe"" """ & root & "\dist\server.mjs"""
quiet = False
Do
  If quiet Then
    env("V380_NO_OPEN") = "1"
  Else
    On Error Resume Next
    env.Remove("V380_NO_OPEN")
    On Error GoTo 0
  End If
  code = shell.Run(node, 0, True)
  If code = 86 Then
    shell.Run "http://127.0.0.1:8787"
    Exit Do
  End If
  quiet = True
  WScript.Sleep 2000
Loop
