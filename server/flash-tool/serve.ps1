# 智能家居烧录工具包 · 本地静态服务器（PowerShell，零依赖）
#
# 为什么必须起一个本地服务器，而不是直接双击 index.html：
#   浏览器只在「安全上下文」里开放 Web Serial（navigator.serial）。file:// 不是安全上下文，
#   页面上根本拿不到串口；而 http://127.0.0.1 被浏览器明确视为安全上下文 —— 所以走本地回环。
#
# 为什么用 TcpListener 而不是 HttpListener：
#   HttpListener 需要管理员权限或预先注册 URL ACL（netsh http add urlacl），双击就弹 UAC；
#   TcpListener 绑定 127.0.0.1 完全不需要提权，也不会触发 Windows 防火墙弹窗（只绑回环）。
#
# 端口：让系统分配一个空闲端口（bind 0），然后把浏览器指过去——不用猜端口，也不会撞占用。
param(
  [string]$Root = $PSScriptRoot,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Root = (Resolve-Path -LiteralPath $Root).Path
$Mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.md'   = 'text/plain; charset=utf-8'
  '.bin'  = 'application/octet-stream'
  '.py'   = 'text/plain; charset=utf-8'
  '.exe'  = 'application/octet-stream'
  '.dll'  = 'application/octet-stream'
  '.sys'  = 'application/octet-stream'
  '.cat'  = 'application/octet-stream'
  '.inf'  = 'text/plain; charset=utf-8'
  '.cmd'  = 'text/plain; charset=utf-8'
  '.bat'  = 'text/plain; charset=utf-8'
  '.vxd'  = 'application/octet-stream'
  '.png'  = 'image/png'
  '.svg'  = 'image/svg+xml'
  '.zip'  = 'application/zip'
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$url = "http://127.0.0.1:$port/index.html"

Write-Host ''
Write-Host '  智能家居烧录工具包 —— 本地烧录服务已启动' -ForegroundColor Green
Write-Host "  地址: $url" -ForegroundColor Cyan
Write-Host '  说明: 浏览器里选串口、点烧录即可。用完直接关掉这个窗口。' -ForegroundColor Gray
Write-Host ''

if (-not $NoBrowser) {
  # 优先用 Edge / Chrome（Web Serial 只在这两个里可用；Firefox/Safari 都没有）
  $opened = $false
  foreach ($exe in @(
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
      "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    )) {
    if (Test-Path -LiteralPath $exe) { Start-Process -FilePath $exe -ArgumentList $url; $opened = $true; break }
  }
  if (-not $opened) { Start-Process $url }  # 兜底：交给系统默认浏览器（若不是 Edge/Chrome 页面会提示换浏览器）
}

function Send-Bytes($stream, [byte[]]$bytes) {
  if ($bytes.Length -gt 0) { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush() }
}
function Send-Text($stream, [string]$text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  Send-Bytes $stream $bytes
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 5000
      $client.SendTimeout = 30000
      $stream = $client.GetStream()

      # ---- 读请求头（本工具只服务 GET，且都是小请求：读到 \r\n\r\n 为止就够）----
      $buf = New-Object byte[] 8192
      $sb = New-Object System.Text.StringBuilder
      $headerEnd = -1
      while ($headerEnd -lt 0) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        [void]$sb.Append([System.Text.Encoding]::ASCII.GetString($buf, 0, $n))
        $headerEnd = $sb.ToString().IndexOf("`r`n`r`n")
        if ($sb.Length -gt 65536) { break }   # 畸形/超长请求头，直接放弃
      }
      $head = $sb.ToString()
      if (-not $head) { continue }

      $line = ($head -split "`r`n")[0]
      $parts = $line -split ' '
      $method = if ($parts.Count -gt 0) { $parts[0] } else { '' }
      $target = if ($parts.Count -gt 1) { $parts[1] } else { '/' }

      if ($method -ne 'GET' -and $method -ne 'HEAD') {
        Send-Text $stream "HTTP/1.1 405 Method Not Allowed`r`nContent-Length: 0`r`nConnection: close`r`n`r`n"
        continue
      }

      # ---- 路径 → 文件（严格限制在 $Root 内，杜绝 ../ 穿越）----
      $pathOnly = ($target -split '\?')[0]
      $pathOnly = [System.Uri]::UnescapeDataString($pathOnly)
      if ($pathOnly -eq '/' -or $pathOnly -eq '') { $pathOnly = '/index.html' }
      $rel = $pathOnly.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))
      $inside = $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)

      if (-not $inside -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $pathOnly")
        Send-Text $stream "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
        Send-Bytes $stream $body
        continue
      }

      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ctype = if ($Mime.ContainsKey($ext)) { $Mime[$ext] } else { 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($full)

      # 固件/驱动不许被浏览器缓存（换地址重新打包后同一 URL 名字不变）
      $cache = 'no-cache, no-store, must-revalidate'
      Send-Text $stream "HTTP/1.1 200 OK`r`nContent-Type: $ctype`r`nContent-Length: $($bytes.Length)`r`nCache-Control: $cache`r`nConnection: close`r`n`r`n"
      if ($method -eq 'GET') { Send-Bytes $stream $bytes }
      Write-Host ("  {0} {1} ({2} 字节)" -f $method, $pathOnly, $bytes.Length) -ForegroundColor DarkGray
    } catch {
      # 单个连接出错不影响服务（浏览器预连接/半关闭很常见）
    } finally {
      try { $client.Close() } catch {}
    }
  }
} finally {
  $listener.Stop()
}
