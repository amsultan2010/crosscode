import { runDaemonProcess, type ManagedDaemon } from "./runtime.js";

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
