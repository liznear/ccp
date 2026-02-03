#!/usr/bin/env node
/**
 * Context Sync Hook
 *
 * Monitors session length and signals when a sync is needed.
 * This script is intended to be run by the PreToolUse hook.
 */

const fs = require('fs');
const path = require('path');

// Configuration
const SYNC_INTERVAL = 15; // Sync every 15 user messages
const TRANSCRIPT_PATH = process.env.CLAUDE_TRANSCRIPT_PATH;

function log(message) {
  console.error(message);
}

function main() {
  if (!TRANSCRIPT_PATH || !fs.existsSync(TRANSCRIPT_PATH)) {
    return;
  }

  try {
    const content = fs.readFileSync(TRANSCRIPT_PATH, 'utf8');
    // Simple regex to count user messages
    // Note: This format depends on how Claude stores transcripts locally.
    // Adjust regex if transcript format changes.
    const userMessageCount = (content.match(/"type":"user"/g) || []).length;

    if (userMessageCount > 0 && userMessageCount % SYNC_INTERVAL === 0) {
      log(`\n[AUTO-SYNC] Context volume is high (${userMessageCount} messages).`);
      log(`[AUTO-SYNC] Please run 'session-manager' skill to consolidate state before context compaction.\n`);
    }
  } catch (err) {
    // Silently fail to not disrupt flow
  }
}

main();
