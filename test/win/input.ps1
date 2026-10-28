# Real Windows mouse/keyboard input for tests: input.ps1 <action> [x] [y] [text]
#   move x y | lclick x y | rclick x y | type "text" | shot path
param([string]$action, [int]$x = 0, [int]$y = 0, [string]$text = '')
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class U {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[U]::SetProcessDPIAware() | Out-Null
switch ($action) {
  'move'   { [U]::SetCursorPos($x, $y) | Out-Null }
  'lclick' { [U]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 120; [U]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [U]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero) }
  'rclick' { [U]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 120; [U]::mouse_event(0x8, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [U]::mouse_event(0x10, 0, 0, 0, [UIntPtr]::Zero) }
  'type'   { [System.Windows.Forms.SendKeys]::SendWait($text) }
  'shot'   {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save($text, [System.Drawing.Imaging.ImageFormat]::Png)
  }
}
