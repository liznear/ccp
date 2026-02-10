#!/usr/bin/env node
/**
 * Context Sync Hook
 *
 * Monitors session activity using a local persisted counter and signals when a sync is needed.
 * This script is intended to be run by the PreToolUse hook.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const SYNC_INTERVAL = 15; // Sync every 15 tool uses/actions

// Store state in ~/.claude directory to persist across CLI runs
const HOME_DIR = os.homedir();
const CLAUDE_DIR = path.join(HOME_DIR, '.claude');
const STATE_FILE = path.join(CLAUDE_DIR, 'context-sync-state.json');

function log(message) {
  console.error(message);
}

function main() {
  try {
    // 0. Ensure .claude dir exists
    if (!fs.existsSync(CLAUDE_DIR)) {
      // If we can't find/make the directory, we can't track state
      return;
    }

    let count = 0;

    // 1. Read existing state if available
    if (fs.existsSync(STATE_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (typeof data.count === 'number') {
          count = data.count;
        }
      } catch (e) {
        // Ignore corrupted file, start from 0
      }
    }

    // 2. Increment counter
    count++;

    // 3. Save new state
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      count,
      lastUpdated: new Date().toISOString()
    }));

    // 4. Check threshold
    if (count > 0 && count % SYNC_INTERVAL === 0) {
      log(`\n[AUTO-SYNC] Context volume is high (${count} actions).`);
      log(`[CCP TRIGGER] You are required to run the 'session-manager' skill now to save state before context compaction.\n`);
    }

  } catch (err) {
    // Silently fail to not disrupt flow
    // console.error(err);
  }
}

main();
