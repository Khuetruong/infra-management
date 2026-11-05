#Requires -Version 5.1
<#
  Infra agent for Windows. Connects a Windows server to the control plane.
  - Outbound only: polls the control plane over HTTPS; opens no inbound port.
  - Runs only the allowlisted actions below, re-validating every parameter locally.
  - shell.exec is refused unless allow_shell=true in this server's LOCAL config file.

  Usage:
    infra_agent.ps1 -Command enroll -Server https://infra.example.com -Token enr_xxx [-Config PATH] [-CaFile PATH] [-InsecureHttp]
    infra_agent.ps1 -Command run   [-Config PATH]     # long-running loop (scheduled task / service)
    infra_agent.ps1 -Command once  [-Config PATH]     # one heartbeat + run received tasks (testing)
#>
param(
  [string]$Command = 'run',
  [string]$Server,
  [string]$Token,
  [string]$Config = "$env:ProgramData\infra-agent\config.json",
  [string]$CaFile,
  [switch]$InsecureHttp
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$script:VERSION = '0.1.0'
$script:MAX_OUTPUT = 200 * 1024
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocol]::Tls12 -bor [Net.SecurityProtocol]::Tls11

function Write-Log { param([Parameter(ValueFromRemainingArguments = $true)]$m) Write-Host ((Get-Date).ToString('s') + ' ' + ($m -join ' ')) }

