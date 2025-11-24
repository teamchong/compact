#!/usr/bin/env bun
// compact - Background compaction with resume
import { $ } from 'bun';
import { createHash } from 'crypto';
import { unlink } from 'fs/promises';

async function* readLinesReverse(filePath: string) {
  const file = Bun.file(filePath);
  const fileSize = file.size;
  const chunkSize = 100 * 1024;

  let endPos = fileSize;
  let savedFirstLine = '';

  while (endPos > 0) {
    const startPos = Math.max(0, endPos - chunkSize);
    const text = await file.slice(startPos, endPos).text();

    const fullText = text + savedFirstLine;
    const lines = fullText.split('\n').reverse();

    if (startPos > 0 && lines.length > 0) {
      savedFirstLine = lines[lines.length - 1];
      lines.pop(); // Skip incomplete line from chunk boundary
    }

    for (const line of lines) {
      if (line.trim()) yield line;
    }

    endPos = startPos;
  }
}

async function cleanup() {
  await Promise.allSettled([
    unlink(FORKED_TMP_JSONL_FILE).catch(() => {}),
    unlink(MERGE_TMP_JSONL_FILE).catch(() => {})
  ]);
}

function cleanupSync() {
  try { Bun.spawn(['rm', '-f', FORKED_TMP_JSONL_FILE, MERGE_TMP_JSONL_FILE]); } catch {}
}

async function firstLine<T>(lines: AsyncIterable<T>): Promise<T | null> {
  for await (const line of lines) {
    return line;
  }
  return null;
}

function getHash(): string {
  return createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16);
}

function getStateJsonFile(): string {
  return `/tmp/compact-${getHash()}.json`;
}

function getBackupFile(): string {
  return `/tmp/compact-backup-${getHash()}.jsonl`;
}

function isValidGuid(str: string): boolean {
  const guidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return guidRegex.test(str);
}

function sanitizePath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

async function getCurrentSessionId(): Promise<string> {
  const cwd = process.cwd();
  const sanitized = sanitizePath(cwd);
  const projectDir = `${process.env.HOME}/.claude/projects/${sanitized}`;

  // Get all GUID pattern JSONL files
  const guidRegex = /^.*\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
  const sessions: Array<{ sessionId: string; timestamp: string }> = [];

  for await (const line of $`ls ${projectDir}/*.jsonl`.lines()) {
    const match = line.match(guidRegex);
    if (!match) continue;

    const sessionId = match[1];
    const file = Bun.file(line);
    if (file.size === 0) continue;

    // Read last line to get last message timestamp
    const lastLine = await firstLine(readLinesReverse(line));
    if (!lastLine) continue;

    try {
      const json = JSON.parse(lastLine);
      if (json.timestamp) {
        sessions.push({ sessionId, timestamp: json.timestamp });
      }
    } catch {
      // Skip invalid JSON
    }
  }

  if (sessions.length === 0) {
    throw new Error(`No valid sessions found in ${projectDir}`);
  }

  // Sort by timestamp descending (newest first)
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return sessions[0].sessionId;
}


