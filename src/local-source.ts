import type { LocalRuntime, DiskEntry } from "./local-copy";
import { checkedDirectory, exists, markdownHeader } from "./local-copy";
import type { VaultTransfer, TransferItem } from "./vault-transfer";
import { parseVaultTransfer } from "./vault-transfer";

export function yamlObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Markdown frontmatter 必须是 YAML 对象");
  return value as Record<string, unknown>;
}
export async function sourceTransfer(io: LocalRuntime, root: string, entries: DiskEntry[], pluginId: string,
  generate: (kind: "f" | "d", used: Set<string>) => string, parseYaml: (text: string) => unknown,
): Promise<{ pack: VaultTransfer; fallback: number; generated: number; metadataPath: string; metadataText: string }> {
  let cursor = root, vaultRoot = root, data: any = {}, metadataPath = "", metadataText = "";
  while (true) {
    let candidate = io.path.join(cursor, ".obsidian", "plugins", pluginId, "data.json");
    // Source vaults using the previous plugin ID remain readable after the rename.
    if (pluginId === "yuque-sorting" && !await exists(io, candidate)) candidate = io.path.join(cursor, ".obsidian", "plugins", "yuque-order-drag", "data.json");
    if (await exists(io, candidate)) {
      await checkedDirectory(io, io.path.dirname(candidate));
      if ((await io.fs.promises.lstat(candidate)).isSymbolicLink()) throw new Error("来源插件数据不能是符号链接");
      if ((await io.fs.promises.stat(candidate)).size > 64 * 1024 * 1024) throw new Error("来源插件数据超过 64 MiB，请使用手动顺序包");
      metadataPath = candidate; metadataText = await io.fs.promises.readFile(candidate, "utf8");
      data = JSON.parse(metadataText); vaultRoot = cursor; break;
    }
    // Do not borrow order data from a parent of an independent Vault.
    if (await exists(io, io.path.join(cursor, ".obsidian"))) break;
    const parent = io.path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  if (!data || typeof data !== "object") throw new Error("来源 data.json 无效");
  const pack: VaultTransfer = { format: "yuque-vault-transfer", version: 1, items: [], orders: Object.create(null), mergeChoices: Object.create(null) };
  const used = new Set<string>();
  const grouped = new Map<string, TransferItem[]>(); grouped.set("", []);
  const base = io.path.relative(vaultRoot, root).split(io.path.sep).join("/");
  const fullPath = (relative: string): string => base ? (relative ? `${base}/${relative}` : base) : relative;
  let generated = 0, fallback = 0;
  for (const entry of entries) {
    if (!entry.path) continue;
    let raw: unknown;
    if (entry.kind === "file" && /\.md$/i.test(entry.path)) {
      const header = await markdownHeader(io, io.path.join(root, entry.path));
      raw = header.yaml === null ? null : yamlObject(parseYaml(header.yaml)).guid;
    } else raw = (entry.kind === "folder" ? data.folderGuids : data.fileGuids)?.[fullPath(entry.path)];
    const guid = typeof raw === "string" && /^[A-Za-z0-9:_-]{1,256}$/.test(raw)
      && !["__proto__", "constructor", "prototype"].includes(raw) ? raw : generate(entry.kind === "folder" ? "d" : "f", used);
    if (raw !== guid) generated++;
    used.add(guid);
    const item: TransferItem = { path: entry.path, kind: entry.kind, guid };
    pack.items.push(item);
    if (pack.items.length % 250 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const parent = entry.path.split("/").slice(0, -1).join("/");
    if (!grouped.has(parent)) grouped.set(parent, []);
    grouped.get(parent)!.push(item);
    if (entry.kind === "folder" && !grouped.has(entry.path)) grouped.set(entry.path, []);
  }
  const byPath = new Map(pack.items.map(item => [item.path, item]));
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  for (const [parent, children] of grouped) {
    const sourcePath = fullPath(parent);
    const folderGuid = data.folderGuids?.[sourcePath || "/"];
    const saved = data.orderByFolder?.[folderGuid || (sourcePath ? "" : "__root__")];
    const rank = new Map<string, number>();
    if (Array.isArray(saved)) saved.forEach((guid: string, index: number) => { if (!rank.has(guid)) rank.set(guid, index); });
    fallback += children.filter(item => !rank.has(item.guid)).length;
    children.sort((a, b) => (rank.get(a.guid) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.guid) ?? Number.MAX_SAFE_INTEGER)
      || collator.compare(a.path, b.path) || a.path.localeCompare(b.path));
    pack.orders[parent] = children.map(item => item.path);
    if (parent) {
      const guid = byPath.get(parent)!.guid;
      const choice = data.folderNoteMergeOverrides?.[guid.slice(2)];
      pack.mergeChoices[guid.slice(2)] = typeof choice === "boolean" ? choice : Boolean(data.settings?.mergePairedFolderNotes);
    }
  }
  return { pack: parseVaultTransfer(pack), fallback, generated, metadataPath, metadataText };
}