# ----------------------------------------------------------------------------- config & HTTP
function Read-Config { param($Path) Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json }
function Save-Config {
  param($Path, $Cfg)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  ($Cfg | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Invoke-ApiJson {
  param($Cfg, $Method, $Path, $Body, $TokenStr, $TimeoutSec = 30)
  $url = ($Cfg.server_url.TrimEnd('/')) + $Path
  $headers = @{ 'Content-Type' = 'application/json'; 'User-Agent' = "infra-agent-win/$($script:VERSION)" }
  if ($TokenStr) { $headers['Authorization'] = "Bearer $TokenStr" }
  $json = ($Body | ConvertTo-Json -Depth 12 -Compress)
  try {
    $resp = Invoke-WebRequest -Uri $url -Method $Method -Headers $headers -Body $json -UseBasicParsing -TimeoutSec $TimeoutSec
    if ($resp.Content) { return ($resp.Content | ConvertFrom-Json) } else { return @{} }
  } catch {
    $r = $_.Exception.Response
    if ($r) {
      try {
        $sr = New-Object IO.StreamReader($r.GetResponseStream())
        $errText = $sr.ReadToEnd()
        $msg = ($errText | ConvertFrom-Json).error
      } catch { $msg = $_.Exception.Message }
      throw "HTTP $([int]$r.StatusCode): $msg"
    }
    throw $_.Exception.Message
  }
}

# ----------------------------------------------------------------------------- facts & metrics
function Get-PrimaryIp {
  try {
    $r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1
    (Get-NetIPAddress -InterfaceIndex $r.ifIndex -AddressFamily IPv4 -ErrorAction Stop | Select-Object -First 1).IPAddress
  } catch { try { (Test-Connection -ComputerName $env:COMPUTERNAME -Count 1 -ErrorAction Stop).IPV4Address.IPAddressToString } catch { $null } }
}

function Get-Facts {
  $os = $null; $cs = $null
  try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch {}
  try { $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop } catch {}
  $fw = $null
  try { $fw = (Get-NetFirewallProfile -ErrorAction Stop | Where-Object { $_.Enabled } | Select-Object -First 1).Name } catch {}
  [ordered]@{
    hostname        = $env:COMPUTERNAME
    os              = if ($os) { $os.Caption } else { 'Windows' }
    os_id           = 'windows'
    kernel          = if ($os) { $os.Version } else { [string][Environment]::OSVersion.Version }
    arch            = $env:PROCESSOR_ARCHITECTURE
    cpu_count       = [int]$env:NUMBER_OF_PROCESSORS
    mem_total       = if ($cs) { [int64]$cs.TotalPhysicalMemory } else { $null }
    primary_ip      = Get-PrimaryIp
    package_manager = 'windows-update'
    init            = 'service'
    firewall        = if ($fw) { "windows-firewall ($fw)" } else { 'off' }
    agent_runtime   = "powershell $($PSVersionTable.PSVersion)"
  }
}

function Get-PendingReboot {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  )
  foreach ($k in $keys) { if (Test-Path $k) { return $true } }
  return $false
}

function Get-Metrics {
  $os = $null
  try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch {}
  $cpu = $null
  try { $cpu = [math]::Round((Get-CimInstance Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average).Average, 1) } catch {}
  $memPct = $null; $memUsed = $null
  if ($os -and $os.TotalVisibleMemorySize) {
    $total = [int64]$os.TotalVisibleMemorySize * 1024
    $free = [int64]$os.FreePhysicalMemory * 1024
    $memUsed = $total - $free
    $memPct = [math]::Round(100.0 * $memUsed / $total, 1)
  }
  $diskPct = $null; $diskUsed = $null; $diskTotal = $null
  try {
    $sys = ($env:SystemDrive).TrimEnd(':')
    $d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($sys):'" -ErrorAction Stop
    if ($d.Size) { $diskTotal = [int64]$d.Size; $diskUsed = $diskTotal - [int64]$d.FreeSpace; $diskPct = [math]::Round(100.0 * $diskUsed / $diskTotal, 1) }
  } catch {}
  $uptime = $null
  if ($os) { try { $uptime = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds } catch {} }
  [ordered]@{
    cpu_percent      = $cpu
    mem_percent      = $memPct
    mem_used         = $memUsed
    disk_percent     = $diskPct
    disk_used        = $diskUsed
    disk_total       = $diskTotal
    uptime_seconds   = $uptime
    reboot_required  = Get-PendingReboot
  }
}

# ----------------------------------------------------------------------------- validation
# spec: @{ param = @{ type='int'|'bool'|'enum'|'string'|'secret'|'shell'; ... } }
$script:ACTIONS = [ordered]@{
  'system.info'               = @{}
  'system.disk_usage'         = @{}
  'system.processes'          = @{ limit = @{ type = 'int'; min = 1; max = 100; default = 15 } }
  'system.users'              = @{}
  'system.update_check'       = @{}
  'system.update_apply'       = @{ security_only = @{ type = 'bool'; default = $true } }
  'system.reboot'             = @{ delay_minutes = @{ type = 'int'; min = 0; max = 60; default = 1 } }
  'service.list'              = @{}
  'service.status'            = @{ name = @{ type = 'string'; pattern = '^[A-Za-z0-9@._: -]{1,128}$'; required = $true } }
  'service.restart'           = @{ name = @{ type = 'string'; pattern = '^[A-Za-z0-9@._: -]{1,128}$'; required = $true } }
  'service.start'             = @{ name = @{ type = 'string'; pattern = '^[A-Za-z0-9@._: -]{1,128}$'; required = $true } }
  'service.stop'              = @{ name = @{ type = 'string'; pattern = '^[A-Za-z0-9@._: -]{1,128}$'; required = $true } }
  'logs.tail'                 = @{ unit = @{ type = 'string'; pattern = '^[A-Za-z0-9@._:/\\ -]{1,128}$' }; lines = @{ type = 'int'; min = 1; max = 2000; default = 200 } }
  'security.audit'            = @{}
  'security.listening_ports'  = @{}
  'security.failed_logins'    = @{ lines = @{ type = 'int'; min = 1; max = 1000; default = 100 } }
  'security.firewall_status'  = @{}
  'security.firewall_allow'   = @{ port = @{ type = 'int'; min = 1; max = 65535; required = $true }; proto = @{ type = 'enum'; values = @('tcp', 'udp'); default = 'tcp' } }
  'security.firewall_deny'    = @{ port = @{ type = 'int'; min = 1; max = 65535; required = $true }; proto = @{ type = 'enum'; values = @('tcp', 'udp'); default = 'tcp' } }
  'security.block_ip'         = @{ ip = @{ type = 'string'; pattern = '^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{2,39}$'; required = $true } }
  'security.deep_audit'       = @{}
  'security.disable_smb1'     = @{}
  'security.disable_guest'    = @{}
  'shell.exec'                = @{ command = @{ type = 'shell' } }
}

class Rejected : System.Exception { Rejected([string]$m) : base($m) {} }

function Resolve-Params {
  param($Action, $Params, $Cfg)
  if (-not $script:ACTIONS.Contains($Action)) { throw [Rejected]::new("action not allowed by agent: $Action") }
  $spec = $script:ACTIONS[$Action]
  if ($null -eq $Params) { $Params = @{} }
  $ph = @{}
  foreach ($p in $Params.PSObject.Properties) { $ph[$p.Name] = $p.Value }
  foreach ($k in $ph.Keys) { if (-not $spec.Contains($k)) { throw [Rejected]::new("unknown parameter: $k") } }
  $out = @{}
  foreach ($k in $spec.Keys) {
    $s = $spec[$k]
    $v = if ($ph.Contains($k)) { $ph[$k] } else { $null }
    $skip = $false
    switch ($s.type) {
      'int' {
        if ($null -eq $v) { $v = $s.default }
        $iv = 0
        if ($null -eq $v -or -not [int]::TryParse([string]$v, [ref]$iv)) { throw [Rejected]::new("invalid $k") }
        $v = $iv
        if ($v -lt $s.min -or $v -gt $s.max) { throw [Rejected]::new("invalid $k") }
      }
      'bool' { if ($null -eq $v) { $v = $s.default }; if ($v -isnot [bool]) { throw [Rejected]::new("invalid $k") } }
      'enum' { if ($null -eq $v -or $v -eq '') { $v = $s.default }; if ($s.values -notcontains $v) { throw [Rejected]::new("invalid $k") } }
      'string' {
        if ($null -eq $v -or $v -eq '') { if ($s.required) { throw [Rejected]::new("invalid $k") } else { $skip = $true } }
        elseif ([string]$v -notmatch $s.pattern) { throw [Rejected]::new("invalid $k") }
        else { $v = [string]$v }
      }
      'secret' { if ($null -eq $v) { $skip = $true } elseif ($v -isnot [string]) { throw [Rejected]::new("invalid $k") } }
      'shell' {
        if (-not $Cfg.allow_shell) { throw [Rejected]::new("shell.exec is disabled in this agent's local config (allow_shell=false)") }
        if ($v -isnot [string] -or [string]::IsNullOrWhiteSpace($v) -or $v.Length -gt 4000) { throw [Rejected]::new("invalid $k") }
      }
    }
    if (-not $skip) { $out[$k] = $v }
  }
  return $out
}

# ----------------------------------------------------------------------------- action helpers
function New-Result { param($code, $output, $result = $null) [pscustomobject]@{ code = $code; output = $output; result = $result } }
function Clip { param($s) if ($null -eq $s) { '' } else { $t = [string]$s; if ($t.Length -gt $script:MAX_OUTPUT) { $t.Substring($t.Length - $script:MAX_OUTPUT) } else { $t } } }

function Act-SystemInfo {
  $d = @{}; (Get-Facts).GetEnumerator() | ForEach-Object { $d[$_.Key] = $_.Value }; (Get-Metrics).GetEnumerator() | ForEach-Object { $d[$_.Key] = $_.Value }
  New-Result 0 ($d | ConvertTo-Json -Depth 6) $d
}
function Act-DiskUsage {
  $rows = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
    "{0}  {1:N1} GB / {2:N1} GB  ({3:N0}% dùng)" -f $_.DeviceID, (($_.Size - $_.FreeSpace) / 1GB), ($_.Size / 1GB), (100.0 * ($_.Size - $_.FreeSpace) / [math]::Max($_.Size, 1))
  }
  New-Result 0 ($rows -join "`n")
}
function Act-Processes { param($p)
  $rows = Get-Process | Sort-Object CPU -Descending | Select-Object -First $p.limit |
    ForEach-Object { "{0,8} {1,6:N1}  {2,8:N0} MB  {3}" -f $_.Id, ([double]$_.CPU), ($_.WorkingSet64 / 1MB), $_.ProcessName }
  New-Result 0 (("   PID    CPU(s)       RAM  NAME`n") + ($rows -join "`n"))
}
function Act-Users {
  $users = @()
  try { $users = Get-LocalUser | Where-Object { $_.Enabled } | ForEach-Object { @{ name = $_.Name; enabled = [bool]$_.Enabled; last_logon = [string]$_.LastLogon } } } catch {
    $users = Get-CimInstance Win32_UserAccount -Filter "LocalAccount=True" | ForEach-Object { @{ name = $_.Name; enabled = (-not $_.Disabled) } }
  }
  New-Result 0 (($users | ForEach-Object { $_.name }) -join "`n") @{ users = $users }
}
function Act-UpdateCheck {
  try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $res = $searcher.Search("IsInstalled=0 and Type='Software'")
    $items = @(); foreach ($u in $res.Updates) { $items += $u.Title }
    New-Result 0 (("$($items.Count) bản cập nhật đang chờ:`n") + ($items -join "`n")) @{ count = $items.Count }
  } catch { New-Result 1 "Không truy vấn được Windows Update: $($_.Exception.Message)" }
}
function Act-UpdateApply { param($p)
  try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $q = if ($p.security_only) { "IsInstalled=0 and Type='Software' and AutoSelectOnWebSites=1" } else { "IsInstalled=0 and Type='Software'" }
    $res = $searcher.Search($q)
    if ($res.Updates.Count -eq 0) { return New-Result 0 'Không có bản cập nhật nào cần cài.' @{ installed = 0 } }
    $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($u in $res.Updates) { if ($u.EulaAccepted -eq $false) { $u.AcceptEula() }; [void]$toInstall.Add($u) }
    $dl = $session.CreateUpdateDownloader(); $dl.Updates = $toInstall; [void]$dl.Download()
    $inst = $session.CreateUpdateInstaller(); $inst.Updates = $toInstall; $r = $inst.Install()
    New-Result ([int]($r.ResultCode -ne 2 -and $r.ResultCode -ne 3)) ("Đã cài $($toInstall.Count) bản. ResultCode=$($r.ResultCode), RebootRequired=$($r.RebootRequired)") @{ installed = $toInstall.Count; reboot_required = [bool]$r.RebootRequired }
  } catch { New-Result 1 "Lỗi khi cài cập nhật: $($_.Exception.Message)" }
}
function Act-Reboot { param($p)
  $o = (& shutdown.exe /r /t ([int]$p.delay_minutes * 60) /c 'Reboot requested from control plane' 2>&1 | Out-String)
  New-Result $LASTEXITCODE "$o`nServer sẽ khởi động lại sau $($p.delay_minutes) phút."
}
function Get-SvcOut { param($verb, $name)
  try {
    switch ($verb) {
      'status'  { $s = Get-Service -Name $name -ErrorAction Stop; return New-Result 0 "$($s.DisplayName) [$($s.Name)]: $($s.Status)" @{ active = [string]$s.Status } }
      'restart' { Restart-Service -Name $name -Force -ErrorAction Stop }
      'start'   { Start-Service -Name $name -ErrorAction Stop }
      'stop'    { Stop-Service -Name $name -Force -ErrorAction Stop }
    }
    $s = Get-Service -Name $name -ErrorAction Stop
    New-Result 0 "$($s.Name): $($s.Status)" @{ active = [string]$s.Status }
  } catch { New-Result 1 $_.Exception.Message }
}
function Act-ServiceList {
  $rows = Get-Service | Where-Object { $_.Status -eq 'Running' } | Sort-Object Name | ForEach-Object { "{0}  {1}" -f $_.Name, $_.DisplayName }
  New-Result 0 ($rows -join "`n")
}
function Act-LogsTail { param($p)
  $logName = if ($p.Contains('unit') -and $p.unit) { $p.unit } else { 'System' }
  try {
    $rows = Get-WinEvent -LogName $logName -MaxEvents $p.lines -ErrorAction Stop |
      ForEach-Object { "{0:s} [{1}] {2}: {3}" -f $_.TimeCreated, $_.LevelDisplayName, $_.ProviderName, ($_.Message -replace "`r?`n", ' ') }
    New-Result 0 (($rows | Select-Object -Last $p.lines) -join "`n")
  } catch { New-Result 1 "Không đọc được log '$logName': $($_.Exception.Message)" }
}
function Get-ListeningPorts {
  $ports = @()
  try {
    $conns = Get-NetTCPConnection -State Listen -ErrorAction Stop
    foreach ($c in $conns) {
      $proc = $null; try { $proc = (Get-Process -Id $c.OwningProcess -ErrorAction Stop).ProcessName } catch {}
      $ports += @{ proto = 'tcp'; local = "$($c.LocalAddress):$($c.LocalPort)"; process = $proc }
    }
  } catch {}
  return $ports
}
function Act-ListeningPorts {
  $ports = Get-ListeningPorts
  New-Result 0 (($ports | ForEach-Object { "{0,-5} {1,-28} {2}" -f $_.proto, $_.local, $_.process }) -join "`n") @{ ports = $ports }
}
function Act-FailedLogins { param($p)
  try {
    $evts = Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 } -MaxEvents $p.lines -ErrorAction Stop
    $counts = @{}
    foreach ($e in $evts) {
      $ip = ($e.Properties | Where-Object { $_.Value -match '^\d{1,3}(\.\d{1,3}){3}$' } | Select-Object -First 1).Value
      if ($ip) { if ($counts.Contains($ip)) { $counts[$ip]++ } else { $counts[$ip] = 1 } }
    }
    $top = $counts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 20
    $header = if ($top) { 'Top IP: ' + (($top | ForEach-Object { "$($_.Key) ($($_.Value))" }) -join ', ') } else { 'Không có đăng nhập thất bại' }
    New-Result 0 $header @{ top_sources = @($top | ForEach-Object { @{ ip = $_.Key; count = $_.Value } }) }
  } catch { New-Result 0 'Không có sự kiện đăng nhập thất bại (hoặc không đủ quyền đọc Security log).' @{ top_sources = @() } }
}
function Act-FirewallStatus {
  try {
    $rows = Get-NetFirewallProfile | ForEach-Object { "{0}: {1}" -f $_.Name, (@('Tắt', 'Bật')[[int][bool]$_.Enabled]) }
    New-Result 0 ($rows -join "`n")
  } catch { New-Result 1 $_.Exception.Message }
}
function Act-FirewallRule { param($p, $action)
  try {
    $name = "InfraAgent $action $($p.proto)/$($p.port)"
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action (@{ allow = 'Allow'; deny = 'Block' }[$action]) -Protocol $p.proto.ToUpper() -LocalPort $p.port -ErrorAction Stop | Out-Null
    New-Result 0 "Đã tạo luật firewall: $name"
  } catch { New-Result 1 $_.Exception.Message }
}
function Act-BlockIp { param($p)
  try {
    New-NetFirewallRule -DisplayName "InfraAgent block $($p.ip)" -Direction Inbound -Action Block -RemoteAddress $p.ip -ErrorAction Stop | Out-Null
    New-Result 0 "Đã chặn IP: $($p.ip)"
  } catch { New-Result 1 $_.Exception.Message }
}
function Act-SecurityAudit {
  $findings = New-Object System.Collections.ArrayList
  $add = { param($sev, $fid, $title, $detail = '') [void]$findings.Add(@{ id = $fid; severity = $sev; title = $title; detail = $detail }) }
  # firewall
  try { if ((Get-NetFirewallProfile | Where-Object { -not $_.Enabled })) { & $add 'medium' 'firewall_off' 'Có profile firewall đang tắt' '' } } catch {}
  # RDP exposure
  try {
    $rdp = (Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction Stop).fDenyTSConnections
    if ($rdp -eq 0) { & $add 'medium' 'rdp_on' 'RDP đang bật' 'Giới hạn bằng firewall / NLA nếu không cần truy cập từ ngoài' }
  } catch {}
  # SMBv1
  try { $smb1 = Get-SmbServerConfiguration -ErrorAction Stop; if ($smb1.EnableSMB1Protocol) { & $add 'high' 'smb1' 'SMBv1 đang bật' 'Tắt SMBv1 (giao thức lỗi thời, nhiều lỗ hổng)' } } catch {}
  # Guest account
  try { $g = Get-LocalUser -Name 'Guest' -ErrorAction Stop; if ($g.Enabled) { & $add 'high' 'guest_on' 'Tài khoản Guest đang bật' '' } } catch {}
  # Defender
  try { $av = Get-MpComputerStatus -ErrorAction Stop; if (-not $av.RealTimeProtectionEnabled) { & $add 'high' 'defender_off' 'Windows Defender real-time đang tắt' '' } } catch {}
  # pending updates
  try { $cnt = (Act-UpdateCheck).result.count; if ($cnt -gt 0) { & $add 'medium' 'updates' "$cnt bản cập nhật chưa cài" '' } } catch {}
  if (Get-PendingReboot) { & $add 'low' 'reboot_required' 'Cần khởi động lại để hoàn tất cập nhật' '' }
  $weights = @{ high = 25; medium = 10; low = 3 }
  $penalty = ($findings | ForEach-Object { $weights[$_.severity] } | Measure-Object -Sum).Sum
  $score = [math]::Max(0, 100 - [int]$penalty)
  $lines = @("Điểm bảo mật: $score/100")
  foreach ($f in $findings) { $lines += ("[{0}] {1}{2}" -f $f.severity.ToUpper(), $f.title, $(if ($f.detail) { " - $($f.detail)" } else { '' })) }
  New-Result 0 ($lines -join "`n") @{ score = $score; findings = @($findings) }
}
function Get-InstalledSoftwareCount {
  $n = 0
  foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    try { $n += (Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName }).Count } catch {}
  }
  return $n
}

