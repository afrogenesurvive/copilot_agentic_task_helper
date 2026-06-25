#!/usr/bin/env node

/**
 * Agent Runner — Autonomous queue processor (watch mode)
 *
 * Listens for trigger file changes from the webhook server, then processes
 * priority queue items via DeepSeek V4. No polling — event-driven.
 *
 * Usage:
 *   node mcp/agent-runner/index.js             # Start in foreground
 *   AGENT_RUNNER_ENABLED=false node ...        # Dry run (no processing)
 *
 * On startup, the runner checks the queue once. After that, it sits idle
 * until the webhook server touches .runner-trigger (on every priority
 * enqueue). A slow fallback timer checks for daily tasks only.
 *
 * Toggle from chat:
 *   Start: node mcp/agent-runner/index.js &
 *   Stop:  kill <PID> (find with: lsof -i :3199 | grep agent-runner)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import {
  readPending,
  markCleared,
  acquireLock,
  releaseLock,
  readTasks,
  markTaskDone,
  acquireTaskLock,
  releaseTaskLock,
  isTaskLocked,
} from "./poller.js";
import { callModel, buildTaskContext } from "./model-client.js";
import { executeToolCall } from "./tool-executor.js";
import { logAction } from "./logger.js";
import { allTools } from "../../shared/tool-manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.resolve(__dirname, ".runner.pid");

// ── Config ──

const ENABLED = process.env.AGENT_RUNNER_ENABLED !== "false";

// Trigger file path — the webhook server touches this whenever it
// enqueues a priority item, waking the runner up (no polling).
const TRIGGER_FILE = path.resolve(__dirname, "..", "..", "logs", "pending-tool-calls", ".runner-trigger");

// Slow fallback for daily task checking only (queue triggered via fs.watch).
// Default: every 60 seconds. Set to 0 to disable fallback entirely.
const TASK_CHECK_INTERVAL = parseInt(process.env.AGENT_TASK_INTERVAL || "60000", 10);

// ── Helpers ──

function printQueueState(label) {
  const items = readPending();
  if (items.length === 0) {
    console.log(`   📭 [QUEUE] ${label} — queue is empty`);
    return;
  }
  console.log(`   📋 [QUEUE] ${label} — ${items.length} item(s):`);
  for (const item of items) {
    const num = item.seqNo ? `#${item.seqNo}` : `#?`;
    const desc = item.data?.rule ? `"${item.data.rule}" → ${item.data.tool}` : `${item.source}/${item.type}`;
    const summary = item.data?.originalEvent?.data?.card?.name
      ? ` — card: "${item.data.originalEvent.data.card.name}"`
      : item.data?.text
        ? ` — "${item.data.text.slice(0, 60)}"`
        : item.card?.name
          ? ` — card: "${item.card.name}"`
          : "";
    console.log(`      ${num}) ${desc}${summary}`);
  }
}

function printTaskState(label) {
  const tasks = readTasks();
  const pending = tasks.filter((t) => !t.checked);
  const done = tasks.filter((t) => t.checked);
  if (tasks.length === 0) {
    console.log(`   📭 [TASKS] ${label} — no task file for today`);
    return;
  }
  console.log(`   📋 [TASKS] ${label} — ${done.length}/${tasks.length} done, ${pending.length} pending`);
  for (const t of tasks) {
    const status = t.checked ? "✅" : "⬜";
    console.log(`      ${status} ${t.text}`);
  }
}

// ── Main processing loop ──

async function processEvent(event) {
  const eventId = event.id;
  const seqNo = event.seqNo;
  const tag = seqNo ? `#${seqNo}` : `(${eventId?.slice(0, 8)}...)`;

  console.log(`\n   ╔══════════════════════════════════════════════╗`);
  console.log(`   ║       🔄 PROCESSING EVENT ${tag.padEnd(16)}║`);
  console.log(`   ╚══════════════════════════════════════════════╝`);
  console.log(`   📋 [RUNNER] ${event.source}/${event.type}`);

  // Show queue state before processing
  printQueueState("before");

  // Acquire lock so the poller skips this item
  acquireLock(eventId);

  // Detect frontdesk events — these are restricted to read-only + commenting
  const isFrontdesk =
    event.source === "trello" &&
    (event.type === "commentCard" || event.type === "createCard") &&
    (event.data?.originalEvent?.data?.list?.name === "frontdesk_input" ||
      event.data?.originalEvent?.data?.list?.name === "frontdesk_output" ||
      event.data?.rule?.toLowerCase().includes("frontdesk"));

  if (isFrontdesk) {
    console.log(`   🔒 [RUNNER] Frontdesk event detected — read-only + commenting only`);
  }

  try {
    // Step 1: Send to DeepSeek V4 for reasoning
    console.log(`   🤖 [RUNNER] Asking DeepSeek V4...`);
    const decision = await callModel(event, allTools);

    if (!decision) {
      console.log(`   ⏭️  [RUNNER] No decision — marking as skipped`);
      logAction({ eventId, seqNo, eventType: `${event.source}/${event.type}`, action: "skipped" });
      markCleared(eventId);
      printQueueState("after");
      return;
    }

    // Step 2: Taking action
    console.log(`\n   ╔══════════════════════════════════════════════╗`);
    console.log(`   ║        🛠️  TAKING ACTION                       ║`);
    console.log(`   ╚══════════════════════════════════════════════╝`);
    console.log(`   🎯 [RUNNER] ${decision.name}`);
    console.log(`   📝 [RUNNER] Params: ${JSON.stringify(decision.arguments)}`);

    const result = await executeToolCall(decision.name, decision.arguments, { isFrontdesk });

    // Step 3: Log the outcome
    logAction({
      eventId,
      seqNo,
      eventType: `${event.source}/${event.type}`,
      toolName: decision.name,
      toolArgs: decision.arguments,
      toolResult: result.ok ? "success" : "failed",
      error: result.error || null,
      action: result.ok ? "processed" : "failed",
    });

    // Step 4: Mark as cleared
    if (result.ok) {
      console.log(`\n   ✅ [RUNNER] Event ${tag} processed successfully`);
    } else {
      console.log(`   ❌ [RUNNER] Event ${tag} failed: ${result.error}`);
    }
    markCleared(eventId);

    // Show queue state after
    printQueueState("after");
  } catch (err) {
    console.error(`   ❌ [RUNNER] Unexpected error processing ${tag}: ${err.message}`);
    logAction({ eventId, seqNo, eventType: `${event.source}/${event.type}`, action: "failed", error: err.message });
    releaseLock(eventId);
    printQueueState("after");
  }
}

/**
 * Process a task from the daily task list by sending it to DeepSeek.
 * The model decides if it can take action (read queues, comment, etc.)
 * or marks the task as not automatable.
 */
