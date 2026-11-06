# Draw the 180x180 storefront icon (PNG, raster) that mirrors icon.svg.
# Marketplace tiles are drawn at ~96px and must be a GitHub-hosted raster image,
# so the SVG source is re-rendered here instead of being shipped as-is.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\assets\icon-180.png'
$target = [System.IO.Path]::GetFullPath($out)
$dir = Split-Path -Parent $target
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$size = 180
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath {
  param([double]$X, [double]$Y, [double]$W, [double]$H, [double]$R)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $R * 2
  $p.AddArc($X, $Y, $d, $d, 180, 90)
  $p.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $p.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $p.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# Background tile: rounded square, #1d2733
$bg = New-RoundedPath -X 11 -Y 11 -W 158 -H 158 -R 39
$bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#1d2733'))
$g.FillPath($bgBrush, $bg)

# Row 1 (bright), row 2 (dimmed), row 3 (short + dot) - same proportions as icon.svg
$yellow = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#ffd166'))
$row1 = New-RoundedPath -X 42 -Y 45 -W 96 -H 20 -R 10
$g.FillPath($yellow, $row1)

$dim = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(191, 255, 209, 102))
$row2 = New-RoundedPath -X 42 -Y 82 -W 96 -H 20 -R 10
$g.FillPath($dim, $row2)

$blue = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#8ecdf7'))
$row3 = New-RoundedPath -X 67 -Y 118 -W 70 -H 17 -R 8
$g.FillPath($blue, $row3)
$g.FillEllipse($blue, 39, 118, 18, 18)

$g.Dispose()
$bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

$info = Get-Item $target
"wrote {0} ({1} bytes)" -f $info.FullName, $info.Length
