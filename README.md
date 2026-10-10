# Blockhost

A zero-dependency Node.js (22+) dashboard for running a Minecraft Java server on Windows: console, players,
options, backups, world tools, mod/pack kit, and Live Sync for friends.

## Layout

```
Start_Dashboard.bat      launcher (put next to server.jar)
dashboard/               the app (server.js, lib/, public/)
dashboard/config.example.json
dashboard/cloud/          Cloud Host coordinator (Cloudflare Worker) + setup guide
test/                    node --test test/*.test.js
```

Copy this repo's `dashboard/` folder and `Start_Dashboard.bat` into your Minecraft server folder, then run the
`.bat`. The dashboard opens at http://localhost:8765.

## Highlights

- **Server tuner** (Settings): audits JVM flags and heap, applies Aikar's G1 set validated against your real Java,
  optional LZ4 chunk compression and simulation distance. Never touches view distance or visuals. One-click undo.
- **Cloud Host** (no 24/7 PC needed): friends take turns hosting. Whoever starts playing becomes the host, the world
  is synced through a free Cloudflare Worker, and the host hands off after the server has been idle (default 30 min).
  RAM is sized to the host PC, capped at 4 GB. Setup: `dashboard/cloud/README.md`.
- **Friends host from the tray app**: the owner downloads a friend app from the Cloud Host page. After running it once, a friend's tray icon asks "Start the server for everyone?" when they open Minecraft and nobody is hosting. Their PC downloads its own Java and Node, pulls the world, and runs the server on the owner's one fixed address. The dashboard stays owner-only.
- **Remote control while a friend hosts**: the friend's PC reports its state and console to your Cloudflare coordinator, and your dashboard mirrors it (online players, live console, commands, op/kick/ban, Stop & hand back). It uses a second, owner-only secret (`ADMIN_SECRET`, deployed once with Cloud Host > "Update cloud") that friends never receive. The friend's PC reports fast only while your dashboard is open. Operators stay session-only on a friend's PC too (Op Guard travels with the host).
- **Mod Guard**: reads installed mods, flags missing dependencies and client/server mismatches.
- **Smart storage cleanup** for backups, and auto dependency install for mods.

## Keeping secrets out of git

`.gitignore` excludes `dashboard/config.json`, `dashboard/sync-key.pem`, `dashboard/baton-state.json`, `Blockhost-Sync-*.bat`,
`server.properties` (contains the management-server secret), world data, backups and jars.
Never commit those. If one leaks, rotate it: delete `sync-key.pem` and click "New access token" on the Live Sync
page, regenerate the CurseForge key, and change `management-server-secret`.
