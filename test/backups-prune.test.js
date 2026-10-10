'use strict';
// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Backups } = require('../dashboard/lib/backups');

test('prune only deletes auto- backups and keeps before-* safety copies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(bdir);
  const mk = (i, label) => {
    const f = path.join(bdir, `backup_2026-01-01_00-00-0${i}_${label}.zip`);
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, 1000 + i, 1000 + i); // distinct, increasing mtimes
    return path.basename(f);
  };
  const safety = [mk(1, 'before-reset'), mk(2, 'before-import'), mk(3, 'before-26.3'), mk(4, 'before-nether-trip')];
  const autos = [mk(5, 'auto-a'), mk(6, 'auto-b'), mk(7, 'auto-c'), mk(8, 'auto-d')];
  const b = new Backups(dir, null, () => ({ backupsToKeep: 2 }));
  b.prune();
  const left = fs.readdirSync(bdir);
  for (const f of safety) assert.ok(left.includes(f), `${f} must survive`);
  assert.deepStrictEqual(left.filter(f => /_auto-/.test(f)).sort(), autos.slice(2).sort()); // newest 2 autos kept
  fs.rmSync(dir, { recursive: true, force: true });
});
