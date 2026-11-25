param(
    [switch]$NoOpen
)

$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $npm -or -not $node) {
    Write-Error 'Node.js and npm must be available on PATH to start Picodevil.'
    exit 1
}

Push-Location -LiteralPath $PSScriptRoot
try {
    $vite = 'node_modules/vite/bin/vite.js'
    if (-not (Test-Path -LiteralPath $vite -PathType Leaf) -or
        -not (Test-Path -LiteralPath 'node_modules/blockly/package.json' -PathType Leaf)) {
        & $npm.Source ci
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }

    $viteArgs = @()
    if (-not $NoOpen) { $viteArgs += '--open' }
    & $node.Source $vite @viteArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
