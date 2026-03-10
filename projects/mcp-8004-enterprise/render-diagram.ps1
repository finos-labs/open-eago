# Render all Mermaid diagrams to PNG
# Requires: npx @mermaid-js/mermaid-cli (mmdc)
# Usage:  .\render-diagram.ps1

$dirs = @("design", "paper\figures")

foreach ($dir in $dirs) {
    $mmdFiles = Get-ChildItem -Path $dir -Filter "*.mmd" -ErrorAction SilentlyContinue
    foreach ($file in $mmdFiles) {
        $outPath = $file.FullName -replace '\.mmd$', '.png'
        Write-Host "Rendering $($file.FullName) -> $outPath"
        npx @mermaid-js/mermaid-cli -i $file.FullName -o $outPath --width 1600 --backgroundColor white
    }
}

Write-Host "Done. All diagrams rendered."
