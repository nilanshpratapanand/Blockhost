'use strict';
// Downloads the official playit.gg agent (signed Windows build from GitHub releases) and verifies it.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { IS_WIN, download, run, moveFile } = require('./util');

const PLAYIT_URL = process.env.BLOCKHOST_PLAYIT_URL
  || 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-windows-x86_64-signed.exe';

async function verifySignature(file) {
  // Authenticode check via PowerShell - make sure the exe is really signed and untampered.
  const ps = "$s = Get-AuthenticodeSignature -LiteralPath $env:BH_FILE; Write-Output ($s.Status.ToString() + '|' + $s.SignerCertificate.Subject)";
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, BH_FILE: file } });
  const [status, subject] = r.stdout.trim().split('|');
  return { ok: status === 'Valid', status: status || 'Unknown', subject: subject || '' };
}

async function installPlayit(dashDir, progress) {
  if (!IS_WIN && !process.env.BLOCKHOST_PLAYIT_URL) throw new Error('Automatic playit install is only for Windows.');
  const binDir = path.join(dashDir, 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  const dest = path.join(binDir, 'playit.exe');
  const tmp = dest + '.download';
  try {
    progress('Downloading playit.gg from its official GitHub releases...', 5);
    await download(PLAYIT_URL, tmp, pct => progress(null, 5 + Math.round(pct * 0.8)));
    const head = Buffer.alloc(2); const fd = await fsp.open(tmp, 'r'); await fd.read(head, 0, 2, 0); await fd.close();
    const size = (await fsp.stat(tmp)).size;
    if (head.toString('latin1') !== 'MZ' || size < 500 * 1024) throw new Error('Downloaded file is not a Windows program.');
    if (IS_WIN) {
      progress('Checking the digital signature...', 90);
      const sig = await verifySignature(tmp);
      if (!sig.ok) throw new Error(`Signature check failed (${sig.status}). Not installing it.`);
      progress(`Signature OK: ${sig.subject.split(',')[0]}`, 95);
    }
    await fsp.rm(dest, { force: true });
    await moveFile(tmp, dest);
    return dest;
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    if (!IS_WIN) throw e;
    // Fallback: official winget package
    progress(`Direct download failed (${e.message}). Trying winget...`, 50);
    const r = await run('winget', ['install', '-e', '--id', 'DevelopedMethods.playit', '--accept-source-agreements', '--accept-package-agreements'],
      { onData: l => { const t = l.trim(); if (t) progress(t.slice(0, 120)); } });
    if (r.code !== 0) throw new Error('Could not install playit.gg automatically. Get it from https://playit.gg/download');
    return null; // installed system-wide; caller auto-detects the path
  }
}

async function createDesktopShortcut(batPath) {
  if (!IS_WIN) throw new Error('Desktop shortcuts are Windows-only.');
  if (!fs.existsSync(batPath)) throw new Error('Start Dashboard.bat not found next to the dashboard folder.');
  const ps = [
    "$d = [Environment]::GetFolderPath('Desktop')",
    "$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Minecraft Server.lnk'))",
    '$s.TargetPath = $env:BH_BAT',
    '$s.WorkingDirectory = (Split-Path -Parent $env:BH_BAT)',
    "$s.IconLocation = \"$env:SystemRoot\\System32\\imageres.dll,1\"",
    "$s.Description = 'Open the Blockhost Minecraft server dashboard'",
    '$s.Save()',
    "Write-Output (Join-Path $d 'Minecraft Server.lnk')",
  ].join('; ');
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, BH_BAT: batPath } });
  if (r.code !== 0) throw new Error('Could not create the shortcut: ' + r.stderr.slice(0, 200));
  return r.stdout.trim();
}

module.exports = { installPlayit, createDesktopShortcut };
