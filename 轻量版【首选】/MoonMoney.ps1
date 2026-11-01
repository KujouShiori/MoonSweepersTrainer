<#
  MoonMoney.ps1 —— 不安装任何东西，用 Windows 自带的 PowerShell 直接改
                   Moon Sweepers 的团队钱包（session.moon）。

  它就是把手动流程自动化：解压 → 找到钱包那 16 个字节 → 改数字 →
  重算 SHA256 → 重新压缩 → 写回。原理和 MoonTrainer 完全一样，只是不依赖它。

  用法（先彻底退出游戏！）：
    powershell -ExecutionPolicy Bypass -File MoonMoney.ps1 -Money 1000000
    powershell -ExecutionPolicy Bypass -File MoonMoney.ps1 -Money 88888 -SaveFile "完整路径\session.moon"
    powershell -ExecutionPolicy Bypass -File MoonMoney.ps1 -Money 1000 -DryRun   # 只看不改
#>
param(
  [string]$Money,       # 不给就走交互式提问
  [string]$SaveFile,
  [switch]$Add,         # 加钱模式：在现有金额上加上 -Money
  [switch]$DryRun       # 只看不改
)

$ErrorActionPreference = 'Stop'

try { Add-Type -AssemblyName System.Numerics -ErrorAction SilentlyContinue } catch { }
try { Add-Type -AssemblyName System.IO.Compression -ErrorAction SilentlyContinue } catch { }

$MAGIC = 1296257073
# 注意：PowerShell 变量名不区分大小写，所以这个常量千万别叫 $SCALE，
# 否则函数里常用的局部变量 $scale 会把它覆盖掉（踩过这个坑）。
$DECIMALS = 10
$script:o = 0

# ---------- 小工具 ----------
function Read7($buf) {
  $n = [long]0; $shift = 0
  while ($true) {
    if ($script:o -ge $buf.Length) { throw '存档结构解析越界（unexpected end of file）' }
    $b = $buf[$script:o]; $script:o++
    $n = $n -bor ([long]($b -band 0x7f) -shl $shift)
    $shift += 7
    if (($b -band 0x80) -eq 0) { break }
  }
  return $n
}
function ReadStr($buf) {
  $n = Read7 $buf
  if ($script:o + $n -gt $buf.Length) { throw '存档结构解析越界（string）' }
  $s = [System.Text.Encoding]::UTF8.GetString($buf, $script:o, [int]$n)
  $script:o += [int]$n
  return $s
}
function ReadI32($buf) {
  if ($script:o + 4 -gt $buf.Length) { throw '存档结构解析越界（i32）' }
  $v = [BitConverter]::ToInt32($buf, $script:o); $script:o += 4; return $v
}
function Skip($buf, $n) {
  if ($n -lt 0 -or $script:o + $n -gt $buf.Length) { throw '存档结构解析越界（skip）' }
  $script:o += [int]$n
}
function ReadF64($buf) { Skip $buf 8 }
function ReadF32($buf) { Skip $buf 4 }
function ReadBool($buf) { Skip $buf 1 }

function MoneyToScaled([string]$text) {
  $s = $text.Trim() -replace '[$,\s]', ''
  if ($s -notmatch '^\d+(\.\d{0,10})?$') { throw "金额写法不对：'$text'（只能是非负数字，最多 10 位小数，例如 1000000 或 1234.56）" }
  $parts = $s -split '\.'
  $frac = if ($parts.Count -gt 1) { $parts[1] } else { '' }
  return [System.Numerics.BigInteger]::Parse($parts[0] + $frac.PadRight($DECIMALS, '0'))
}
function ShowMoney($scaled) {
  $neg = $scaled -lt 0
  $abs = [System.Numerics.BigInteger]::Abs($scaled)
  $s = $abs.ToString().PadLeft($DECIMALS + 1, '0')
  $s = $s.Substring(0, $s.Length - $DECIMALS) + '.' + $s.Substring($s.Length - $DECIMALS)
  $s = $s.TrimEnd('0').TrimEnd('.')
  if ($neg) { '-' + $s } else { $s }
}
function Pow10([int]$n) {
  # 也别用 [BigInteger]::Pow(10, $a - $b)：PowerShell 在方法参数里会把
  # "$a - $b" 解析成别的东西（实测得到 1）。这里老老实实循环。
  $r = [System.Numerics.BigInteger]::One
  for ($i = 0; $i -lt $n; $i++) { $r = $r * 10 }
  return $r
}
function DecimalToScaled($buf, $off) {
  $lo = [BitConverter]::ToUInt32($buf, $off)
  $mid = [BitConverter]::ToUInt32($buf, $off + 4)
  $hi = [BitConverter]::ToUInt32($buf, $off + 8)
  $flags = [BitConverter]::ToUInt32($buf, $off + 12)
  $scale = [int](($flags -shr 16) -band 0xff)
  $negative = (($flags -shr 31) -band 1) -eq 1
  $v = ([System.Numerics.BigInteger]$hi -shl 64) -bor ([System.Numerics.BigInteger]$mid -shl 32) -bor [System.Numerics.BigInteger]$lo
  if ($scale -gt $DECIMALS) { $v = [System.Numerics.BigInteger]($v / (Pow10 ($scale - $DECIMALS))) }
  elseif ($scale -lt $DECIMALS) { $v = $v * (Pow10 ($DECIMALS - $scale)) }
  if ($negative) { $v = -$v }
  return $v
}
function WriteDecimalScaled($buf, $off, $value) {
  $mask = [System.Numerics.BigInteger]::Parse('4294967295')
  $lo = [uint32]([System.Numerics.BigInteger]($value -band $mask))
  $mid = [uint32]([System.Numerics.BigInteger](($value -shr 32) -band $mask))
  $hi = [uint32]([System.Numerics.BigInteger](($value -shr 64) -band $mask))
  [Array]::Copy([BitConverter]::GetBytes($lo), 0, $buf, $off, 4)
  [Array]::Copy([BitConverter]::GetBytes($mid), 0, $buf, $off + 4, 4)
  [Array]::Copy([BitConverter]::GetBytes($hi), 0, $buf, $off + 8, 4)
  [Array]::Copy([BitConverter]::GetBytes([uint32](($DECIMALS -shl 16))), 0, $buf, $off + 12, 4)
}

