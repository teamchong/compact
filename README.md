# compact

Claude session compaction tool with background processing and resume.

## Installation

```bash
bun link
```

## Usage

### Run compaction

```bash
compact &
```

During Claude Code session

```bash
!compact
```

Then press `Ctrl + B` to send it to background

### Check status

```bash
compact status
```

### Resume compacted session

```bash
compact resume
```

## How it works

1. Forks current session
2. Runs `/compact` on forked session
3. Merges compacted fork back into original
4. Resumes original session with reduced context

## Features

- Status checking while compaction runs
- Automatic merge of new messages added during compaction
