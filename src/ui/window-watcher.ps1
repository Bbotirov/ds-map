# Наблюдатель за окном харнеса: один процесс вместо PowerShell на каждый тик.
# Вход: DSMAP_PID_LIST (PID через запятую), DSMAP_OWNER_PID (PID панели),
#       опционально DSMAP_HWND (окно консоли), DSMAP_TITLE, DSMAP_INTERVAL_MS.
# Выход: NDJSON — {"state":"bounds"...,"anchor":"hwnd|tree|parent|title"} |
#        minimized | pending | gone. Строка только при смене.

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
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

[int]$interval = 400
if ($env:DSMAP_INTERVAL_MS) { [Void][int]::TryParse($env:DSMAP_INTERVAL_MS, [ref]$interval) }
if ($interval -lt 100) { $interval = 100 }

# Предок, который окно харнеса дать не может в принципе: обрываем цепочку на нём,
# иначе панель начнёт пристёгиваться к рабочему столу или к службе.
$script:stopNames = @('explorer.exe', 'winlogon.exe', 'services.exe', 'svchost.exe', 'memory compression')
# Рабочий стол формально тоже «видимое окно всего экрана» от explorer.exe.
$script:deskClasses = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd')
$script:vsW = [DsMapWinApi]::GetSystemMetrics(78)
$script:vsH = [DsMapWinApi]::GetSystemMetrics(79)
if ($script:vsW -le 0 -or $script:vsH -le 0) { $script:vsW = [int]::MaxValue; $script:vsH = [int]::MaxValue }
$GW_OWNER = 4

# Снимок таблицы процессов: одно CimInstance кормит и дерево потомков, и цепочку
# предков. Второй запрос на каждый тик стоил бы дороже самого перебора окон.
$script:byParent = @{}
$script:parentOf = @{}
$script:nameOf = @{}

function Update-Procs {
  $bp = @{}
  $po = @{}
  $nm = @{}
  foreach ($p in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name)) {
    if ($null -eq $p.ProcessId) { continue }
    $procId = [int]$p.ProcessId
    $nm[[string]$procId] = [string]$p.Name
    if ($null -eq $p.ParentProcessId) { continue }
    $parent = [int]$p.ParentProcessId
    $po[[string]$procId] = $parent
    $k = [string]$parent
    if (-not $bp.ContainsKey($k)) { $bp[$k] = New-Object System.Collections.ArrayList }
    [Void]$bp[$k].Add($procId)
  }
  $script:byParent = $bp
  $script:parentOf = $po
  $script:nameOf = $nm
}

# Seed-PID'ы наблюдателя: харнес и всё, что он породил (.cmd -> node -> ...).
function Get-WatchSet([int[]]$seeds) {
  $set = New-Object System.Collections.Generic.HashSet[int]
  $queue = New-Object System.Collections.Queue
  foreach ($s in $seeds) { [Void]$set.Add($s); $queue.Enqueue($s) }
  while ($queue.Count -gt 0) {
    $pidNow = $queue.Dequeue()
    foreach ($child in $script:byParent[[string]$pidNow]) {
      if ($set.Add([int]$child)) { $queue.Enqueue([int]$child) }
    }
  }
  return @($set)
}

# Панель — тоже потомок шелла, который мы раскрываем в дерево, и её собственное
# окно попало бы в якоря: панель пристёгивала бы сама себя и уезжала вправо на
# каждый тик. Поддерево владельца наблюдателя из дерева вычёркиваем.
function Remove-OwnerTree([int[]]$set) {
  if ($script:ownerPid -le 0) { return @($set) }
  $blocked = New-Object 'System.Collections.Generic.HashSet[int]'
  $queue = New-Object System.Collections.Queue
  [Void]$blocked.Add($script:ownerPid); $queue.Enqueue($script:ownerPid)
  while ($queue.Count -gt 0) {
    $procId = $queue.Dequeue()
    foreach ($child in $script:byParent[[string]$procId]) {
      if ($blocked.Add([int]$child)) { $queue.Enqueue([int]$child) }
    }
  }
  return @($set | Where-Object { -not $blocked.Contains([int]$_) })
}