async function processTask(task) {
  const tag = task.lineIndex;

  console.log(`\n   ╔══════════════════════════════════════════════╗`);
  console.log(`   ║       🔄 PROCESSING TASK                       ║`);
  console.log(`   ╚══════════════════════════════════════════════╝`);
  console.log(`   📋 [RUNNER] Task: "${task.text}"`);

  // Show task state before
  printTaskState("before");

  // Acquire lock
  acquireTaskLock(task.lineIndex);

  try {
    // Build task context and send to DeepSeek
    console.log(`   🤖 [RUNNER] Asking DeepSeek V4...`);
    const taskContext = buildTaskContext(task);
    const decision = await callModel(taskContext, allTools);

    if (!decision) {
      console.log(`   ⏭️  [RUNNER] No decision — marking task as skipped`);
      logAction({
        eventType: "task",
        taskText: task.text,
        action: "skipped",
        reason: "model returned no decision",
      });
      markTaskDone(task.lineIndex);
      printTaskState("after");
      return;
    }

    // Check if the model explicitly said to skip
    if (decision.skip) {
      console.log(`   ⏭️  [RUNNER] Model indicated task is not automatable — marking done`);
      logAction({
        eventType: "task",
        taskText: task.text,
        action: "skipped",
        reason: "not automatable",
      });
      markTaskDone(task.lineIndex);
      printTaskState("after");
      return;
    }

    // Taking action
    console.log(`\n   ╔══════════════════════════════════════════════╗`);
    console.log(`   ║        🛠️  TAKING ACTION                       ║`);
    console.log(`   ╚══════════════════════════════════════════════╝`);
    console.log(`   🎯 [RUNNER] ${decision.name}`);
    console.log(`   📝 [RUNNER] Params: ${JSON.stringify(decision.arguments)}`);

    const result = await executeToolCall(decision.name, decision.arguments, { isFrontdesk: false });

    // Log the outcome
    logAction({
      eventType: "task",
      taskText: task.text,
      toolName: decision.name,
      toolArgs: decision.arguments,
      toolResult: result.ok ? "success" : "failed",
      error: result.error || null,
      action: result.ok ? "processed" : "failed",
    });

    // Mark task done after processing (or even if failed — avoid re-trying bad tasks)
    if (result.ok) {
      console.log(`\n   ✅ [RUNNER] Task "${task.text}" processed successfully`);
    } else {
      console.log(`   ❌ [RUNNER] Task failed: ${result.error}`);
    }
    markTaskDone(task.lineIndex);

    // Show task state after
    printTaskState("after");
  } catch (err) {
    console.error(`   ❌ [RUNNER] Unexpected error processing task: ${err.message}`);
    logAction({
      eventType: "task",
      taskText: task.text,
      action: "failed",
      error: err.message,
    });
    releaseTaskLock(task.lineIndex);
    printTaskState("after");
  }
}

// Guard to prevent concurrent mainLoop runs
let isProcessing = false;

