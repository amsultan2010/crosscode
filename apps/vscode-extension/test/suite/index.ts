import { run as runViewsSuite } from "./views.suite.js";

/** Entry point @vscode/test-electron loads inside the real extension host (extensionTestsPath). */
export async function run(): Promise<void> {
  await runViewsSuite();
}
