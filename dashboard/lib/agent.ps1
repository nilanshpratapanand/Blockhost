#AGENT_START
# =====================================================================================================
#  Blockhost Sync agent - keeps this PC's Minecraft packs / shaders / mods in sync with the host.
#  Runs hidden in the background (tray icon), checks the host every ~45 s.
#  * Only installs what the host's SIGNED list says (RSA signature checked with the host key saved at
#    install time) and every file is SHA-1 checked.
#  * Never touches files it did not install itself (your own mods stay as they are).
#  * While Minecraft is running it only downloads; files are swapped in when the game is closed, or
#    after a restart if the host asks for one.
#  Remove it any time: tray icon > Uninstall (or delete "Blockhost Sync" from the Startup folder).
# =====================================================================================================
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
$AgentVersion = 4
$Mode = 'agent'
if ($env:BH_MODE) { $Mode = $env:BH_MODE } elseif ($args.Count -gt 0) { $Mode = [string]$args[0] }
$env:BH_MODE = $null
$IsWin = ($env:OS -eq 'Windows_NT')
$NoGui = [bool]$env:BH_NOGUI -or -not $IsWin
$AppData = $env:APPDATA; if ($env:BH_APPDATA) { $AppData = $env:BH_APPDATA }
$Local = $env:LOCALAPPDATA; if ($env:BH_LOCALAPPDATA) { $Local = $env:BH_LOCALAPPDATA }
$Root = Join-Path $Local 'BlockhostSync'
$CfgFile = Join-Path $Root 'agent.json'
$StateFile = Join-Path $Root 'state.json'
$LogFile = Join-Path $Root 'sync.log'
$Staging = Join-Path $Root 'staging'
$HostDir = Join-Path $Root 'host'
$script:Tray = $null
$script:Busy = $false
$script:Status = 'Starting...'
$script:LastError = ''
$script:Pending = 0
$script:SrvAt = [datetime]::MinValue
$script:InSrv = $false
$script:Via = ''

function Say($m, $c = 'Gray') { if ($Mode -ne 'agent' -or $NoGui) { Write-Host "  $m" -ForegroundColor $c } }
function Log($m) {
  try {
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item -LiteralPath $LogFile -Destination "$LogFile.old" -Force }
    Add-Content -LiteralPath $LogFile -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $m)
  } catch { }
}
function Read-Json($p, $default) { if (Test-Path -LiteralPath $p) { try { return (Get-Content -LiteralPath $p -Raw | ConvertFrom-Json) } catch { } } return $default }
function Write-Json($p, $o) { New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null; [IO.File]::WriteAllText($p, ($o | ConvertTo-Json -Depth 8)) }
function Sha1($p) { return (Get-FileHash -LiteralPath $p -Algorithm SHA1).Hash.ToLower() }
function Prop($o, $n, $d = $null) { if ($o -and ($o.PSObject.Properties.Name -contains $n) -and $null -ne $o.$n) { return $o.$n } return $d }

# ----------------------------------------------------------------------------------- notifications / prompts
function Notify($title, $text) {
  Log "NOTE $title - $text"
  if ($script:Tray) { $script:Tray.BalloonTipTitle = $title; $script:Tray.BalloonTipText = $text; $script:Tray.ShowBalloonTip(8000) }
  else { Say "$title - $text" 'Cyan' }
}
function Ask($title, $text) {
  if ($NoGui) { Say "$title - $text  [auto: $($env:BH_ANSWER)]" 'Yellow'; return ($env:BH_ANSWER -eq 'yes') }
  $owner = New-Object Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; WindowState = 'Minimized' }
  $r = [Windows.Forms.MessageBox]::Show($owner, $text, $title, 'YesNo', 'Question')
  $owner.Dispose()
  return ($r -eq 'Yes')
}
function Countdown($title, $text, [int]$secs) {
  if ($NoGui) { Say "$title - $text (countdown $secs s skipped in test mode)" 'Yellow'; return }
  $f = New-Object Windows.Forms.Form -Property @{ Text = $title; TopMost = $true; Width = 440; Height = 190; StartPosition = 'CenterScreen'; FormBorderStyle = 'FixedDialog'; MaximizeBox = $false; MinimizeBox = $false; ControlBox = $false }
  $l = New-Object Windows.Forms.Label -Property @{ Left = 16; Top = 14; Width = 400; Height = 70; Font = (New-Object Drawing.Font('Segoe UI', 10)) }
  $b = New-Object Windows.Forms.Button -Property @{ Text = 'Restart now'; Left = 290; Top = 100; Width = 120; Height = 32 }
  $f.Controls.Add($l); $f.Controls.Add($b)
  $st = @{ left = $secs }
  $l.Text = "$text`r`n`r`nMinecraft restarts in $($st.left) s."
  $t = New-Object Windows.Forms.Timer -Property @{ Interval = 1000 }
  $t.add_Tick({ $st.left--; $l.Text = "$text`r`n`r`nMinecraft restarts in $($st.left) s."; if ($st.left -le 0) { $t.Stop(); $f.Close() } }.GetNewClosure())
  $b.add_Click({ $t.Stop(); $f.Close() }.GetNewClosure())
  $t.Start(); [void]$f.ShowDialog(); $t.Dispose(); $f.Dispose()
}

