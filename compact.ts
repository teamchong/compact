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
      console.log(`Resuming original session ${orgSessionId}...`);
      const proc = Bun.spawn(['claude', '-r', orgSessionId], {
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
      console.log('Usage: compact [session-id | command]');
      console.log('\nCommands:');
      console.log('  (no args)         Run compaction on current session');
      console.log('  <session-id>      Run compaction on specific session');
      console.log('  status            Check compaction status');
      console.log('  resume            Resume compacted session');
      console.log('  rollback          Restore from backup after resume');
      process.exit(1);
    }

    const compactStartTime = new Date().toISOString();

    let orgSessionId: string;
    if (sessionIdArg) {
      // Use the specified session ID with -r
      console.log("Using specified session...");
      const data = await $`claude -p --output-format json -r ${sessionIdArg} '!echo Compact started at ${compactStartTime}'`.json();
      orgSessionId = data.session_id;
      if (!orgSessionId) throw new Error("Failed to get session ID");
    } else {
      // Use current session with -c
      console.log("Getting current session...");
      const data = await $`claude -p --output-format json -c '!echo Compact started at ${compactStartTime}'`.json();
      orgSessionId = data.session_id;
      if (!orgSessionId) throw new Error("Failed to get original session ID");
    }

    const orgJsonlFile = await firstLine($`fd -1utf ${'^' + orgSessionId + '.jsonl$'} ${CLAUDE_PROJECTS_DIR}`.lines());
    if (!orgJsonlFile) throw new Error(`Original JSONL file not found for session ${orgSessionId}`);

    console.log(`ORG_SESSION_ID = ${orgSessionId}`);
    console.log(`ORG_JSONL_FILE = ${orgJsonlFile}`);

    // Fork session
    console.log("Forking session for compaction...");
    const forkData = await $`claude -p --output-format json -r ${orgSessionId} --fork-session '!echo Forked for compaction at ${compactStartTime}'`.json();
    const forkSessionId = forkData.session_id;
    if (!forkSessionId) throw new Error("Failed to fork session for compaction");

    const forkJsonlFile = await firstLine($`fd -1utf ^${forkSessionId}.jsonl$ ${CLAUDE_PROJECTS_DIR}`.lines());
    if (!forkJsonlFile) throw new Error(`Compact JSONL file not found for session ${forkSessionId}`);

    console.log(`FORK_SESSION_ID = ${forkSessionId}`);
    console.log(`FORK_JSONL_FILE = ${forkJsonlFile}`);

    // Save state (mark as in-progress)
    const stateFile = getStateJsonFile();
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

    // Run /compact in the forked session
    console.log("Running /compact...\n");
    const compactResult = await $`claude -p -r ${forkSessionId} '/compact'`;
    if (compactResult.exitCode !== 0) throw new Error(`Compact failed with exit code ${compactResult.exitCode}`);

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
