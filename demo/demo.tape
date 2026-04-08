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

# ── Opening ────────────────────────────────────────────────────────────────────
Sleep 500ms
Type "ai-spec --help"
Sleep 300ms
Enter
Sleep 3s

# ── Scene 2: single-repo create pipeline ──────────────────────────────────────
Sleep 800ms
Type "ai-spec create 'Add task management feature to Vue admin'"
Sleep 300ms
Enter
Sleep 300ms
Type "bash demo.sh create"
Enter
Sleep 40s

# ── Scene 3: multi-repo workspace ─────────────────────────────────────────────
Sleep 800ms
Type "ai-spec create 'Add user profile sync' --workspace"
Sleep 300ms
Enter
Sleep 300ms
Type "bash demo.sh multirepo"
Enter
Sleep 14s

# ── Scene 4: DSL artifacts ─────────────────────────────────────────────────────
Sleep 800ms
Type "bash demo.sh artifacts"
Enter
Sleep 10s

# ── Scene 5: observability ─────────────────────────────────────────────────────
Sleep 800ms
Type "bash demo.sh observability"
Enter
Sleep 8s

Sleep 2s
