import { runDaemonProcess, type ManagedDaemon } from "./runtime.js";
import { createKeyring, generateDeviceKeyPair, saveKeyring } from "./workspace-key.js";

export type { ManagedDaemon };
export type SpawnDaemonOptions = Parameters<typeof runDaemonProcess>[1];

const daemons = new Set<ManagedDaemon>();

export async function spawnDaemon(directory: string, options?: SpawnDaemonOptions): Promise<ManagedDaemon> {
  const daemon = await runDaemonProcess(directory, options);
  daemons.add(daemon);
  return daemon;
}

export async function stopDaemon(daemon: ManagedDaemon): Promise<void> {
  if (!daemons.delete(daemon)) return;
  await daemon.stop();
}

export async function stopAllDaemons(): Promise<void> {
  await Promise.all([...daemons].map((daemon) => stopDaemon(daemon)));
}

/**
 * Puts the same workspace key (and a distinct device identity) into several checkouts,
 * standing in for the pairing/approval dance the real flow uses to distribute it.
 *
 * Integration tests that are about something else -- live fan-out, reconnects, handoffs --
 * still run fully encrypted this way, which is the point: it keeps them exercising the
 * default rather than tempting anyone to switch encryption off to make them simple.
 */
export async function shareTestKeyring(workspaceId: string, directories: string[]): Promise<void> {
  const shared = createKeyring(workspaceId);
  for (const directory of directories) {
    await saveKeyring(directory, { ...shared, device: generateDeviceKeyPair() });
  }
}
