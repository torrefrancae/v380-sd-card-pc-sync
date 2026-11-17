#define AppName "V380 SD Sync"
#define AppVersion "1.0.0"
#define AppPublisher "Torrefranca"

[Setup]
AppId={{8F3A1C2E-6B74-4D11-9A5E-2C7B0E4D91A6}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\V380SdSync
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist\installer
OutputBaseFilename=V380SdSync-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={sys}\wscript.exe

[Files]
Source: "..\build\win\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-when-ready.vbs"""; WorkingDir: "{app}"
Name: "{autodesktop}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-when-ready.vbs"""; WorkingDir: "{app}"

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-when-ready.vbs"""; WorkingDir: "{app}"; StatusMsg: "Starting V380 SD Sync. The browser opens when the page is ready. The first start can take a minute."; Flags: runasoriginaluser
