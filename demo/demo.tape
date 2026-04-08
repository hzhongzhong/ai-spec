# ai-spec demo
# Generate: vhs demo.tape

Output demo.gif
Set Theme "Dracula"
Set FontSize 13
Set Width 1100
Set Height 720
Set Padding 24
Set FontFamily "JetBrains Mono"
Set PlaybackSpeed 1.0

# ── Scene 1: help ──────────────────────────────────────────────────────────────
Sleep 500ms
Type "ai-spec --help"
Enter
Sleep 5s

# ── Scene 2: single-repo create pipeline ──────────────────────────────────────
Sleep 500ms
Type "bash demo.sh create"
Enter
Sleep 50s

# ── Scene 3: multi-repo workspace ─────────────────────────────────────────────
Sleep 500ms
Type "bash demo.sh multirepo"
Enter
Sleep 20s

# ── Scene 4: DSL artifacts ─────────────────────────────────────────────────────
Sleep 500ms
Type "bash demo.sh artifacts"
Enter
Sleep 16s

# ── Scene 5: observability ─────────────────────────────────────────────────────
Sleep 500ms
Type "bash demo.sh observability"
Enter
Sleep 12s

Sleep 2s
