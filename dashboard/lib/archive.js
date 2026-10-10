'use strict';
// Zip create/extract using Windows' built-in tar.exe (bsdtar), or zip/unzip elsewhere.
const fs = require('fs');
const path = require('path');
const { IS_WIN, run } = require('./util');

function winTar() { return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); }

async function createZip(cwd, items, outFile) {
  if (!items.length) throw new Error('Nothing to archive');
  let r;
  if (IS_WIN) r = await run(winTar(), ['-a', '-c', '-f', outFile, ...items], { cwd });
  else r = await run('zip', ['-r', '-q', outFile, ...items], { cwd });
  if (r.code !== 0 || !fs.existsSync(outFile)) throw new Error('Archive failed: ' + (r.stderr || r.stdout || r.code).toString().slice(0, 400));
}

async function extractZip(file, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  let r;
  if (IS_WIN) r = await run(winTar(), ['-x', '-f', file, '-C', destDir]);
  else r = await run('unzip', ['-o', '-q', file, '-d', destDir]);
  if (r.code !== 0) throw new Error('Extract failed: ' + (r.stderr || r.stdout || r.code).toString().slice(0, 400));
}

module.exports = { createZip, extractZip };