async function mainLoop() {
  if (isProcessing) return;
  isProcessing = true;

  if (!ENABLED) {
    console.log(`   ⏸️  [RUNNER] Disabled (AGENT_RUNNER_ENABLED=false)`);
    isProcessing = false;
    return;
  }

  // First check the priority queue
  const pending = readPending();
  if (pending.length > 0) {
    console.log(`\n   🔔 [RUNNER] ${pending.length} pending item(s) detected in priority queue`);
    const event = pending[0];
    await processEvent(event);
    isProcessing = false;
    return;
  }

  // Queue empty — check for uncompleted tasks
  const tasks = readTasks();
  const pendingTasks = tasks.filter((t) => !t.checked);
  if (pendingTasks.length === 0) {
    isProcessing = false;
    return;
  }

  // Skip tasks already being processed by another cycle
  const availableTask = pendingTasks.find((t) => !isTaskLocked(t.lineIndex));
  if (!availableTask) {
    isProcessing = false;
    return;
  }

  console.log(`\n   🔔 [RUNNER] ${pendingTasks.length} uncompleted task(s) in daily task list`);
  await processTask(availableTask);
  isProcessing = false;
}

// ── Startup ──

function printBanner() {
  const line = "─".repeat(50);
  console.log(`\n${line}`);
  console.log(`   🤖 Agent Runner`);
  console.log(`   📡 DeepSeek V4`);
  console.log(`   � Watch mode (triggered by webhook server via .runner-trigger)`);
  console.log(`   📋 Task fallback: every ${TASK_CHECK_INTERVAL / 1000}s (AGENT_TASK_INTERVAL)`);
  console.log(`   🛡️  ${allTools.length} tools available (allowlist restricts to safe subset)`);
  console.log(`${line}\n`);

  // Write PID file for easy kill from chat
  fs.writeFileSync(PID_FILE, String(process.pid));
}

printBanner();

// ── Trigger file watcher (event-driven) ──
// The webhook server touches .runner-trigger whenever it enqueues
// a priority item. We watch it instead of polling the JSONL file.

// Ensure the trigger file exists (fs.watch will fail if it doesn't)
try {
  if (!fs.existsSync(TRIGGER_FILE)) {
    fs.writeFileSync(TRIGGER_FILE, "");
  }
} catch {
  /* ignore */
}

// Debounce timer for fs.watch (macOS can fire multiple rapid events)
let watchTimer = null;

const triggerWatcher = fs.watch(TRIGGER_FILE, () => {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(() => mainLoop(), 100);
});

// ── Fallback timer for daily tasks ──
// Priority queue changes are triggered via fs.watch above, but daily
// task file changes aren't tracked. This slow fallback picks up tasks.
let taskTimer = null;
if (TASK_CHECK_INTERVAL > 0) {
  taskTimer = setInterval(() => {
    // Only bother if the queue is empty (otherwise mainLoop already runs)
    const pending = readPending();
    if (pending.length === 0) {
      mainLoop();
    }
  }, TASK_CHECK_INTERVAL);
}

// Run once immediately on startup (handles backlog + tasks)
mainLoop();

// ── Interactive terminal ──
// Type "stop", "exit", "quit", or press Ctrl+C to shut down

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "runner> ",
  terminal: true,
});

rl.prompt();

rl.on("line", (input) => {
  const cmd = input.trim().toLowerCase();
  if (cmd === "stop" || cmd === "exit" || cmd === "quit") {
    shutdown();
  } else if (cmd === "status") {
    const items = readPending();
    console.log(`   📋 Priority queue: ${items.length} pending`);
    for (const item of items) {
      const num = item.seqNo ? `#${item.seqNo}` : `#?`;
      console.log(`      ${num}) ${item.source}/${item.type}`);
    }
    // Also show task state
    const allTasks = readTasks();
    if (allTasks.length > 0) {
      const pending = allTasks.filter((t) => !t.checked);
      const done = allTasks.filter((t) => t.checked);
      console.log(`   📋 Tasks: ${done.length}/${allTasks.length} done, ${pending.length} pending`);
      for (const t of allTasks) {
        const status = t.checked ? "✅" : "⬜";
        console.log(`      ${status} ${t.text}`);
      }
    }
    rl.prompt();
  } else if (cmd === "help") {
    console.log(`   Available commands:`);
    console.log(`   stop/exit/quit  — Shut down the runner`);
    console.log(`   status          — Show pending queue items and tasks`);
    console.log(`   tasks           — Show task list with status`);
    console.log(`   help            — Show this help`);
    rl.prompt();
  } else if (cmd === "tasks") {
    printTaskState("current");
    rl.prompt();
  } else if (cmd) {
    console.log(`   Unknown command. Type "help" for options.`);
    rl.prompt();
  } else {
    rl.prompt();
  }
});

// ── Graceful shutdown ──

function shutdown() {
  console.log(`\n   ⏹️  [RUNNER] Shutting down...`);
  if (watchTimer) clearTimeout(watchTimer);
  triggerWatcher.close();
  if (taskTimer) clearInterval(taskTimer);
  rl.close();
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
