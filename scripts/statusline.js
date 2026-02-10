#!/usr/bin/env node

/**
 * Claude Code Statusline
 * Emits a compact, ANSI-colored single-line status string showing:
 * duration | status | cost | context usage @ percent | current agent name current loaded skills
 *
 * If background agents are running, appends a tree-style block listing each background task.
 */

const fs = require("fs");
const readline = require("readline");
const path = require("path");

// ANSI color constants
const RESET = "\x1B[0m";
const DIM = "\x1B[2m";
const GREEN = "\x1B[32m";
const YELLOW = "\x1B[33m";
const RED = "\x1B[31m";
const CYAN = "\x1B[36m";
const MAGENTA = "\x1B[35m";

// Pricing data (simplified from hud.js)
const PRICING = {
  "claude-haiku-4": {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cacheWriteMarkup: 0.25,
    cacheReadDiscount: 0.9,
  },
  "claude-sonnet-4.5": {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheWriteMarkup: 0.25,
    cacheReadDiscount: 0.9,
  },
  "claude-opus-4.5": {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheWriteMarkup: 0.25,
    cacheReadDiscount: 0.9,
  },
};

// Model output ratios for estimation
const MODEL_OUTPUT_RATIOS = { haiku: 0.3, sonnet: 0.4, opus: 0.5 };
const DEFAULT_RATIO = 0.4;

// Max bytes to read from transcript tail
const MAX_TAIL_BYTES = 512 * 1024;
const MAX_AGENT_MAP_SIZE = 100;

/**
 * Read and parse stdin JSON
 */
async function readStdin() {
  if (process.stdin.isTTY) {
    return null;
  }
  const chunks = [];
  try {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = chunks.join("");
    if (!raw.trim()) {
      return null;
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Get total tokens from stdin
 */
function getTotalTokens(stdin) {
  const usage = stdin.context_window?.current_usage;
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0)
  );
}

/**
 * Get context window percentage
 */
function getContextPercent(stdin) {
  const nativePercent = stdin.context_window?.used_percentage;
  if (typeof nativePercent === "number" && !Number.isNaN(nativePercent)) {
    return Math.min(100, Math.max(0, Math.round(nativePercent)));
  }
  const size = stdin.context_window?.context_window_size;
  if (!size || size <= 0) {
    return 0;
  }
  const totalTokens = getTotalTokens(stdin);
  return Math.min(100, Math.round((totalTokens / size) * 100));
}

/**
 * Get model name from stdin
 */
function getModelName(stdin) {
  return stdin.model?.display_name ?? stdin.model?.id ?? "Unknown";
}

/**
 * Detect model output ratio
 */
function detectModelRatio(modelName) {
  const normalized = modelName.toLowerCase();
  for (const [tier, ratio] of Object.entries(MODEL_OUTPUT_RATIOS)) {
    if (normalized.includes(tier)) {
      return ratio;
    }
  }
  return DEFAULT_RATIO;
}

/**
 * Estimate output tokens based on input
 */
function estimateOutputTokens(inputTokens, modelName) {
  if (inputTokens === 0) return 0;
  const ratio = detectModelRatio(modelName);
  return Math.round(inputTokens * ratio);
}

/**
 * Get pricing for model (simplified version)
 */
function getPricingForModel(modelName) {
  const normalized = modelName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/claude-/, "");
  if (normalized.includes("haiku")) return PRICING["claude-haiku-4"];
  if (normalized.includes("opus")) return PRICING["claude-opus-4.5"];
  return PRICING["claude-sonnet-4.5"];
}

/**
 * Calculate cost from token usage
 */
function calculateCost(
  modelName,
  inputTokens,
  cacheCreationTokens,
  cacheReadTokens,
) {
  const pricing = getPricingForModel(modelName);
  const estimatedOutput = estimateOutputTokens(inputTokens, modelName);

  const inputCost = (inputTokens / 1e6) * pricing.inputPerMillion;
  const outputCost = (estimatedOutput / 1e6) * pricing.outputPerMillion;
  const cacheWriteCost =
    (cacheCreationTokens / 1e6) *
    pricing.inputPerMillion *
    (1 + pricing.cacheWriteMarkup);
  const cacheReadCost =
    (cacheReadTokens / 1e6) *
    pricing.inputPerMillion *
    (1 - pricing.cacheReadDiscount);
  const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;

  return totalCost;
}

/**
 * Format cost with appropriate precision
 */
function formatCost(cost) {
  return `$${cost.toFixed(4)}`;
}

/**
 * Read tail lines from file (for large transcripts)
 */
