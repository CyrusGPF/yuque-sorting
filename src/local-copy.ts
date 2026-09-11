import type { VaultTransfer } from "./vault-transfer";
import { safeTransferPath } from "./vault-transfer";

// Node facilities are injected lazily by the desktop entry point; mobile/manual import never loads them.
export interface LocalRuntime { fs: any; path: any; }
export interface DiskEntry { path: string; kind: "file" | "folder"; stamp: string; size: number; mtimeMs: number; }
export type CopyChoice = { mode: "replace" | "rename" | "number"; name?: string };
export interface CopyRoot { source: string; target: string; replaces: boolean; }
const key = (name: string): string => name.normalize("NFC").toLowerCase();
export function portableCopyName(name: string): boolean {
  return safeTransferPath(name) && !name.includes("/") && !/[<>"|?*]/.test(name)
    && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
export function planCopyRoots(names: string[], existing: string[], choices: ReadonlyMap<string, CopyChoice>): CopyRoot[] {
  const occupied = new Map<string, string>();
  for (const name of existing) {
    if (occupied.has(key(name))) throw new Error(`目标存在大小写或 Unicode 等价重名：${name}`);
    occupied.set(key(name), name);
  }
  const sourceKeys = new Set<string>();
  for (const name of names) {
    if (!portableCopyName(name) || sourceKeys.has(key(name))) throw new Error(`来源名称不安全或大小写重名：${name}`);
    sourceKeys.add(key(name));
  }
  const reserved = new Set([...occupied.keys(), ...sourceKeys]);
  const assigned = new Set<string>();
  return names.map((source, index) => {
    const collision = occupied.get(key(source));
    const choice = choices.get(source);
    if (collision && !choice) throw new Error(`请选择同名项处理方式：${source}`);
    let target = source;
    let replaces = false;
    if (choice?.mode === "replace" && collision) { target = collision; replaces = true; }
    else if (choice?.mode === "rename") {
      target = (choice.name || "").trim();
      if (!portableCopyName(target) || (key(target) !== key(source) && reserved.has(key(target))) || occupied.has(key(target))) throw new Error(`新名称无效或已被占用：${target}`);
    } else if (choice?.mode === "number") {
      const stem = `${String(index + 1).padStart(3, "0")}-${source}`;
      target = stem;
      let retry = 2;
      while (reserved.has(key(target))) target = `${String(index + 1).padStart(3, "0")}-${retry++}-${source}`;
    } else if (collision && !replaces) throw new Error(`未解决同名项：${source}`);
    if (assigned.has(key(target))) throw new Error(`两个迁入项使用同一名称：${target}`);
    reserved.add(key(target)); assigned.add(key(target));
    return { source, target, replaces };
  });
}

export function copyPathMap(pack: VaultTransfer, roots: CopyRoot[]): Map<string, string> {
  const rootMap = new Map(roots.map(root => [root.source, root.target]));
  const pairs = new Map<string, string>();
  const byPath = new Map(pack.items.map(item => [item.path, item]));
  // When a top folder is renamed, rename its paired note too (never silently overwrite a sibling).
  for (const root of roots) {
    const folder = byPath.get(root.source);
    const extension = (name: string): string => name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
    if (folder?.kind === "file" && extension(root.source) !== extension(root.target)) throw new Error(`文件重命名需保留扩展名：${root.source}`);
    const notePath = `${root.source}/${root.source}.md`;
    const note = byPath.get(notePath);
    if (root.source !== root.target && folder?.kind === "folder" && /^d[:-]/.test(folder.guid)
      && note?.kind === "file" && /^f[:-]/.test(note.guid) && folder.guid.slice(2) === note.guid.slice(2)) {
      const desired = `${root.source}/${root.target}.md`;
      if (pack.orders[root.source].some(path => key(path) === key(desired) && path !== notePath)) throw new Error(`重命名会与配对笔记的兄弟文件冲突：${desired}`);
      pairs.set(notePath, `${root.target}/${root.target}.md`);
    }
  }
  return new Map(pack.items.map(item => {
    const slash = item.path.indexOf("/");
    const first = slash < 0 ? item.path : item.path.slice(0, slash);
    const renamed = rootMap.get(first);
    if (!renamed) throw new Error(`缺少复制计划：${item.path}`);
    return [item.path, pairs.get(item.path) || renamed + (slash < 0 ? "" : item.path.slice(slash))];
  }));
}

function stamp(stat: any): string { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.isDirectory()].join(":"); }
export async function exists(io: LocalRuntime, path: string): Promise<boolean> {
  try { await io.fs.promises.lstat(path); return true; } catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}
export function contained(io: LocalRuntime, root: string, target: string): boolean {
  const rel = io.path.relative(root, target);
  return rel === "" || (!io.path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${io.path.sep}`));
}
export async function checkedDirectory(io: LocalRuntime, value: string): Promise<string> {
  if (!io.path.isAbsolute(value)) throw new Error("来源必须是本机绝对路径");
  const full = io.path.resolve(value);
  // Reject junctions/symlinks along the entire path, not just at the leaf.
  let cursor = full;
  while (true) {
    const stat = await io.fs.promises.lstat(cursor);
    if (stat.isSymbolicLink()) throw new Error(`不支持符号链接或目录联接：${cursor}`);
    const parent = io.path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  if (!(await io.fs.promises.stat(full)).isDirectory()) throw new Error(`不是目录：${full}`);
  return io.fs.promises.realpath(full);
}

export async function resolveCopyDestination(io: LocalRuntime, vaultRoot: string, input: string): Promise<{ absolute: string; relative: string; missing: string[] }> {
  const absolute = input ? io.path.resolve(vaultRoot, input) : vaultRoot;
  if (!contained(io, vaultRoot, absolute)) throw new Error("目标必须是当前 Vault 或其内部目录，不能选择库外目录");
  const relative = io.path.relative(vaultRoot, absolute).split(io.path.sep).join("/");
  if (!safeTransferPath(relative, true) || relative.split("/").some(part => part && !portableCopyName(part))) throw new Error("目标目录名称无效，不支持隐藏目录、上级路径或特殊名称");
  const missing: string[] = [];
  let cursor = vaultRoot, rel = "", parentExists = true;
  for (const name of relative ? relative.split("/") : []) {
    if (parentExists) {
      const siblings: string[] = await io.fs.promises.readdir(cursor);
      const equivalent = siblings.find(other => key(other) === key(name));
      if (equivalent && equivalent !== name) throw new Error(`目标目录名称大小写或 Unicode 不一致，请通过选择目录填入实际路径：${name}`);
    }
    cursor = io.path.join(cursor, name); rel = rel ? `${rel}/${name}` : name;
    if (parentExists && await exists(io, cursor)) await checkedDirectory(io, cursor);
    else { parentExists = false; missing.push(rel); }
  }
  return { absolute, relative, missing };
}

/** Metadata only; no file bodies are retained. hidden=true is used for replacement backup preflight. */
export async function scanDisk(io: LocalRuntime, root: string, hidden = false): Promise<DiskEntry[]> {
  const result: DiskEntry[] = [];
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop()!;
    const absolute = io.path.join(root, relative);
    const stat = await io.fs.promises.lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`不支持链接或特殊文件：${absolute}`);
    result.push({ path: relative, kind: stat.isDirectory() ? "folder" : "file", stamp: stamp(stat), size: stat.size, mtimeMs: stat.mtimeMs });
    if (stat.isDirectory()) {
      const names: string[] = await io.fs.promises.readdir(absolute);
      const keys = new Set<string>();
      for (const name of names) {
        if (!hidden && name.startsWith(".")) continue;
        if (!hidden && !portableCopyName(name)) throw new Error(`来源名称不支持安全复制：${name}`);
        if (keys.has(key(name))) throw new Error(`目录存在大小写或 Unicode 等价重名：${absolute}/${name}`);
        keys.add(key(name)); pending.push(relative ? `${relative}/${name}` : name);
      }
    }
    if (result.length % 250 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return result;
}
export async function verifyDisk(io: LocalRuntime, root: string, expected: DiskEntry[], hidden = false): Promise<void> {
  const current = await scanDisk(io, root, hidden);
  const before = new Map(expected.map(entry => [entry.path, entry.stamp]));
  if (current.length !== expected.length || current.some(entry => before.get(entry.path) !== entry.stamp)) throw new Error(`预检后内容发生变化，请重新预检：${root}`);
}

export async function verifyInstalledCopies(io: LocalRuntime, target: string, roots: CopyRoot[], staged: DiskEntry[]): Promise<void> {
  const expected = new Map(staged.filter(entry => entry.path).map(entry => [entry.path, entry]));
  let count = 0;
  for (const root of roots) {
    for (const entry of await scanDisk(io, io.path.join(target, root.target), true)) {
      const relative = entry.path ? `${root.target}/${entry.path}` : root.target;
      const previous = expected.get(relative); count++;
      if (!previous || previous.kind !== entry.kind || (entry.kind === "file" && (previous.size !== entry.size || Math.abs(previous.mtimeMs - entry.mtimeMs) >= 2))) throw new Error(`安装后的副本发生变化：${relative}`);
    }
  }
  if (count !== expected.size) throw new Error("安装后的副本项目集合发生变化");
}

export interface MarkdownHeader { yaml: string | null; offset: number; bom: boolean; eol: string; }
/** At most 256 KiB is read for YAML; large bodies are copied with a fixed 64 KiB buffer. */
export async function markdownHeader(io: LocalRuntime, path: string): Promise<MarkdownHeader> {
  const handle = await io.fs.promises.open(path, "r");
  try {
    const size = (await handle.stat()).size;
    for (const limit of [4096, 256 * 1024]) {
      const buffer = new Uint8Array(Math.min(size, limit));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break; bytesRead += chunk.bytesRead;
      }
      const bom = buffer[0] === 239 && buffer[1] === 187 && buffer[2] === 191;
      const text = new TextDecoder().decode(buffer.subarray(bom ? 3 : 0, bytesRead));
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      if (!/^---[ \t]*\r?\n/.test(text)) return { yaml: null, offset: bom ? 3 : 0, bom, eol };
      const match = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
      if (match && (match[0].endsWith("\n") || bytesRead === size)) return { yaml: match[1], offset: new TextEncoder().encode(match[0]).length + (bom ? 3 : 0), bom, eol };
      if (bytesRead === size) break;
    }
    throw new Error(`frontmatter 未闭合或超过 256 KiB：${path}`);
  } finally { await handle.close(); }
}
export async function copyMarkdown(io: LocalRuntime, source: string, destination: string, yaml: string, header: MarkdownHeader): Promise<void> {
  const input = await io.fs.promises.open(source, "r");
  let output: any;
  try {
    output = await io.fs.promises.open(destination, "wx");
    await output.writeFile(`${header.bom ? "\uFEFF" : ""}---${header.eol}${yaml.replace(/\s+$/, "").replace(/\r?\n/g, header.eol)}${header.eol}---${header.eol}`);
    const buffer = new Uint8Array(64 * 1024);
    let position = header.offset;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written, null)).bytesWritten;
      position += bytesRead;
    }
  } finally { await input.close(); if (output) await output.close(); }
}

export interface CopyTransaction {
  roots: CopyRoot[]; target: string; workspace: string;
  verify: () => Promise<void>; commitData: () => Promise<void>; rollbackData: () => Promise<void>;
  checkCancelled?: () => void;
}
/** All staging is complete before this function. Never deletes: rollback retains incoming copies. */
export async function installCopies(io: LocalRuntime, options: CopyTransaction): Promise<void> {
  const { roots, target, workspace } = options;
  await checkedDirectory(io, target);
  if (!contained(io, io.path.dirname(workspace), workspace) || contained(io, workspace, target)) throw new Error("备份路径与目标冲突");
  await options.verify();
  const installed: CopyRoot[] = [], backedUp: CopyRoot[] = [];
  const journalPath = io.path.join(workspace, "transaction.json");
  const journal = async (phase: string, root?: CopyRoot): Promise<void> => {
    await io.fs.promises.appendFile(io.path.join(workspace, "progress.jsonl"), JSON.stringify({ phase, root }) + "\n");
  };
  await io.fs.promises.mkdir(io.path.join(workspace, "originals"));
  await io.fs.promises.writeFile(journalPath, JSON.stringify({ version: 1, target, roots }), { flag: "wx" });
  await journal("prepared");
  try {
    for (const root of roots) {
      options.checkCancelled?.();
      if (!portableCopyName(root.target) || !portableCopyName(root.source)) throw new Error("复制名称无效");
      const destination = io.path.join(target, root.target);
      if (root.replaces) {
        if (!await exists(io, destination)) throw new Error(`替换目标已消失：${root.target}`);
        await io.fs.promises.rename(destination, io.path.join(workspace, "originals", root.target));
        backedUp.push(root); await journal("backed-up", root);
      } else if (await exists(io, destination)) throw new Error(`目标已被其他操作创建：${root.target}`);
      await io.fs.promises.rename(io.path.join(workspace, "staged", root.target), destination);
      installed.push(root); await journal("installed", root);
    }
    options.checkCancelled?.(); await options.commitData();
    await journal("complete");
  } catch (error) {
    const failures: string[] = [];
    for (const root of installed.slice().reverse()) {
      try {
        await io.fs.promises.rename(io.path.join(target, root.target), io.path.join(workspace, "staged", root.target));
      } catch { failures.push(root.target); }
    }
    for (const root of backedUp.slice().reverse()) {
      try {
        const destination = io.path.join(target, root.target);
        if (await exists(io, destination)) throw new Error("目标被占用");
        await io.fs.promises.rename(io.path.join(workspace, "originals", root.target), destination);
      } catch { failures.push(root.target); }
    }
    try { await options.rollbackData(); } catch { failures.push("data.json"); }
    await journal(failures.length ? "recovery-required" : "rolled-back").catch(() => undefined);
    throw new Error(`${String(error)}；${failures.length ? `回滚不完整：${failures.join("；")}` : "已回滚"}。保留恢复目录：${workspace}`);
  }
}
