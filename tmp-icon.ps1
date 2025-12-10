$out='c:/react-firebase-auth-and-firestore/electron/build/icon.png'
Add-Type -AssemblyName System.Drawing
$size=512
$bmp=New-Object Drawing.Bitmap $size,$size
$g=[Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::HighQuality
$bg=New-Object Drawing.SolidBrush ([Drawing.Color]::Black)
$g.FillRectangle($bg,0,0,$size,$size)
$centerX=256
$centerY=256
$outerR=200
$g.FillEllipse($bg,$centerX-$outerR,$centerY-$outerR,$outerR*2,$outerR*2)
$whiteBrush=New-Object Drawing.SolidBrush ([Drawing.Color]::White)
$whiteR=170
$g.FillEllipse($whiteBrush,($centerX+20)-$whiteR,($centerY+40)-$whiteR,$whiteR*2,$whiteR*2)
$blackBrush=New-Object Drawing.SolidBrush ([Drawing.Color]::Black)
$maskR=90
$g.FillEllipse($blackBrush,($centerX-120)-$maskR,($centerY-70)-$maskR,$maskR*2,$maskR*2)
$yellow=[Drawing.Color]::FromArgb(245,193,55)
$yellowBrush=New-Object Drawing.SolidBrush ($yellow)
$yellowR=70
$g.FillEllipse($yellowBrush,($centerX-120)-$yellowR,($centerY-120)-$yellowR,$yellowR*2,$yellowR*2)
$g.Dispose()
$bmp.Save($out,[Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "Saved $out"='c:/react-firebase-auth-and-firestore/electron/build/icon.png'

