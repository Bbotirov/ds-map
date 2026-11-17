/**
 * Поиск окна харнеса по PID и пристегивание панели справа.
 * Реализация для Windows (через PowerShell + user32.dll).
 * Fallback: правый край экрана, если окно не найдено.
 */

import * as child_process from 'node:child_process'
import * as os from 'node:os'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export function findWindowByPid(pid: number): WindowBounds | null {
  if (os.platform() !== 'win32') return null

  try {
    const psCmd = `
      Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool GetWindowThreadProcessId(IntPtr hwnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT lpRect);
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lp);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static void Main() { }
}
"@
$windows = [System.Collections.ArrayList]::new()
[Win]::EnumWindows((hwnd, lp) => {
  uint pid;
  [Win]::GetWindowThreadProcessId(hwnd, [ref] pid);
  if (pid -eq ${pid}) {
    $rect = New-Object Win+RECT
    [Win]::GetWindowRect(hwnd, [ref] $rect)
    $windows.Add([PSCustomObject]@{ X=$rect.Left; Y=$rect.Top; Width=$rect.Right-$rect.Left; Height=$rect.Bottom-$rect.Top })
  }
  return $true
}, [IntPtr]::Zero)
$windows | ConvertTo-Json
    `
    const result = child_process.execSync(
      `powershell -NoProfile -Command "${psCmd}"`,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 }
    )
    const parsed = JSON.parse(result.trim())
    if (Array.isArray(parsed) && parsed.length > 0) {
      const w = parsed[0]
      return { x: w.X, y: w.Y, width: w.Width, height: w.Height }
    }
  } catch {
    // окно не найдено — возвращаем null
  }
  return null
}

export function computePanelBounds(
  harness: WindowBounds | null,
  screenWidth: number,
  screenHeight: number
): { x: number; y: number; width: number; height: number } {
  const DEFAULT_W = 420
  const MIN_W = 320
  const MAX_W = 560
  const GAP = 8

  let x: number, y: number, h: number, w: number

  if (harness) {
    x = harness.x + harness.width + GAP
    y = harness.y
    h = harness.height
    w = Math.min(MAX_W, Math.max(MIN_W, DEFAULT_W))
  } else {
    x = screenWidth - DEFAULT_W - GAP
    y = GAP
    h = screenHeight - GAP * 2
    w = DEFAULT_W
  }

  // Прижать к правому краю если вылезает
  if (x + w > screenWidth) {
    w = Math.max(MIN_W, screenWidth - x - GAP)
    x = screenWidth - w - GAP
  }
  if (x < 0) x = GAP

  // Обрезать высоту если вылезает за низ
  if (y + h > screenHeight) {
    h = screenHeight - y - GAP
  }
  if (h < 200) h = 200

  return { x, y, width: w, height: h }
}
