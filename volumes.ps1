# Emit one JSON line describing every fixed local volume (letter, label, filesystem).
# Called once in a while by index.js so the status strip can explain what C:/D:/E: are.
#
# 卷标可能是中文（例如“系统”“软件”“文档”）。Windows PowerShell 5.1 把 stdout 写进管道时
# 用系统 ANSI 页，Node 端按 UTF-8 解码就会变成乱码，而[Console]::OutputEncoding 在
# -File 模式下并不总能在输出前生效。最稳的办法是只输出 ASCII：把非 ASCII 字符转成 JSON 的
# \uXXXX 转义，Node 的 JSON.parse 会自动还原成中文。
$ErrorActionPreference = 'Stop'
try {
  $items = @(
    Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
      [pscustomobject]@{
        name       = [string]$_.DeviceID
        label      = [string]$_.VolumeName
        fileSystem = [string]$_.FileSystem
      }
    }
  )
  $json = ConvertTo-Json -InputObject $items -Compress -Depth 4
  $escaped = [regex]::Replace($json, '[^\x00-\x7F]', {
    param($match)
    $code = [int][char]$match.Value
    if ($code -gt 0xFFFF) {
      # 代理对（极少见）：按 UTF-16 分成两个 \u 转义
      $chars = $match.Value.ToCharArray()
      -join ($chars | ForEach-Object { '\u{0:x4}' -f [int]$_ })
    } else {
      '\u{0:x4}' -f $code
    }
  })
  Write-Output $escaped
} catch {
  Write-Output '{"error":"volumes-unavailable"}'
}
