'use strict';
// Op Guard: with online-mode=false a player's name is not proof of identity, so anyone who types "nilansh" at the
// login screen would inherit that name's operator rights. Op Guard removes the permanent name -> op link:
//   - ops.json is emptied before every server start and after every stop/crash,
//   - the host grants op from the dashboard only while the player is online (a "session op"),
//   - the op is revoked the moment that player leaves, and anyone found opped on join without a grant is de-opped.
const fs = require('fs');
const path = require('path');

class OpGuard {
  /** deps: { dir, getConfig, saveConfig, send(cmd), log(msg, level) } */
  constructor(deps) {
    this.dir = deps.dir; this.getConfig = deps.getConfig; this.saveConfig = deps.saveConfig;
    this.send = deps.send; this.log = deps.log || (() => {});
    this.session = new Set();           // lowercase names the host granted during this run
  }

  get enabled() { return this.getConfig().opGuard !== false; }
  get file() { return path.join(this.dir, 'ops.json'); }

  read() { try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; } }
  listed(name) { const n = String(name).toLowerCase(); return this.read().some(e => String(e.name).toLowerCase() === n); }

  /** Empty ops.json (only call while the server process is not running). Remembers the names that were removed. */
  scrub() {
    if (!this.enabled) return;
    const ops = this.read();
    if (!ops.length) return;
    const names = [...new Set([...(this.getConfig().opGuardNames || []), ...ops.map(e => e.name).filter(Boolean)])];
    fs.writeFileSync(this.file, '[]\n');
    this.saveConfig({ opGuardNames: names });
    this.log(`Op Guard: removed ${ops.length} permanent operator(s) from ops.json. Grant op per session from the Players page.`, 'warn');
  }

  /** Called before the host's dashboard "op" action. Throws if the grant would be unsafe. */
  grant(name, isOnline) {
    if (!this.enabled) return;
    if (!isOnline) throw new Error('Op Guard: operators are session-only. Wait until the player is online, then grant op.');
    this.session.add(String(name).toLowerCase());
  }

  onJoin(name) {
    if (!this.enabled) return;
    if (this.listed(name) && !this.session.has(String(name).toLowerCase())) {
      this.log(`Op Guard: "${name}" joined holding op without a dashboard grant - removing op.`, 'warn');
      this.send(`deop ${name}`);
    }
  }

  onLeave(name) {
    if (!this.enabled) return;
    this.session.delete(String(name).toLowerCase());
    if (this.listed(name)) this.send(`deop ${name}`);
  }

  /** Server process ended. */
  onStop() { this.session.clear(); this.scrub(); }
}

module.exports = { OpGuard };
