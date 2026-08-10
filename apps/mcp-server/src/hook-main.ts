import { setTimeout as delay } from "node:timers/promises";
import { connectToDaemon } from "./daemon-api.js";
import { runHook } from "./hook.js";

/**
 * A hook runs in front of the agent's edit, so it has to end. A client that hands us a pipe
 * and does not close it -- Claude Code closes its own, other clients are their own
 * implementations -- would otherwise leave this loop waiting for an EOF that never comes,
 * and the edit blocked behind it forever. Whatever arrived by then is what gets parsed;
 * nothing usable means exit 0 and out of the way.
 */
const STDIN_TIMEOUT_MS = 5_000;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let text = "";
  const drain = (async () => { for await (const chunk of process.stdin) text += chunk; })().catch(() => {});
  // Unreferenced, so waiting for EOF is still what ends this on the normal path.
  await Promise.race([drain, delay(STDIN_TIMEOUT_MS, undefined, { ref: false })]);
  process.stdin.destroy();
  return text;
}

function parsePayload(stdin: string, argv: string[]): unknown {
  const raw = stdin.trim() || argv[0]?.trim() || "";
  if (raw.startsWith("{")) {
    try { return JSON.parse(raw); } catch { return undefined; }
  }
  // A client that passes the path as a plain argument still works.
  return raw ? { path: raw } : undefined;
}

/**
 * Blocks with exit 2 and the reason on stderr: Claude Code feeds a PreToolUse hook's stderr
 * back to the agent on that exit code, and a non-zero exit is the only signal every other
 * client agrees on. The stdout JSON is Claude Code's structured form, emitted as well for
 * clients that read it. Anything unexpected exits 0 and stays out of the way.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let decision;
  try {
    decision = await runHook(await connectToDaemon(), parsePayload(await readStdin(), argv));
  } catch {
    return 0;
  }
  if (!decision) return 0;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason
    }
  }));
  process.stderr.write(`${decision.reason}\n`);
  return 2;
}
