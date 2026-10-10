'use strict';
// Builds "Friend Installer" .bat files: a player double-clicks it once and it downloads the server's
// shaders / texture packs (and optionally Fabric + Iris + Sodium so shaders actually run) into their
// .minecraft folder. Every file comes from Modrinth / Fabric with a SHA-1 check. Nothing runs silently:
// it shows what it will do and waits for Enter first.

function buildInstaller(d) {
  const data = Buffer.from(JSON.stringify(d), 'utf8').toString('base64');
  const bat = String.raw`@echo off
:: ==========================================================================
::  Minecraft pack installer for: __NAME__
::  Made with Blockhost. Downloads shaders / texture packs for Minecraft __VER__
::  into your .minecraft folder. Safe to run again to update.
:: ==========================================================================
setlocal
title Minecraft pack installer
set "BH_SELF=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:BH_SELF); $p=($s -split '(?m)^#{3}PS_BEGIN\s*$')[-1]; Invoke-Expression $p"
echo.
pause
exit /b

###PS_BEGIN
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$D = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__DATA__')) | ConvertFrom-Json

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
$Here = Split-Path -Parent ([string]$env:BH_SELF)
function Get-Item2($f, $folder, $dest) {
  # 1) download from its source (3 tries), 2) fall back to the copy packed inside the installer zip
  $src = Join-Path $Here ("files\" + $folder + "\" + $f.name)
  if ($f.url) {
    for ($try = 1; $try -le 3; $try++) {
      try { Get-Verified $f.url $dest $f.sha1; return } catch { $err = $_.Exception.Message; if ($try -lt 3) { Start-Sleep -Seconds (2 * $try) } }
    }
    if (Test-Path -LiteralPath $src) { Say "    download failed ($err) - using the copy inside the installer" 'DarkYellow' }
    else { throw "Could not download $($f.name): $err" }
  } elseif (-not (Test-Path -LiteralPath $src)) {
    throw "Missing $($f.name) - extract the whole zip first (right-click > Extract All), then run the .bat from that folder."
  }
  Copy-Item -LiteralPath $src -Destination $dest -Force
  if ($f.sha1 -and (Get-FileHash -LiteralPath $dest -Algorithm SHA1).Hash.ToLower() -ne $f.sha1.ToLower()) { throw "File $($f.name) is damaged - get the installer again." }
}
function Get-Verified($url, $dest, $sha1) {
  $tmp = "$dest.part"
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -Headers @{ 'User-Agent' = 'blockhost-friend-installer/1.0' }
  if ($sha1) {
    $h = (Get-FileHash -LiteralPath $tmp -Algorithm SHA1).Hash.ToLower()
    if ($h -ne $sha1.ToLower()) { Remove-Item -LiteralPath $tmp -Force; throw "Checksum failed for $([IO.Path]::GetFileName($dest))" }
  }
  Move-Item -LiteralPath $tmp -Destination $dest -Force
}

Clear-Host
$log = New-Object System.Collections.Generic.List[string]
function Log($m) { $log.Add($m); Say "  $m" }
Say ''
Say "  $($D.serverName)" 'Magenta'
Say "  Pack installer for Minecraft $($D.version)" 'Gray'
Say ''

# Find the game folder. TLauncher can use a custom folder (saved in its settings file).
$default = Join-Path $env:APPDATA '.minecraft'
$mc = $default
$tlProps = @((Join-Path $env:APPDATA '.tlauncher\tlauncher-2.0.properties'), (Join-Path $env:APPDATA '.tlauncher\tlauncher.properties'))
foreach ($tp in $tlProps) {
  if (Test-Path $tp) {
    foreach ($l in Get-Content -LiteralPath $tp) {
      if ($l -match '^\s*minecraft\.gamedir\s*=\s*(.+)$') {
        $g = $Matches[1].Trim() -replace '\\:', ':' -replace '\\\\', '\'
        if ($g -and (Test-Path $g)) { $mc = $g }
      }
    }
  }
}
if (-not (Test-Path $mc)) {
  Say "  Could not find the Minecraft folder ($mc)." 'Yellow'
  Say '  Open TLauncher, start Minecraft once, close it, then run this again.' 'Yellow'
  return
}
if (($D.shaders.Count + $D.resourcepacks.Count) -eq 0) {
  Say '  This installer has nothing in it - ask the host to add shaders/texture packs to the Player Kit and send a new one.' 'Yellow'
  return
}
Say "  Minecraft folder: $mc" 'White'
# What happened the last time the game started? (helps explain "shaders not working")
$ll = Join-Path $mc 'logs\latest.log'
if (Test-Path $ll) {
  $txt = Get-Content -LiteralPath $ll -Raw -ErrorAction SilentlyContinue
  $fab = [regex]::Match($txt, 'Loading Minecraft \S+ with Fabric Loader \S+')
  $irisLoaded = $txt -match '(?m)^\s*-\s*iris\s'
  Say ''
  Say '  Last time Minecraft started:' 'White'
  if ($fab.Success) { Say "    with Fabric ($($fab.Value))" 'Green' } else { Say '    WITHOUT Fabric - shaders cannot work in that version. Pick the Fabric version in TLauncher!' 'Yellow' }
  if ($fab.Success) { if ($irisLoaded) { Say '    Iris shader mod: loaded' 'Green' } else { Say '    Iris shader mod: NOT loaded' 'Yellow' } }
  $bad = [regex]::Matches($txt, '(?m)^.*(Incompatible mods? found|Mod resolution failed|requires .* which is missing).*$') | Select-Object -First 3
  foreach ($b in $bad) { Say "    ! $($b.Value.Trim())" 'Red' }
  $log.Add("Last launch: fabric=$($fab.Success) iris=$irisLoaded")
}
# Auto-fix: a content mod that broke joining the (vanilla) server last time -> move it out of mods
if ($txt -and $txt -match 'Network Protocol Error|Failed to load registries|Missing element ResourceKey') {
  $ids = @([regex]::Matches($txt, 'Missing element ResourceKey\[[\w:/]+ / ([a-z0-9_.\-]+):') | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -ne 'minecraft' })
  if ($txt -match 'Failed to load registries|Unbound tags in registry') { $ids += 'biomesoplenty', 'terrablender' }
  $want = @{}; foreach ($i in $ids) { $want[$i] = 1; if ($i -eq 'biomesoplenty') { $want['terrablender'] = 1; $want['glitchcore'] = 1 }; if ($i -eq 'terrablender') { $want['glitchcore'] = 1 } }
  $md = Join-Path $mc 'mods'
  foreach ($j in @(Get-ChildItem -LiteralPath $md -Filter '*.jar' -ErrorAction SilentlyContinue)) {
    $id = ([IO.Path]::GetFileNameWithoutExtension($j.Name).ToLower() -replace '[-_].*$', '')
    try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue; $z = [IO.Compression.ZipFile]::OpenRead($j.FullName); try { $e = $z.GetEntry('fabric.mod.json'); if ($e) { $r = New-Object IO.StreamReader($e.Open()); $id = ($r.ReadToEnd() | ConvertFrom-Json).id; $r.Close() } } finally { $z.Dispose() } } catch { }
    if ($want.ContainsKey($id)) {
      $dest = Join-Path $md '_disabled-by-blockhost'; New-Item -ItemType Directory -Force -Path $dest | Out-Null
      try { Move-Item -LiteralPath $j.FullName -Destination $dest -Force; Say "    FIXED: moved $($j.Name) out of mods - it stopped you joining the server" 'Green'; $log.Add("auto-fix moved $($j.Name)") } catch { }
    }
  }
}
Say ''
Say '  This will install:' 'White'
foreach ($f in $D.shaders) { Say "    - shader: $($f.name)" }
foreach ($f in $D.resourcepacks) { Say "    - texture pack: $($f.name)" }
if ($D.fabric) { Say "    - Fabric $($D.fabric.loader) for Minecraft $($D.version)" }
foreach ($m in $D.mods) { Say "    - mod: $($m.filename)" }
if ($D.shaders.Count -gt 0 -and -not ($D.mods | Where-Object { $_.slug -eq 'iris' })) { Say '    (no shader mod included - you will need OptiFine/Iris yourself)' 'Yellow' }
if (@($D.shaders) + @($D.resourcepacks) + @($D.mods) | Where-Object { $_.local -and -not $_.url }) {
  if (-not (Test-Path -LiteralPath (Join-Path $Here 'files'))) { Say ''; Say '  This installer came in a .zip - extract the whole zip first (right-click > Extract All), then run the .bat inside.' 'Red'; return }
}
Say ''
Say '  Close Minecraft first if it is open.' 'Yellow'
Read-Host '  Press Enter to install (or close this window to cancel)' | Out-Null
function Test-TLauncherOpen {
  try { return [bool](Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.CommandLine -match 'tlauncher' -and $_.ProcessId -ne $PID -and $_.CommandLine -notmatch [regex]::Escape([string]$env:BH_SELF) }) } catch { return $false }
}
while (Test-TLauncherOpen) {
  Say '  TLauncher is open - please close it completely (it would undo the settings), then press Enter.' 'Yellow'
  Read-Host '  ' | Out-Null
}
$log.Add("Installer for $($D.serverName) / Minecraft $($D.version) - $(Get-Date)")
$log.Add("Game folder: $mc")

try {
  $sp = Join-Path $mc 'shaderpacks'; $rp = Join-Path $mc 'resourcepacks'
  New-Item -ItemType Directory -Force -Path $sp, $rp | Out-Null

  foreach ($f in $D.shaders) { Say "  Downloading shader $($f.name)..." 'Cyan'; Get-Item2 $f 'shaderpacks' (Join-Path $sp $f.name); Log "OK shader -> $sp\$($f.name)" }
  foreach ($f in $D.resourcepacks) { Say "  Downloading texture pack $($f.name)..." 'Cyan'; Get-Item2 $f 'resourcepacks' (Join-Path $rp $f.name); Log "OK texture pack -> $rp\$($f.name)" }

  # Turn the texture packs on in options.txt
  $opt = Join-Path $mc 'options.txt'
  if ($D.resourcepacks.Count -gt 0 -and (Test-Path $opt)) {
    $lines = @(Get-Content -LiteralPath $opt)
    $i = [Array]::FindIndex([string[]]$lines, [Predicate[string]]{ param($l) $l -like 'resourcePacks:*' })
    $raw = ''; if ($i -ge 0) { $raw = $lines[$i].Substring(14) }
    # parse by hand: Windows PowerShell 5.1's ConvertTo/From-Json mangle nested arrays into {"value":[..],"Count":n}
    # (which makes Minecraft throw away the whole options.txt). This also repairs a line broken that way.
    $packs = @(foreach ($mm in [regex]::Matches($raw, '"((?:[^"\\]|\\.)*)"')) { if ($raw.Substring($mm.Index + $mm.Length).TrimStart() -notmatch '^:') { $mm.Groups[1].Value -replace '\\(.)', '$1' } })
    if ($packs.Count -eq 0) { $packs = @('vanilla') }
    foreach ($f in $D.resourcepacks) { $id = "file/$($f.name)"; if ($packs -notcontains $id) { $packs += $id } }
    $newLine = 'resourcePacks:[' + ((@($packs | Select-Object -Unique) | ForEach-Object { '"' + ($_ -replace '\\', '\\' -replace '"', '\"') + '"' }) -join ',') + ']'
    if ($i -ge 0) { $lines[$i] = $newLine } else { $lines += $newLine }
    [IO.File]::WriteAllLines($opt, [string[]]$lines)   # UTF-8 without BOM (Minecraft dislikes a BOM)
    Log 'OK texture packs switched on in options.txt'
  }

  if ($D.fabric) {
    Say "  Installing Fabric $($D.fabric.loader) for $($D.version)..." 'Cyan'
    $vid = $D.fabric.id
    $vdir = Join-Path $mc "versions\$vid"
    New-Item -ItemType Directory -Force -Path $vdir | Out-Null
    Invoke-WebRequest -Uri $D.fabric.profileUrl -OutFile (Join-Path $vdir "$vid.json") -UseBasicParsing
    Log "OK Fabric version -> versions\$vid"
    $mods = Join-Path $mc 'mods'
    New-Item -ItemType Directory -Force -Path $mods | Out-Null
    # Move older copies of the same mods aside (two versions of one mod stop Fabric from starting)
    $old = Join-Path $mods '_old-before-blockhost'
    foreach ($m in $D.mods) {
      if ($m.slug) { Get-ChildItem -LiteralPath $mods -Filter "$($m.slug)*.jar" -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $m.filename } | ForEach-Object {
        New-Item -ItemType Directory -Force -Path $old | Out-Null; Move-Item -LiteralPath $_.FullName -Destination $old -Force; Log "moved old $($_.Name) to mods\_old-before-blockhost" } }
      Say "  Installing mod $($m.filename)..." 'Cyan'
      Get-Item2 ([pscustomobject]@{ name = $m.filename; url = $m.url; sha1 = $m.sha1; local = $m.local }) 'mods' (Join-Path $mods $m.filename)
      Log "OK mod -> mods\$($m.filename)"
    }
    # Pre-select the first shader and switch shaders on
    if ($D.shaders.Count -gt 0) {
      $cfg = Join-Path $mc 'config'; New-Item -ItemType Directory -Force -Path $cfg | Out-Null
      $ip = Join-Path $cfg 'iris.properties'
      $kv = [ordered]@{}
      if (Test-Path $ip) { foreach ($l in Get-Content -LiteralPath $ip) { if ($l -match '^([^#=]+)=(.*)$') { $kv[$Matches[1]] = $Matches[2] } } }
      $kv['shaderPack'] = $D.shaders[0].name
      $kv['enableShaders'] = 'true'
      Set-Content -LiteralPath $ip -Value ($kv.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -Encoding ASCII
      Log "OK shader '$($D.shaders[0].name)' pre-selected in config\iris.properties"
    }
  }

  # --- TLauncher: pre-select the Fabric version and show modified versions -----------------------------
  if ($D.fabric) {
    $tlDir = Join-Path $env:APPDATA '.tlauncher'
    $tp = Join-Path $tlDir 'tlauncher-2.0.properties'
    if (Test-Path $tp) {
      Copy-Item -LiteralPath $tp -Destination "$tp.blockhost-backup" -Force
      $lines = @(Get-Content -LiteralPath $tp)
      $want = [ordered]@{ 'login.version.game' = $D.fabric.id; 'minecraft.versions.modified' = 'true' }
      foreach ($k in @($want.Keys)) {
        $i = [Array]::FindIndex([string[]]$lines, [Predicate[string]]{ param($l) $l -like "$k=*" })
        if ($i -ge 0) { $lines[$i] = "$k=$($want[$k])" } else { $lines += "$k=$($want[$k])" }
      }
      [IO.File]::WriteAllLines($tp, [string[]]$lines)
      Log "OK TLauncher will open with '$($D.fabric.id)' selected"
    } else { Log 'NOTE TLauncher settings not found - pick the Fabric version yourself' }
  }

  # --- Add the server to the Multiplayer list (and auto-accept its texture pack) ------------------------
  if ($D.address) {
    function NbtStr([string]$s) { $b = [Text.Encoding]::UTF8.GetBytes($s); $l = [BitConverter]::GetBytes([uint16]$b.Length); [Array]::Reverse($l); return ,($l + $b) }
    function NbtTagStr([string]$n, [string]$v) { return ,([byte[]](8) + (NbtStr $n) + (NbtStr $v)) }
    $entry = [byte[]]@() + (NbtTagStr 'name' $D.serverName) + (NbtTagStr 'ip' $D.address) + [byte[]](1) + (NbtStr 'acceptTextures') + [byte[]](1) + [byte[]](0)
    $sd = Join-Path $mc 'servers.dat'
    $head = [byte[]](10, 0, 0, 9) + (NbtStr 'servers') + [byte[]](10)
    $done = $false
    if (Test-Path $sd) {
      $bytes = [IO.File]::ReadAllBytes($sd)
      $text = [Text.Encoding]::UTF8.GetString($bytes)
      if ($text.Contains($D.address)) { Log 'OK server already in your Multiplayer list'; $done = $true }
      else {
        $okHead = $bytes.Length -ge ($head.Length + 5) -and $bytes[$bytes.Length - 1] -eq 0
        for ($i = 0; $okHead -and $i -lt $head.Length; $i++) { if ($bytes[$i] -ne $head[$i]) { $okHead = $false } }
        if ($okHead) {
          Copy-Item -LiteralPath $sd -Destination "$sd.blockhost-backup" -Force
          $cnt = [byte[]]$bytes[$head.Length..($head.Length + 3)]; [Array]::Reverse($cnt); $n = [BitConverter]::ToInt32($cnt, 0) + 1
          $nb = [BitConverter]::GetBytes([int32]$n); [Array]::Reverse($nb)
          $out = [byte[]]@() + $bytes[0..($head.Length - 1)] + $nb + $bytes[($head.Length + 4)..($bytes.Length - 2)] + $entry + [byte[]](0)
          [IO.File]::WriteAllBytes($sd, [byte[]]$out); Log 'OK server added to your Multiplayer list'; $done = $true
        }
      }
    } else {
      $one = [BitConverter]::GetBytes([int32]1); [Array]::Reverse($one)
      [IO.File]::WriteAllBytes($sd, [byte[]]([byte[]]@() + $head + $one + $entry + [byte[]](0))); Log 'OK server added to your Multiplayer list'; $done = $true
    }
    if (-not $done) { Log 'NOTE could not add the server automatically - add it in Multiplayer' }
  }

  # Final check
  Say ''
  $bad = 0
  foreach ($f in $D.shaders) { if (-not (Test-Path (Join-Path $sp $f.name))) { $bad++; Log "MISSING shader $($f.name)" } }
  if ($D.fabric) { foreach ($m in $D.mods) { if (-not (Test-Path (Join-Path $mc "mods\$($m.filename)"))) { $bad++; Log "MISSING mod $($m.filename)" } } }
  if (-not (Test-Path (Join-Path $mc "versions\$($D.version)"))) { Log "NOTE vanilla $($D.version) not downloaded yet - start it once in TLauncher before the Fabric version." }

  if ($D.address) { try { Set-Clipboard -Value $D.address; $copied = $true } catch { $copied = $false } }
  if ($bad -eq 0) { Say '  All done!' 'Green' } else { Say "  Finished with $bad problem(s) - see the log on your Desktop." 'Yellow' }
  Say ''
  if ($D.fabric) {
    Say "  1. Open TLauncher - '$($D.fabric.id)' is already selected. Just press Play." 'White'
    Say '     Not in the list? Restart TLauncher. Or install TLauncher''s own Fabric for this version - the mods folder is shared.' 'Gray'
  } else { Say "  1. In TLauncher pick an OptiFine build of $($D.version) to use the shaders." 'White' }
  if ($D.address) { Say "  2. Multiplayer: '$($D.serverName)' is already in your server list - just join." 'White' }
  else { Say '  2. Multiplayer > Add Server > use the address your host gave you.' 'White' }
  Say '  3. In game: Options > Video Settings > Shader Packs - the shader should already be on.' 'White'
} catch {
  Say ''
  Say "  Something went wrong: $($_.Exception.Message)" 'Red'
  $log.Add("ERROR: $($_.Exception.Message)")
  Say '  Check your internet connection and run this file again.' 'Yellow'
}
$tl = @((Join-Path $mc 'TLauncher.exe'), (Join-Path $env:APPDATA '.minecraft\TLauncher.exe'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'TLauncher.lnk')) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($tl) {
  Say ''
  Read-Host '  Press Enter to open TLauncher now (Fabric is already selected - just press Play)' | Out-Null
  try { Start-Process -FilePath $tl } catch { }
}
try {
  $lp = Join-Path ([Environment]::GetFolderPath('Desktop')) 'minecraft-pack-install-log.txt'
  [IO.File]::WriteAllLines($lp, [string[]]$log)
  Say ''
  Say "  Log saved to: $lp  (send it to the host if something is wrong)" 'DarkGray'
} catch { }
`;
  return bat.replace('__DATA__', data).replace('__NAME__', String(d.serverName).replace(/[^\w .\-]/g, '')).replace('__VER__', String(d.version).replace(/[^\w.\-]/g, ''))
    .replace(/\r?\n/g, '\r\n');
}

module.exports = { buildInstaller };