# ----------------------------------------------------------------------------------- config / http / signature
$Cfg = Read-Json $CfgFile $null
function Test-Sig([byte[]]$data, [byte[]]$sig) {
  $p = New-Object Security.Cryptography.RSAParameters
  $p.Modulus = [Convert]::FromBase64String($Cfg.pub.n)
  $p.Exponent = [Convert]::FromBase64String($Cfg.pub.e)
  $rsa = $null
  try { $rsa = New-Object Security.Cryptography.RSACng } catch { $rsa = [Security.Cryptography.RSA]::Create() }
  $rsa.ImportParameters($p)
  return $rsa.VerifyData($data, $sig, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
}
# ----------------------------------------------------------------------------------- transports
# playit's free "Minecraft Java" tunnel only lets Minecraft-protocol traffic through, so besides plain web
# requests the helper can (a) wrap HTTP behind a Minecraft handshake, or (b) fetch data in server-list "status"
# replies (100% Minecraft protocol). It tries them in order and remembers what worked last time.
$MAGIC_HTTP = 0x0B10C7
$MAGIC_FRAMED = 0x0B20000
function VarInt([long]$n) { $o = New-Object System.Collections.Generic.List[byte]; $u = [uint32]$n; do { $b = [byte]($u -band 0x7f); $u = $u -shr 7; if ($u -ne 0) { $b = [byte]($b -bor 0x80) }; $o.Add($b) } while ($u -ne 0); return , $o.ToArray() }
function McString([string]$t) { $b = [Text.Encoding]::UTF8.GetBytes($t); return , ([byte[]]((VarInt $b.Length) + $b)) }
function McPacket([int]$id, [byte[]]$body) { $p = [byte[]]((VarInt $id) + $body); return , ([byte[]]((VarInt $p.Length) + $p)) }
function McHandshake([long]$proto, [string]$h, [int]$port) { $pb = [byte[]]@((($port -shr 8) -band 0xff), ($port -band 0xff)); return , (McPacket 0 ([byte[]]((VarInt $proto) + (McString $h) + $pb + (VarInt 1)))) }
function Open-Mc($t) {
  $c = New-Object Net.Sockets.TcpClient
  $iar = $c.BeginConnect($t.host, [int]$t.port, $null, $null)
  if (-not $iar.AsyncWaitHandle.WaitOne(8000)) { $c.Close(); throw "connect timeout $($t.host):$($t.port)" }
  $c.EndConnect($iar); $c.NoDelay = $true
  $st = $c.GetStream(); $st.ReadTimeout = 25000; $st.WriteTimeout = 25000
  return @{ client = $c; stream = $st }
}
function Read-Exact($st, [int]$n) { $buf = New-Object byte[] $n; $o = 0; while ($o -lt $n) { $r = $st.Read($buf, $o, $n - $o); if ($r -le 0) { throw 'connection closed' }; $o += $r }; return , $buf }
function Read-VarIntS($st) { $v = 0; $sh = 0; do { $b = $st.ReadByte(); if ($b -lt 0) { throw 'connection closed' }; $v = $v -bor (($b -band 0x7f) -shl $sh); $sh += 7 } while ($b -band 0x80); return $v }
function Get-McTargets {
  $l = @()
  $mc = Prop $Cfg 'mc'
  if ($mc -and (Prop $mc 'host')) { $l += , @{ host = $mc.host; port = [int]$mc.port } }
  $h = Prop $Cfg 'mcHost'
  if ($h -and -not ($l | Where-Object { $_.host -eq $h -and $_.port -eq 25565 })) { $l += , @{ host = $h; port = 25565 } }
  return $l
}
function Invoke-McHttp($t, $path, $method, [byte[]]$bodyBytes, $outFile) {
  $m = Open-Mc $t
  try {
    $hdr = "$method $path HTTP/1.0`r`nHost: blockhost`r`nConnection: close`r`nX-BH-Token: $($Cfg.token)`r`nUser-Agent: blockhost-sync/$AgentVersion`r`n"
    if ($bodyBytes) { $hdr += "Content-Type: application/json`r`nContent-Length: $($bodyBytes.Length)`r`n" }
    $req = [byte[]]((McHandshake $MAGIC_HTTP $t.host $t.port) + [Text.Encoding]::ASCII.GetBytes($hdr + "`r`n"))
    if ($bodyBytes) { $req = [byte[]]($req + $bodyBytes) }
    $m.stream.Write($req, 0, $req.Length)
    $ms = New-Object IO.MemoryStream; $m.stream.CopyTo($ms); $all = $ms.ToArray()
  } finally { $m.client.Close() }
  $sep = -1; for ($i = 0; $i -lt $all.Length - 3; $i++) { if ($all[$i] -eq 13 -and $all[$i + 1] -eq 10 -and $all[$i + 2] -eq 13 -and $all[$i + 3] -eq 10) { $sep = $i; break } }
  if ($sep -lt 0) { throw 'no reply (tunnel blocked it?)' }
  $head = [Text.Encoding]::ASCII.GetString($all, 0, $sep)
  if ($head -notmatch '^HTTP/\d\.\d 200') { throw "HTTP $(($head -split "`r`n")[0])" }
  $body = New-Object byte[] ($all.Length - $sep - 4); [Array]::Copy($all, $sep + 4, $body, 0, $body.Length)
  if ($outFile) { [IO.File]::WriteAllBytes($outFile, $body); return $true }
  return [Text.Encoding]::UTF8.GetString($body)
}
function Get-McFramedChunk($t, [int]$resId, [int]$chunk) {
  $m = Open-Mc $t
  try {
    $req = [byte[]]((McHandshake ($MAGIC_FRAMED + $resId) $t.host $chunk) + (McPacket 0 ([byte[]]@())))
    $m.stream.Write($req, 0, $req.Length)
    $len = Read-VarIntS $m.stream
    $pkt = Read-Exact $m.stream $len
    $ping = McPacket 1 ([byte[]](0, 0, 0, 0, 0, 0, 0, 0)); try { $m.stream.Write($ping, 0, $ping.Length) } catch { }
  } finally { $m.client.Close() }
  # packet: id varint (0), string length varint, utf8 json
  $o = 1; $sl = 0; $sh = 0; do { $b = $pkt[$o]; $o++; $sl = $sl -bor (($b -band 0x7f) -shl $sh); $sh += 7 } while ($b -band 0x80)
  $j = [Text.Encoding]::UTF8.GetString($pkt, $o, $sl) | ConvertFrom-Json
  if (-not $j.bh -or (Prop $j.bh 'error')) { throw 'not a Blockhost server' }
  return $j.bh
}
function Invoke-McFramed($t, [int]$resId, $outFile) {
  $first = Get-McFramedChunk $t $resId 0
  $ms = New-Object IO.MemoryStream
  $b = [Convert]::FromBase64String($first.d); $ms.Write($b, 0, $b.Length)
  for ($c = 1; $c -lt [int]$first.t; $c++) { $b = [Convert]::FromBase64String((Get-McFramedChunk $t $resId $c).d); $ms.Write($b, 0, $b.Length) }
  $all = $ms.ToArray()
  if ($all.Length -ne [int]$first.n) { throw 'incomplete download' }
  if ($outFile) { [IO.File]::WriteAllBytes($outFile, $all); return $true }
  return [Text.Encoding]::UTF8.GetString($all)
}

function Invoke-Host($path, $method = 'GET', $body = $null, $outFile = $null, $resId = $null) {
  if ($null -eq $resId) { if ($path -eq '/m') { $resId = 0 } elseif ($path -eq '/agent') { $resId = 1 } }
  $bodyBytes = $null; if ($body) { $bodyBytes = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress)) }
  $tries = New-Object System.Collections.Generic.List[object]
  foreach ($u in @($Cfg.urls)) { if ($u) { $tries.Add(@{ kind = 'web'; url = $u }) } }
  foreach ($t in (Get-McTargets)) { $tries.Add(@{ kind = 'wrapped'; t = $t }) }
  if ($method -eq 'GET' -and $null -ne $resId) { foreach ($t in (Get-McTargets)) { $tries.Add(@{ kind = 'framed'; t = $t }) } }
  # what worked last time goes first
  $ordered = @($tries | Where-Object { $_.kind -eq $script:Via }) + @($tries | Where-Object { $_.kind -ne $script:Via })
  $err = $null
  foreach ($x in $ordered) {
    try {
      $r = $null
      if ($x.kind -eq 'web') {
        $a = @{ Uri = ($x.url.TrimEnd('/') + $path); Method = $method; UseBasicParsing = $true; TimeoutSec = 25; Headers = @{ 'X-BH-Token' = $Cfg.token; 'User-Agent' = "blockhost-sync/$AgentVersion" } }
        if ($bodyBytes) { $a.Body = $bodyBytes; $a.ContentType = 'application/json' }
        if ($outFile) { $a.OutFile = $outFile; Invoke-WebRequest @a; $r = $true }
        else { $w = Invoke-WebRequest @a; if ($w.Content -is [byte[]]) { $r = [Text.Encoding]::UTF8.GetString($w.Content) } else { $r = [string]$w.Content } }
      } elseif ($x.kind -eq 'wrapped') { $r = Invoke-McHttp $x.t $path $method $bodyBytes $outFile }
      else { $r = Invoke-McFramed $x.t $resId $outFile }
      if ($script:Via -ne $x.kind) { Log "connected via $($x.kind)" }
      $script:Via = $x.kind
      return $r
    } catch { $err = (@($err, "$($x.kind) $(if ($x.t) { "$($x.t.host):$($x.t.port)" } else { $x.url }): $($_.Exception.Message)") | Where-Object { $_ }) -join ' | ' }
  }
  # The playit port of the Minecraft tunnel can change: look it up again (SRV record), at most every 10 min
  if ((Prop $Cfg 'mcHost') -and -not $script:InSrv -and ((Get-Date) - $script:SrvAt).TotalMinutes -ge 10) {
    $script:SrvAt = Get-Date; $script:InSrv = $true
    try {
      $r = $null
      if (Get-Command Resolve-DnsName -ErrorAction SilentlyContinue) {
        foreach ($srv in @($null, '1.1.1.1', '8.8.8.8')) {
          try {
            $q = @{ Name = ('_minecraft._tcp.' + $Cfg.mcHost); Type = 'SRV'; ErrorAction = 'Stop'; DnsOnly = $true }
            if ($srv) { $q.Server = $srv }
            $r = Resolve-DnsName @q | Where-Object { $_.Port } | Select-Object -First 1
            if ($r) { break }
          } catch { }
        }
      }
      if ($r) {
        $h = $Cfg.mcHost; if ($r.NameTarget) { $h = $r.NameTarget.TrimEnd('.') }
        $mcOld = Prop $Cfg 'mc'
        if (-not $mcOld -or $mcOld.host -ne $h -or [int]$mcOld.port -ne [int]$r.Port) {
          $Cfg | Add-Member -NotePropertyName mc -NotePropertyValue ([pscustomobject]@{ host = $h; port = [int]$r.Port }) -Force
          Write-Json $CfgFile $Cfg; Log "host address re-discovered: ${h}:$($r.Port)"
          return (Invoke-Host $path $method $body $outFile $resId)
        }
      }
    } catch { } finally { $script:InSrv = $false }
  }
  throw "Host not reachable ($err)"
}
function Get-Signed($path) {
  $e = (Invoke-Host $path) | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String($e.payload)
  if (-not (Test-Sig $bytes ([Convert]::FromBase64String($e.sig)))) { throw 'Signature check failed - ignoring this update (it did not come from your host).' }
  return [Text.Encoding]::UTF8.GetString($bytes)
}

