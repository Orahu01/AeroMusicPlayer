# =====================================================================
#  AeroMusic Player (AMP) ランチャー
#   1. スクリプトと同じフォルダを配信する超軽量ローカルサーバを起動
#   2. Chrome / Edge を「アプリモード」で開く（アドレスバーなし）
#   3. ウィンドウを閉じたらサーバも自動終了
#  ※ ローカルサーバ経由にすることで、出力デバイス選択・フォルダ記憶が使えます
# =====================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$page = 'AeroMusicPlayer.html'

# ---------- ポート ----------
# 設定・SE音源はブラウザにポート番号ごとに保存されるため、必ず同じポートを使う
$PORT = 8777
$listener = $null
try {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $PORT)
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "  ポート $PORT が使用中です。" -ForegroundColor Yellow
  Write-Host "  AMP が既に起動していないか確認してください（二重起動はできません）。"
  Write-Host "  別のソフトが使っている場合は amp-launch.ps1 の `$PORT を書き換えてください。"
  Write-Host "  ※ ポートを変えると保存済みの設定・SE は引き継がれません。" -ForegroundColor DarkYellow
  Write-Host ""
  pause; exit 1
}
$port = $PORT

$url = "http://127.0.0.1:$port/$page"
Write-Host ""
Write-Host "  AeroMusic Player" -ForegroundColor Cyan
Write-Host "  ----------------------------------------"
Write-Host "  server : $url"
Write-Host "  folder : $root"
Write-Host "  このウィンドウは閉じないでください（閉じると再生も止まります）"
Write-Host ""

# ---------- ブラウザを探す ----------
$cands = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)
$browser = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Write-Host 'Chrome / Edge が見つかりません。' -ForegroundColor Red; pause; exit 1 }

$profileDir = Join-Path $root '.amp-profile'
$args = @(
  "--app=$url",
  "--user-data-dir=$profileDir",
  "--autoplay-policy=no-user-gesture-required",
  # ウィンドウを裏に回しても本番中に処理が止まらないようにする
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-features=CalculateNativeWinOcclusion",
  "--window-size=1500,940",
  "--no-first-run",
  "--no-default-browser-check"
)
$browserProc = Start-Process -FilePath $browser -ArgumentList $args -PassThru

# ---------- 静的ファイル配信 ----------
$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8';
  '.css'='text/css; charset=utf-8';  '.json'='application/json; charset=utf-8';
  '.png'='image/png'; '.jpg'='image/jpeg'; '.svg'='image/svg+xml'; '.ico'='image/x-icon';
}

function Send-Response($stream, [int]$code, [string]$status, [string]$type, [byte[]]$body) {
  $head = "HTTP/1.1 $code $status`r`n" +
          "Content-Type: $type`r`n" +
          "Content-Length: $($body.Length)`r`n" +
          "Cache-Control: no-store`r`n" +
          "Connection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  if ($body.Length) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

try {
  while (-not $browserProc.HasExited) {
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 25; continue }
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 3000
      $ns = $client.GetStream()
      $buf = New-Object byte[] 8192
      $n = $ns.Read($buf, 0, $buf.Length)
      if ($n -le 0) { continue }
      $req = [System.Text.Encoding]::ASCII.GetString($buf, 0, $n)
      $line = ($req -split "`r`n")[0]
      $path = ($line -split ' ')[1]
      if (-not $path) { $path = '/' }
      $path = ($path -split '\?')[0]
      $path = [System.Uri]::UnescapeDataString($path)
      if ($path -eq '/') { $path = "/$page" }

      $safe = $path.TrimStart('/').Replace('/', '\')
      $full = Join-Path $root $safe
      # ルート外へのアクセスを遮断
      $rootFull = [System.IO.Path]::GetFullPath($root)
      $fileFull = try { [System.IO.Path]::GetFullPath($full) } catch { '' }

      if ($fileFull -and $fileFull.StartsWith($rootFull) -and (Test-Path -LiteralPath $fileFull -PathType Leaf)) {
        $ext = [System.IO.Path]::GetExtension($fileFull).ToLower()
        $ct = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $bytes = [System.IO.File]::ReadAllBytes($fileFull)
        Send-Response $ns 200 'OK' $ct $bytes
      } else {
        Send-Response $ns 404 'Not Found' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('404'))
      }
    } catch { }
    finally { try { $client.Close() } catch { } }
  }
} finally {
  $listener.Stop()
  Write-Host "  終了しました。" -ForegroundColor DarkGray
  Start-Sleep -Milliseconds 400
}