function Act-DeepAudit {
  $findings = New-Object System.Collections.ArrayList
  $add = { param($sev, $fid, $title, $detail, $remediation, $fix = $null)
    [void]$findings.Add(@{ id = $fid; severity = $sev; category = 'security'; title = $title; detail = $detail; remediation = $remediation; fix = $fix; refs = @() }) }

  $os = $null; try { $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop } catch {}
  $caption = if ($os) { $os.Caption } else { 'Windows' }
  # 1. EOL Windows versions
  if ($caption -match 'Windows 7|Windows 8 |Windows Server 2008|Windows Server 2012(?!\sR2)|Windows XP|Vista') {
    & $add 'critical' 'os_eol' 'Phiên bản Windows đã hết hỗ trợ (EOL)' "$caption không còn nhận bản vá bảo mật." 'Nâng cấp lên phiên bản Windows còn được hỗ trợ.' $null
  }
  # 2. pending updates
  try {
    $cnt = (Act-UpdateCheck).result.count
    if ($cnt -gt 0) { & $add 'high' 'updates' "$cnt bản cập nhật chưa cài" "Có $cnt cập nhật đang chờ." 'Cài cập nhật. Bấm Khắc phục để agent tự cài.' @{ action = 'system.update_apply'; params = @{ security_only = $true }; label = 'Cài cập nhật bảo mật ngay' } }
  } catch {}
  # 3. SMBv1
  try { if ((Get-SmbServerConfiguration -ErrorAction Stop).EnableSMB1Protocol) { & $add 'high' 'smb1' 'SMBv1 đang bật' 'SMBv1 là giao thức lỗi thời, nhiều lỗ hổng (WannaCry/EternalBlue).' 'Tắt SMBv1. Bấm Khắc phục để agent tắt ngay.' @{ action = 'security.disable_smb1'; params = @{}; label = 'Tắt SMBv1' } } } catch {}
  # 4. Guest account
  try { $g = Get-LocalUser -Name 'Guest' -ErrorAction Stop; if ($g.Enabled) { & $add 'high' 'guest_on' 'Tài khoản Guest đang bật' 'Guest cho phép truy cập ẩn danh.' 'Tắt tài khoản Guest. Bấm Khắc phục để agent tắt.' @{ action = 'security.disable_guest'; params = @{}; label = 'Tắt Guest' } } } catch {}
  # 5. Defender
  try { $av = Get-MpComputerStatus -ErrorAction Stop; if (-not $av.RealTimeProtectionEnabled) { & $add 'high' 'defender_off' 'Windows Defender real-time đang tắt' 'Bảo vệ thời gian thực bị tắt.' 'Bật lại Defender real-time: Set-MpPreference -DisableRealtimeMonitoring $false' $null } } catch {}
  # 6. RDP + NLA
  try {
    $rdp = (Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -ErrorAction Stop).fDenyTSConnections
    if ($rdp -eq 0) {
      $nla = 1; try { $nla = (Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -ErrorAction Stop).UserAuthentication } catch {}
      $sev = if ($nla -eq 0) { 'high' } else { 'medium' }
      & $add $sev 'rdp_on' ('RDP đang bật' + $(if ($nla -eq 0) { ' và tắt NLA' } else { '' })) 'Cổng 3389 mở ra ngoài là mục tiêu dò mật khẩu phổ biến.' 'Giới hạn RDP bằng firewall/VPN; bật Network Level Authentication (NLA).' $null
    }
  } catch {}
  # 7. firewall off
  try { if ((Get-NetFirewallProfile | Where-Object { -not $_.Enabled })) { & $add 'medium' 'firewall_off' 'Có profile firewall đang tắt' 'Một hoặc nhiều profile Windows Firewall đang tắt.' 'Bật Windows Firewall cho mọi profile: Set-NetFirewallProfile -All -Enabled True' $null } } catch {}
  # 8. exposed risky ports
  $risky = @{ '3389' = 'RDP'; '445' = 'SMB'; '1433' = 'MSSQL'; '3306' = 'MySQL'; '5985' = 'WinRM-HTTP' }
  foreach ($c in (Get-ListeningPorts)) {
    $pnum = ($c.local -split ':')[-1]
    if ($risky.ContainsKey($pnum) -and ($c.local -match '^0\.0\.0\.0|^\[::\]|^::')) {
      & $add 'medium' "exposed_$pnum" "$($risky[$pnum]) lắng nghe trên mọi địa chỉ (cổng $pnum)" "Dịch vụ $($risky[$pnum]) mở ra ngoài." 'Giới hạn bằng Windows Firewall hoặc chỉ bind nội bộ.' $null
    }
  }
  # 9. pending reboot
  if (Get-PendingReboot) { & $add 'low' 'reboot_required' 'Cần khởi động lại' 'Có cập nhật chờ reboot.' 'Lên lịch khởi động lại.' $null }

  $weights = @{ critical = 40; high = 25; medium = 10; low = 3 }
  $penalty = ($findings | ForEach-Object { $weights[$_.severity] } | Measure-Object -Sum).Sum
  $score = [math]::Max(0, 100 - [int]$penalty)
  $counts = @{ critical = 0; high = 0; medium = 0; low = 0 }
  foreach ($f in $findings) { $counts[$f.severity]++ }
  $bios = $null; try { $b = Get-CimInstance Win32_BIOS -ErrorAction Stop; $bios = @{ version = $b.SMBIOSBIOSVersion; vendor = $b.Manufacturer; date = [string]$b.ReleaseDate } } catch {}
  $inventory = @{ os = $caption; os_id = 'windows'; version_id = if ($os) { $os.Version } else { '' }; kernel = if ($os) { $os.Version } else { '' }
    arch = $env:PROCESSOR_ARCHITECTURE; packages_count = (Get-InstalledSoftwareCount); bios = $bios; firewall = 'windows-firewall' }
  $lines = @("Điểm an toàn: $score/100 (nghiêm trọng $($counts.critical), cao $($counts.high), trung bình $($counts.medium), thấp $($counts.low))")
  foreach ($f in $findings) { $lines += "[$($f.severity.ToUpper())] $($f.title)" }
  New-Result 0 ($lines -join "`n") @{ score = $score; counts = $counts; findings = @($findings); inventory = $inventory }
}