# ----------------------------------------------------------------------------------- Minecraft / TLauncher
function Find-GameDir {
  $mc = Join-Path $AppData '.minecraft'
  foreach ($tp in @((Join-Path $AppData '.tlauncher\tlauncher-2.0.properties'), (Join-Path $AppData '.tlauncher\tlauncher.properties'))) {
    if (Test-Path $tp) { foreach ($l in Get-Content -LiteralPath $tp) { if ($l -match '^\s*minecraft\.gamedir\s*=\s*(.+)$') { $g = $Matches[1].Trim() -replace '\\:', ':' -replace '\\\\', '\'; if ($g -and (Test-Path $g)) { $mc = $g } } } }
  }
  return $mc
}
$GameRx = 'KnotClient|net\.minecraft\.client\.main\.Main|--gameDir|--assetsDir'
function Get-GameProcs {
  if ($env:BH_TEST_GAME) { if (Test-Path $env:BH_TEST_GAME) { return @([pscustomobject]@{ ProcessId = -1 }) } return @() }
  if (-not $IsWin) { return @() }
  # cheap pre-check: no Java running = no game
  if (-not (Get-Process -Name javaw, java -ErrorAction SilentlyContinue)) { return @() }
  try { return @(Get-CimInstance Win32_Process -Filter "Name='javaw.exe' OR Name='java.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -match $GameRx }) } catch { return @() }
}
function Test-TLauncherOpen {
  if ($env:BH_TEST_TL) { return (Test-Path $env:BH_TEST_TL) }
  if (-not $IsWin) { return $false }
  try { return [bool](Get-CimInstance Win32_Process -Filter "Name='TLauncher.exe' OR Name='javaw.exe' OR Name='java.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -match 'tlauncher' -and $_.CommandLine -notmatch $GameRx -and $_.ProcessId -ne $PID }) } catch { return $false }
}
function Find-TLauncher {
  $mc = Find-GameDir
  $c = @((Join-Path $mc 'TLauncher.exe'), (Join-Path $AppData '.minecraft\TLauncher.exe'))
  try { $desk = [Environment]::GetFolderPath('Desktop'); if ($desk) { $c += (Join-Path $desk 'TLauncher.lnk') } } catch { }
  return ($c | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}
function Get-PlayerName {
  $ll = Join-Path (Find-GameDir) 'logs\latest.log'
  if (Test-Path $ll) { try { $m = Select-String -LiteralPath $ll -Pattern 'Setting user: (\S+)' | Select-Object -First 1; if ($m) { return $m.Matches[0].Groups[1].Value } } catch { } }
  return $env:USERNAME
}
# Reads the friend's last game log for a join failure, so the host sees it on the Live Sync page
function Get-JoinError {
  $ll = Join-Path (Find-GameDir) 'logs\latest.log'
  if (-not (Test-Path $ll)) { return '' }
  try {
    $m = Select-String -LiteralPath $ll -Pattern 'Missing element ResourceKey|Failed to decode packet|Failed to handle packet|Error receiving packet|Unknown custom packet identifier|Network Protocol Error' | Sort-Object { if ($_.Line -match 'Missing element') { 0 } else { 1 } } | Select-Object -First 1
    if ($m) { $t = ($m.Line -replace '^.*?\]: ?', ''); if ($t.Length -gt 120) { $t = $t.Substring(0, 120) }; return "Last join: $t" }
  } catch { }
  return ''
}
# If the last join failed with a Network Protocol Error caused by a content mod (e.g. Biomes O' Plenty on a vanilla
# server), move that mod (and libraries that exist only for it) to mods\_disabled-by-blockhost. Once per game log.
function Get-ModId($jar) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $z = [IO.Compression.ZipFile]::OpenRead($jar)
    try { $e = $z.GetEntry('fabric.mod.json'); if ($e) { $r = New-Object IO.StreamReader($e.Open()); $j = $r.ReadToEnd(); $r.Close(); return ($j | ConvertFrom-Json).id } } finally { $z.Dispose() }
  } catch { }
  return ([IO.Path]::GetFileNameWithoutExtension($jar).ToLower() -replace '[-_].*$', '')
}
function Repair-JoinErrors($S) {
  $mc = Find-GameDir
  $ll = Join-Path $mc 'logs\latest.log'
  if (-not (Test-Path $ll)) { return '' }
  $stamp = [string](Get-Item $ll).LastWriteTimeUtc.Ticks
  if ((Prop $S 'repairStamp') -eq $stamp) { return '' }
  $S | Add-Member -NotePropertyName repairStamp -NotePropertyValue $stamp -Force
  $txt = Get-Content -LiteralPath $ll -Raw -ErrorAction SilentlyContinue
  if (-not $txt -or $txt -notmatch 'Network Protocol Error|Failed to load registries|Missing element ResourceKey') { return '' }
  $ids = @([regex]::Matches($txt, 'Missing element ResourceKey\[[\w:/]+ / ([a-z0-9_.\-]+):') | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -ne 'minecraft' })
  if ($txt -match 'Failed to load registries|Unbound tags in registry') { $ids += 'biomesoplenty', 'terrablender' }
  $companions = @{ biomesoplenty = @('terrablender', 'glitchcore'); terrablender = @('glitchcore') }
  $want = @{}; foreach ($i in $ids) { $want[$i] = 1; foreach ($c in @($companions[$i])) { if ($c) { $want[$c] = 1 } } }
  $owned = @($S.owned | Where-Object { $_ -and $_.folder -eq 'mods' } | ForEach-Object { $_.name })
  $moved = @()
  $md = Join-Path $mc 'mods'
  foreach ($j in @(Get-ChildItem -LiteralPath $md -Filter '*.jar' -ErrorAction SilentlyContinue)) {
    if ($owned -contains $j.Name) { continue }                     # never touch the host's own kit mods
    if (-not $want.ContainsKey((Get-ModId $j.FullName))) { continue }
    $dest = Join-Path $md '_disabled-by-blockhost'; New-Item -ItemType Directory -Force -Path $dest | Out-Null
    try { Move-Item -LiteralPath $j.FullName -Destination $dest -Force; $moved += $j.Name; Log "auto-fix: moved $($j.Name) out of mods (it broke joining the server)" } catch { Log "auto-fix: could not move $($j.Name): $($_.Exception.Message)" }
  }
  if ($moved.Count) { Notify 'Minecraft fixed' "These mods stopped you joining the server and were moved to mods\_disabled-by-blockhost: $($moved -join ', '). Start Minecraft and join again." ; return "auto-fixed: $($moved -join ', ')" }
  return ''
}

function Stop-Game {
  $procs = Get-GameProcs
  if (-not $procs) { return }
  Log 'Closing Minecraft for the update...'
  if ($env:BH_TEST_GAME) { Remove-Item -LiteralPath $env:BH_TEST_GAME -Force; return }
  foreach ($p in $procs) { try { [void](Get-Process -Id $p.ProcessId).CloseMainWindow() } catch { } }
  for ($i = 0; $i -lt 40 -and (Get-GameProcs); $i++) { Start-Sleep -Seconds 1; if ($script:Tray) { [Windows.Forms.Application]::DoEvents() } }
  foreach ($p in (Get-GameProcs)) { try { Stop-Process -Id $p.ProcessId -Force } catch { } }
  Start-Sleep -Seconds 2
}

# ----------------------------------------------------------------------------------- sync logic
function Load-State { $s = Read-Json $StateFile $null; if (-not $s) { $s = [pscustomobject]@{ rev = ''; owned = @(); rpEnabled = @(); shaderSet = ''; tlSet = ''; addrSet = ''; handled = '' } }; return $s }
function Save-State($s) { Write-Json $StateFile $s }
function Get-Dest($mc, $f) { return (Join-Path (Join-Path $mc $f.folder) $f.name) }

function Test-UpToDate($M, $S) {
  if ($M.rev -ne $S.rev) { return $false }
  $mc = Find-GameDir
  foreach ($f in @($M.files)) { if (-not (Test-Path -LiteralPath (Get-Dest $mc $f))) { return $false } }
  return $true
}

# Download everything that is missing/outdated into the staging folder (safe while the game runs)
function Stage-Files($M) {
  $mc = Find-GameDir
  $n = 0
  $idx = -1
  foreach ($f in @($M.files)) {
    $idx++
    $dest = Get-Dest $mc $f
    if ((Test-Path -LiteralPath $dest) -and (-not $f.sha1 -or (Sha1 $dest) -eq $f.sha1)) { continue }
    $st = Join-Path (Join-Path $Staging $f.folder) $f.name
    if ((Test-Path -LiteralPath $st) -and (-not $f.sha1 -or (Sha1 $st) -eq $f.sha1)) { $n++; continue }
    New-Item -ItemType Directory -Force -Path (Split-Path $st) | Out-Null
    $tmp = "$st.part"; $ok = $false; $err = ''
    $sources = @()
    if ($f.url) { $sources += , @('web', $f.url) }
    if ($f.mirror) { $sources += , @('host', ('/f/' + $f.folder + '/' + [Uri]::EscapeDataString($f.name))) }
    foreach ($src in $sources) {
      for ($try = 1; $try -le 2 -and -not $ok; $try++) {
        try {
          if ($src[0] -eq 'web') { Invoke-WebRequest -Uri $src[1] -OutFile $tmp -UseBasicParsing -TimeoutSec 120 -Headers @{ 'User-Agent' = "blockhost-sync/$AgentVersion" } }
          else { [void](Invoke-Host $src[1] 'GET' $null $tmp (100 + $idx)) }
          if ($f.sha1 -and (Sha1 $tmp) -ne $f.sha1) { throw 'checksum mismatch' }
          Move-Item -LiteralPath $tmp -Destination $st -Force; $ok = $true
          Log "downloaded $($f.folder)\$($f.name) from $($src[0])"
        } catch { $err = $_.Exception.Message; Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds $try }
      }
      if ($ok) { break }
    }
    if (-not $ok) { throw "Could not download $($f.name): $err" }
    $n++
  }
  return $n
}

function Set-OptionsPacks($mc, $add, $remove) {
  $opt = Join-Path $mc 'options.txt'
  if (-not (Test-Path $opt)) { return $false }
  $lines = @(Get-Content -LiteralPath $opt)
  $i = [Array]::FindIndex([string[]]$lines, [Predicate[string]]{ param($l) $l -like 'resourcePacks:*' })
  $raw = ''; if ($i -ge 0) { $raw = $lines[$i].Substring(14) }
  # parse by hand: Windows PowerShell 5.1's ConvertTo/From-Json mangle nested arrays into {"value":[..],"Count":n}
  # (which makes Minecraft throw away the whole options.txt). This also repairs a line broken that way.
  $packs = @(foreach ($mm in [regex]::Matches($raw, '"((?:[^"\\]|\\.)*)"')) { if ($raw.Substring($mm.Index + $mm.Length).TrimStart() -notmatch '^:') { $mm.Groups[1].Value -replace '\\(.)', '$1' } })
  if ($packs.Count -eq 0) { $packs = @('vanilla') }
  $packs = @($packs | Where-Object { $remove -notcontains $_ })
  foreach ($id in $add) { if ($packs -notcontains $id) { $packs += $id } }
  $newLine = 'resourcePacks:[' + ((@($packs | Select-Object -Unique) | ForEach-Object { '"' + ($_ -replace '\\', '\\' -replace '"', '\"') + '"' }) -join ',') + ']'
  if ($i -ge 0) { $lines[$i] = $newLine } else { $lines += $newLine }
  [IO.File]::WriteAllLines($opt, [string[]]$lines)
  return $true
}

# Older Blockhost versions could write resourcePacks:[{"value":[..],"Count":n}] (PowerShell 5.1 bug) - fix it
function Repair-Options($mc) {
  $opt = Join-Path $mc 'options.txt'
  if ((Test-Path $opt) -and (Select-String -LiteralPath $opt -Pattern '^resourcePacks:.*"value"' -Quiet)) { if (Set-OptionsPacks $mc @() @()) { Log 'repaired a broken resourcePacks line in options.txt' } }
}

function Set-TLauncher($id) {
  $tp = Join-Path $AppData '.tlauncher\tlauncher-2.0.properties'
  if (-not (Test-Path $tp)) { return $false }
  Copy-Item -LiteralPath $tp -Destination "$tp.blockhost-backup" -Force
  $lines = @(Get-Content -LiteralPath $tp)
  $want = [ordered]@{ 'login.version.game' = $id; 'minecraft.versions.modified' = 'true' }
  foreach ($k in @($want.Keys)) {
    $i = [Array]::FindIndex([string[]]$lines, [Predicate[string]]{ param($l) $l -like "$k=*" })
    if ($i -ge 0) { $lines[$i] = "$k=$($want[$k])" } else { $lines += "$k=$($want[$k])" }
  }
  [IO.File]::WriteAllLines($tp, [string[]]$lines)
  return $true
}

function Add-ServerEntry($mc, $name, $address) {
  function NbtStr([string]$s) { $b = [Text.Encoding]::UTF8.GetBytes($s); $l = [BitConverter]::GetBytes([uint16]$b.Length); [Array]::Reverse($l); return , ($l + $b) }
  function NbtTagStr([string]$n, [string]$v) { return , ([byte[]](8) + (NbtStr $n) + (NbtStr $v)) }
  $entry = [byte[]]@() + (NbtTagStr 'name' $name) + (NbtTagStr 'ip' $address) + [byte[]](1) + (NbtStr 'acceptTextures') + [byte[]](1) + [byte[]](0)
  $sd = Join-Path $mc 'servers.dat'
  $head = [byte[]](10, 0, 0, 9) + (NbtStr 'servers') + [byte[]](10)
  if (Test-Path $sd) {
    $bytes = [IO.File]::ReadAllBytes($sd)
    if ([Text.Encoding]::UTF8.GetString($bytes).Contains($address)) { return $true }
    $okHead = $bytes.Length -ge ($head.Length + 5) -and $bytes[$bytes.Length - 1] -eq 0
    for ($i = 0; $okHead -and $i -lt $head.Length; $i++) { if ($bytes[$i] -ne $head[$i]) { $okHead = $false } }
    if (-not $okHead) { return $false }
    Copy-Item -LiteralPath $sd -Destination "$sd.blockhost-backup" -Force
    $cnt = [byte[]]$bytes[$head.Length..($head.Length + 3)]; [Array]::Reverse($cnt); $n = [BitConverter]::ToInt32($cnt, 0) + 1
    $nb = [BitConverter]::GetBytes([int32]$n); [Array]::Reverse($nb)
    $out = [byte[]]@() + $bytes[0..($head.Length - 1)] + $nb + $bytes[($head.Length + 4)..($bytes.Length - 2)] + $entry + [byte[]](0)
    [IO.File]::WriteAllBytes($sd, [byte[]]$out); return $true
  }
  $one = [BitConverter]::GetBytes([int32]1); [Array]::Reverse($one)
  [IO.File]::WriteAllBytes($sd, [byte[]]([byte[]]@() + $head + $one + $entry + [byte[]](0))); return $true
}

# Swap staged files in (game must be closed), remove what the host removed, apply settings once per change
function Install-Staged($M, $S) {
  $mc = Find-GameDir
  if (-not (Test-Path $mc)) { throw "Minecraft folder not found ($mc). Start Minecraft once in TLauncher." }
  $changed = 0
  Repair-Options $mc
  $wantKeys = @($M.files | ForEach-Object { "$($_.folder)/$($_.name)" })
  $oldDir = Join-Path $mc 'mods\_old-before-blockhost'
  foreach ($f in @($M.files)) {
    $dest = Get-Dest $mc $f
    $st = Join-Path (Join-Path $Staging $f.folder) $f.name
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    if ($f.folder -eq 'mods' -and $f.slug) {
      Get-ChildItem -LiteralPath (Split-Path $dest) -Filter "$($f.slug)*.jar" -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $f.name -and $wantKeys -notcontains "mods/$($_.Name)" } | ForEach-Object {
        New-Item -ItemType Directory -Force -Path $oldDir | Out-Null; Move-Item -LiteralPath $_.FullName -Destination $oldDir -Force; Log "moved old $($_.Name) aside" }
    }
    if (Test-Path -LiteralPath $st) { Move-Item -LiteralPath $st -Destination $dest -Force; $changed++; Log "installed $($f.folder)\$($f.name)" }
  }
  # remove files we installed earlier that the host took out of the kit
  $removedPacks = @()
  foreach ($o in @($S.owned)) {
    if (-not $o) { continue }
    if ($wantKeys -contains "$($o.folder)/$($o.name)") { continue }
    $p = Join-Path (Join-Path $mc $o.folder) $o.name
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; $changed++; Log "removed $($o.folder)\$($o.name) (host removed it)" }
    if ($o.folder -eq 'resourcepacks') { $removedPacks += "file/$($o.name)" }
  }
  $rpNew = @($M.files | Where-Object { $_.folder -eq 'resourcepacks' -and @($S.rpEnabled) -notcontains $_.name } | ForEach-Object { "file/$($_.name)" })
  if ($rpNew.Count -or $removedPacks.Count) {
    if (Set-OptionsPacks $mc $rpNew $removedPacks) {
      $S.rpEnabled = @(@($S.rpEnabled | Where-Object { $removedPacks -notcontains "file/$_" }) + @($rpNew | ForEach-Object { $_.Substring(5) }) | Where-Object { $_ } | Select-Object -Unique)
      Log 'texture packs switched on/off in options.txt'
    }
  }
  if ($M.fabric) {
    $vdir = Join-Path $mc "versions\$($M.fabric.id)"
    $vjson = Join-Path $vdir "$($M.fabric.id).json"
    if (-not (Test-Path $vjson)) {
      New-Item -ItemType Directory -Force -Path $vdir | Out-Null
      Invoke-WebRequest -Uri $M.fabric.profileUrl -OutFile $vjson -UseBasicParsing -TimeoutSec 60
      Log "installed Fabric version $($M.fabric.id)"; $changed++
    }
    if ($S.tlSet -ne $M.fabric.id) {
      if (Test-TLauncherOpen) { Log 'TLauncher is open - will select the Fabric version once it is closed' }
      elseif (Set-TLauncher $M.fabric.id) { $S.tlSet = $M.fabric.id; Log "TLauncher: selected $($M.fabric.id)" }
    }
  }
  if ($M.shader -and $S.shaderSet -ne $M.shader -and $M.fabric) {
    $cfg = Join-Path $mc 'config'; New-Item -ItemType Directory -Force -Path $cfg | Out-Null
    $ip = Join-Path $cfg 'iris.properties'
    $kv = [ordered]@{}
    if (Test-Path $ip) { foreach ($l in Get-Content -LiteralPath $ip) { if ($l -match '^([^#=]+)=(.*)$') { $kv[$Matches[1]] = $Matches[2] } } }
    $kv['shaderPack'] = $M.shader; $kv['enableShaders'] = 'true'
    Set-Content -LiteralPath $ip -Value ($kv.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -Encoding ASCII
    $S.shaderSet = $M.shader; Log "shader '$($M.shader)' selected and switched on"
  }
  if ($M.address -and $S.addrSet -ne $M.address) { if (Add-ServerEntry $mc $M.serverName $M.address) { $S.addrSet = $M.address; Log 'server added to the Multiplayer list' } }
  $S.owned = @($M.files | ForEach-Object { [pscustomobject]@{ folder = $_.folder; name = $_.name } })
  $S.rev = $M.rev
  Save-State $S
  Remove-Item -LiteralPath $Staging -Recurse -Force -ErrorAction SilentlyContinue
  return $changed
}

function Start-TLauncher {
  $tl = Find-TLauncher
  if ($tl -and -not $env:BH_TEST_GAME) { try { Start-Process -FilePath $tl } catch { } }
}

function Send-Hello($state, $rev) {
  try {
    $id = ([BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes("$env:COMPUTERNAME|$env:USERNAME"))) -replace '-', '').Substring(0, 16).ToLower()
    [void](Invoke-Host '/hello' 'POST' @{ id = $id; name = (Get-PlayerName); pc = $env:COMPUTERNAME; rev = $rev; state = $state; game = [bool](Get-GameProcs); pending = $script:Pending; agent = $AgentVersion; error = $(if ($script:LastError) { $script:LastError } elseif ($script:LastFix) { $script:LastFix } else { Get-JoinError }) })
  } catch { }
}

function Update-Agent($M) {
  if ([int](Prop $M 'agentVersion' 0) -le $AgentVersion -or $Mode -ne 'agent') { return }
  try {
    $code = Get-Signed '/agent'
    [IO.File]::WriteAllText((Join-Path $Root 'agent.ps1'), $code)
    Log "agent updated to v$($M.agentVersion) - restarting"
    Restart-Agent
  } catch { Log "agent update failed: $($_.Exception.Message)" }
}
function Restart-Agent {
  if ($script:Mutex) { try { $script:Mutex.ReleaseMutex() } catch { } }
  Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'agent.ps1'), 'agent') -WindowStyle Hidden
  if ($script:Tray) { $script:Tray.Visible = $false }
  [Environment]::Exit(0)
}

# One sync round. Returns a short status text.
function Invoke-Sync([switch]$Force) {
  if ($script:Busy) { return $script:Status }
  $script:Busy = $true
  try {
    $M = (Get-Signed '/m') | ConvertFrom-Json
    # the host tells us its current addresses (signed): direct web URLs and the Minecraft address
    $nu = @(Prop $M 'urls' @()); $nm = Prop $M 'mc'
    $changed = (($nu -join ' ') -ne (@($Cfg.urls) -join ' '))
    if ($nm -and (-not (Prop $Cfg 'mc') -or $Cfg.mc.host -ne $nm.host -or [int]$Cfg.mc.port -ne [int]$nm.port)) { $Cfg | Add-Member -NotePropertyName mc -NotePropertyValue $nm -Force; $changed = $true }
    if ($changed) { $Cfg.urls = $nu; Write-Json $CfgFile $Cfg; Log "host addresses updated: $($nu -join ', ') $(if ($nm) { "$($nm.host):$($nm.port)" })" }
    Update-Agent $M
    $S = Load-State
    if (-not (Get-GameProcs)) { $before = Prop $S 'repairStamp'; $fix = Repair-JoinErrors $S; if ($fix) { $script:LastFix = $fix }; if ((Prop $S 'repairStamp') -ne $before) { Save-State $S } }
    if ($Force) { $S.rev = ''; $S.rpEnabled = @(); $S.shaderSet = ''; $S.tlSet = ''; $S.addrSet = '' }
    if (Test-UpToDate $M $S) {
      if (-not (Get-GameProcs)) { Repair-Options (Find-GameDir) }
      # finish a TLauncher selection that had to wait until TLauncher was closed
      if ($M.fabric -and $S.tlSet -ne $M.fabric.id -and -not (Test-TLauncherOpen) -and (Set-TLauncher $M.fabric.id)) { $S.tlSet = $M.fabric.id; Save-State $S; Log "TLauncher: selected $($M.fabric.id)" }
      $script:Pending = 0; $script:LastError = ''
      Send-Hello 'synced' $M.rev
      return ($script:Status = "Up to date - $(@($M.files).Count) files")
    }
    $script:Pending = Stage-Files $M
    $game = Get-GameProcs
    if (-not $game) {
      $n = Install-Staged $M $S
      $script:Pending = 0; $script:LastError = ''
      if ($n -gt 0 -or $Force) { Notify 'Minecraft updated' "Your packs are up to date with $($M.serverName) ($n change$(if ($n -ne 1) { 's' }))." }
      Send-Hello 'synced' $M.rev
      return ($script:Status = 'Up to date')
    }
    # Minecraft is running: files are downloaded and wait in staging
    $pol = $M.policy
    $msg = "$($M.serverName) has an update"; if ($pol.message) { $msg = "$msg`: $($pol.message)" }
    if ($S.handled -ne $pol.id) {
      $S.handled = $pol.id; Save-State $S
      if ($pol.mode -eq 'now') {
        Send-Hello 'restarting' $S.rev
        Countdown 'Minecraft update' "$msg.`r`nThe host asked everyone to restart to get it." 60
        Stop-Game; $n = Install-Staged $M $S; Start-TLauncher
        Notify 'Minecraft updated' 'TLauncher is opening - just press Play.'
        Send-Hello 'synced' $M.rev
        return ($script:Status = 'Up to date')
      }
      if ($pol.mode -eq 'ask' -and (Ask 'Minecraft update' "$msg.`r`n`r`nRestart Minecraft now to install it? (Your game is closed safely and TLauncher opens again.)")) {
        Stop-Game; $n = Install-Staged $M $S; Start-TLauncher
        Notify 'Minecraft updated' 'TLauncher is opening - just press Play.'
        Send-Hello 'synced' $M.rev
        return ($script:Status = 'Up to date')
      }
      Notify 'Update downloaded' "$msg. It installs automatically when you close Minecraft."
    }
    Send-Hello 'pending' $S.rev
    return ($script:Status = 'Update ready - installs when Minecraft closes')
  } catch {
    $script:LastError = $_.Exception.Message
    Log "ERROR $($script:LastError)"
    if ($script:LastError -notmatch 'not reachable') { Send-Hello 'error' '' }
    return ($script:Status = $(if ($script:LastError -match 'not reachable') { 'Host offline - will retry' } else { "Problem: $($script:LastError)" }))
  } finally { $script:Busy = $false }
}

# ----------------------------------------------------------------------------------- hosting (friends start the shared server from here)
# A small Node program (lib/player.js, shipped inside this file) pulls the newest world from the cloud, runs the server on THIS PC
# and opens the owner's shared address. This tray app starts it on demand and talks to it on 127.0.0.1.
$script:HS = $null
$script:LastPhase = ''
$script:LastReach = ''
$script:Win = $null
$script:AskedAt = [datetime]::MinValue
$script:GameWas = $false
function Test-HostMode { return [bool](Prop $Cfg 'hostMode' $false) }
function Ensure-Node {
  $nodeDir = Join-Path $HostDir 'node'; $exe = Join-Path $nodeDir 'node.exe'
  if (Test-Path -LiteralPath $exe) { return $true }
  $tmp = Join-Path $HostDir 'node-unpack'
  try {
    Say 'Downloading Node.js, the engine that runs the server helper (about 30 MB, first time only)...' 'Cyan'
    New-Item -ItemType Directory -Force -Path $HostDir | Out-Null
    $idx = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json'
    $rel = $idx | Where-Object { $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
    if (-not $rel) { throw 'no Node.js release found' }
    $ver = [string]$rel.version; $name = "node-$ver-win-x64.zip"
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$ver/SHASUMS256.txt").Content
    if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
    $line = ($sums -split "`n" | Where-Object { $_ -match ("\s" + [regex]::Escape($name) + "\s*$") } | Select-Object -First 1)
    if (-not $line) { throw 'no checksum listed for the Node.js download' }
    $want = (($line.Trim() -split '\s+')[0]).ToLower()
    $zip = Join-Path $HostDir 'node.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$ver/$name" -OutFile $zip
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne $want) { Remove-Item -LiteralPath $zip -Force; throw 'the Node.js download did not match its checksum' }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
    Remove-Item -LiteralPath $zip -Force
    $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
    Remove-Item -LiteralPath $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $inner.FullName -Destination $nodeDir
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Log "Node.js $ver installed"
    return (Test-Path -LiteralPath $exe)
  } catch { Log "Node.js download failed: $($_.Exception.Message)"; Say "Could not get Node.js: $($_.Exception.Message)" 'Red'; return $false }
}
function Install-HostFiles($H) {
  $null = Invoke-Player 'POST' '/quit' $null 5
  if (Get-PlayerCtl) { Start-Sleep -Seconds 3 }
  $app = Join-Path $HostDir 'app'
  New-Item -ItemType Directory -Force -Path $app | Out-Null
  foreach ($f in $H.files.PSObject.Properties) { [IO.File]::WriteAllBytes((Join-Path $app $f.Name), [Convert]::FromBase64String([string]$f.Value)) }
  $hj = [pscustomobject]@{ code = $H.code; playitKey = $H.playitKey; address = $H.address; world = $H.world; port = (Prop $H 'port' 0); name = (Prop $H 'name' '') }
  Write-Json (Join-Path $HostDir 'host.json') $hj
}
function Get-PlayerCtl {
  $c = Read-Json (Join-Path $HostDir 'control.json') $null
  if (-not $c) { return $null }
  try { $null = Get-Process -Id ([int]$c.pid) -ErrorAction Stop } catch { return $null }
  return $c
}
function Invoke-Player([string]$Method, [string]$Path, $Body = $null, [int]$Timeout = 10) {
  $c = Get-PlayerCtl; if (-not $c) { return $null }
  try {
    $a = @{ Uri = "http://127.0.0.1:$($c.port)$Path"; Method = $Method; Headers = @{ 'x-bh-token' = [string]$c.token }; TimeoutSec = $Timeout; UseBasicParsing = $true }
    if ($Method -eq 'POST') { $a.ContentType = 'application/json'; $a.Body = $(if ($Body) { ($Body | ConvertTo-Json -Compress) } else { '{}' }) }
    return (Invoke-RestMethod @a)
  } catch { Log "helper call $Path failed: $($_.Exception.Message)"; return $null }
}
function Start-Player {
  if (Get-PlayerCtl) { return $true }
  $node = Join-Path $HostDir 'node\node.exe'; $js = Join-Path $HostDir 'app\player.js'
  if (-not (Test-Path -LiteralPath $js)) { Log 'player.js missing'; return $false }
  if (-not (Test-Path -LiteralPath $node)) { if (-not (Ensure-Node)) { return $false } }
  $sp = @{ FilePath = $node; ArgumentList = @(('"' + $js + '"'), ('"' + $HostDir + '"')) }
  if ($IsWin) { $sp.WindowStyle = 'Hidden' }
  Start-Process @sp
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep -Milliseconds 250; if (-not $NoGui) { [Windows.Forms.Application]::DoEvents() }; if (Get-PlayerCtl) { return $true } }
  Log 'the server helper did not start'; return $false
}
function Start-HostServer {
  if (-not (Start-Player)) { Notify 'Blockhost' 'Could not start the server helper. Tray icon > Show log for details.'; return }
  $st = Invoke-Player 'POST' '/start' $null 15
  if (-not $st) { Notify 'Blockhost' 'The server helper did not answer. Try again in a minute.'; return }
  if ($st.ok -eq $false -and $st.error) { Notify 'Blockhost' ([string]$st.error); return }
  Notify 'Blockhost' 'Starting the server on this PC... a notification will tell you when friends can join.'
  try { Show-HostWindow } catch { Log "window: $($_.Exception.Message)" }
}
function Get-HostLine($st) {
  if (-not $st) { return 'Server: asleep (nobody is hosting)' }
  switch ([string]$st.phase) {
    'hosting' { return "Server: ONLINE from this PC ($($st.players) playing)" }
    { $_ -in 'checking', 'acquiring' } { return 'Server: checking...' }
    'downloading' { return "Server: getting the latest world... $($st.message)" }
    'starting' { return 'Server: starting...' }
    'saving' { return "Server: saving the world... $($st.message)" }
    'error' { return "Server problem: $($st.message)" }
    'lost' { return 'Server: another PC took over' }
  }
  if ($st.remote -and $st.remote.state -eq 'hosted') { return "Server: online - hosted by $($st.remote.host.name)" }
  return 'Server: asleep (nobody is hosting)'
}
# runs on every tray tick: notices state changes of the helper and tells the user once
function Invoke-HostPoll {
  if (-not (Get-PlayerCtl)) { $script:HS = $null; return }
  $st = Invoke-Player 'GET' '/state' $null 3
  if (-not $st) { return }
  $script:HS = $st
  $ph = [string]$st.phase
  if ($ph -ne $script:LastPhase) {
    $prev = $script:LastPhase; $script:LastPhase = $ph
    if ($ph -eq 'hosting') { Notify 'Server is starting up' 'Checking that friends can reach it...' }
    elseif ($ph -eq 'off' -and $prev -in 'saving', 'hosting') { Notify 'Server asleep' 'The world is saved to the cloud. It starts again when someone opens Minecraft.' }
    elseif ($ph -eq 'error') { Notify 'Server problem' ([string]$st.message) }
    elseif ($ph -eq 'lost') { Notify 'Server' ([string]$st.message) }
  }
  $rs = ''; if ($st.reach) { $rs = [string]$st.reach.state }
  if ($ph -eq 'hosting' -and $rs -ne $script:LastReach -and $rs -in 'ok', 'fail') {
    if ($rs -eq 'ok') { Notify 'Server is online' "Friends can join now: $($st.address)" } else { Notify 'Friends cannot reach the server yet' ([string]$st.reach.error) }
  }
  $script:LastReach = $rs
}
# Minecraft was just opened: if nobody is hosting, offer to start the server for everyone
function Invoke-HostJoinCheck {
  if (((Get-Date) - $script:AskedAt) -lt [TimeSpan]::FromMinutes(10)) { return }
  if (-not (Start-Player)) { Notify 'Blockhost' 'Could not start the server helper. Tray icon > Show log for details.'; return }
  $st = Invoke-Player 'GET' '/state?fresh=1' $null 20
  if (-not $st) { return }
  $script:HS = $st
  $addr = [string]$st.address
  if ($st.hosting) { return }
  if ($st.phase -in 'checking', 'acquiring', 'downloading', 'starting') { Notify 'Blockhost' 'The server is starting - a notification will tell you when to join.'; return }
  if ($st.remoteErr) { Log "cloud: $($st.remoteErr)"; Notify 'Blockhost' "Can't reach the cloud right now: $($st.remoteErr)"; return }
  if ($st.remote -and $st.remote.state -eq 'hosted') { $script:AskedAt = Get-Date; Notify 'Server is online' "$($st.remote.host.name) is hosting. Join: $addr"; return }
  $script:AskedAt = Get-Date
  if ($st.ramPlan.ok) {
    if (Ask 'Blockhost' "The server is asleep.`r`n`r`nStart it for everyone now? It runs on this PC (about $($st.ramPlan.ramGB) GB of RAM), saves itself to the cloud and goes back to sleep when everyone has left.") { Start-HostServer }
  } else {
    $null = Invoke-Player 'POST' '/request' $null 15
    Notify 'Blockhost' "This PC ($($st.ramPlan.totalGB) GB RAM) is too small to host, so I asked another friend's PC to wake the server. Hold on a minute."
  }
}
function Update-HostMenu {
  $st = $script:HS
  $busy = $st -and ($st.phase -in 'checking', 'acquiring', 'downloading', 'starting', 'saving')
  $mine = $st -and $st.hosting
  $miHost.Text = Get-HostLine $st
  $miStart.Visible = (-not $busy) -and (-not $mine) -and (-not ($st -and $st.remote -and $st.remote.state -eq 'hosted'))
  $miStop.Visible = [bool]$mine
  $miAddr.Visible = [bool]($st -and $st.address) -or [bool](Prop (Read-Json (Join-Path $HostDir 'host.json') $null) 'address')
}


