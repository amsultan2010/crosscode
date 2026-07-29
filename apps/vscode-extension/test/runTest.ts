import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runTests } from "@vscode/test-electron";
import { CoordinationService } from "../../service/src/index.js";
import { DaemonClient } from "../../daemon/src/client.js";
import { LocalDaemon } from "../../daemon/src/index.js";

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CLAIM_PATH = "claimed.txt";
const PROPOSAL_PATH_A = "shared-a.txt";
const PROPOSAL_PATH_B = "shared-b.txt";

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Timed out waiting for condition${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

/**
 * Sets up a temporary Git repository VS Code will open as its workspace, a real Crosscode daemon
 * process serving it, and a pending proposal from a second replica -- following the same
 * in-process-daemons-then-real-process pattern as apps/daemon/src/process.test.ts.
 */
async function fixture(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "crosscode-vscode-e2e-"));
  const seed = join(root, "seed");
  const workspace = join(root, "workspace");
  const secondReplica = join(root, "second-replica");

  await exec("git", ["init", "-q", "-b", "main", seed]);
  await exec("git", ["-C", seed, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", seed, "config", "user.name", "Test"]);
  await writeFile(join(seed, "a.txt"), "one\n");
  await mkdir(join(seed, ".crosscode"), { recursive: true });
  await writeFile(
    join(seed, ".crosscode", "config.yaml"),
    "version: 1\nvalidation:\n  profiles:\n    fast:\n      commands:\n        - exit 0\n        - exit 1\n"
  );
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-qm", "initial"]);

  await exec("git", ["clone", "-q", seed, workspace]);
  await exec("git", ["clone", "-q", seed, secondReplica]);
  for (const checkout of [workspace, secondReplica]) {
    await exec("git", ["-C", checkout, "config", "user.email", "test@example.com"]);
    await exec("git", ["-C", checkout, "config", "user.name", "Test"]);
  }

  await mkdir(join(workspace, ".git", "crosscode"), { recursive: true });
  await writeFile(
    join(workspace, ".git", "crosscode", "config.json"),
    JSON.stringify({ workspaceId: "w", replicaId: "workspace", actorId: "actor" })
  );

  // Seed two pending proposals from a second replica before the real daemon process starts,
  // exactly like the receiver-restart fixture in apps/daemon/src/process.test.ts.
  const service = new CoordinationService();
  const sending = await LocalDaemon.open(secondReplica, { workspaceId: "w", replicaId: "second-replica", actorId: "second-actor" });
  const receiving = await LocalDaemon.open(workspace, { workspaceId: "w", replicaId: "workspace", actorId: "actor" });
  await writeFile(join(secondReplica, PROPOSAL_PATH_A), "from replica two (a)\n");
  await sending.capture("proposal a", service);
  await receiving.sync(service);
  await writeFile(join(secondReplica, PROPOSAL_PATH_B), "from replica two (b)\n");
  await sending.capture("proposal b", service);
  await receiving.sync(service);
  sending.close();
  receiving.close();

  return { root, workspace };
}

function startDaemonProcess(directory: string): ChildProcess {
  const entry = join(repoRoot, "apps/daemon/src/main.ts");
  const child = spawn(process.execPath, ["--import", "tsx", entry, "--directory", directory], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[daemon] ${chunk}`));
  return child;
}

async function stopDaemonProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function main(): Promise<void> {
  const { root, workspace } = await fixture();
  const daemonProcess = startDaemonProcess(workspace);
  // VS Code's user-data-dir hosts a Unix domain socket whose path must stay under ~103 chars;
  // this repo's own path is long enough to exceed that, so use a short tmp dir instead
  // (the documented @vscode/test-electron workaround for "IPC handle ... is longer than 103 chars").
  const shortDataDir = await mkdtemp(join(tmpdir(), "cc-vscode-"));
  try {
    await waitFor(() => DaemonClient.connect(workspace), () => true);

    const extensionDevelopmentPath = extensionRoot;
    const extensionTestsPath = join(extensionRoot, "dist/test/suite/index.cjs");

    console.log(`Launching a real VS Code extension host against temporary workspace: ${workspace}`);
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        "--disable-extensions",
        `--user-data-dir=${join(shortDataDir, "user-data")}`,
        `--extensions-dir=${join(shortDataDir, "extensions")}`
      ],
      extensionTestsEnv: {
        CROSSCODE_TEST_CLAIM_PATH: CLAIM_PATH,
        CROSSCODE_TEST_PROPOSAL_PATH_A: PROPOSAL_PATH_A,
        CROSSCODE_TEST_PROPOSAL_PATH_B: PROPOSAL_PATH_B
      }
    });
    console.log("Extension host integration suite passed.");

    // Phase 5 exit criterion: disabling/deactivating the extension must not disrupt daemon state.
    // The VS Code process above has fully exited (deactivating the extension along with it); the
    // daemon process was never told to stop, so a direct daemon status call now proves it survived
    // extension teardown untouched.
    const statusAfterExtensionExit = await DaemonClient.connect(workspace).then((client) => client.status());
    if (statusAfterExtensionExit.workspaceId !== "w" || statusAfterExtensionExit.replicaId !== "workspace") {
      throw new Error("Daemon status was unexpectedly disrupted after the extension host exited");
    }
    console.log("Confirmed: the daemon remained healthy and reachable after the extension host exited.");
  } finally {
    await stopDaemonProcess(daemonProcess);
    await rm(root, { recursive: true, force: true });
    await rm(shortDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
