$ErrorActionPreference = "Stop"

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startup = [Environment]::GetFolderPath("Startup")
$vbs = Join-Path $dir "start-hidden.vbs"
$asset = "https://github.com/vojtechhabes/nfc-bridge/releases/latest/download/pcsclite-win32-x64.node"
$release = Join-Path $dir "node_modules\@pokusew\pcsclite\build\Release"

# The reader library is a native module. Building it here would need Visual
# Studio, so we skip every install script and drop in the binary that GitHub
# Actions built instead. It is tied to the Node 22 ABI.
$abi = & node -p "process.versions.modules"
if ($abi -ne "127") {
  Write-Host "Node 22 is required (this is Node $(node -v), module ABI $abi)."
  Write-Host "Install it from https://nodejs.org and run this script again."
  exit 1
}

Push-Location $dir
npm install --ignore-scripts
Pop-Location

New-Item -ItemType Directory -Force -Path $release | Out-Null
Invoke-WebRequest -Uri $asset -OutFile (Join-Path $release "pcsclite.node")

@"
Set shell = CreateObject("WScript.Shell")
shell.Run "node ""$dir\index.js""", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII

Copy-Item $vbs (Join-Path $startup "nfc-bridge.vbs") -Force
Start-Process wscript $vbs

Write-Host "Done. The bridge is running and will start after login."