function Act-DisableSmb1 {
  try {
    Set-SmbServerConfiguration -EnableSMB1Protocol $false -Force -ErrorAction Stop
    try { Disable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol -NoRestart -ErrorAction SilentlyContinue | Out-Null } catch {}
    New-Result 0 'Đã tắt SMBv1.' @{ disabled = $true }
  } catch { New-Result 1 $_.Exception.Message }
}
function Act-DisableGuest {
  try { Disable-LocalUser -Name 'Guest' -ErrorAction Stop; New-Result 0 'Đã tắt tài khoản Guest.' @{ disabled = $true } }
  catch { New-Result 1 $_.Exception.Message }
}

function Act-Shell { param($p, $cfg)
  try {
    $global:LASTEXITCODE = 0
    $out = (& powershell.exe -NoProfile -NonInteractive -Command $p.command 2>&1 | Out-String)
    New-Result $global:LASTEXITCODE $out
  } catch { New-Result 1 $_.Exception.Message }
}

$script:HANDLERS = @{
  'system.info'              = { param($p, $c) Act-SystemInfo }
  'system.disk_usage'        = { param($p, $c) Act-DiskUsage }
  'system.processes'         = { param($p, $c) Act-Processes $p }
  'system.users'             = { param($p, $c) Act-Users }
  'system.update_check'      = { param($p, $c) Act-UpdateCheck }
  'system.update_apply'      = { param($p, $c) Act-UpdateApply $p }
  'system.reboot'            = { param($p, $c) Act-Reboot $p }
  'service.list'             = { param($p, $c) Act-ServiceList }
  'service.status'           = { param($p, $c) Get-SvcOut 'status'  $p.name }
  'service.restart'          = { param($p, $c) Get-SvcOut 'restart' $p.name }
  'service.start'            = { param($p, $c) Get-SvcOut 'start'   $p.name }
  'service.stop'             = { param($p, $c) Get-SvcOut 'stop'    $p.name }
  'logs.tail'                = { param($p, $c) Act-LogsTail $p }
  'security.audit'           = { param($p, $c) Act-SecurityAudit }
  'security.listening_ports' = { param($p, $c) Act-ListeningPorts }
  'security.failed_logins'   = { param($p, $c) Act-FailedLogins $p }
  'security.firewall_status' = { param($p, $c) Act-FirewallStatus }
  'security.firewall_allow'  = { param($p, $c) Act-FirewallRule $p 'allow' }
  'security.firewall_deny'   = { param($p, $c) Act-FirewallRule $p 'deny' }
  'security.block_ip'        = { param($p, $c) Act-BlockIp $p }
  'security.deep_audit'      = { param($p, $c) Act-DeepAudit }
  'security.disable_smb1'    = { param($p, $c) Act-DisableSmb1 }
  'security.disable_guest'   = { param($p, $c) Act-DisableGuest }
  'shell.exec'               = { param($p, $c) Act-Shell $p $c }
}