function readTailLines(filePath, fileSize, maxBytes) {
  const startOffset = Math.max(0, fileSize - maxBytes);
  const bytesToRead = fileSize - startOffset;
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(bytesToRead);
  try {
    fs.readSync(fd, buffer, 0, bytesToRead, startOffset);
  } finally {
    fs.closeSync(fd);
  }
  const content = buffer.toString("utf8");
  const lines = content.split("\n");
  if (startOffset > 0 && lines.length > 0) {
    lines.shift();
  }
  return lines;
}

/**
 * Extract background agent ID from content
 */
function extractBackgroundAgentId(content) {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const textBlock = content.find((c) => c.type === "text");
    text = textBlock?.text || "";
  } else if (content?.type === "text") {
    text = content.text || "";
  }
  const match = text.match(/agentId:\s*([a-zA-Z0-9-]+)/);
  return match ? match[1] : null;
}

/**
 * Parse TaskOutput result for completion status
 */
function parseTaskOutputResult(content) {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const textBlock = content.find((c) => c.type === "text");
    text = textBlock?.text || "";
  } else if (content?.type === "text") {
    text = content.text || "";
  }
  const taskIdMatch = text.match(/<task_id>([^<]+)<\/task_id>/);
  const statusMatch = text.match(/<status>([^<]+)<\/status>/);
  if (taskIdMatch && statusMatch) {
    return { taskId: taskIdMatch[1], status: statusMatch[1] };
  }
  return null;
}

/**
 * Process a single transcript entry
 */
function processEntry(entry, agentMap, result, backgroundAgentMap) {
  const timestamp = entry.timestamp ? new Date(entry.timestamp) : new Date();

  if (!result.sessionStart && entry.timestamp) {
    result.sessionStart = timestamp;
  }

  const content = entry.message?.content;
  if (!content || !Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === "tool_use" && block.id && block.name) {
      if (block.name === "Task" || block.name === "proxy_Task") {
        const input = block.input;
        const agentEntry = {
          id: block.id,
          type: input?.subagent_type ?? "unknown",
          model: input?.model,
          description: input?.description,
          status: "running",
          startTime: timestamp,
          endTime: null,
        };

        // Manage map size
        if (agentMap.size >= MAX_AGENT_MAP_SIZE) {
          let oldestCompleted = null;
          let oldestTime = Infinity;
          for (const [id, agent] of agentMap) {
            if (agent.status === "completed" && agent.startTime) {
              const time = agent.startTime.getTime();
              if (time < oldestTime) {
                oldestTime = time;
                oldestCompleted = id;
              }
            }
          }
          if (oldestCompleted) {
            agentMap.delete(oldestCompleted);
          }
        }

        agentMap.set(block.id, agentEntry);
      } else if (block.name === "Skill" || block.name === "proxy_Skill") {
        const input = block.input;
        if (input?.skill) {
          result.lastActivatedSkill = {
            name: input.skill,
            args: input.args,
            timestamp,
          };
        }
      }
    }

    if (block.type === "tool_result" && block.tool_use_id) {
      const agent = agentMap.get(block.tool_use_id);
      if (agent) {
        const blockContent = block.content;
        const isBackgroundLaunch =
          typeof blockContent === "string"
            ? blockContent.includes("Async agent launched")
            : Array.isArray(blockContent) &&
              blockContent.some(
                (c) =>
                  c.type === "text" && c.text?.includes("Async agent launched"),
              );

        if (isBackgroundLaunch) {
          if (backgroundAgentMap && blockContent) {
            const bgAgentId = extractBackgroundAgentId(blockContent);
            if (bgAgentId) {
              backgroundAgentMap.set(bgAgentId, block.tool_use_id);
            }
          }
        } else {
          agent.status = "completed";
          agent.endTime = timestamp;
        }
      }
    }

    // Check for background agent completion (outside the tool_use_id check)
    if (block.type === "tool_result" && backgroundAgentMap && block.content) {
      const taskOutput = parseTaskOutputResult(block.content);
      if (taskOutput && taskOutput.status === "completed") {
        const toolUseId = backgroundAgentMap.get(taskOutput.taskId);
        if (toolUseId) {
          const bgAgent = agentMap.get(toolUseId);
          if (bgAgent && bgAgent.status === "running") {
            bgAgent.status = "completed";
            bgAgent.endTime = timestamp;
          }
        }
      }
    }
  }
}

/**
 * Parse transcript file
 */
