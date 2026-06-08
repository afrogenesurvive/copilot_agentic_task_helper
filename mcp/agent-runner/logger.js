/**
 * Logger — audit logging for every action the runner takes
 *
 * Writes structured JSONL logs to logs/agent-runner/YYYY-MM-DD.jsonl
 * so there's a complete, queryable record of every autonomous action.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "..", "..", "logs", "agent-runner");

/**
 * Log an action result to the daily audit file.
 * @param {object} entry — { eventId, seqNo?, eventType, toolName?, toolResult?, error?, action: 'processed'|'skipped'|'failed' }
 */
export function logAction(entry) {
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  const logEntry = { ts, ...entry };

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${day}.jsonl`), JSON.stringify(logEntry) + "\n");
  } catch (err) {
    console.error(`   ❌ [LOGGER] Write failed: ${err.message}`);
  }
}
