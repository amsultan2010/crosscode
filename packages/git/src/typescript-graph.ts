import { readFile, readdir } from "node:fs/promises";
import { posix } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";

const exec = promisify(execFile);

/**
 * Resolution scope: relative specifiers and workspace package names (via each
 * package.json's "exports" string) among this monorepo's own tracked .ts/.tsx
 * files. Bare npm packages, Node builtins, and tsconfig "paths" aliases are
 * treated as external and stop the walk -- there is no bundler-equivalent
 * resolution algorithm here, and no type checker: only the syntactic import
 * graph is inspected, so re-exports through indirection the parser can't see
 * (e.g. computed module specifiers) are invisible to it.
 */
async function listTrackedTsFiles(root: string): Promise<string[]> {
  const { stdout } = await exec("git", ["-C", root, "ls-files", "-z", "--", "*.ts", "*.tsx"]);
  return stdout.split("\0").filter(Boolean);
}

async function workspacePackageEntries(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const group of ["apps", "packages"]) {
    let entries: string[];
    try { entries = await readdir(posix.join(root, group)); } catch { continue; }
    for (const name of entries) {
      try {
        const pkg = JSON.parse(await readFile(posix.join(root, group, name, "package.json"), "utf8")) as { name?: string; exports?: unknown };
        if (pkg.name && typeof pkg.exports === "string") map.set(pkg.name, posix.normalize(posix.join(group, name, pkg.exports.replace(/^\.\//, ""))));
      } catch { continue; }
    }
  }
  return map;
}

function stripKnownExtension(specifier: string): string {
  if (specifier.endsWith(".js")) return specifier.slice(0, -3);
  if (specifier.endsWith(".jsx")) return specifier.slice(0, -4);
  return specifier;
}

function resolveRelativeSpecifier(importerPath: string, specifier: string, trackedFiles: Set<string>): string | undefined {
  const stripped = stripKnownExtension(specifier);
  const joined = posix.normalize(posix.join(posix.dirname(importerPath), stripped));
  for (const candidate of [`${joined}.ts`, `${joined}.tsx`, `${joined}/index.ts`, `${joined}/index.tsx`, /\.tsx?$/.test(stripped) ? joined : undefined]) {
    if (candidate && trackedFiles.has(candidate)) return candidate;
  }
  return undefined;
}

type ImportEdge = { targetFile: string; names: string[]; isNamespace: boolean };

function parseImportEdges(sourceFile: ts.SourceFile, importerPath: string, trackedFiles: Set<string>, packages: Map<string, string>): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const resolveSpecifier = (specifier: string): string | undefined =>
    specifier.startsWith(".") ? resolveRelativeSpecifier(importerPath, specifier, trackedFiles) : packages.get(specifier);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const targetFile = resolveSpecifier(node.moduleSpecifier.text);
      if (targetFile) {
        const names: string[] = [];
        let isNamespace = false;
        const clause = node.importClause;
        if (clause) {
          if (clause.name) names.push("default");
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) isNamespace = true;
            else for (const element of clause.namedBindings.elements) names.push((element.propertyName ?? element.name).text);
          }
        }
        edges.push({ targetFile, names, isNamespace });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const targetFile = resolveSpecifier(node.moduleSpecifier.text);
      if (targetFile) {
        const names: string[] = [];
        let isNamespace = false;
        if (node.exportClause) {
          if (ts.isNamespaceExport(node.exportClause)) isNamespace = true;
          else for (const element of node.exportClause.elements) names.push((element.propertyName ?? element.name).text);
        } else {
          isNamespace = true;
        }
        edges.push({ targetFile, names, isNamespace });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edges;
}

function scriptKindFor(path: string): ts.ScriptKind {
  return path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Real import-graph dependents of `changedPath`'s `symbols`, including
 * transitive importers, computed from the AST of this monorepo's own tracked
 * .ts/.tsx files. Returns `undefined` -- meaning "not applicable, fall back
 * to the textual search" -- when `changedPath` is not TypeScript, or when
 * parsing the graph fails for any reason.
 */
export async function findAstDependentFiles(root: string, symbols: string[], changedPath: string): Promise<string[] | undefined> {
  if (!/\.tsx?$/.test(changedPath)) return undefined;
  try {
    const files = await listTrackedTsFiles(root);
    const trackedFiles = new Set(files);
    if (!trackedFiles.has(changedPath)) return undefined;
    const packages = await workspacePackageEntries(root);
    const importEdges = new Map<string, ImportEdge[]>();
    for (const file of files) {
      if (file === changedPath) continue;
      const content = await readFile(posix.join(root, file), "utf8").catch(() => undefined);
      if (content === undefined) continue;
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKindFor(file));
      importEdges.set(file, parseImportEdges(sourceFile, file, trackedFiles, packages));
    }
    const symbolSet = new Set(symbols);
    const visited = new Set<string>([changedPath]);
    const dependents = new Set<string>();
    const queue: string[] = [];
    for (const [file, edges] of importEdges) {
      const matches = edges.some((edge) => edge.targetFile === changedPath && (edge.isNamespace || edge.names.some((name) => symbolSet.has(name))));
      if (matches) { dependents.add(file); visited.add(file); queue.push(file); }
    }
    while (queue.length) {
      const current = queue.shift()!;
      for (const [file, edges] of importEdges) {
        if (visited.has(file)) continue;
        if (edges.some((edge) => edge.targetFile === current)) { dependents.add(file); visited.add(file); queue.push(file); }
      }
    }
    return [...dependents].sort();
  } catch {
    return undefined;
  }
}
