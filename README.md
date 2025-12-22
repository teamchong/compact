# compact

Background compaction for Claude Code sessions—reduce context bloat without losing your work.

## Why Use This?

Claude Code sessions accumulate context over time: file reads, tool outputs, conversation history. Eventually this bloats your context window, slowing responses and increasing costs. The built-in `/compact` command summarizes this history, but it blocks your terminal while running.

**compact** solves this by:
1. Running compaction in the background (you keep working)
2. Preserving any messages you add during compaction
3. Merging everything back seamlessly
4. Providing rollback if anything goes wrong

## Quick Start

```bash
# Install (requires Bun)
git clone https://github.com/your-username/compact.git
cd compact
bun link

# Run compaction (backgrounds automatically)
compact &

# Check if done
compact status

# When ready, merge and resume
compact resume
```

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                        YOUR SESSION                             │
│  [msg1] → [msg2] → [msg3] → ... → [msg100]  (bloated context)   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ compact &
┌─────────────────────────────────────────────────────────────────┐
│  FORK (background)              │  ORIGINAL (you keep working)  │
│  Running /compact...            │  [msg101] → [msg102] → ...    │
│  ████████████░░░░ 75%           │                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ compact resume
┌─────────────────────────────────────────────────────────────────┐
│                      MERGED SESSION                             │
│  [summary] → [msg101] → [msg102] → ...  (clean context)         │
└─────────────────────────────────────────────────────────────────┘
```

1. **Fork**: Creates a copy of your session and runs `/compact` on it in the background
2. **Work**: You continue using your original session normally
3. **Merge**: Combines the compacted summary with any new messages you added
4. **Resume**: Continues your original session with reduced context

## Commands

| Command | Description |
|---------|-------------|
| `compact` | Start background compaction of current session |
| `compact <session-id>` | Compact a specific session |
| `compact status` | Check compaction progress |
| `compact resume` | Merge compacted fork and resume session |
| `compact rollback` | Restore from backup if something went wrong |

## Workflow Examples

### Basic Usage
```bash
# In your Claude Code session, background compact
compact &

# Continue working...
# When notified (macOS) or status shows 'ready':
compact status

# Exit your current Claude Code session first (Ctrl+C or /exit)
# Then resume with the compacted context:
compact resume
```

### From Within Claude Code
```bash
# Type this in Claude Code:
!compact

# Press Ctrl+Z to background, then:
bg

# Or use Ctrl+B if your terminal supports it
```

### Compact a Different Session
```bash
# Get session IDs from ~/.claude/projects/
compact abc12345-1234-1234-1234-123456789abc &
```

### Resume With Extra Claude Args
```bash
# Pass additional arguments to claude on resume
compact resume --model opus
```

## What Gets Preserved

- **All messages added during compaction**: If you keep working while compact runs, those messages are merged in
- **Message chain integrity**: Parent/child UUID relationships are maintained
- **Tool result pairing**: Tool calls and their results stay linked

## Rollback

If something goes wrong after resume:

```bash
compact rollback
# Then try again:
compact resume
```

Two files are saved for debugging:
- `/tmp/compact-backup-{hash}.jsonl` - Pre-merge original
- `/tmp/compact-rollback-{hash}.jsonl` - Post-merge version (created on rollback)

## Requirements

- [Bun](https://bun.sh) - install with `curl -fsSL https://bun.sh/install | bash`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and in PATH
- [fd](https://github.com/sharkdp/fd) - install with `brew install fd` (macOS) or `apt install fd-find` (Linux)
- macOS for notifications (optional)

## How State is Tracked

State is stored in `/tmp/compact-{hash}.json` where hash is derived from your working directory. This means each project directory has independent compaction state.

States:
- `compacting` - Fork is running /compact
- `ready` - Compaction done, waiting for resume
- `resumed` - Successfully merged (can rollback from here)

## Flags

| Flag | Description |
|------|-------------|
| `--force` | Skip confirmation when overriding an existing ready compaction |
| `--model <model>` | Use specific model for compaction (defaults to haiku for speed) |

## Troubleshooting

**"No valid sessions found"**
- Make sure you're in a directory with an active Claude Code session
- Check `~/.claude/projects/` for session files

**"Compaction timeout"**
- Large sessions can take a while; default timeout is 10 minutes
- Check `compact status` to see if it's still running

**Merge issues**
- Use `compact rollback` to restore the original
- Check the rollback files in `/tmp/` for debugging

## License

MIT