# ----------------------------------------------------------------------------------- the Blockhost window (WinForms, dark)
function Get-HostView($st) {
  $v = @{ title = 'Server asleep'; detail = 'Nobody is hosting right now. Press Start to run the server on this PC.'; color = 'gray'; busy = $false; pct = -1; reach = ''; reachColor = 'gray' }
  if (-not $st) { return $v }
  $ph = [string]$st.phase
  if ($st.prep) { $v.title = 'Getting ready'; $v.detail = "$($st.prep) (first time only)"; $v.color = 'amber'; $v.busy = $true; if ($st.prepPct) { $v.pct = [int]$st.prepPct }; return $v }
  switch ($ph) {
    'hosting' {
      $v.title = 'Server is online'; $v.color = 'green'
      $v.detail = "Running on this PC - $($st.players) playing. Tunnel: $($st.tunnelVia)."
      if ($st.tunnelErr) { $v.reach = [string]$st.tunnelErr; $v.reachColor = 'red' }
      elseif ($st.reach -and $st.reach.state -eq 'ok') { $v.reach = 'Internet check passed - friends can join.'; $v.reachColor = 'green' }
      elseif ($st.reach -and $st.reach.state -eq 'fail') { $v.reach = "Friends can NOT reach it yet: $($st.reach.error)"; $v.reachColor = 'red'; $v.color = 'amber' }
      else { $v.reach = 'Checking that friends can reach it...'; $v.reachColor = 'amber' }
    }
    { $_ -in 'checking', 'acquiring' } { $v.title = 'Starting...'; $v.detail = 'Checking who is hosting and taking the baton.'; $v.color = 'amber'; $v.busy = $true }
    'downloading' { $v.title = 'Getting the latest world'; $v.detail = [string]$st.message; $v.color = 'amber'; $v.busy = $true; if ($st.progress -and $st.progress.total) { $v.pct = [int](100 * $st.progress.done / $st.progress.total) } }
    'starting' { $v.title = 'Starting the server'; $v.detail = 'Minecraft is loading the world...'; $v.color = 'amber'; $v.busy = $true }
    'saving' { $v.title = 'Saving the world'; $v.detail = [string]$st.message; $v.color = 'amber'; $v.busy = $true; if ($st.progress -and $st.progress.total) { $v.pct = [int](100 * $st.progress.done / $st.progress.total) } }
    'error' { $v.title = 'Something went wrong'; $v.detail = [string]$st.message; $v.color = 'red' }
    'lost' { $v.title = 'Another PC took over'; $v.detail = [string]$st.message; $v.color = 'amber' }
    default {
      if ($st.remote -and $st.remote.state -eq 'hosted') { $v.title = "Online - hosted by $($st.remote.host.name)"; $v.detail = 'Just join with the address below.'; $v.color = 'green' }
      elseif ($st.remoteErr) { $v.title = 'Cannot reach the cloud'; $v.detail = [string]$st.remoteErr; $v.color = 'red' }
    }
  }
  return $v
}
function ColorOf($n) {
  switch ($n) { 'green' { return [Drawing.Color]::FromArgb(127, 193, 90) } 'amber' { return [Drawing.Color]::FromArgb(238, 155, 61) } 'red' { return [Drawing.Color]::FromArgb(232, 85, 47) } default { return [Drawing.Color]::FromArgb(185, 164, 135) } }
}
function New-HostWindow {
  # Campfire palette (same tokens as the dashboard; every text colour is >= 4.5:1 on its background)
  $bg = [Drawing.Color]::FromArgb(12, 9, 5); $card = [Drawing.Color]::FromArgb(23, 17, 10); $well = [Drawing.Color]::FromArgb(7, 5, 3)
  $fg = [Drawing.Color]::FromArgb(244, 230, 204); $dim = [Drawing.Color]::FromArgb(185, 164, 135); $flame = [Drawing.Color]::FromArgb(255, 210, 122)
  $bark = [Drawing.Color]::FromArgb(75, 55, 36)
  $f = New-Object Windows.Forms.Form
  $f.Text = "Blockhost - $($Cfg.serverName)"; $f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'FixedSingle'; $f.MaximizeBox = $false
  $f.ClientSize = New-Object Drawing.Size(470, 556); $f.BackColor = $bg; $f.ForeColor = $fg; $f.Font = New-Object Drawing.Font('Segoe UI', 10)
  try { $f.Icon = $script:Tray.Icon } catch { }
  try { $f.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'Instance,NonPublic').SetValue($f, $true, $null) } catch { }
  $mk = {
    param($parent, $text, $x, $y, $w, $h, $size, $color, $bold)
    $l = New-Object Windows.Forms.Label
    $l.Text = $text; $l.Left = $x; $l.Top = $y; $l.Width = $w; $l.Height = $h; $l.ForeColor = $color; $l.BackColor = $parent.BackColor; $l.AutoSize = $false
    $fam = 'Segoe UI'; $st = [Drawing.FontStyle]::Regular; if ($bold) { $fam = 'Segoe UI Semibold' }
    $l.Font = New-Object Drawing.Font($fam, $size, $st)
    $parent.Controls.Add($l); return $l
  }
  # flat button in the camp style: kind = primary (amber), danger (ember), quiet (bark outline)
  $btn = {
    param($text, $x, $y, $w, $h, $kind)
    $b = New-Object Windows.Forms.Button; $b.Text = $text; $b.Left = $x; $b.Top = $y; $b.Width = $w; $b.Height = $h; $b.FlatStyle = 'Flat'; $b.UseVisualStyleBackColor = $false; $b.Cursor = 'Hand'
    $b.FlatAppearance.BorderSize = 1; $b.FlatAppearance.BorderColor = $bark; $b.BackColor = $card; $b.ForeColor = $fg
    $b.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(45, 32, 20); $b.FlatAppearance.MouseDownBackColor = [Drawing.Color]::FromArgb(58, 43, 28)
    if ($kind -eq 'primary') { $b.BackColor = [Drawing.Color]::FromArgb(238, 155, 61); $b.ForeColor = [Drawing.Color]::FromArgb(29, 16, 4); $b.FlatAppearance.BorderSize = 0; $b.FlatAppearance.MouseOverBackColor = [Drawing.Color]::FromArgb(255, 179, 90); $b.FlatAppearance.MouseDownBackColor = [Drawing.Color]::FromArgb(224, 138, 44) }
    $f.Controls.Add($b); return $b
  }
  $W = @{}
  # header: the fire, the name, and which server this is
  $W.fire = New-Object Windows.Forms.PictureBox; $W.fire.Left = 24; $W.fire.Top = 14; $W.fire.Width = 48; $W.fire.Height = 60; $W.fire.SizeMode = 'Normal'; $W.fire.BackColor = $bg; $f.Controls.Add($W.fire)
  [void](& $mk $f 'Blockhost' 84 16 360 34 19 $flame $true)
  $W.title = & $mk $f ([string]$Cfg.serverName) 86 52 360 22 10 $dim $false
  # status card with a colour bar on its left edge
  $panel = New-Object Windows.Forms.Panel; $panel.Left = 24; $panel.Top = 92; $panel.Width = 422; $panel.Height = 166; $panel.BackColor = $card; $f.Controls.Add($panel)
  $W.accent = New-Object Windows.Forms.Panel; $W.accent.Left = 0; $W.accent.Top = 0; $W.accent.Width = 5; $W.accent.Height = 166; $W.accent.BackColor = (ColorOf 'gray'); $panel.Controls.Add($W.accent)
  $W.state = & $mk $panel 'Server asleep' 22 14 384 30 15 $fg $true
  $W.detail = & $mk $panel '' 22 50 384 46 10 $dim $false
  $W.bar = New-Object Windows.Forms.ProgressBar; $W.bar.Left = 22; $W.bar.Top = 104; $W.bar.Width = 380; $W.bar.Height = 8; $W.bar.Style = 'Continuous'; $W.bar.Visible = $false; $panel.Controls.Add($W.bar)
  $W.reach = & $mk $panel '' 22 120 384 40 9.5 $dim $false
  # the address, in a recessed well
  [void](& $mk $f 'Join with this address' 24 272 300 18 9 $dim $false)
  $well1 = New-Object Windows.Forms.Panel; $well1.Left = 24; $well1.Top = 294; $well1.Width = 326; $well1.Height = 40; $well1.BackColor = $well; $f.Controls.Add($well1)
  $W.addr = & $mk $well1 '' 12 6 308 28 13 $flame $false
  $W.addr.Font = New-Object Drawing.Font('Consolas', 13, [Drawing.FontStyle]::Bold)
  $W.copy = & $btn 'Copy' 358 294 88 40 'quiet'
  # one big action that changes meaning with the state
  $W.main = & $btn '' 24 352 422 54 'primary'; $W.main.Font = New-Object Drawing.Font('Segoe UI Semibold', 12)
  $W.standby = New-Object Windows.Forms.CheckBox; $W.standby.Text = 'Wake the server when a friend asks'; $W.standby.Left = 24; $W.standby.Top = 420; $W.standby.Width = 430; $W.standby.Height = 26; $W.standby.ForeColor = $fg; $W.standby.Checked = [bool](Prop $Cfg 'standby' $false); $f.Controls.Add($W.standby)
  $W.stats = & $mk $f '' 24 454 422 22 9 $dim $false
  $W.sync = & $mk $f '' 24 476 422 22 9 $dim $false
  $W.log = & $btn 'Show log' 24 510 100 30 'quiet'
  $W.recheck = & $btn 'Test reachability' 134 510 140 30 'quiet'
  $W.hide = & $btn 'Hide to tray' 346 510 100 30 'quiet'
  # the fire flickers while the server is up (three frames), and stays still when Windows animations are off
  $W.fireTimer = New-Object Windows.Forms.Timer; $W.fireTimer.Interval = 450
  $W.fireTimer.add_Tick({ $script:FireFrame = ($script:FireFrame + 1) % 3; Set-Fire })
  $script:FireFrame = 0; $script:FireMode = 'asleep'

  $W.copy.add_Click({ $a = [string]$script:Win.addr.Text; if ($a) { [Windows.Forms.Clipboard]::SetText($a); $script:Win.copy.Text = 'Copied'; Start-Sleep -Milliseconds 10 } })
  $W.main.add_Click({
    $st = $script:HS
    $script:Win.main.Enabled = $false
    try {
      if ($st -and $st.hosting) { if (Ask 'Blockhost' 'Stop the server? Everyone is disconnected. The world is saved to the cloud first.') { $null = Invoke-Player 'POST' '/stop' $null 10 } }
      elseif ($st -and $st.phase -eq 'error') { $null = Start-Player; $null = Invoke-Player 'POST' '/stop' $null 10; Start-HostServer }
      else { Start-HostServer }
    } finally { Invoke-HostPoll; Update-HostWindow }
  })
  $W.standby.add_Click({
    $on = [bool]$script:Win.standby.Checked
    $Cfg | Add-Member -NotePropertyName standby -NotePropertyValue $on -Force; Write-Json $CfgFile $Cfg
    if (Start-Player) { $null = Invoke-Player 'POST' '/standby' @{ on = $on } 10 }
    if ($miStandby) { $miStandby.Checked = $on }
  })
  $W.log.add_Click({ $lf = Join-Path $HostDir 'host.log'; if (Test-Path -LiteralPath $lf) { Start-Process notepad.exe $lf } else { Start-Process notepad.exe $LogFile } })
  $W.recheck.add_Click({ $null = Invoke-Player 'POST' '/recheck' $null 5; Invoke-HostPoll; Update-HostWindow })
  $W.hide.add_Click({ $script:Win.fireTimer.Stop(); $script:Win.form.Hide() })
  $f.add_FormClosing({ param($s, $e) if ($e.CloseReason -eq 'UserClosing') { $e.Cancel = $true; $script:Win.fireTimer.Stop(); $script:Win.form.Hide() } })
  $W.form = $f
  $script:Win = $W
}
function Set-Fire {
  $W = $script:Win; if (-not $W) { return }
  $W.fire.Image = Get-FireBitmap $script:FireMode $script:FireFrame
  if ($script:FireMode -eq 'online' -and [Windows.Forms.SystemInformation]::UIEffectsEnabled) { if (-not $W.fireTimer.Enabled) { $W.fireTimer.Start() } } else { $W.fireTimer.Stop() }
}
function Update-HostWindow {
  $W = $script:Win; if (-not $W -or -not $W.form.Visible) { return }
  $st = $script:HS
  $v = Get-HostView $st
  $c = ColorOf $v.color
  $W.accent.BackColor = $c; $W.state.Text = $v.title; $W.detail.Text = $v.detail
  $W.reach.Text = $v.reach; $W.reach.ForeColor = (ColorOf $v.reachColor)
  if ($v.pct -ge 0) { $W.bar.Style = 'Continuous'; $W.bar.Value = [Math]::Min(100, [Math]::Max(0, $v.pct)); $W.bar.Visible = $true } elseif ($v.busy) { $W.bar.Style = 'Marquee'; $W.bar.Visible = $true } else { $W.bar.Visible = $false }
  $addr = ''; if ($st) { $addr = [string]$st.address }
  if (-not $addr) { $addr = [string](Prop (Read-Json (Join-Path $HostDir 'host.json') $null) 'address' '') }
  $W.addr.Text = $addr
  if ($W.copy.Text -eq 'Copied') { $W.copy.Text = 'Copy' }
  $mine = $st -and $st.hosting
  $busy = $v.busy
  $other = $st -and $st.remote -and $st.remote.state -eq 'hosted'
  # the fire mirrors the server: coals asleep, small flame while it starts or saves, full flame online, smoke on trouble
  $mode = 'asleep'; if ($v.color -eq 'red') { $mode = 'error' } elseif ($busy) { $mode = 'starting' } elseif ($mine -or $other) { $mode = 'online' }
  if ($mode -ne $script:FireMode -or -not $W.fire.Image) { $script:FireMode = $mode; Set-Fire }
  $quiet = [Drawing.Color]::FromArgb(45, 32, 20)
  if ($mine) { $W.main.Text = 'Stop the server (save and sleep)'; $W.main.BackColor = [Drawing.Color]::FromArgb(165, 50, 19); $W.main.ForeColor = [Drawing.Color]::White; $W.main.Enabled = $true }
  elseif ($busy) { $W.main.Text = 'Working...'; $W.main.BackColor = $quiet; $W.main.ForeColor = [Drawing.Color]::FromArgb(244, 230, 204); $W.main.Enabled = $false }
  elseif ($other) { $W.main.Text = "$($st.remote.host.name) is keeping the fire"; $W.main.BackColor = $quiet; $W.main.ForeColor = [Drawing.Color]::FromArgb(244, 230, 204); $W.main.Enabled = $false }
  else { $W.main.Text = 'Light the fire - start the server'; $W.main.BackColor = [Drawing.Color]::FromArgb(238, 155, 61); $W.main.ForeColor = [Drawing.Color]::FromArgb(29, 16, 4); $W.main.Enabled = $true }
  $W.recheck.Enabled = [bool]$mine
  $ps = ''; if ($st) { $ps = "Players: $($st.players)"; if ($st.ramPlan) { $ps += "   |   This PC: $($st.ramPlan.totalGB) GB RAM" }; if ($st.lastSync) { $ps += "   |   Cloud copy v$($st.lastSync.version)" } }
  $W.stats.Text = $ps
  $W.sync.Text = $(if (Prop $Cfg 'hostOnly' $false) { 'In Minecraft: Multiplayer, then pick the server in your list.' } else { "Pack sync: $($script:Status)" })
}
function Show-HostWindow {
  if (-not $script:Win) { New-HostWindow }
  if (-not $script:Win.form.Visible) { $script:Win.form.Show(); Set-Fire }
  $script:Win.form.WindowState = 'Normal'; $script:Win.form.Activate()
  if (Get-PlayerCtl) { Invoke-HostPoll } else { [void](Start-Player); Invoke-HostPoll }
  Update-HostWindow
}

