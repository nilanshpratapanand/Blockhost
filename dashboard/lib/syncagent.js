'use strict';
// Builds "Blockhost Sync.bat": a friend runs it ONCE. It installs the background sync agent (lib/agent.ps1)
// with the host's address, access token and public key baked in.
const fs = require('fs');
const path = require('path');

const AGENT_FILE = path.join(__dirname, 'agent.ps1');
const agentScript = () => fs.readFileSync(AGENT_FILE, 'utf8').replace(/\r?\n/g, '\r\n');

/** d: {serverName, urls[], token, pub{n,e}, keyId} */
function buildSyncBat(d) {
  const data = Buffer.from(JSON.stringify(d), 'utf8').toString('base64');
  const safeName = String(d.serverName).replace(/[^\w .\-]/g, '');
  const head = [
    '@echo off',
    ':: ==========================================================================',
    `::  Blockhost Sync for: ${safeName}`,
    '::  Run this ONCE. It installs a small background helper that keeps your',
    '::  Minecraft shaders / texture packs / mods in sync with the host.',
    '::  The code below is plain PowerShell - open this file in Notepad to read it.',
    ':: ==========================================================================',
    'setlocal',
    'title Blockhost Sync setup',
    'set "BH_SELF=%~f0"',
    'set "BH_MODE=install"',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:BH_SELF); $p=($s -split '(?m)^#{3}PS_BEGIN\\s*$')[-1]; Invoke-Expression $p"`,
    'echo.',
    'pause',
    'exit /b',
    '',
    '###PS_BEGIN',
    `$BH_SETUP = '${data}'`,
  ].join('\r\n');
  return head + '\r\n' + agentScript();
}

module.exports = { buildSyncBat, agentScript };