# Предки seed'ов с глубиной: терминал — родитель шелла, а не его потомок, поэтому
# дерева PID его не видит никогда (VS Code/Windows Terminal живут выше по цепочке).
# Ближайший окно-владелец и есть то окно, в котором сидит пользователь, поэтому
# глубину сохраняем и позже выбираем минимум, а не самое большое окно.
function Get-ParentWants([int[]]$seeds) {
  $want = @{}
  foreach ($seed in $seeds) {
    $procId = [int]$seed
    for ($depth = 0; $depth -lt 8; $depth++) {
      $parent = $script:parentOf[[string]$procId]
      if ($null -eq $parent) { break }
      $parent = [int]$parent
      # 0/4 — System Idle и System, цикл = испорченный снимок: дальше не идём.
      if ($parent -le 4 -or $parent -eq $procId) { break }
      $name = [string]$script:nameOf[[string]$parent]
      if ($script:stopNames -contains $name.ToLowerInvariant()) { break }
      $key = [string]$parent
      if (-not $want.ContainsKey($key) -or [int]$want[$key] -gt ($depth + 1)) { $want[$key] = $depth + 1 }
      $procId = $parent
    }
  }
  return $want
}

# Панель — наш родитель. Её PID нужен и до первого дерева: поддерево панели
# вычёркивается из якорей, иначе панель следит за собой.
[int]$script:ownerPid = 0
if ($env:DSMAP_OWNER_PID) { [Void][int]::TryParse($env:DSMAP_OWNER_PID, [ref]$script:ownerPid) }

