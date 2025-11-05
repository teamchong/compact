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

    let skipLast = false;
    if (startPos > 0 && lines.length > 0) {
      savedFirstLine = lines[lines.length - 1];
      skipLast = true; // Don't yield incomplete line from chunk boundary
    }

    for (let i = 0; i < lines.length; i++) {
      if (skipLast && i === lines.length - 1) continue; // Skip incomplete line
      const line = lines[i];
      if (line.trim()) yield line;
    }

    endPos = startPos;
  }
}

async function cleanup() {
  await Promise.allSettled([
    unlink(FORKED_TMP_JSONL_FILE),
    unlink(MERGE_TMP_JSONL_FILE)
  ]);
}

async function firstLine<T>(lines: AsyncIterable<T>): Promise<T | null> {
  for await (const line of lines) {
    return line;
  }
  return null;
}

function getStateJsonFile(): string {
  const cwd = process.cwd();
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  return `/tmp/compact-${hash}.json`;
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

      const state = await Bun.file(stateFile).json();
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

      const state = await Bun.file(stateFile).json();
      if (state.status !== 'resumed') {
        throw new Error(`Cannot rollback. Current status: ${state.status}. Only 'resumed' sessions can be rolled back.`);
      }

      const { orgJsonlFile } = state;

      const cwd = process.cwd();
      const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
      const backupFile = `/tmp/compact-backup-${hash}.jsonl`;

      if (!await Bun.file(backupFile).exists()) {
        throw new Error(`Backup file not found: ${backupFile}`);
      }

      await $`mv ${backupFile} ${orgJsonlFile}`;

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

    const compactStartTime = new Date().toISOString();
    console.log("Getting current session...");
    const data = await $`claude -p --output-format json -c '!echo Compact started at ${compactStartTime}'`.json();
    const orgSessionId = data.session_id;
    if (!orgSessionId) throw new Error("Failed to get original session ID");

    const orgJsonlFile = await firstLine($`fd -1utf ${'^' + orgSessionId + '.jsonl$'} ${process.env.HOME + '/.claude/projects'}`.lines());
    if (!orgJsonlFile) throw new Error("Original JSONL file not found");

    console.log(`ORG_SESSION_ID = ${orgSessionId}`);
    console.log(`ORG_JSONL_FILE = ${orgJsonlFile}`);

    // Fork session
    console.log("Forking session for compaction...");
    const forkData = await $`claude -p --output-format json -r ${orgSessionId} --fork-session '!echo Forked for compaction at ${compactStartTime}'`.json();
    const forkSessionId = forkData.session_id;
    if (!forkSessionId) throw new Error("Failed to fork session for compaction");

    const forkJsonlFile = await firstLine($`fd -1utf ^${forkSessionId}.jsonl$ ${process.env.HOME}/.claude/projects`.lines());
    if (!forkJsonlFile) throw new Error("Compact JSONL file not found");

    console.log(`FORK_SESSION_ID = ${forkSessionId}`);
    console.log(`FORK_JSONL_FILE = ${forkJsonlFile}`);

    // Save state (mark as in-progress)
    const stateFile = getStateJsonFile();
    const state = {
      orgSessionId,
      orgJsonlFile,
      forkSessionId,
      forkJsonlFile,
      status: 'compacting',
      compactStartTime,
      startTime: new Date().toISOString(),
      endTime: null as string | null,
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

  let state = await Bun.file(stateFile).json();

  // Wait for compaction to complete if in progress
  if (state.status === 'compacting') {
    console.log('Compaction in progress, waiting...');
    while (state.status === 'compacting') {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Poll every 1 second
      state = await Bun.file(stateFile).json();
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

  //Read fork jsonl file (reversed, then we'll reverse back)
  const forkLinesArrayRev: JsonLine[] = [];

  for await (const line of readLinesReverse(forkJsonlFile)) {
    if (!line) continue;
    const json: JsonLine = JSON.parse(line); // No error handling, fail fast and loud

    forkLinesArrayRev.push(json);

    // Stop after compact_boundary
    if (json.subtype === "compact_boundary") break;
  }

  //Read original jsonl file - get messages added after forking
  let firstNewTimestamp: string = '';
  const newLinesArrayRev: JsonLine[] = [];

  // Read original lines (reversed, then we'll reverse back)
  for await (const line of readLinesReverse(orgJsonlFile)) {
    if (!line) continue;
    const json: JsonLine = JSON.parse(line.replaceAll(orgSessionId, forkSessionId));

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

  const newUuidKeys = Object.keys(newUuidMap);
  const replaceNewUuids = (str: string): string => {
    newUuidKeys.forEach(key => {
      str = str.replaceAll(key, newUuidMap[key]);
    });
    return str;
  };

  const writer = Bun.file(FORKED_TMP_JSONL_FILE).writer();
  try {
    forkLinesArray.forEach(line => writer.write(JSON.stringify(line) + '\n'));
    newLinesArray.forEach(line => writer.write(replaceNewUuids(JSON.stringify(line)) + '\n'));
  } finally {
    await writer.end();
  }

  const orgLinesCount = parseInt(await firstLine($`wc -l < ${orgJsonlFile}`.lines()) ?? '0');
  const preCompactLinesCount = orgLinesCount - newLinesArray.length - 1; // -1 for trailing newline

  // Backup original file before merge
  const cwd = process.cwd();
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  const backupFile = `/tmp/compact-backup-${hash}.jsonl`;
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

interface JsonLine {
  uuid?: string;
  logicalParentUuid?: string;
  parentUuid?: string;
  timestamp?: string;
  subtype?: string;
  [key: string]: unknown;
}

const FORKED_TMP_JSONL_FILE = `/tmp/claude-forked-${process.pid}.jsonl`;
const MERGE_TMP_JSONL_FILE = `/tmp/claude-merge-${process.pid}.jsonl`;

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", cleanup);
process.on("exit", cleanup);

main();
