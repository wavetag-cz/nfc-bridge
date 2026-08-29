$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startup = [Environment]::GetFolderPath("Startup")
$vbs = Join-Path $dir "start-hidden.vbs"

@"
Set shell = CreateObject("WScript.Shell")
shell.Run "node ""$dir\index.js""", 0, False
"@ | Set-Content -Path $vbs -Encoding ASCII

Copy-Item $vbs (Join-Path $startup "nfc-bridge.vbs") -Force
Start-Process wscript $vbs

Write-Host "Done. The bridge is running and will start after login."
