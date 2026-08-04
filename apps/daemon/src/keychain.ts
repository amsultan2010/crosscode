import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SERVICE_NAME = "crosscode-supabase-session";

/**
 * Shells out to the OS-native secret store rather than depending on a native npm module
 * (keytar is deprecated; nothing keychain-related is otherwise vendored in this repo).
 * Every function here is opportunistic: any failure or platform without a supported tool
 * resolves to false/undefined rather than throwing, so callers can always fall back to the
 * existing mode-0600 config file behavior without special-casing errors.
 */

async function commandExists(command: string): Promise<boolean> {
  return exec("which", [command]).then(() => true, () => false);
}

export async function keychainAvailable(): Promise<boolean> {
  if (process.platform === "darwin") return commandExists("security");
  if (process.platform === "linux") return commandExists("secret-tool");
  return false;
}

export async function storeSecret(account: string, secret: string): Promise<boolean> {
  // A newline would terminate the value early on both platforms' stdin protocol below,
  // storing a truncated secret that then fails to authenticate in a confusing way.
  // Supabase refresh tokens never contain one; refuse rather than corrupt if that changes.
  if (/[\r\n]/.test(secret)) return false;
  try {
    if (process.platform === "darwin") {
      // `-w` with no value makes `security` read the password from stdin (twice, for its
      // confirmation prompt) instead of taking it as an argument. Passing it as `-w
      // <secret>` put the refresh token in this process's argv, where any other user on
      // the machine could read it straight out of `ps`.
      await execFileWithStdin("security", ["add-generic-password", "-a", account, "-s", SERVICE_NAME, "-U", "-w"], `${secret}\n${secret}\n`);
      return true;
    }
    if (process.platform === "linux") {
      await execFileWithStdin("secret-tool", ["store", "--label", SERVICE_NAME, "service", SERVICE_NAME, "account", account], secret);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function readSecret(account: string): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await exec("security", ["find-generic-password", "-a", account, "-s", SERVICE_NAME, "-w"]);
      return stdout.replace(/\n$/, "");
    }
    if (process.platform === "linux") {
      const { stdout } = await exec("secret-tool", ["lookup", "service", SERVICE_NAME, "account", account]);
      return stdout.replace(/\n$/, "");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function deleteSecret(account: string): Promise<void> {
  try {
    if (process.platform === "darwin") await exec("security", ["delete-generic-password", "-a", account, "-s", SERVICE_NAME]);
    else if (process.platform === "linux") await exec("secret-tool", ["clear", "service", SERVICE_NAME, "account", account]);
  } catch { /* best-effort cleanup only */ }
}

function execFileWithStdin(command: string, args: string[], stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, (error) => (error ? reject(error) : resolve()));
    child.stdin?.end(stdin);
  });
}