# ---------- 解析存档，返回每个钱包的「金额字段」偏移 ----------
function Get-WalletRecords($payload) {
  $script:o = 0
  $version = ReadI32 $payload
  if ($version -lt 19 -or $version -gt 35) { throw "存档版本 $version 不受支持（本脚本支持 19..35）" }
  $identity = ReadStr $payload
  [void](ReadI32 $payload)                 # seed
  [void](ReadStr $payload)                 # settings

  $regionCount = ReadI32 $payload
  if ($regionCount -lt 0 -or $regionCount -gt 2000000) { throw '地区数量异常' }
  Skip $payload $regionCount

  $chunkCount = ReadI32 $payload
  if ($chunkCount -lt 0 -or $chunkCount -gt 24576) { throw '区块数量异常' }
  for ($i = 0; $i -lt $chunkCount; $i++) {
    [void](ReadI32 $payload)
    [void](ReadStr $payload)
    $coarse = ReadI32 $payload
    if ($coarse -lt 0 -or $coarse -gt 600000000) { throw '区块数据长度异常' }
    Skip $payload $coarse
  }

  [void](ReadI32 $payload); ReadF64 $payload
  $pileCount = ReadI32 $payload
  if ($pileCount -lt 0 -or $pileCount -gt 2000000) { throw '物料堆数量异常' }
  for ($i = 0; $i -lt $pileCount; $i++) {
    [void](ReadI32 $payload); ReadF32 $payload; ReadF32 $payload; ReadF32 $payload; ReadF64 $payload
  }
  ReadF64 $payload; ReadBool $payload; ReadF64 $payload
  $invCount = ReadI32 $payload
  if ($invCount -lt 0 -or $invCount -gt 10000) { throw '仓库数量异常' }
  for ($i = 0; $i -lt $invCount; $i++) { [void](ReadStr $payload); ReadF64 $payload }
  ReadF64 $payload

  $walletCount = ReadI32 $payload
  if ($walletCount -lt 0 -or $walletCount -gt 10000) { throw '钱包记录数量异常' }
  $records = New-Object System.Collections.ArrayList
  for ($i = 0; $i -lt $walletCount; $i++) {
    $player = ReadStr $payload
    $off = $script:o
    $dollars = DecimalToScaled $payload $off
    Skip $payload 16                       # dollars
    Skip $payload 16                       # pending
    [void]$records.Add([pscustomobject]@{ Player = $player; Off = $off; Dollars = $dollars })
  }

  # 钱包后面还有一大堆区段，这里只看钱包，后面的不用解析
  return [pscustomobject]@{ Version = $version; Identity = $identity; Records = $records }
}

