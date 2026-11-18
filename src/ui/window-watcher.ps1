# Наблюдатель за окном харнеса: один процесс вместо PowerShell на каждый тик.
# Вход: DSMAP_PID_LIST (PID через запятую), DSMAP_OWNER_PID (PID панели),
#       опционально DSMAP_HWND (окно консоли), DSMAP_TITLE, DSMAP_INTERVAL_MS.
# Выход: NDJSON — {"state":"bounds"...} | minimized | pending | gone. Строка только при смене.

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DsMapWinApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

[int]$interval = 400
if ($env:DSMAP_INTERVAL_MS) { [Void][int]::TryParse($env:DSMAP_INTERVAL_MS, [ref]$interval) }
if ($interval -lt 100) { $interval = 100 }

# Seed-PID'ы наблюдателя: харнес и всё, что он породил (.cmd -> node -> ...).
function Get-WatchSet([int[]]$seeds) {
  $byParent = @{}
  foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)) {
    if ($null -eq $p.ParentProcessId) { continue }
    $k = [string]$p.ParentProcessId
    if (-not $byParent.ContainsKey($k)) { $byParent[$k] = New-Object System.Collections.ArrayList }
    [Void]$byParent[$k].Add([int]$p.ProcessId)
  }
  $set = New-Object System.Collections.Generic.HashSet[int]
  $queue = New-Object System.Collections.Queue
  foreach ($s in $seeds) { [Void]$set.Add($s); $queue.Enqueue($s) }
  while ($queue.Count -gt 0) {
    $pidNow = $queue.Dequeue()
    foreach ($child in $byParent[[string]$pidNow]) {
      if ($set.Add([int]$child)) { $queue.Enqueue([int]$child) }
    }
  }
  return @($set)
}

