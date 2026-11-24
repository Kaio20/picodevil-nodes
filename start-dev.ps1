param(
    [switch]$NoOpen
)

$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $npm -or -not (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js and npm must be available on PATH to start NodesDevil.'
    exit 1
}

Push-Location -LiteralPath $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath 'node_modules/.bin/vite.cmd' -PathType Leaf)) {
        & $npm.Source ci
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }

    $viteArgs = @()
    if (-not $NoOpen) {
        $viteArgs = @('--', '--open')
    }

    & $npm.Source run dev @viteArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