async function parseTranscript(transcriptPath) {
  const result = {
    agents: [],
    lastActivatedSkill: undefined,
    sessionStart: null,
  };

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return result;
  }

  const agentMap = new Map();
  const backgroundAgentMap = new Map();

  try {
    const stat = fs.statSync(transcriptPath);
    const fileSize = stat.size;

    if (fileSize > MAX_TAIL_BYTES) {
      const lines = readTailLines(transcriptPath, fileSize, MAX_TAIL_BYTES);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          processEntry(entry, agentMap, result, backgroundAgentMap);
        } catch {
          // Skip invalid lines
        }
      }
    } else {
      const fileStream = fs.createReadStream(transcriptPath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          processEntry(entry, agentMap, result, backgroundAgentMap);
        } catch {
          // Skip invalid lines
        }
      }
    }
  } catch {
    // Return empty result on error
  }

  // Mark stale agents as completed
  const STALE_AGENT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();
  for (const agent of agentMap.values()) {
    if (agent.status === "running") {
      const runningTime = now - agent.startTime.getTime();
      if (runningTime > STALE_AGENT_THRESHOLD_MS) {
        agent.status = "completed";
        agent.endTime = new Date(
          agent.startTime.getTime() + STALE_AGENT_THRESHOLD_MS,
        );
      }
    }
  }

  // Separate running and completed agents
  const running = Array.from(agentMap.values()).filter(
    (a) => a.status === "running",
  );
  const completed = Array.from(agentMap.values()).filter(
    (a) => a.status === "completed",
  );
  result.agents = [
    ...running,
    ...completed.slice(-(10 - running.length)),
  ].slice(0, 10);

  return result;
}

/**
 * Format duration in human-readable form
 */
function formatDuration(sessionStart) {
  if (!sessionStart) return "0m";
  const durationMs = Date.now() - sessionStart.getTime();
  const minutes = Math.floor(durationMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
}

/**
 * Format context size with K suffix
 */
function formatContextSize(size) {
  if (!size) return "0";
  const k = Math.round(size / 1024);
  return `${k}K`;
}

/**
 * Get cost color based on value
 */
function getCostColor(cost) {
  if (cost < 1) return GREEN;
  if (cost < 5) return YELLOW;
  return RED;
}

/**
 * Render background agent tree
 */
function renderBackgroundAgentTree(agents) {
  if (agents.length === 0) return "";

  const lines = [];
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const isLast = i === agents.length - 1;
    const prefix = isLast ? "└─ " : "├─ ";
    const continuation = isLast ? "   " : "│  ";

    const desc = agent.description || agent.type || "unknown";
    const statusStr = agent.status === "completed" ? "Done" : "Running";

    lines.push(`${prefix}${desc} · ? tool uses · 0 tokens`);
    lines.push(`${continuation}⎿ ${statusStr}`);
  }

  return lines.join("\n");
}

/**
 * Main function
 */
async function main() {
  const stdin = await readStdin();
  if (!stdin) {
    console.error("No stdin data provided");
    process.exit(1);
  }

  const transcriptPath = process.argv[2] || stdin.transcript_path;
  const transcriptData = await parseTranscript(transcriptPath);

  // Calculate fields
  const duration = formatDuration(transcriptData.sessionStart);
  const status = "ok"; // Simple constant as per plan

  // Calculate cost
  let cost = "$0.00";
  let costColor = RESET;
  try {
    const usage = stdin.context_window?.current_usage;
    if (usage) {
      const modelName = getModelName(stdin);
      const inputTokens = usage.input_tokens ?? 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

      const totalCost = calculateCost(
        modelName,
        inputTokens,
        cacheCreationTokens,
        cacheReadTokens,
      );
      cost = formatCost(totalCost);
      costColor = getCostColor(totalCost);
    }
  } catch {
    // Use default on error
  }

  // Context info
  const contextSize = formatContextSize(getTotalTokens(stdin));
  const contextPercent = getContextPercent(stdin);

  // Current agent
  const runningAgents = transcriptData.agents.filter(
    (a) => a.status === "running",
  );
  const currentAgent =
    runningAgents.length > 0
      ? runningAgents[0].description || runningAgents[0].type
      : "";

  // Current skill
  let currentSkill = "";
  if (transcriptData.lastActivatedSkill) {
    const skill = transcriptData.lastActivatedSkill;
    const argsStr = skill.args ? `(${skill.args})` : "";
    currentSkill = `skill:${skill.name}${argsStr}`;
  }

  // Build main statusline
  const parts = [
    `${DIM}${duration}${RESET}`,
    status,
    `${costColor}${cost}${RESET}`,
    `${contextSize} @ ${contextPercent}%`,
    currentAgent ? `${CYAN}${currentAgent}${RESET}` : "",
    currentSkill ? `${MAGENTA}${currentSkill}${RESET}` : "",
  ].filter((p) => p !== "");

  const statusline = parts.join(" | ");

  // Output
  console.log(statusline);

  // Background agents tree (if any running)
  if (runningAgents.length > 1) {
    const backgroundAgents = runningAgents.slice(1);
    const tree = renderBackgroundAgentTree(backgroundAgents);
    if (tree) {
      console.log(tree);
    }
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
