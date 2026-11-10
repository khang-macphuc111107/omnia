# Shared capture contract. Dot sourcing defines functions only.
function Initialize-OmniaQaCaptureInterop {
    Add-Type -AssemblyName System.Drawing
    if ('OmniaQaCapture' -as [type]) { return }
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OmniaQaCapture {
 [DllImport("user32.dll", SetLastError=true)]
 public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
 [DllImport("user32.dll", SetLastError=true)]
 public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
 [DllImport("user32.dll", SetLastError=true)]
 public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")]
 public static extern IntPtr GetThreadDpiAwarenessContext();
 [DllImport("user32.dll")]
 public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
 [DllImport("user32.dll")]
 public static extern bool IsWindow(IntPtr hwnd);
 [DllImport("user32.dll")]
 public static extern bool IsIconic(IntPtr hwnd);
 [StructLayout(LayoutKind.Sequential)]
 public struct Rect { public int Left, Top, Right, Bottom; }
}
'@
}

function Save-OmniaQaWindowCapture {
    param(
        [Parameter(Mandatory)][IntPtr]$WindowHandle,
        [Parameter(Mandatory)][Diagnostics.Process]$Process,
        [Parameter(Mandatory)][string]$Path,
        [ValidateRange(1, 8192)][int]$MaximumDimension = 8192
    )
    if (-not [IO.Path]::IsPathFullyQualified($Path)) {
        throw 'Capture path must be absolute.'
    }
    $imagePath = [IO.Path]::GetFullPath($Path)
    Assert-OmniaQaLiteralBoundary $imagePath
    if (Test-Path -LiteralPath $imagePath) {
        throw "Refusing to overwrite capture: $imagePath"
    }
    if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($imagePath)) -PathType Container)) {
        throw 'Capture parent directory must already exist.'
    }
    Initialize-OmniaQaCaptureInterop
    $Process.Refresh()
    if ($Process.HasExited) { throw 'Capture target process has exited.' }
    if ($WindowHandle -eq [IntPtr]::Zero -or -not [OmniaQaCapture]::IsWindow($WindowHandle)) {
        throw 'Capture target window is invalid.'
    }
    $ownerId = [uint32]0
    $threadId = [OmniaQaCapture]::GetWindowThreadProcessId($WindowHandle, [ref]$ownerId)
    if ($threadId -eq 0 -or $ownerId -ne $Process.Id) {
        throw 'Capture window does not belong to the expected process.'
    }
    if ([OmniaQaCapture]::IsIconic($WindowHandle)) {
        throw 'Minimized-window capture is not qualified by this QA helper.'
    }
    $startedUtc = [DateTime]::UtcNow.ToString('o')
    $startedAt = $Process.StartTime.ToUniversalTime().ToString('o')
    $timer = [Diagnostics.Stopwatch]::StartNew()
    # This evaluation shell is DPI-unaware. GetWindowRect and PrintWindow
    # must use the same logical coordinate space to avoid black padding.
    $priorDpi = [OmniaQaCapture]::SetThreadDpiAwarenessContext([IntPtr](-1))
    if ($priorDpi -eq [IntPtr]::Zero) { throw 'Capture DPI context unavailable.' }
    try {
        $rect = [OmniaQaCapture+Rect]::new()
        if (-not [OmniaQaCapture]::GetWindowRect($WindowHandle, [ref]$rect)) {
            throw 'Capture window bounds unavailable.'
        }
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        if ($width -le 0 -or $height -le 0 -or
            $width -gt $MaximumDimension -or $height -gt $MaximumDimension) {
            throw "Capture bounds invalid or exceed limit: ${width}x${height}"
        }
        $bitmap = [Drawing.Bitmap]::new($width, $height)
        try {
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            try {
                $dc = $graphics.GetHdc()
                try {
                    if (-not [OmniaQaCapture]::PrintWindow($WindowHandle, $dc, 2)) {
                        throw 'PrintWindow failed; capture not accepted.'
                    }
                } finally { $graphics.ReleaseHdc($dc) }
            } finally { $graphics.Dispose() }
            $after = [OmniaQaCapture+Rect]::new()
            $afterOwner = [uint32]0
            $afterThread = [OmniaQaCapture]::GetWindowThreadProcessId($WindowHandle, [ref]$afterOwner)
            if (-not [OmniaQaCapture]::GetWindowRect($WindowHandle, [ref]$after) -or
                $after.Left -ne $rect.Left -or $after.Top -ne $rect.Top -or
                $after.Right -ne $rect.Right -or $after.Bottom -ne $rect.Bottom -or
                $afterThread -ne $threadId -or $afterOwner -ne $ownerId -or
                [OmniaQaCapture]::IsIconic($WindowHandle)) {
                throw 'Capture window changed geometry, owner or minimized state.'
            }
            $Process.Refresh()
            if ($Process.HasExited) { throw 'Capture target exited before receipt.' }
            $stream = [IO.File]::Open($imagePath, [IO.FileMode]::CreateNew,
                [IO.FileAccess]::Write, [IO.FileShare]::Read)
            try { $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png) }
            finally { $stream.Dispose() }
        } finally { $bitmap.Dispose() }
    } finally {
        if ([OmniaQaCapture]::SetThreadDpiAwarenessContext($priorDpi) -eq [IntPtr]::Zero) {
            throw 'Capture could not restore caller DPI context.'
        }
    }
    return [ordered]@{
        path = $imagePath
        sha256 = (Get-FileHash -LiteralPath $imagePath -Algorithm SHA256).Hash
        width = $width
        height = $height
        bounds = @{ left=$rect.Left; top=$rect.Top; right=$rect.Right; bottom=$rect.Bottom }
        coordinateSpace = 'DPI-unaware logical window units; not physical screen coordinates'
        dpiContext = -1
        dpiContextRestored = $true
        api = 'PrintWindow'
        flags = 2
        processId = $Process.Id
        processStartedUtc = $startedAt
        windowHandle = $WindowHandle.ToInt64()
        windowThreadId = $threadId
        startedUtc = $startedUtc
        finishedUtc = [DateTime]::UtcNow.ToString('o')
        elapsedMilliseconds = $timer.Elapsed.TotalMilliseconds
        helperSha256 = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'qa-capture.ps1')).Hash
        pixelReview = 'required separately; API success and dimensions do not prove complete rendering'
    }
}