function Invoke-Task {
  param($Task, $Cfg)
  try {
    $params = Resolve-Params $Task.action $Task.params $Cfg
    $h = $script:HANDLERS[$Task.action]
    if (-not $h) { throw [Rejected]::new("action not implemented on Windows agent: $($Task.action)") }
    $r = & $h $params $Cfg
    $status = if ($r.code -eq 0) { 'succeeded' } else { 'failed' }
    $body = @{ status = $status; exit_code = [int]$r.code; output = (Clip $r.output) }
    if ($null -ne $r.result) { $body.result = $r.result }
    return $body
  } catch [Rejected] {
    return @{ status = 'rejected'; exit_code = $null; output = "Agent từ chối: $($_.Exception.Message)" }
  } catch {
    return @{ status = 'failed'; exit_code = $null; output = "Lỗi agent: $($_.Exception.Message)" }
  }
}

# ----------------------------------------------------------------------------- loops
function Invoke-Enroll {
  $cfg = @{ server_url = $Server.TrimEnd('/') }
  if ($CaFile) { $cfg.ca_file = $CaFile }
  if (-not $cfg.server_url.StartsWith('https://') -and -not $InsecureHttp) { throw 'Refusing to enroll over plain HTTP. Use https:// or pass -InsecureHttp for lab setups.' }
  $cfgObj = [pscustomobject]$cfg
  $resp = Invoke-ApiJson $cfgObj 'POST' '/api/agent/enroll' @{
    token = $Token; version = $script:VERSION; platform = 'windows'
    capabilities = @($script:ACTIONS.Keys); facts = (Get-Facts); metrics = (Get-Metrics)
  }
  $cfg.server_id = $resp.server_id; $cfg.agent_token = $resp.agent_token; $cfg.allow_shell = $false
  Save-Config $Config ([pscustomobject]$cfg)
  Write-Log "Enrolled as $($resp.server_id); config written to $Config"
}