# ----------------------------------------------------------------------------------- uninstall
function Remove-Agent {
  if (Test-HostMode) { $null = Invoke-Player 'POST' '/quit' $null 5; Start-Sleep -Seconds 4 }
  if ($IsWin) { Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'Blockhost Sync.lnk') -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}

# ----------------------------------------------------------------------------------- install (first run from the .bat)
if ($Mode -eq 'install') {
  Clear-Host
  $D = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BH_SETUP)) | ConvertFrom-Json
  Say ''
  Say "$($D.serverName)" 'Magenta'
  Say 'Blockhost Sync - your Minecraft stays in sync with the host automatically' 'Gray'
  Say ''
  Say 'This installs a small helper that runs in the background (tray icon, starts with Windows).' 'White'
  if (Prop $D 'host' $null) { Say 'It also lets YOUR PC host the shared server when a friend wants to play and nobody else is online:' 'White'; Say 'open Minecraft and it asks "Start the server for everyone?". The world is saved to the cloud afterwards.' 'White' }
  if (-not (Prop $D 'hostOnly' $false)) {
    Say 'Whenever the host adds or removes shaders, texture packs or mods, it updates this PC by itself.' 'White'
    Say 'If Minecraft is open it waits until you close it (or asks to restart, if the host wants that).' 'White'
  }
  Say 'Your own mods are never touched. Remove it any time: tray icon > Uninstall.' 'DarkGray'
  Say ''
  if (-not $NoGui) {
    Read-Host '  Press Enter to install (or close this window to cancel)' | Out-Null
    while (Test-TLauncherOpen) { Say 'TLauncher is open - close it completely (it would undo the version setting), then press Enter.' 'Yellow'; Read-Host '  ' | Out-Null }
  }
  # stop an older copy of the agent
  if ($IsWin) { try { Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'BlockhostSync\\agent\.ps1' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force } } catch { } }
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  $src = [IO.File]::ReadAllText([string]$env:BH_SELF)
  $at = $src.IndexOf('#AGENT_START')
  [IO.File]::WriteAllText((Join-Path $Root 'agent.ps1'), $src.Substring($at))
  $old = Read-Json $CfgFile $null
  $Cfg = [pscustomobject]@{ urls = @($D.urls); mc = (Prop $D 'mc' $null); mcHost = (Prop $D 'mcHost' ''); token = $D.token; pub = $D.pub; keyId = $D.keyId; serverName = $D.serverName; installed = (Get-Date).ToString('s'); hostMode = [bool](Prop $D 'host' $null); hostOnly = [bool](Prop $D 'hostOnly' $false) }
  if ($old -and $old.keyId -ne $D.keyId) { Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue }
  Write-Json $CfgFile $Cfg
  Log "installed for $($D.serverName) ($($D.urls -join ', '))"
  Say "Minecraft folder: $(Find-GameDir)" 'White'
  if (-not $Cfg.hostOnly) {
    Say 'Syncing for the first time...' 'Cyan'
    $r = Invoke-Sync -Force
    if ($script:LastError) { Say $r 'Red'; Say 'The helper will keep retrying in the background (is the host online?).' 'Yellow' } else { Say $r 'Green' }
    foreach ($l in (Get-Content -LiteralPath $LogFile -Tail 25)) { if ($l -match 'installed|downloaded|selected|added|switched|removed') { Say ('  ' + $l.Substring(21)) 'DarkGray' } }
  }
  if ($Cfg.hostMode) {
    Install-HostFiles $D.host
    if (Ensure-Node) {
      Say 'Getting Java and the tunnel helper ready (first time only, a few minutes)...' 'Cyan'
      & (Join-Path $HostDir 'node\node.exe') (Join-Path $HostDir 'app\player.js') $HostDir prepare
      if ($LASTEXITCODE -ne 0) { Say 'Some downloads failed - the helper will retry the first time you start the server.' 'Yellow' } else { Say 'Ready to host.' 'Green' }
    } else { Say 'Hosting is not ready yet - the helper will retry when you first start the server.' 'Yellow' }
    if ($D.host.address) { try { New-Item -ItemType Directory -Force -Path (Find-GameDir) | Out-Null; [void](Add-ServerEntry (Find-GameDir) $D.serverName ([string]$D.host.address)); Say "Added '$($D.serverName)' to your Minecraft server list." 'Green' } catch { Log "server list: $($_.Exception.Message)" } }
  }
  if ($IsWin) {
    $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Blockhost Sync.lnk'
    $ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut($lnk)
    $sc.TargetPath = (Join-Path $PSHOME 'powershell.exe')
    $sc.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $Root 'agent.ps1') + '" agent'
    $sc.WindowStyle = 7; $sc.Description = 'Keeps Minecraft packs in sync with your Blockhost server'; $sc.Save()
    Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'agent.ps1'), 'agent') -WindowStyle Hidden
    Say ''
    Say 'Done! The Blockhost Sync icon is now in your tray (bottom-right, maybe under ^).' 'Green'
    Say 'You never need to run this file again.' 'Green'
    $tl = Find-TLauncher
    if ($tl) { Say ''; Read-Host '  Press Enter to open TLauncher (the right version is already selected - just press Play)' | Out-Null; Start-TLauncher }
  }
  return
}
if (-not $Cfg) { Say 'Blockhost Sync is not installed - run the Blockhost Sync .bat from your host.' 'Yellow'; return }
if ($Mode -eq 'uninstall') { Remove-Agent; Say 'Blockhost Sync removed.' 'Green'; return }
if ($Mode -eq 'once') { if (Prop $Cfg 'hostOnly' $false) { Say 'Hosting only - nothing to sync.'; return }; $r = Invoke-Sync; Say $r; return }
if ($Mode -eq 'repair') { $r = Invoke-Sync -Force; Say $r; return }
if ($Mode -eq 'lib') { return }   # dot-sourced for tests

