'use strict';
// System stats (CPU, RAM, server process memory) and playit.gg helpers.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { IS_WIN, run } = require('./util');

let lastCpu = null;
function systemCpu() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  const prev = lastCpu; lastCpu = { idle, total };
  if (!prev || total === prev.total) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)))));
}

async function processMemory(pid) {
  if (!pid) return 0;
  if (IS_WIN) {
    const r = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = r.stdout.match(/"([\d.,\s\u00a0]+) K"/);
    return m ? parseInt(m[1].replace(/[^\d]/g, ''), 10) * 1024 : 0;
  }
  try {
    const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+) kB/);
    return s ? parseInt(s[1], 10) * 1024 : 0;
  } catch { return 0; }
}

async function stats(pid) {
  return {
    cpu: systemCpu(),
    cpuCount: os.cpus().length,
    memTotal: os.totalmem(),
    memUsed: os.totalmem() - os.freemem(),
    serverMem: await processMemory(pid),
  };
}

// ---------- playit.gg ----------
function playitCandidates(configured) {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const la = process.env.LOCALAPPDATA || '';
  return [configured,
    path.join(pf, 'playit_gg', 'bin', 'playit.exe'),
    path.join(pf86, 'playit_gg', 'bin', 'playit.exe'),
    path.join(la, 'playit_gg', 'bin', 'playit.exe'),
    path.join(la, 'playit_gg', 'playit.exe'),
  ].filter(Boolean);
}

function findPlayit(configured, serverDir, dashDir) {
  const list = playitCandidates(configured);
  if (dashDir) list.push(path.join(dashDir, 'bin', 'playit.exe'));
  if (serverDir) list.push(path.join(serverDir, 'playit.exe'));
  return list.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

async function playitRunning() {
  if (IS_WIN) {
    const r = await run('tasklist', ['/FI', 'IMAGENAME eq playit.exe', '/FO', 'CSV', '/NH']);
    return /playit\.exe/i.test(r.stdout);
  }
  const r = await run('pgrep', ['-f', 'playit']);
  return r.code === 0 && r.stdout.trim().length > 0;
}

function startPlayit(exe) {
  if (IS_WIN) {
    // open in its own console window so its terminal UI works
    const c = spawn('cmd.exe', ['/c', 'start', '"playit.gg"', `"${exe}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' });
    c.on('error', () => {}); c.unref();
  } else {
    const c = spawn(exe, [], { detached: true, stdio: 'ignore' });
    c.on('error', () => {}); c.unref();
  }
}

module.exports = { stats, findPlayit, playitRunning, startPlayit };
