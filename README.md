# WaveTag NFC bridge

A small program that runs on the operator's computer, talks to the ACS
ACR1252U-M1 reader over PC/SC and exposes it through a local WebSocket. It is
used by the WaveTag admin at `https://admin.wavetag.cz` (in Chrome or Edge) to
write URLs to NFC tags.

## Requirements

- Node.js 20+
- ACR1252U reader driver from the ACS site (`https://www.acs.com.hk`,
  support / drivers section)
- ACR1252U-M1 reader connected over USB

## Installation — macOS

```sh
git clone https://github.com/wavetag-cz/nfc-bridge.git
cd nfc-bridge
npm install
./install-mac.sh
```

## Installation — Windows

```powershell
git clone https://github.com/wavetag-cz/nfc-bridge.git
cd nfc-bridge
npm install
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

## Updating

```sh
git pull
npm install
```

Then run the install script again (`./install-mac.sh` or
`powershell -ExecutionPolicy Bypass -File .\install-windows.ps1`).

## Log

On macOS the log is written to `bridge.log` in the project folder.