$seeds = @(($env:DSMAP_PID_LIST -split '[^0-9]+' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ }))
# Отдельно от `$seeds`: их там не было вовсе — это ручной запуск панели с одним
# `--anchor-hwnd`, следить не за чем, но и закрывать панель причин нет.
$havePids = [bool]($env:DSMAP_PID_LIST -match '\d')
$seeds = @($seeds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
[Void](Update-Procs)
$watch = Remove-OwnerTree (Get-WatchSet $seeds)
# Точный хэндл окна-якоря важнее дерева PID: консоль терминала принадлежит
# Windows Terminal/conhost, которого в нашем дереве процессов нет никогда.
[long]$script:hwnd = 0
if ($env:DSMAP_HWND) { [Void][long]::TryParse($env:DSMAP_HWND, [ref]$script:hwnd) }
# Делегат EnumWindows вызывает PowerShell из неуправляемого кода: локальные
# переменные функции ему не видны, поэтому всё нужное живёт в script-скоупе.
$script:title = if ($env:DSMAP_TITLE) { $env:DSMAP_TITLE.ToLowerInvariant() } else { '' }
$script:want = Get-ParentWants $seeds

$script:best = $null
$script:bestKey = ''
$script:hits = @{}
$script:byTitle = $null
$script:byTitleKey = ''
$script:anchorKind = ''
$script:anchorProc = ''
$script:rb = New-Object System.Text.StringBuilder 512
$script:cb = New-Object System.Text.StringBuilder 128

# Панель — наш родитель. Если Electron убит снаружи, наблюдатель уходит сам:
# иначе powershell переживёт панель и останется крутиться сиротой.
# HasExited, а не Get-Process: мы дети родителя и держим его handle, поэтому
# «процесс найден» ничего не говорит — найден он бывает уже мёртвым.
$ownerGone = {
  if ($script:ownerPid -le 0) { return $false }
  try { return [System.Diagnostics.Process]::GetProcessById($script:ownerPid).HasExited }
  catch { return $true }
}

# Один проход EnumWindows наполняет три независимых корзины — дерево PID,
# предков и заголовок: приоритет между ними выбирает уже Get-Anchor.
$filter = [DsMapWinApi+EnumWindowsProc] {
  param($hWnd, $lParam)
  if (-not [DsMapWinApi]::IsWindowVisible($hWnd)) { return $true }
  $procId = 0
  [Void][DsMapWinApi]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  $key = [string][int]$procId
  $mine = $script:watch -contains [int]$procId
  $up = $script:want.ContainsKey($key)
  $named = $false
  if ($script:title -ne '' -and -not $mine) {
    [Void]$script:rb.Clear()
    [Void][DsMapWinApi]::GetWindowText($hWnd, $script:rb, $script:rb.Capacity)
    $named = $script:rb.ToString().ToLowerInvariant().Contains($script:title)
  }
  if (-not $mine -and -not $up -and -not $named) { return $true }
  $rc = New-Object DsMapWinApi+RECT
  [Void][DsMapWinApi]::GetWindowRect($hWnd, [ref]$rc)
  $w = $rc.Right - $rc.Left
  $hh = $rc.Bottom - $rc.Top
  $rect = @{
    Area   = ($w * $hh)
    X      = $rc.Left
    Y      = $rc.Top
    Width  = $w
    Height = $hh
    Iconic = [DsMapWinApi]::IsIconic($hWnd)
  }
  # То же правило размера, что у Get-AnchorRect: под ConPTY у самого шелла есть
  # «видимое» окно 0x0, и без него наблюдатель пристыковался бы к точке 0,0,
  # так и не дойдя до окна терминала.
  $plausible = if ($rect.Iconic) { $true } else { ($w -ge 40 -and $hh -ge 40) }
  if ($mine -and $plausible) {
    # Для дерева PID других проверок нет: окно харнеса бывает и маленьким,
    # и свёрнутым, а конкурентов у него в этом наборе нет.
    if ($null -eq $script:best -or $rect.Area -gt $script:best.Area) { $script:best = $rect; $script:bestKey = $key }
  }
  if ($named -and $plausible) {
    if ($null -eq $script:byTitle -or $rect.Area -gt $script:byTitle.Area) { $script:byTitle = $rect; $script:byTitleKey = $key }
  }
  if ($up -and $plausible) {
    # Кандидат в якоря — только настоящее окно приложения: owned-диалог, тултип
    # или рабочий стол присоседить панель нельзя.
    $ok = $true
    if ([DsMapWinApi]::GetWindow($hWnd, $GW_OWNER) -ne [IntPtr]::Zero) { $ok = $false }
    if ($ok -and -not $rect.Iconic -and $w -ge $script:vsW -and $hh -ge $script:vsH) {
      if ([string]$script:nameOf[$key] -eq 'explorer.exe') { $ok = $false }
    }
    if ($ok) {
      [Void]$script:cb.Clear()
      [Void][DsMapWinApi]::GetClassName($hWnd, $script:cb, $script:cb.Capacity)
      if ($script:deskClasses -notcontains $script:cb.ToString()) { $script:hits[$key] = $rect }
    }
  }
  return $true
}

# Геометрия якоря: точный hwnd, иначе — окно из дерева PID, иначе окно ближайшего
# предка, иначе заголовок.
# Под Windows Terminal `GetConsoleWindow()` даёт служебное невидимое окно
# (или ничего), поэтому hwnd принимается только как реальное видимое окно,
# а иначе наблюдатель откатывается к пребору процессов.
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

function Get-ProcName([string]$key) {
  $name = [string]$script:nameOf[$key]
  if ($name) { return $name }
  [int]$procId = 0
  if ([int]::TryParse($key, [ref]$procId) -and $procId -gt 0) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p) { return [string]$p.ProcessName }
  }
  return ''
}

