param([string]$MarketplaceRoot = $env:USERPROFILE)
$ErrorActionPreference = 'Stop'
$pluginSource = Split-Path -Parent $PSScriptRoot
$pluginDestination = Join-Path $MarketplaceRoot 'plugins\harness-pilot'
New-Item -ItemType Directory -Force $pluginDestination | Out-Null
if ((Resolve-Path $pluginSource).Path -ne $pluginDestination) {
    Get-ChildItem -LiteralPath $pluginSource -Force | Where-Object { $_.Name -ne 'node_modules' } |
        Copy-Item -Destination $pluginDestination -Recurse -Force
}
$marketplaceDirectory = Join-Path $MarketplaceRoot '.agents\plugins'
New-Item -ItemType Directory -Force $marketplaceDirectory | Out-Null
$marketplacePath = Join-Path $marketplaceDirectory 'marketplace.json'
if (Test-Path $marketplacePath) {
    $catalog = Get-Content -LiteralPath $marketplacePath -Raw | ConvertFrom-Json
} else {
    $catalog = [pscustomobject]@{ name = 'local-personal'; interface = @{ displayName = '本地插件' }; plugins = @() }
}
$existing = @($catalog.plugins | Where-Object { $_.name -eq 'harness-pilot' })
if ($existing.Count -eq 0) {
    $catalog.plugins = @($catalog.plugins) + @(@{
        name = 'harness-pilot'; source = @{ source = 'local'; path = './plugins/harness-pilot' }
        policy = @{ installation = 'AVAILABLE'; authentication = 'ON_INSTALL' }; category = 'Productivity'
    })
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($marketplacePath, ($catalog | ConvertTo-Json -Depth 20), $utf8)
Push-Location $pluginDestination
try {
    & npm.cmd ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm dependency installation failed' }
} finally { Pop-Location }
$codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
if ($null -eq $codexCommand) {
    $codexCandidates = @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\*\codex.exe') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($codexCandidates.Count -eq 0) { throw 'Codex CLI not found; install from the local marketplace in Codex' }
    $codexExe = $codexCandidates[0].FullName
} else { $codexExe = $codexCommand.Source }
if ($MarketplaceRoot -ne $env:USERPROFILE) {
    $registered = & $codexExe plugin marketplace list --json | ConvertFrom-Json
    if (@($registered.marketplaces | Where-Object { $_.root -eq $MarketplaceRoot }).Count -eq 0) {
        & $codexExe plugin marketplace add $MarketplaceRoot
        if ($LASTEXITCODE -ne 0) { throw 'marketplace registration failed; existing plugin data preserved' }
    }
}
& $codexExe plugin add "harness-pilot@$($catalog.name)" --json
if ($LASTEXITCODE -ne 0) { throw 'Codex plugin installation failed; source preserved' }
Write-Host 'Harness Pilot installed. Refresh plugins or open a new Codex chat to load the MCP tools.'
