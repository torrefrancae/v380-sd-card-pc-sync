Set shell = CreateObject("Wscript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root

If Not PageReady() Then
  shell.Run "wscript.exe """ & root & "\launch.vbs""", 0, False
End If

ready = False
For i = 1 To 90
  If PageReady() Then
    ready = True
    Exit For
  End If
  WScript.Sleep 1000
Next

Set net = CreateObject("WScript.Network")
page = "http://" & net.ComputerName & ":8787"

If ready Then
  shell.Run "cmd /c start """" " & page, 0, False
Else
  MsgBox "V380 SD Sync is still starting." & vbCrLf & vbCrLf & "Open " & page & " in a moment. Refresh the page if it is not ready yet.", 64, "V380 SD Sync"
End If

Function PageReady()
  On Error Resume Next
  Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
  If Err.Number <> 0 Then
    PageReady = False
    Exit Function
  End If
  http.SetTimeouts 800, 800, 800, 800
  http.Open "GET", "http://127.0.0.1:8787/", False
  http.Send
  PageReady = (Err.Number = 0 And http.Status = 200)
  Err.Clear
End Function
