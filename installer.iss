; NinjaOne Software Lookup — Inno Setup installer script
; Build with: ISCC.exe installer.iss
; Inno Setup 6 download: https://jrsoftware.org/isdl.php

#define AppName        "NinjaOne Software Lookup"
#define AppVersion     "1.0.0"
#define AppPublisher   "NinjaOne Software Lookup"
#define AppExe         "NinjaSoftwareLookup.exe"

[Setup]
; AppId uniquely identifies this app for upgrade/uninstall — DO NOT change once shipped.
AppId={{8C4F2E1A-9B3D-4F8E-A7C6-1D2E3F4A5B6C}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
VersionInfoProductName={#AppName}

; Install to C:\NinjaOneSoftwareLookup — requires admin (writing to C:\ root is restricted).
PrivilegesRequired=admin

DefaultDirName=C:\NinjaOneSoftwareLookup
DisableDirPage=no
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}

; Installer branding — icon, banner image, and modern wizard
SetupIconFile=logo.ico
WizardImageFile=installer-banner.bmp
WizardImageStretch=yes
WizardStyle=modern

OutputDir=dist
OutputBaseFilename=NinjaSoftwareLookup-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; \
  GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "NinjaSoftwareLookup.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "logo.ico";                DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}";              Filename: "{app}\{#AppExe}"; IconFilename: "{app}\logo.ico"
Name: "{group}\Uninstall {#AppName}";    Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";        Filename: "{app}\{#AppExe}"; IconFilename: "{app}\logo.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; \
  Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Clean up the per-app browser profile dir on uninstall. The user's NinjaOne
; credentials live in %AppData%\NinjaSoftwareLookup\config.json and are
; intentionally preserved across uninstall/reinstall.
Type: filesandordirs; Name: "{localappdata}\NinjaSoftwareLookup\BrowserProfile"
