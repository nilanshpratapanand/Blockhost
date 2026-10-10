# Blockhost

A zero-dependency Node.js (22+) dashboard for running a Minecraft Java server on Windows: console, players,
options, backups, world tools, mod/pack kit, and Live Sync for friends.

## Layout

```
Start_Dashboard.bat      launcher (put next to server.jar)
dashboard/               the app (server.js, lib/, public/)
dashboard/config.example.json
test/                    node --test test/backups-prune.test.js
```

Copy this repo's `dashboard/` folder and `Start_Dashboard.bat` into your Minecraft server folder, then run the
`.bat`. The dashboard opens at http://localhost:8765.

## Keeping secrets out of git

`.gitignore` excludes `dashboard/config.json`, `dashboard/sync-key.pem`, `Blockhost-Sync-*.bat`,
`server.properties` (contains the management-server secret), world data, backups and jars.
Never commit those. If one leaks, rotate it: delete `sync-key.pem` and click "New access token" on the Live Sync
page, regenerate the CurseForge key, and change `management-server-secret`.