function Load-Envelope([string]$file) {
  $raw = [System.IO.File]::ReadAllBytes($file)
  if ($raw.Length -lt 16) { throw '文件太小，不像存档' }
  if ([BitConverter]::ToInt32($raw, 0) -ne $MAGIC) { throw '这不是 Moon Sweepers 存档（缺少 MCP1 标记）' }
  $len = [BitConverter]::ToInt32($raw, 4)
  if ($len -lt 0 -or $len -gt 600000000) { throw '存档长度字段异常' }
  $script:o = 8
  $headerHash = ReadStr $raw
  $gzLen = $raw.Length - $script:o
  $ms = New-Object System.IO.MemoryStream($raw, $script:o, $gzLen)
  $gzs = New-Object System.IO.Compression.GZipStream($ms, [System.IO.Compression.CompressionMode]::Decompress)
  $out = New-Object System.IO.MemoryStream
  $gzs.CopyTo($out)
  $gzs.Dispose(); $ms.Dispose()
  $payload = $out.ToArray()
  $out.Dispose()
  if ($payload.Length -ne $len) { throw '解压后长度和文件头不一致' }
  return [pscustomobject]@{ Raw = $raw; Payload = $payload; HeaderHash = $headerHash }
}

function New-Envelope($payload) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hexHash = -join ($sha.ComputeHash($payload) | ForEach-Object { $_.ToString('x2') })
  $ms = New-Object System.IO.MemoryStream
  $ms.Write($payload, 0, $payload.Length)
  $ms.Position = 0
  $gz = New-Object System.IO.MemoryStream
  $gzs = New-Object System.IO.Compression.GZipStream($gz, [System.IO.Compression.CompressionMode]::Compress)
  $ms.CopyTo($gzs)
  $gzs.Dispose(); $ms.Dispose()
  $gzBytes = $gz.ToArray(); $gz.Dispose()

  $head = New-Object System.Collections.Generic.List[byte]
  $head.AddRange([BitConverter]::GetBytes([int32]$MAGIC))
  $head.AddRange([BitConverter]::GetBytes([int32]$payload.Length))
  $hb = [System.Text.Encoding]::UTF8.GetBytes($hexHash)
  $head.Add([byte]$hb.Length)
  $head.AddRange($hb)
  return $head.ToArray() + $gzBytes
}

function Get-SaveRoot {
  Join-Path $env:USERPROFILE 'AppData\LocalLow\DragDropGames\MoonSweepers\MoonSessions'
}

function Find-Saves {
  $root = Get-SaveRoot
  $list = New-Object System.Collections.ArrayList
  if (-not (Test-Path -LiteralPath $root)) { return $list }
  foreach ($slotDir in Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue) {
    if ($slotDir.Name -notmatch '^slot-(\d+)$') { continue }
    $slot = [int]$Matches[1]
    foreach ($worldDir in Get-ChildItem -LiteralPath $slotDir.FullName -Directory -ErrorAction SilentlyContinue) {
      $file = Join-Path $worldDir.FullName 'session.moon'
      if (-not (Test-Path -LiteralPath $file)) { continue }
      $walletText = '?'
      try {
        $env2 = Load-Envelope $file
        $info = Get-WalletRecords $env2.Payload
        $sum = [System.Numerics.BigInteger]::Zero
        foreach ($r in $info.Records) { $sum += $r.Dollars }
        $walletText = ShowMoney $sum
      } catch { }
      [void]$list.Add([pscustomobject]@{
          File = $file; Slot = $slot; World = $worldDir.Name
          Wallet = $walletText; Modified = (Get-Item -LiteralPath $file).LastWriteTime
        })
    }
  }
  return @($list | Sort-Object Modified -Descending)
}

# ---------- 主流程 ----------
function Assert-GameClosed {
  $p = Get-Process -Name 'MoonSweepers' -ErrorAction SilentlyContinue
  if ($p) { throw '游戏还在运行！请先完全退出到桌面，再运行本脚本。' }
}

if (-not $Money) {
  $tip = if ($Add) { '要加多少钱？（直接回车 = 1000000）' } else { '要改成多少钱？（直接回车 = 1000000）' }
  $Money = (Read-Host $tip).Trim()
  if (-not $Money) { $Money = '1000000' }
}
$target = MoneyToScaled $Money
if ($target -lt 0) { throw '金额不能是负数' }
# 游戏里金额是 96 位整数（除以 10^10 才是美元），硬上限 = 2^96 / 10^10 ≈ 7.9e18 美元
$MAX_SCALED = [System.Numerics.BigInteger]::Parse('79228162514264337593543950336')
if ($target -ge $MAX_SCALED) {
  throw '金额太大了，游戏存不下。上限约 7,922,816,251,426,433,759 美元；平时改成一百万就够了。'
}

