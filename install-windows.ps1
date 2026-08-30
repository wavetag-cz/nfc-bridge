$ErrorActionPreference = "Stop"

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startup = [Environment]::GetFolderPath("Startup")
$vbs = Join-Path $dir "start-hidden.vbs"
$release = Join-Path $dir "node_modules\@pokusew\pcsclite\build\Release"
$binary = Join-Path $release "pcsclite.node"

# The reader library is a native module. Building it here would need Visual
# Studio, so we skip every install script and drop in the binary that GitHub
# Actions built instead. It is tied to the Node 22 ABI and to the architecture
# of the Node that runs it, so a 32bit Node needs the 32bit build.
$abi = & node -p "process.versions.modules"
if ($abi -ne "127") {
  Write-Host "Node 22 is required (this is Node $(node -v), module ABI $abi)."
  Write-Host "Install it from https://nodejs.org and run this script again."
  exit 1
}

$arch = & node -p "process.arch"
switch ($arch) {
  "x64" { $name = "pcsclite-win32-x64.node" }
  "ia32" { $name = "pcsclite-win32-ia32.node" }
  default {
    Write-Host "No prebuilt reader module for this architecture ($arch)."
    exit 1
  }
}
$asset = "https://github.com/wavetag-cz/nfc-bridge/releases/latest/download/$name"

Push-Location $dir
npm install --ignore-scripts
Pop-Location

New-Item -ItemType Directory -Force -Path $release | Out-Null
Invoke-WebRequest -Uri $asset -OutFile $binary -UseBasicParsing

# A missing release asset answers with an HTML error page, which Windows would
# only reject later as "not a valid Win32 application". Catch it here instead.
$header = [System.IO.File]::ReadAllBytes($binary)[0..1]
if ($header[0] -ne 0x4D -or $header[1] -ne 0x5A) {
  Remove-Item $binary
  Write-Host "The download from $asset is not a Windows binary."
  Write-Host "Check that the latest release has $name attached."
  exit 1
}

# The smart card service is demand started on Windows and is regularly still
# down when the bridge launches from the Startup folder, which used to leave the
# bridge running but permanently blind to the reader. The bridge now recovers on
# its own, but starting the service here means it works on the first try.
try {
  Set-Service -Name SCardSvr -StartupType Automatic -ErrorAction Stop
  Start-Service -Name SCardSvr -ErrorAction Stop
  Write-Host "Smart card service is running."
} catch {
  Write-Host "Could not configure the smart card service (run as administrator to fix this)."
  Write-Host "The bridge will still start it on demand, but the first scan may take longer."
}

# A second copy cannot bind the port and exits immediately, so clear out any
# bridge left over from an earlier install before starting this one.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like "*nfc-bridge*index.js*" } |
  ForEach-Object {
    Write-Host "Stopping the bridge already running (pid $($_.ProcessId))."
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

@"
Set shell = CreateObject("WScript.Shell")
shell.Run "node ""$dir\index.js""", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII

Copy-Item $vbs (Join-Path $startup "nfc-bridge.vbs") -Force
Start-Process wscript $vbs

Write-Host "Done. The bridge is running and will start after login."
Write-Host "Log file: $(Join-Path $dir 'bridge.log')"
