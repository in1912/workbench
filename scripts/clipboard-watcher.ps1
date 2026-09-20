# 个人工作台 · Windows 剪贴板自动采集脚本
# 用法：在 PowerShell 中运行  powershell -ExecutionPolicy Bypass -File clipboard-watcher.ps1
# 功能：每 3 秒检测一次系统剪贴板，内容变化时推送到工作台 API（/api/clipboard）
# 修改下面的 $BASE 为你的工作台地址

$BASE = "http://localhost:3000"
$INTERVAL_SECONDS = 3

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$last = ""
Write-Host "[clipboard-watcher] 开始监听剪贴板，目标: $BASE  (Ctrl+C 退出)"

while ($true) {
    try {
        $text = [System.Windows.Forms.Clipboard]::GetText()
        if ($text -and $text -ne $last -and $text.Length -gt 1) {
            $last = $text
            $body = @{ content = $text; source = "windows-clipboard" } | ConvertTo-Json
            try {
                Invoke-RestMethod -Uri "$BASE/api/clipboard" -Method Post -ContentType "application/json" -Body $body | Out-Null
                Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 已收录 $($text.Substring(0, [Math]::Min(40, $text.Length)))..."
            } catch {
                Write-Host "[warn] 推送失败: $($_.Exception.Message)"
            }
        }
    } catch {
        # 剪贴板被其他程序占用时忽略
    }
    Start-Sleep -Seconds $INTERVAL_SECONDS
}