$file = $SaveFile
if (-not $file) {
  $saves = Find-Saves
  if (-not $saves -or $saves.Count -eq 0) {
    throw "没找到存档。请先在游戏里创建存档并退出游戏。默认位置：`n  $(Get-SaveRoot)"
  }
  Write-Host ''
  Write-Host '找到这些存档（新的在前）：' -ForegroundColor Cyan
  for ($i = 0; $i -lt $saves.Count; $i++) {
    Write-Host ("  {0}) slot-{1}  世界 {2}  钱包 `${3}  {4}" -f ($i + 1), $saves[$i].Slot, $saves[$i].World.Substring(0, [Math]::Min(12, $saves[$i].World.Length)), $saves[$i].Wallet, $saves[$i].Modified)
    Write-Host ("     " + $saves[$i].File) -ForegroundColor DarkGray
  }
  $file = $saves[0].File
  if ($saves.Count -gt 1) {
    $pick = (Read-Host "`n要改第几个？(直接回车 = 1)").Trim()
    if ($pick) {
      $idx = 0
      if (-not [int]::TryParse($pick, [ref]$idx) -or $idx -lt 1 -or $idx -gt $saves.Count) { throw '输入的序号无效' }
      $file = $saves[$idx - 1].File
    }
  }
}

if (-not (Test-Path -LiteralPath $file)) { throw "找不到文件：$file" }
Assert-GameClosed

$env1 = Load-Envelope $file
$info = Get-WalletRecords $env1.Payload
if ($info.Records.Count -eq 0) { throw '存档里没有钱包记录' }

$team = $info.Records | Where-Object { $_.Player -eq 'team' } | Select-Object -First 1
if (-not $team) { $team = $info.Records[0] }

$oldTotal = [System.Numerics.BigInteger]::Zero
foreach ($r in $info.Records) { $oldTotal += $r.Dollars }
if ($Add) { $target = $oldTotal + $target }

Write-Host ''
Write-Host "文件： $file"
Write-Host "身份： $($info.Identity)   存档版本： $($info.Version)"
Write-Host "钱包记录：" -NoNewline
foreach ($r in $info.Records) { Write-Host (" [$($r.Player)=`$$(ShowMoney $r.Dollars)]") -NoNewline }
Write-Host ''
Write-Host "团队钱包： `$$(ShowMoney $oldTotal)   ->   `$$(ShowMoney $target)" -ForegroundColor Yellow

if ($DryRun) { Write-Host "`n-DryRun：只查看，没有写入。" -ForegroundColor Green; return }

# 备份
$stamp = Get-Date -Format 'yyyyMMddHHmmssfff'
$backup = "$file.money-backup-$stamp"
Copy-Item -LiteralPath $file -Destination $backup

# 改：team 记录 = 目标金额，其它记录清零（和 MoonTrainer 的行为一致）
$payload = [byte[]]$env1.Payload.Clone()
foreach ($r in $info.Records) {
  if ($r.Player -eq $team.Player) { WriteDecimalScaled $payload $r.Off $target }
  else { WriteDecimalScaled $payload $r.Off ([System.Numerics.BigInteger]::Zero) }
}

$out = New-Envelope $payload
$tmp = "$file.ps-tmp"
[System.IO.File]::WriteAllBytes($tmp, $out)
Move-Item -LiteralPath $tmp -Destination $file -Force

# 回读校验
$env2 = Load-Envelope $file
$info2 = Get-WalletRecords $env2.Payload
$newTotal = [System.Numerics.BigInteger]::Zero
foreach ($r in $info2.Records) { $newTotal += $r.Dollars }
$ok = $true
if ($newTotal -ne $target) { $ok = $false; Write-Host '校验失败：读回来的金额不对' -ForegroundColor Red }
if ($env2.HeaderHash -ne (-join ([System.Security.Cryptography.SHA256]::Create().ComputeHash($env2.Payload) | ForEach-Object { $_.ToString('x2') }))) {
  $ok = $false; Write-Host '校验失败：文件头 SHA256 对不上' -ForegroundColor Red
}
if ($env1.Payload.Length -ne $env2.Payload.Length) { $ok = $false; Write-Host '校验失败：正文长度变了' -ForegroundColor Red }
$a = [byte[]]$env1.Payload.Clone(); $b = [byte[]]$env2.Payload.Clone()
foreach ($r in $info.Records) {
  [Array]::Clear($a, $r.Off, 16); [Array]::Clear($b, $r.Off, 16)
}
if (-not ($null -eq (Compare-Object $a $b -SyncWindow 0))) { $ok = $false; Write-Host '校验失败：钱包以外的字节被改动了' -ForegroundColor Red }

if (-not $ok) {
  Copy-Item -LiteralPath $backup -Destination $file -Force
  throw "写入校验失败，已自动还原原文件。备份：$backup"
}

Write-Host "`n成功！团队钱包 = `$$(ShowMoney $newTotal)" -ForegroundColor Green
Write-Host "备份文件： $backup" -ForegroundColor DarkGray
Write-Host '现在启动游戏，读取这个存档即可。主菜单上的旧数字会在下次游戏保存后更新。'