# ----------------------------------------------------------------------------------- background agent with tray icon
$script:Mutex = New-Object Threading.Mutex($false, "Local\BlockhostSync-$($Cfg.keyId)")
if (-not $script:Mutex.WaitOne(0)) { return }
if ($NoGui) { while ($true) { if (-not (Prop $Cfg 'hostOnly' $false)) { [void](Invoke-Sync) }; Start-Sleep -Seconds 45 } }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# The Blockhost camp fire: a 12x15 pixel sprite (same art as the dashboard). Mode: online | starting | asleep | error
$script:FireRows = @{
  f1 = @('.....o......','....oo......','....ooo.....','...ooaoo.o..','..ooaaaooo..','..oaayaaoo..','.ooaayyaaoo.','.oaayyyyaao.','.oaayywyaao.','.ooaayyyaoo.','..ooaayaoo..','...oooooo...')
  f2 = @('......o.....','......oo....','.....ooo....','..o.oaaoo...','..ooaaaaoo..','..oaayyaoo..','.ooaayyaaoo.','.oaayyyyaoo.','.oaayywyaao.','.ooaayyyaoo.','..ooaayaoo..','...oooooo...')
  f3 = @('............','.....o......','....oo.o....','...ooaooo...','..ooaaaaoo..','..oaayyaaoo.','.ooaayyyaoo.','.oaayyyyaao.','.oaayywyaao.','.ooaayyyaoo.','..ooaayaoo..','...oooooo...')
  sf = @('............','............','............','............','............','............','.....o......','....oao.....','...oaayo....','...oayyao...','....oaao....','....oooo....')
  co = @('............','............','............','............','............','............','............','............','....e..e....','...ekeeke...','..keeekeek..','.kekeekekek.')
  sm = @('............','.....s......','....ss......','.....ss.....','....s.......','.....s......','....ss......','............','............','............','............','............')
  lg = @('..llbbbbll..','.llblllbbll.','bbbbbbbbbbbb')
}
$script:FirePal = @{ o = @(232,85,47); a = @(238,155,61); y = @(255,210,122); w = @(255,244,222); l = @(154,90,40); b = @(92,50,22); e = @(240,101,42); k = @(74,36,16); s = @(122,110,98) }
$script:FireBmps = @{}
function New-FireBitmap([string]$mode, [int]$frame, [int]$cell, [int]$w, [int]$h, [int]$ox, [int]$oy, $back) {
  $bmp = New-Object Drawing.Bitmap $w, $h
  $g = [Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'None'; $g.PixelOffsetMode = 'Half'
  if ($back) { $g.Clear($back) } else { $g.Clear([Drawing.Color]::Transparent) }
  $layers = @()
  switch ($mode) {
    'online'   { $layers = @($script:FireRows.co, $script:FireRows[@('f1', 'f2', 'f3')[$frame % 3]]) }
    'starting' { $layers = @($script:FireRows.co, $script:FireRows.sf) }
    'error'    { $layers = @($script:FireRows.co, $script:FireRows.sm) }
    default    { $layers = @($script:FireRows.co) }
  }
  $draw = { param($rows, $y0) for ($r = 0; $r -lt $rows.Count; $r++) { $row = [string]$rows[$r]; for ($c = 0; $c -lt $row.Length; $c++) { $ch = [string]$row[$c]; if ($ch -ne '.') { $p = $script:FirePal[$ch]; $br = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(255, $p[0], $p[1], $p[2])); $g.FillRectangle($br, $ox + $c * $cell, $oy + ($r + $y0) * $cell, $cell, $cell); $br.Dispose() } } } }
  foreach ($rows in $layers) { & $draw $rows 0 }
  & $draw $script:FireRows.lg 12
  $g.Dispose()
  return $bmp
}
function Get-FireBitmap([string]$mode, [int]$frame) {
  $key = "$mode$($frame % 3)"
  if (-not $script:FireBmps[$key]) { $script:FireBmps[$key] = New-FireBitmap $mode $frame 4 48 60 0 0 ([Drawing.Color]::FromArgb(12, 9, 5)) }
  return $script:FireBmps[$key]
}
function New-FireIcon([string]$mode, [bool]$badge) {
  $bmp = New-FireBitmap $mode 0 2 32 32 4 1 $null
  if ($badge) { $g = [Drawing.Graphics]::FromImage($bmp); $g.FillRectangle((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(255, 12, 9, 5))), 19, 19, 13, 13); $g.FillRectangle((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(255, 232, 85, 47))), 21, 21, 9, 9); $g.Dispose() }
  return [Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$Icons = @{ ok = (New-FireIcon 'online' $false); wait = (New-FireIcon 'asleep' $false); bad = (New-FireIcon 'error' $true) }
$script:Tray = New-Object Windows.Forms.NotifyIcon
$script:Tray.Icon = $Icons.wait; $script:Tray.Visible = $true; $script:Tray.Text = 'Blockhost Sync'
$menu = New-Object Windows.Forms.ContextMenuStrip
$miTitle = $menu.Items.Add("Blockhost Sync - $($Cfg.serverName)"); $miTitle.Enabled = $false
$miStatus = $menu.Items.Add('Starting...'); $miStatus.Enabled = $false
$miSep0 = $menu.Items.Add('-')
function Refresh-Tray {
  $miStatus.Text = $script:Status
  $t = "Blockhost Sync: $($script:Status)"; if ($t.Length -gt 63) { $t = $t.Substring(0, 60) + '...' }
  $script:Tray.Text = $t
  if ($script:LastError -and $script:LastError -notmatch 'not reachable') { $script:Tray.Icon = $Icons.bad } elseif ($script:Pending -gt 0 -or $script:LastError) { $script:Tray.Icon = $Icons.wait } else { $script:Tray.Icon = $Icons.ok }
}
if (Test-HostMode) {
  $miTitle.Visible = $false; $miStatus.Visible = $false; $miSep0.Visible = $false
  $miOpen = $menu.Items.Add('Open Blockhost'); $miOpen.Font = New-Object Drawing.Font($miOpen.Font, [Drawing.FontStyle]::Bold)
  $miHost = $menu.Items.Add('Server: checking...'); $miHost.Enabled = $false
  [void]$menu.Items.Add('-')
  $miOpen.add_Click({ Show-HostWindow })
  $miStart = $menu.Items.Add('Start the server for everyone')
  $miStart.add_Click({ Start-HostServer; Invoke-HostPoll; Update-HostMenu })
  $miStop = $menu.Items.Add('Stop the server (save and let it sleep)')
  $miStop.add_Click({ if (Ask 'Blockhost' 'Stop the server? Everyone will be disconnected. The world is saved to the cloud first.') { $null = Invoke-Player 'POST' '/stop' $null 10; Notify 'Blockhost' 'Saving the world, then the server sleeps...' } })
  $miAddr = $menu.Items.Add('Copy the server address')
  $miAddr.add_Click({ $a = ''; if ($script:HS) { $a = [string]$script:HS.address }; if (-not $a) { $a = [string](Prop (Read-Json (Join-Path $HostDir 'host.json') $null) 'address' '') }; if ($a) { [Windows.Forms.Clipboard]::SetText($a); Notify 'Blockhost' "Copied: $a" } })
  $miStandby = $menu.Items.Add('Wake the server when a friend asks')
  $miStandby.CheckOnClick = $true; $miStandby.Checked = [bool](Prop $Cfg 'standby' $false)
  $miStandby.add_Click({
    $on = [bool]$miStandby.Checked
    $Cfg | Add-Member -NotePropertyName standby -NotePropertyValue $on -Force; Write-Json $CfgFile $Cfg
    if (Start-Player) { $null = Invoke-Player 'POST' '/standby' @{ on = $on } 10 }
    Notify 'Blockhost' $(if ($on) { 'This PC will wake the server when a friend asks (needs the PC on and this icon running).' } else { 'Automatic wake-up is off.' }) })
  $menu.add_Opening({ Invoke-HostPoll; Update-HostMenu })
  [void]$menu.Items.Add('-')
}
if (-not (Prop $Cfg 'hostOnly' $false)) {
$menu.Items.Add('Sync now').add_Click({ [void](Invoke-Sync); Refresh-Tray; Notify 'Blockhost Sync' $script:Status })
$menu.Items.Add('Repair my Minecraft setup').add_Click({ [void](Invoke-Sync -Force); Refresh-Tray; Notify 'Blockhost Sync' $script:Status })
}
$menu.Items.Add('Open Minecraft folder').add_Click({ Start-Process explorer.exe (Find-GameDir) })
$menu.Items.Add('Show log').add_Click({ Start-Process notepad.exe $LogFile })
[void]$menu.Items.Add('-')
$menu.Items.Add('Uninstall Blockhost Sync').add_Click({
  if (Ask 'Blockhost Sync' 'Stop syncing with this server and remove the helper? (Packs already installed stay.)') { Remove-Agent; $script:Tray.Visible = $false; [Windows.Forms.Application]::Exit() } })
$menu.Items.Add('Exit (until next restart)').add_Click({ if (Test-HostMode) { $null = Invoke-Player 'POST' '/quit' $null 5 }; $script:Tray.Visible = $false; [Windows.Forms.Application]::Exit() })
$script:Tray.ContextMenuStrip = $menu
$script:Tray.add_MouseUp({ param($sender, $e) if ($e.Button -eq [Windows.Forms.MouseButtons]::Left -and (Test-HostMode)) { Show-HostWindow } })
$script:Tray.add_DoubleClick({ if (Test-HostMode) { Show-HostWindow } else { [void](Invoke-Sync); Refresh-Tray; Notify 'Blockhost Sync' $script:Status } })

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 4000
$script:Ticks = 0
$timer.add_Tick({
  $script:Ticks++
  # every 45 s a full check; while an update is waiting, a cheap 4-second "has the game closed?" check
  $syncing = -not (Prop $Cfg 'hostOnly' $false)
  $full = ($script:Ticks % 11 -eq 1)
  if (-not $full -and $script:Pending -gt 0 -and -not (Get-GameProcs)) { $full = $true }
  if ($full -and $syncing) { [void](Invoke-Sync); Refresh-Tray }
  if (Test-HostMode) {
    try {
      Invoke-HostPoll
      Update-HostWindow
      $game = [bool](Get-GameProcs)
      if ($game -and -not $script:GameWas) { $script:GameWas = $true; Invoke-HostJoinCheck } elseif (-not $game) { $script:GameWas = $false }
      if (-not $syncing -and $script:Ticks -eq 1) {
        if (Prop $Cfg 'standby' $false) { if (Start-Player) { $null = Invoke-Player 'POST' '/standby' @{ on = $true } 10 } }
        $script:Status = Get-HostLine $script:HS; $script:Tray.Icon = $Icons.wait; $script:Tray.Text = 'Blockhost'
      }
    } catch { Log "host tick: $($_.Exception.Message)" }
    if (-not $syncing) {
      $line = Get-HostLine $script:HS; $miStatus.Text = $line
      $other = $script:HS -and $script:HS.remote -and $script:HS.remote.state -eq 'hosted'
      $ic = $(if (($script:HS -and $script:HS.hosting) -or $other) { $Icons.ok } elseif ($script:HS -and $script:HS.phase -in 'error', 'lost') { $Icons.bad } else { $Icons.wait })
      if ($script:Tray.Icon -ne $ic) { $script:Tray.Icon = $ic }                 # only on a real change: the notification-area icon must not flicker
      $tip = 'Blockhost - ' + ($line -replace '^Server:? ?', ''); if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 60) + '...' }; $script:Tray.Text = $tip
    }
  }
})
$timer.Start()
Log "agent v$AgentVersion started"
[Windows.Forms.Application]::Run()
$script:Tray.Visible = $false