function Invoke-Heartbeat { param($Cfg)
  $resp = Invoke-ApiJson $Cfg 'POST' '/api/agent/heartbeat' @{
    version = $script:VERSION; capabilities = @($script:ACTIONS.Keys); facts = (Get-Facts); metrics = (Get-Metrics)
  } $Cfg.agent_token
  foreach ($task in @($resp.tasks)) {
    Write-Log "task $($task.id): $($task.action)"
    $body = Invoke-Task $task $Cfg
    for ($i = 0; $i -lt 5; $i++) {
      try { Invoke-ApiJson $Cfg 'POST' "/api/agent/tasks/$($task.id)/result" $body $Cfg.agent_token | Out-Null; break }
      catch { Write-Log "result upload failed ($($_.Exception.Message)), retrying"; Start-Sleep -Seconds ([math]::Pow(2, $i)) }
    }
    Write-Log "task $($task.id): $($body.status)"
  }
  if ($resp.poll_interval) { return [int]$resp.poll_interval } else { return 10 }
}

function Invoke-Run { param([switch]$Once)
  $cfg = Read-Config $Config
  Write-Log "infra-agent-win $($script:VERSION) -> $($cfg.server_url) (server $($cfg.server_id), allow_shell=$([bool]$cfg.allow_shell))"
  $backoff = 5
  while ($true) {
    try { $interval = Invoke-Heartbeat $cfg; $backoff = 5 }
    catch { Write-Log "heartbeat failed: $($_.Exception.Message)"; if ($Once) { exit 1 }; Start-Sleep -Seconds $backoff; $backoff = [math]::Min($backoff * 2, 300); continue }
    if ($Once) { return }
    Start-Sleep -Seconds ([math]::Max(1, [math]::Min([int]$interval, 60)))
  }
}

switch ($Command) {
  'enroll'  { Invoke-Enroll }
  'run'     { Invoke-Run }
  'once'    { Invoke-Run -Once }
  'version' { Write-Output $script:VERSION }
  default   { Write-Output 'Usage: infra_agent.ps1 -Command enroll|run|once -Server URL -Token TOKEN' }
}
