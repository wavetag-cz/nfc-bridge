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

@"
Set shell = CreateObject("WScript.Shell")
shell.Run "node ""$dir\index.js""", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII

Copy-Item $vbs (Join-Path $startup "nfc-bridge.vbs") -Force
Start-Process wscript $vbs

Write-Host "Done. The bridge is running and will start after login."
