# SensorLab local launcher for Windows. Uses only built-in Windows PowerShell; nothing to install.
# Fallback for PCs where policy blocks Web Bluetooth on pages opened directly from disk.
# Serves this folder on http://localhost:8080/ (loopback only) and opens the browser.
# Usage (from the unzipped SensorLab folder):  powershell -ExecutionPolicy Bypass -File serve.ps1
param([int]$Port = 8080, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8';
            '.json'='application/json'; '.webmanifest'='application/manifest+json'; '.md'='text/plain; charset=utf-8'; '.txt'='text/plain; charset=utf-8' }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "SensorLab: http://localhost:$Port/  (local only; close this window to stop)"
if (-not $NoBrowser) { Start-Process "http://localhost:$Port/index.html" }
try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
        if ($rel -eq '') { $rel = 'index.html' }
        $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
        if (-not $full.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar) -or -not (Test-Path $full -PathType Leaf)) {
            $ctx.Response.StatusCode = 404
        } else {
            $ext = [System.IO.Path]::GetExtension($full)
            $ctx.Response.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
            $ctx.Response.Headers.Add('Cache-Control', 'no-cache')
            $bytes = [System.IO.File]::ReadAllBytes($full)
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        }
        $ctx.Response.Close()
    }
} finally { $listener.Stop() }