// Main execution
async function main() {
  try {
    // Check for status subcommand
    if (process.argv[2] === 'status') {
      const stateFile = getStateJsonFile();
      const stateFileExists = await Bun.file(stateFile).exists();

      if (!stateFileExists) {
        console.log('No compaction in progress or completed.');
        console.log(`State file: ${stateFile}`);
        process.exit(0);
      }

      const state = await Bun.file(stateFile).json() as CompactState;
      console.log('Compaction Status:');
      console.log(`  Status: ${state.status}`);
      console.log(`  Original session: ${state.orgSessionId}`);
      console.log(`  Forked session: ${state.forkSessionId}`);
      console.log(`  Started: ${state.startTime}`);
      if (state.endTime) {
        console.log(`  Completed: ${state.endTime}`);
      }
      console.log(`\nState file: ${stateFile}`);
      process.exit(0);
    }

    // Check for resume subcommand
    if (process.argv[2] === 'resume') {
      const orgSessionId = await handleMerge();

      // Collect any additional arguments to pass through to claude
      const additionalArgs = process.argv.slice(3);

      const claudeArgs = ['-r', orgSessionId, ...additionalArgs];
      console.log(`Resuming original session ${orgSessionId}...`);
      if (additionalArgs.length > 0) {
        console.log(`With additional args: ${additionalArgs.join(' ')}`);
      }

      const proc = Bun.spawn(['claude', ...claudeArgs], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      process.exit(await proc.exited);
    }

    // Check for rollback subcommand
    if (process.argv[2] === 'rollback') {
      const stateFile = getStateJsonFile();
      if (!await Bun.file(stateFile).exists()) {
        throw new Error('No compact state found. Nothing to rollback.');
      }

      const state = await Bun.file(stateFile).json() as CompactState;
      if (state.status !== 'resumed') {
        throw new Error(`Cannot rollback. Current status: ${state.status}. Only 'resumed' sessions can be rolled back.`);
      }

      const { orgJsonlFile } = state;
      const backupFile = getBackupFile();

      if (!await Bun.file(backupFile).exists()) {
        throw new Error(`Backup file not found: ${backupFile}`);
      }

      // Save merged version for debugging
      const rollbackFile = `/tmp/compact-rollback-${getHash()}.jsonl`;
      await $`cp ${orgJsonlFile} ${rollbackFile}`;
      console.log(`Merged version saved: ${rollbackFile}`);

      await $`cp ${backupFile} ${orgJsonlFile}`;

      // Update state back to ready
      state.status = 'ready';
      state.rollbackTime = new Date().toISOString();
      await Bun.write(stateFile, JSON.stringify(state, null, 2));

      console.log('✅ Rollback complete!');
      console.log(`Restored: ${orgJsonlFile}`);
      console.log(`From backup: ${backupFile}`);
      console.log(`\nYou can now run 'compact resume' again if needed.`);
      process.exit(0);
    }

    // Check if session ID provided as argument
    const arg = process.argv[2];
    let sessionIdArg: string | undefined;

    // Validate if it's a GUID (session ID)
    if (arg && isValidGuid(arg)) {
      sessionIdArg = arg.toLowerCase(); // Normalize to lowercase
      console.log(`Using specified session: ${sessionIdArg}`);
    } else if (arg) {
      // Unknown command
      console.error(`Unknown command: ${arg}\n`);
      console.log('Usage: compact [session-id | command] [--force]');
      console.log('\nCommands:');
      console.log('  (no args)         Run compaction on current session');
      console.log('  <session-id>      Run compaction on specific session');
      console.log('  status            Check compaction status');
      console.log('  resume [args...]  Resume compacted session (args passed to claude)');
      console.log('  rollback          Restore from backup after resume');
      console.log('\nFlags:');
      console.log('  --force           Skip confirmation if ready compaction exists');
      process.exit(1);
    }

    // Check if there's an existing ready compaction
    const stateFile = getStateJsonFile();
    const forceOverride = process.env.COMPACT_FORCE === '1' || process.argv.includes('--force');

    if (!forceOverride && await Bun.file(stateFile).exists()) {
      const existingState = await Bun.file(stateFile).json() as CompactState;
      if (existingState.status === 'ready') {
        console.log('\n⚠️  WARNING: An existing compaction is ready to resume!');
        console.log(`   Fork session: ${existingState.forkSessionId}`);
        console.log(`   Completed: ${existingState.endTime}`);
        console.log('\n   Running a new compaction will discard this ready session.');
        process.stdout.write('\n   Continue anyway? (y/N): ');

        // Read single character without waiting for Enter
        process.stdin.setRawMode(true);
        process.stdin.resume();

        const answer = await new Promise<string>((resolve) => {
          process.stdin.once('data', (data) => {
            const char = data.toString().toLowerCase();
            resolve(char);
          });
        });

        process.stdin.setRawMode(false);
        process.stdin.pause();
        console.log(answer); // Echo the character

        if (answer !== 'y') {
          console.log('\nCancelled. Use "compact resume" to resume the existing session.');
          process.exit(0);
        }
        console.log('');
      }
    }

    const compactStartTime = new Date().toISOString();

    let orgSessionId: string;
    if (sessionIdArg) {
      // Use the specified session ID directly
      console.log("Using specified session...");
      orgSessionId = sessionIdArg;
    } else {
      // Get current session using fd
      console.log("Getting current session...");
      orgSessionId = await getCurrentSessionId();
    }

    // Find JSONL file using fd
    const orgJsonlFile = await firstLine($`fd -1utf ${'^' + orgSessionId + '.jsonl$'} ${CLAUDE_PROJECTS_DIR}`.lines());
    if (!orgJsonlFile) throw new Error(`Original JSONL file not found for session ${orgSessionId}`);

    console.log(`ORG_SESSION_ID = ${orgSessionId}`);
    console.log(`ORG_JSONL_FILE = ${orgJsonlFile}`);

    // Fork session and run /compact in single call
    // Default to haiku unless user specified --model
    const hasModelArg = process.argv.some(arg => arg === '--model' || arg.startsWith('--model='));
    const modelArg = hasModelArg ? '' : ' --model haiku';

    console.log("Forking session and running /compact...");
    const proc = Bun.spawn(['bash', '-c', `echo '{"type":"user","message":{"role":"user","content":"/compact"}}' | claude -p --verbose --input-format stream-json --output-format stream-json -r ${orgSessionId} --fork-session${modelArg}`], {
      stdout: 'pipe',
      stderr: 'inherit'
    });

    // Read first line to get session ID immediately
    const reader = proc.stdout.getReader();
    let buffer = '';
    let forkSessionId = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += new TextDecoder().decode(value);
      const newlineIndex = buffer.indexOf('\n');

      if (newlineIndex !== -1) {
        const firstLine = buffer.slice(0, newlineIndex);
        try {
          const initEvent = JSON.parse(firstLine);
          if (initEvent.type === 'system' && initEvent.subtype === 'init') {
            forkSessionId = initEvent.session_id;
            break;
          }
        } catch (e) {
          // Not valid JSON, continue reading
        }
        buffer = buffer.slice(newlineIndex + 1);
      }
    }

    if (!forkSessionId) throw new Error("Failed to get fork session ID from stream");

    console.log(`FORK_SESSION_ID = ${forkSessionId}`);

    // Find JSONL file
    const forkJsonlFile = await firstLine($`fd -1utf ^${forkSessionId}.jsonl$ ${CLAUDE_PROJECTS_DIR}`.lines());
    if (!forkJsonlFile) throw new Error(`Compact JSONL file not found for session ${forkSessionId}`);

    console.log(`FORK_JSONL_FILE = ${forkJsonlFile}`);

    // Save state (mark as in-progress)
    const state: CompactState = {
      orgSessionId,
      orgJsonlFile,
      forkSessionId,
      forkJsonlFile,
      status: 'compacting',
      compactStartTime,
      startTime: new Date().toISOString(),
      endTime: null,
    };
    await Bun.write(stateFile, JSON.stringify(state, null, 2));

    // Wait for /compact to complete
    console.log("Waiting for /compact to complete...\n");

    // Continue reading rest of stream (discard but keep process alive)
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`Compact failed with exit code ${exitCode}`);

    // Update state to mark as complete
    state.status = 'ready';
    state.endTime = new Date().toISOString();
    await Bun.write(stateFile, JSON.stringify(state, null, 2));

    console.log("\n✅ Session forked for compaction");
    console.log(`   Original session: ${orgSessionId}`);
    console.log(`   Compact session: ${forkSessionId}`);
    console.log(`   State: ${stateFile}\n`);

    console.log(`\n✅ Compaction complete`);
    console.log(`\n   Run 'compact resume' to merge and resume original session\n`);

    // Send notification
    try {
      await $`osascript -e 'display notification "Compaction complete. Run compact resume to merge." with title "Claude: Compact Done"'`;
    } catch (e) {
      console.log(`Notification failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

async function handleMerge() {
  const stateFile = getStateJsonFile();
  if (!await Bun.file(stateFile).exists()) {
    throw new Error(`No compact state found. Run 'compact' first.`);
  }

  let state = await Bun.file(stateFile).json() as CompactState;

  // Wait for compaction to complete if in progress
  if (state.status === 'compacting') {
    console.log('Compaction in progress, waiting...');
    let waited = 0;
    while (state.status === 'compacting' && waited < MAX_COMPACTION_WAIT_SECONDS) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Poll every 1 second
      state = await Bun.file(stateFile).json() as CompactState;
      waited++;
    }
    if (state.status === 'compacting') {
      throw new Error(`Compaction timeout after ${MAX_COMPACTION_WAIT_SECONDS}s. Check compact process.`);
    }
    console.log('Compaction complete, proceeding with merge...');
  } else if (state.status === 'resumed') {
    throw new Error(`Already resumed. Run 'compact rollback' first if you want to undo the merge.`);
  } else if (state.status !== 'ready') {
    throw new Error(`Invalid state: ${state.status}. Run 'compact' first.`);
  }

  const { orgSessionId, orgJsonlFile, forkSessionId, forkJsonlFile, compactStartTime } = state;
  if (!compactStartTime) throw new Error('compactStartTime not found in state - please re-run compact');

  console.log(`Loaded state from ${stateFile}`);
  console.log(`ORG_SESSION_ID = ${orgSessionId}`);
  console.log(`ORG_JSONL_FILE = ${orgJsonlFile}`);
  console.log(`FORK_SESSION_ID = ${forkSessionId}`);
  console.log(`FORK_JSONL_FILE = ${forkJsonlFile}`);

  console.log("\nMerging forked messages with original session...");

  // Read fork jsonl file (reversed, then we'll reverse back)
  const forkLinesArrayRev: JsonLine[] = [];

  for await (const line of readLinesReverse(forkJsonlFile)) {
    const json: JsonLine = JSON.parse(line.replaceAll(forkSessionId, orgSessionId));
    forkLinesArrayRev.push(json);
    if (json.subtype === "compact_boundary") break;
  }

  // Single pass: collect tool_use IDs, track UUIDs, and identify orphaned tool_results
  const toolUseIds = new Set<string>();
  const allUuids = new Set<string>();
  const uuidToParentMap = new Map<string, string>();
  const orphanedIndices = new Set<number>();

  forkLinesArrayRev.forEach((line, idx) => {
    if (line.uuid) allUuids.add(line.uuid);
    if (line.uuid && line.parentUuid) {
      uuidToParentMap.set(line.uuid, line.parentUuid);
    }

    const content = line.message?.content;
    if (!content || !Array.isArray(content)) return;

    // Collect tool_use IDs
    content.forEach(c => {
      if (c.type === 'tool_use' && c.id) {
        toolUseIds.add(c.id);
      }
    });
  });

  // Second pass: identify orphaned tool_results
  forkLinesArrayRev.forEach((line, idx) => {
    const content = line.message?.content;
    if (!content || !Array.isArray(content)) return;

    const hasOrphanedToolResult = content.some(c =>
      c.type === 'tool_result' && c.tool_use_id && !toolUseIds.has(c.tool_use_id)
    );

    if (hasOrphanedToolResult) {
      console.log(`⚠️  Filtered orphaned tool_result (UUID: ${line.uuid})`);
      orphanedIndices.add(idx);
    }
  });

  // Filter out orphaned messages
  const validForkLinesArrayRev = forkLinesArrayRev.filter((_, idx) => !orphanedIndices.has(idx));

  // Find filtered UUIDs
  const remainingUuids = new Set(validForkLinesArrayRev.map(line => line.uuid).filter(Boolean));
  const filteredUuids = new Set<string>();
  for (const uuid of allUuids) {
    if (!remainingUuids.has(uuid)) filteredUuids.add(uuid);
  }

  // Update the array to use filtered version
  forkLinesArrayRev.length = 0;
  forkLinesArrayRev.push(...validForkLinesArrayRev);

  // Fix parent UUID references - if any message references a filtered UUID as parent,
  // relink it to that filtered message's parent
  if (filteredUuids.size > 0) {
    forkLinesArrayRev.forEach(line => {
      if (line.parentUuid && filteredUuids.has(line.parentUuid)) {
        // Walk back to find non-filtered parent
        let newParent = line.parentUuid;
        while (newParent && filteredUuids.has(newParent)) {
          newParent = uuidToParentMap.get(newParent) || '';
        }
        if (newParent) {
          line.parentUuid = newParent;
        }
      }
    });
  }

  // Read original jsonl file - get messages added after forking
  let firstNewTimestamp: string = '';
  const newLinesArrayRev: JsonLine[] = [];

  for await (const line of readLinesReverse(orgJsonlFile)) {
    const json: JsonLine = JSON.parse(line);

    // Stop when we reach messages from before the fork
    if (json.timestamp && json.timestamp <= compactStartTime) {
      // Link the fork's compact_boundary to the last message before fork
      if (json.uuid) {
        forkLinesArrayRev[forkLinesArrayRev.length - 1].logicalParentUuid = json.uuid;
      }
      break;
    }

    if (json.timestamp) firstNewTimestamp = json.timestamp;
    newLinesArrayRev.push(json);
  }
  const newLinesArray = newLinesArrayRev.toReversed(); // Restore original order

  // Build parent map for new messages (same pattern as fork messages)
  const newUuidToParentMap = new Map<string, string>();
  newLinesArray.forEach(line => {
    if (line.uuid && line.parentUuid) {
      newUuidToParentMap.set(line.uuid, line.parentUuid);
    }
  });

  // Collect tool_use IDs from NEW messages only
  const newToolUseIds = new Set<string>();
  newLinesArray.forEach(line => {
    const content = line.message?.content;
    if (content && Array.isArray(content)) {
      content.forEach(c => {
        if (c.type === 'tool_use' && c.id) {
          newToolUseIds.add(c.id);
        }
      });
    }
  });

  // Filter tool_results from new messages that don't have tool_use in NEW messages
  // This catches: 1) truly orphaned tool_results, 2) tool_results referencing pre-fork tool_uses (separated by fork boundary)
  const newOrphanedUuids = new Set<string>();
  const validNewLines = newLinesArray.filter((line, idx) => {
    const content = line.message?.content;
    if (!content || !Array.isArray(content)) return true;

    const hasUnmatchedToolResult = content.some(c =>
      c.type === 'tool_result' && c.tool_use_id && !newToolUseIds.has(c.tool_use_id)
    );

    if (hasUnmatchedToolResult) {
      console.log(`⚠️  Filtered unmatched tool_result from new messages (UUID: ${line.uuid}, tool_use_id: ${content.find(c => c.type === 'tool_result')?.tool_use_id})`);
      if (line.uuid) newOrphanedUuids.add(line.uuid);
      return false;
    }
    return true;
  });

  // Fix parent references in new messages (same pattern as fork messages)
  if (newOrphanedUuids.size > 0) {
    validNewLines.forEach(line => {
      if (line.parentUuid && newOrphanedUuids.has(line.parentUuid)) {
        // Walk back to find non-filtered parent
        let newParent = line.parentUuid;
        while (newParent && newOrphanedUuids.has(newParent)) {
          newParent = newUuidToParentMap.get(newParent) || '';
        }
        if (newParent) {
          line.parentUuid = newParent;
        }
      }
    });
  }

  // Replace newLinesArray with filtered version
  newLinesArray.length = 0;
  newLinesArray.push(...validNewLines);

  // Make sure fork timestamps are in order
  if (firstNewTimestamp) {
    forkLinesArrayRev.forEach(json => {
      if (json.timestamp) {
        if (json.timestamp > firstNewTimestamp) {
          json.timestamp = firstNewTimestamp;
        } else {
          firstNewTimestamp = json.timestamp;
        }
      }
    });
  }

  const forkLinesArray = forkLinesArrayRev.toReversed(); // Restore Fork order
  const uuidSet = forkLinesArray.map(({ uuid }) => uuid).filter(Boolean) as string[];
  const uuidSetForLookup = new Set(uuidSet); // For O(1) lookups

  // Find unknown UUIDs in new lines and map them to previous uuid
  const newUuidMap: Record<string, string> = {};
  newLinesArray.forEach(line => {
    if (line.parentUuid && !uuidSetForLookup.has(line.parentUuid) && !newUuidMap[line.parentUuid]) {
      const lastUuid = uuidSet[uuidSet.length - 1];
      if (lastUuid) newUuidMap[line.parentUuid] = lastUuid;
    }
    if (line.uuid && !uuidSetForLookup.has(line.uuid)) {
      uuidSet.push(line.uuid);
      uuidSetForLookup.add(line.uuid);
    }
  });

  const replaceNewUuids = (str: string): string => {
    for (const [oldUuid, newUuid] of Object.entries(newUuidMap)) {
      str = str.replaceAll(oldUuid, newUuid);
    }
    return str;
  };

  const writer = Bun.file(FORKED_TMP_JSONL_FILE).writer();
  try {
    forkLinesArray.forEach(line => writer.write(JSON.stringify(line) + '\n'));
    newLinesArray.forEach(line => writer.write(replaceNewUuids(JSON.stringify(line)) + '\n'));
    await writer.end();
  } catch (error) {
    await writer.end();
    throw error;
  }

  const orgLinesCount = parseInt(await firstLine($`wc -l < ${orgJsonlFile}`.lines()) ?? '0');
  const preCompactLinesCount = orgLinesCount - newLinesArray.length - 1; // -1 for trailing newline

  // Backup original file before merge
  const backupFile = getBackupFile();
  await $`cp ${orgJsonlFile} ${backupFile}`;
  console.log(`Backup saved: ${backupFile}`);

  await $`head -n ${preCompactLinesCount} ${orgJsonlFile} > ${MERGE_TMP_JSONL_FILE} && cat ${FORKED_TMP_JSONL_FILE} >> ${MERGE_TMP_JSONL_FILE} && rm ${FORKED_TMP_JSONL_FILE} && mv ${MERGE_TMP_JSONL_FILE} ${orgJsonlFile}`;

  // Update state to mark as resumed
  state.status = 'resumed';
  state.resumeTime = new Date().toISOString();
  await Bun.write(stateFile, JSON.stringify(state, null, 2));

  console.log("✅ Merge complete!");
  console.log(`To rollback: compact rollback`);
  return orgSessionId;
}

interface MessageContent {
  type: string;
  id?: string;
  tool_use_id?: string;
}

interface JsonLine {
  uuid?: string;
  logicalParentUuid?: string;
  parentUuid?: string;
  timestamp?: string;
  subtype?: string;
  message?: {
    content?: MessageContent[];
  };
  [key: string]: unknown;
}

interface CompactState {
  orgSessionId: string;
  orgJsonlFile: string;
  forkSessionId: string;
  forkJsonlFile: string;
  status: 'compacting' | 'ready' | 'resumed';
  compactStartTime: string;
  startTime: string;
  endTime: string | null;
  resumeTime?: string;
  rollbackTime?: string;
}

const FORKED_TMP_JSONL_FILE = `/tmp/claude-forked-${process.pid}.jsonl`;
const MERGE_TMP_JSONL_FILE = `/tmp/claude-merge-${process.pid}.jsonl`;
const MAX_COMPACTION_WAIT_SECONDS = 600;
const CLAUDE_PROJECTS_DIR = `${process.env.HOME}/.claude/projects`;

process.on("SIGINT", () => {
  cleanupSync();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanupSync();
  process.exit(143);
});
process.on("exit", cleanupSync);

main();