function Get-Anchor {
  $script:best = $null
  $script:bestKey = ''
  $script:hits = @{}
  $script:byTitle = $null
  $script:byTitleKey = ''
  $script:anchorKind = ''
  $script:anchorProc = ''
  if ($script:hwnd -gt 0) {
    $rect = Get-AnchorRect $script:hwnd
    if ($null -eq $rect) {
      # Мёртвый hwnd — это закрытая консоль; невидимый — просто Windows Terminal.
      if (-not [DsMapWinApi]::IsWindow([IntPtr]$script:hwnd)) { $script:anchorDead = $true; return }
    } else {
      $script:best = $rect
      $script:anchorKind = 'hwnd'
      $owner = 0
      [Void][DsMapWinApi]::GetWindowThreadProcessId([IntPtr]$script:hwnd, [ref]$owner)
      $script:anchorProc = Get-ProcName ([string][int]$owner)
      return
    }
  }
  [Void][DsMapWinApi]::EnumWindows($filter, [IntPtr]::Zero)
  if ($null -ne $script:best) {
    $script:anchorKind = 'tree'
    $script:anchorProc = Get-ProcName $script:bestKey
    return
  }
  $pick = $null
  $pickKey = ''
  $pickDepth = 99
  foreach ($key in $script:hits.Keys) {
    $depth = [int]$script:want[$key]
    if ($depth -lt $pickDepth) { $pickDepth = $depth; $pick = $script:hits[$key]; $pickKey = $key }
  }
  if ($null -ne $pick) {
    $script:best = $pick
    $script:anchorKind = 'parent'
    $script:anchorProc = Get-ProcName $pickKey
    return
  }
  if ($null -ne $script:byTitle) {
    $script:best = $script:byTitle
    $script:anchorKind = 'title'
    $script:anchorProc = Get-ProcName $script:byTitleKey
  }
}

$ticks = 0
# Сколько подряд тиков ни одного живого процесса харнеса. Запас нужен не для
# «харнес завершился», а для ложных пропусков: Win32_Process и Get-Process
# на мгновение не видят чужой процесс, а без запаса панель умирала бы сама.
$dead = 0
$deadGrace = 3
$last = ''
while ($true) {
  if (& $ownerGone) { break }
  $alive = @($watch | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  # Родитель умер, но его потомки живы — следим за ними; дерево обновляем раз в ~2 секунды.
  if ($alive.Count -eq 0 -and $seeds.Count -gt 0) {
    # Seed умер, но харнес мог переехать в потомка (.cmd-обёртка) — пересобираем дерево.
    $seeds = @(($env:DSMAP_PID_LIST -split '[^0-9]+' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ }))
    [Void](Update-Procs)
    $alive = @(Remove-OwnerTree (Get-WatchSet $seeds) | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    $script:want = Get-ParentWants $seeds
  }
  if ($alive.Count -eq 0 -and $havePids) { $dead++ } else { $dead = 0 }
  # Узкое место — процессы харнеса, а не окно: VS Code переживёт `dsh` и висел бы
  # якорем вечно. Панель закрывает лаунчер (молчание его порта), здесь это страховка.
  if ($dead -ge $deadGrace) {
    [Console]::Out.WriteLine('{"state":"gone"}'); [Console]::Out.Flush()
    break
  }
  $watch = $alive
  $ticks++
  if (($ticks % 5) -eq 0 -and $alive.Count -gt 0) {
    [Void](Update-Procs)
    # Потомки панели плодятся между снимками (рендереры, новый наблюдатель),
    # поэтому поддерево владельца вычёркивается на каждом обновлении дерева.
    $watch = Remove-OwnerTree (Get-WatchSet $watch)
    $script:want = Get-ParentWants $seeds
  }

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
    # В лог идёт только имя образа якоря — заголовки окон и командные строки §12 запрещает.
    $proc = ''
    if ($script:anchorProc -match '^[A-Za-z0-9 ._\-\(\)\[\]{}]{1,40}$') {
      $proc = (',"proc":"{0}"' -f $script:anchorProc)
    }
    $line = ('{{"state":"bounds","x":{0},"y":{1},"width":{2},"height":{3},"anchor":"{4}"{5}}}' -f `
        $script:best.X, $script:best.Y, $script:best.Width, $script:best.Height, $script:anchorKind, $proc)
  }
  if ($line -ne $last) {
    $last = $line
    [Console]::Out.WriteLine($line); [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds $interval
}