$seeds = @(($env:DSMAP_PID_LIST -split '[^0-9]+' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ }))
$seeds = @($seeds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
$watch = @(Get-WatchSet $seeds)
# Точный хэндл окна-якоря важнее дерева PID: консоль терминала принадлежит
# Windows Terminal/conhost, которого в нашем дереве процессов нет никогда.
[long]$script:hwnd = 0
if ($env:DSMAP_HWND) { [Void][long]::TryParse($env:DSMAP_HWND, [ref]$script:hwnd) }
# Делегат EnumWindows вызывает PowerShell из неуправляемого кода: локальные
# переменные функции ему не видны, поэтому всё нужное живёт в script-скоупе.
$script:title = if ($env:DSMAP_TITLE) { $env:DSMAP_TITLE.ToLowerInvariant() } else { '' }

$script:best = $null
$script:rb = New-Object System.Text.StringBuilder 512

# Панель — наш родитель. Если Electron убит снаружи, наблюдатель уходит сам:
# иначе powershell переживёт панель и останется крутиться сиротой.
# HasExited, а не Get-Process: мы дети родителя и держим его handle, поэтому
# «процесс найден» ничего не говорит — найден он бывает уже мёртвым.
[int]$script:ownerPid = 0
if ($env:DSMAP_OWNER_PID) { [Void][int]::TryParse($env:DSMAP_OWNER_PID, [ref]$script:ownerPid) }
$ownerGone = {
  if ($script:ownerPid -le 0) { return $false }
  try { return [System.Diagnostics.Process]::GetProcessById($script:ownerPid).HasExited }
  catch { return $true }
}

$filter = [DsMapWinApi+EnumWindowsProc] {
  param($hWnd, $lParam)
  if (-not [DsMapWinApi]::IsWindowVisible($hWnd)) { return $true }
  $procId = 0
  [Void][DsMapWinApi]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  $mine = $script:watch -contains [int]$procId
  if (-not $mine -and $script:title -ne '') {
    [Void]$script:rb.Clear()
    [Void][DsMapWinApi]::GetWindowText($hWnd, $script:rb, $script:rb.Capacity)
    $mine = $script:rb.ToString().ToLowerInvariant().Contains($script:title)
  }
  if (-not $mine) { return $true }
  $rc = New-Object DsMapWinApi+RECT
  [Void][DsMapWinApi]::GetWindowRect($hWnd, [ref]$rc)
  $area = ($rc.Right - $rc.Left) * ($rc.Bottom - $rc.Top)
  if ($null -eq $script:best -or $area -gt $script:best.Area) {
    $script:best = @{
      Area   = $area
      X      = $rc.Left
      Y      = $rc.Top
      Width  = ($rc.Right - $rc.Left)
      Height = ($rc.Bottom - $rc.Top)
      Iconic = [DsMapWinApi]::IsIconic($hWnd)
    }
  }
  return $true
}

# Геометрия якоря: точный hwnd, иначе — самое большое окно из дерева PID.
# Под Windows Terminal `GetConsoleWindow()` даёт служебное невидимое окно
# (или ничего), поэтому hwnd принимается только как реальное видимое окно,
# а иначе наблюдатель откатывается к пребору процессов и заголовка.
$script:anchorDead = $false
function Get-AnchorRect([long]$handle) {
  $h = [IntPtr]$handle
  if (-not [DsMapWinApi]::IsWindow($h)) { return $null }
  if (-not [DsMapWinApi]::IsWindowVisible($h)) { return $null }
  $rc = New-Object DsMapWinApi+RECT
  if (-not [DsMapWinApi]::GetWindowRect($h, [ref]$rc)) { return $null }
  $w = $rc.Right - $rc.Left
  $hh = $rc.Bottom - $rc.Top
  $iconic = [DsMapWinApi]::IsIconic($h)
  # Свернутое окно Windows показывает координаты за экраном: для него размер
  # не проверка, его и так надо прятать вместе с панелью.
  if (-not $iconic -and ($w -lt 40 -or $hh -lt 40)) { return $null }
  return @{ Area = ($w * $hh); X = $rc.Left; Y = $rc.Top; Width = $w; Height = $hh; Iconic = $iconic }
}

function Get-Anchor {
  $script:best = $null
  if ($script:hwnd -gt 0) {
    $rect = Get-AnchorRect $script:hwnd
    if ($null -eq $rect) {
      # Мёртвый hwnd — это закрытая консоль; невидимый — просто Windows Terminal.
      if (-not [DsMapWinApi]::IsWindow([IntPtr]$script:hwnd)) { $script:anchorDead = $true; return }
    } else {
      $script:best = $rect
      return
    }
  }
  [Void][DsMapWinApi]::EnumWindows($filter, [IntPtr]::Zero)
}

$ticks = 0
$last = ''
while ($true) {
  if (& $ownerGone) { break }
  $alive = @($watch | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  # Родитель умер, но его потомки живы — следим за ними; дерево обновляем раз в ~2 секунды.
  if ($alive.Count -eq 0 -and $seeds.Count -gt 0) {
    # Seed умер, но харнес мог переехать в потомка (.cmd-обёртка) — пересобираем дерево.
    $seeds = @(($env:DSMAP_PID_LIST -split '[^0-9]+' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ }))
    $alive = @(Get-WatchSet $seeds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  }
  if ($alive.Count -eq 0 -and $script:hwnd -le 0) {
    [Console]::Out.WriteLine('{"state":"gone"}'); [Console]::Out.Flush()
    break
  }
  $watch = $alive
  $ticks++
  if (($ticks % 5) -eq 0 -and $alive.Count -gt 0) { $watch = @(Get-WatchSet $watch) }

  Get-Anchor
  if ($script:anchorDead) {
    # Окно консоли закрылось: харнесу уже некуда возвращаться, панель не нужна.
    [Console]::Out.WriteLine('{"state":"gone"}'); [Console]::Out.Flush()
    break
  }

  if ($null -eq $script:best) {
    $line = '{"state":"pending"}'
  } elseif ($script:best.Iconic) {
    $line = '{"state":"minimized"}'
  } else {
    $line = ('{{"state":"bounds","x":{0},"y":{1},"width":{2},"height":{3}}}' -f `
        $script:best.X, $script:best.Y, $script:best.Width, $script:best.Height)
  }
  if ($line -ne $last) {
    $last = $line
    [Console]::Out.WriteLine($line); [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds $interval
}
