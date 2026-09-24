#!/usr/bin/env node

/**
 * Agent Runner — Autonomous queue processor (watch mode)
 *
 * Listens for trigger file changes from the webhook server, then processes
 * priority queue items via the configured LLM provider. No polling — event-driven.
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

import config from "../../shared/config-loader.cjs";
config.loadEnvInto(process.env);
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
  appendDeadLetter,
} from "./poller.js";
import { callModel, buildTaskContext, toolStepMessages } from "./model-client.js";
import { getModelName } from "../../shared/model-provider.mjs";
import { executeToolCall } from "./tool-executor.js";
import { logAction } from "./logger.js";
import { allTools } from "../../shared/tool-manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.resolve(__dirname, ".runner.pid");

// ── Config ──

const ENABLED = process.env.AGENT_RUNNER_ENABLED !== "false";

/**
 * How many model turns one frontdesk event may take: read → answer, plus room to
 * recover from a failed tool or a second read.
 *
 * The initial default of 3 was measured too tight on the first live run: asked
 * "check latest inbox message" the model made two reads and ran out before it could
 * reply, so the user got the fallback apology instead of an answer. Non-frontdesk
 * events always get exactly one turn.
 */
const MAX_ROUNDS = (() => {
  const n = parseInt(process.env.AGENT_RUNNER_MAX_ROUNDS || "5", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 5;
})();

/**
 * Upper bound on how many queue items a single wake-up will process. The loop in
 * mainLoop drains the backlog instead of stopping after one item (the fallback
 * timer below used to be the only thing that continued, and it skipped a non-empty
 * queue — so 5 queued messages needed 5 separate triggers).
 */
const MAX_ITEMS_PER_PASS = (() => {
  const n = parseInt(process.env.AGENT_MAX_ITEMS_PER_PASS || "10", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 10;
})();

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

/**
 * What a chat user gets when the event could not be answered at all. The reply
 * itself is sent through the normal executor, so it is encrypted for the seat by
 * the webhook server exactly like any other reply.
 */
const FALLBACK_REPLY =
  "Sorry — I hit a problem handling that message on my side. A team member will pick it up and follow up with you shortly.";

async function processEvent(event) {
  const eventId = event.id;
  const seqNo = event.seqNo;
  const tag = seqNo ? `#${seqNo}` : `(${eventId?.slice(0, 8)}...)`;
  const eventType = `${event.source}/${event.type}`;

  console.log(`\n   ╔══════════════════════════════════════════════╗`);
  console.log(`   ║       🔄 PROCESSING EVENT ${tag.padEnd(16)}║`);
  console.log(`   ╚══════════════════════════════════════════════╝`);
  console.log(`   📋 [RUNNER] ${eventType}`);

  // Show queue state before processing
  printQueueState("before");

  // Acquire lock so the poller skips this item
  acquireLock(eventId);

  // Detect frontdesk events — these are restricted to read-only + commenting
  const isFrontdesk =
    event.source === "frontdesk" ||
    (event.source === "trello" &&
      (event.type === "commentCard" || event.type === "createCard") &&
      (event.data?.originalEvent?.data?.list?.name === "frontdesk_input" ||
        event.data?.originalEvent?.data?.list?.name === "frontdesk_output" ||
        event.data?.rule?.toLowerCase().includes("frontdesk")));

  if (isFrontdesk) {
    console.log(`   🔒 [RUNNER] Frontdesk event detected — read-only + commenting only`);
  }

  const seat = event.data?.sub || null;
  // A frontdesk question normally needs two turns (read the data, then reply with
  // it) and may need a third after a failed tool. Everything else is decided in a
  // single turn, exactly as before.
  const maxRounds = isFrontdesk ? MAX_ROUNDS : 1;
  const history = [];
  let lastError = null;

  try {
    for (let round = 1; round <= maxRounds; round++) {
      // Step 1: Send to the configured LLM for reasoning
      // (throws with code MODEL_ERROR when the provider itself is unreachable)
      console.log(`   🤖 [RUNNER] Asking ${getModelName()}${round > 1 ? ` (turn ${round}/${maxRounds})` : ""}...`);
      const decision = await callModel(event, allTools, { history, step: `decision-${round}` });

      if (!decision) {
        console.log(`   ⏭️  [RUNNER] No decision — marking as skipped`);
        logAction({ eventId, seqNo, eventType, action: "skipped", reason: `no tool call on turn ${round}` });
        await markCleared(eventId);
        printQueueState("after");
        return;
      }

      // Step 2: Taking action
      console.log(`\n   ╔══════════════════════════════════════════════╗`);
      console.log(`   ║        🛠️  TAKING ACTION                       ║`);
      console.log(`   ╚══════════════════════════════════════════════╝`);
      console.log(`   🎯 [RUNNER] ${decision.name}`);
      console.log(`   📝 [RUNNER] Params: ${JSON.stringify(decision.arguments)}`);

      const result = await executeToolCall(decision.name, decision.arguments, { isFrontdesk, sub: seat });

      // Step 3: Log the outcome
      logAction({
        eventId,
        seqNo,
        eventType,
        toolName: decision.name,
        toolArgs: decision.arguments,
        toolResult: result.ok ? "success" : "failed",
        error: result.error || null,
        action: result.ok ? "processed" : "failed",
      });

      // A reply — or any non-frontdesk action — ends the event here.
      if (result.ok && (!isFrontdesk || decision.name === "frontdesk_reply")) {
        console.log(`\n   ✅ [RUNNER] Event ${tag} processed successfully`);
        await markCleared(eventId);
        printQueueState("after");
        return;
      }

      // Otherwise there is another turn: either a read result to answer from, or an
      // error to work around. Both are just context for the next request.
      lastError = result.ok ? null : result.error;
      if (result.ok) {
        console.log(`   ↩️  [RUNNER] ${decision.name} done — feeding the result back for the answer`);
      } else {
        console.log(`   ⚠️  [RUNNER] Turn ${round}/${maxRounds} failed: ${result.error}`);
      }

      history.push(...toolStepMessages(decision, summarizeToolResult(result), `${eventId}-turn-${round}`));
    }

    // Budget spent without reaching a terminal action.
    await failEvent({
      event,
      eventId,
      seqNo,
      eventType,
      isFrontdesk,
      seat,
      reason: lastError || `no terminal action within ${maxRounds} turn(s)`,
    });
    printQueueState("after");
  } catch (err) {
    if (err && err.code === "MODEL_ERROR") {
      // The provider was unreachable. Not the event's fault, and emphatically not
      // "nothing to do" — this used to be swallowed as a skip and cleared.
      await failEvent({ event, eventId, seqNo, eventType, isFrontdesk, seat, reason: `model unavailable: ${err.message}` });
      printQueueState("after");
      return;
    }
    console.error(`   ❌ [RUNNER] Unexpected error processing ${tag}: ${err.message}`);
    logAction({ eventId, seqNo, eventType, action: "failed", error: err.message });
    releaseLock(eventId);
    printQueueState("after");
  }
}

/**
 * Terminal failure for one event: tell the user, record it, then clear it.
 *
 * Clearing is deliberate even though the run failed — every trigger retries
 * `pending[0]`, so leaving it pending would block the whole queue behind it (the
 * old code left exception-path events pending forever for exactly that reason).
 * The dead-letter file is what makes the loss visible and recoverable.
 */
async function failEvent({ event, eventId, seqNo, eventType, isFrontdesk, seat, reason }) {
  console.error(`   ❌ [RUNNER] Event ${seqNo ? `#${seqNo}` : eventId} failed: ${reason}`);

  // Never leave a chat user in silence — say something, even when we could not help.
  if (isFrontdesk && seat) {
    await sendFallbackReply(seat, reason);
  }

  appendDeadLetter({
    eventId,
    seqNo,
    eventType,
    isFrontdesk,
    seat,
    reason,
    text: event.data?.text ?? null,
    data: event.data ?? null,
  });

  logAction({ eventId, seqNo, eventType, action: "failed", error: reason, deadLettered: true });
  await markCleared(eventId, { failed: true, lastError: String(reason).slice(0, 500) });
}

/** Best-effort apology to a frontdesk seat after a terminal failure. */
async function sendFallbackReply(sub, reason) {
  try {
    const r = await executeToolCall("frontdesk_reply", { text: FALLBACK_REPLY }, { isFrontdesk: true, sub });
    if (r.ok) console.log(`   💬 [RUNNER] Sent the fallback reply to ${sub} (reason: ${reason})`);
    else console.error(`   ❌ [RUNNER] Fallback reply failed: ${r.error}`);
    return r.ok;
  } catch (err) {
    console.error(`   ❌ [RUNNER] Fallback reply threw: ${err.message}`);
    return false;
  }
}

/** Tool result → the text fed back to the model (the executor already sanitized it). */
function summarizeToolResult(result) {
  if (!result.ok) return `[error] ${result.error || "tool failed"}`;
  try {
    const out = JSON.stringify(result.result !== undefined ? result.result : result);
    return out.length > 4000 ? `${out.slice(0, 4000)}…(truncated)` : out;
  } catch {
    return "ok";
  }
}

/**
 * Process a task from the daily task list by sending it to the configured LLM.
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
    // Build task context and send to the configured LLM
    console.log(`   🤖 [RUNNER] Asking ${getModelName()}...`);
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

// Set when a trigger arrives while an event is mid-flight. Without it the trigger
// is dropped (the old `if (isProcessing) return;`) and the new item waits for some
// later, unrelated trigger — which is how a 5-item backlog produced latencies of
// 23 minutes and 2h48m in the logs.
let pendingWork = false;

async function mainLoop() {
  if (isProcessing) {
    pendingWork = true;
    return;
  }
  isProcessing = true;

  try {
    if (!ENABLED) {
      console.log(`   ⏸️  [RUNNER] Disabled (AGENT_RUNNER_ENABLED=false)`);
      return;
    }

    // Drain the priority queue (oldest first). `seen` keeps a single pass from
    // retrying an item that failed but stayed pending.
    const seen = new Set();
    for (let pass = 0; pass < MAX_ITEMS_PER_PASS; pass++) {
      const pending = readPending().filter((e) => !seen.has(e.id));
      if (pending.length === 0) break;
      const event = pending[0];
      seen.add(event.id);
      console.log(
        `\n   🔔 [RUNNER] ${pending.length} pending item(s) ${pass === 0 ? "detected" : "still"} in priority queue`,
      );
      await processEvent(event);
    }

    // Queue is empty — fall through to the daily task list
    const tasks = readTasks();
    const pendingTasks = tasks.filter((t) => !t.checked);
    if (pendingTasks.length === 0) return;

    // Skip tasks already being processed by another cycle
    const availableTask = pendingTasks.find((t) => !isTaskLocked(t.lineIndex));
    if (!availableTask) return;

    console.log(`\n   🔔 [RUNNER] ${pendingTasks.length} uncompleted task(s) in daily task list`);
    await processTask(availableTask);
  } finally {
    isProcessing = false;
    // A trigger that arrived while we were busy still needs servicing.
    if (pendingWork) {
      pendingWork = false;
      setTimeout(() => mainLoop(), 50);
    }
  }
}

// ── Startup ──

function printBanner() {
  const line = "─".repeat(50);
  console.log(`\n${line}`);
  console.log(`   🤖 Agent Runner`);
  console.log(`   📡 ${getModelName()}`);
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
  // Safety net only: the trigger file drives the queue in normal operation. This
  // fires unconditionally (it used to skip a non-empty queue) so a missed trigger
  // or a crashed pass cannot leave the backlog sitting there.
  taskTimer = setInterval(() => mainLoop(), TASK_CHECK_INTERVAL);
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
