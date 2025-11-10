# compact

Claude session compaction tool with background processing and resume.

## Installation

```bash
bun link
```

## Usage

### Run compaction on current session

```bash
compact
```

### Run compaction on specific session

```bash
compact <session-id>
```

### Check status

```bash
compact status
```

Shows compaction status (compacting/ready/resumed), session IDs, and timestamps.

### Resume compacted session

```bash
compact resume
```

Merges compacted fork back into original session and creates automatic backup.

### Rollback after resume

```bash
compact rollback
```

Restores session from backup if something went wrong after resume.

For debugging, two files are saved in `/tmp`:
- `compact-backup-{hash}.jsonl` - Pre-merge original version
- `compact-rollback-{hash}.jsonl` - Post-merge version (created during rollback)

## How it works

1. Forks current session
2. Runs `/compact` on forked session
3. Merges compacted fork back into original
4. Resumes original session with reduced context

## Features

- Status checking while compaction runs
- Automatic merge of new messages added during compaction
