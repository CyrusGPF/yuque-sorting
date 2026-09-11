export interface TransferItem { path: string; kind: "file" | "folder"; guid: string; }
export interface VaultTransfer {
  format: "yuque-vault-transfer";
  version: 1;
  items: TransferItem[];
  orders: Record<string, string[]>;
  mergeChoices: Record<string, boolean>;
}

export function safeTransferPath(value: unknown, root = false): value is string {
  return typeof value === "string" && (value === "" ? root :
    !/[\\:\x00-\x1f]/.test(value) && value.split("/").every(part =>
      Boolean(part) && part !== "." && part !== ".." && !part.startsWith(".") && part !== "__proto__"));
}

/** Validate before any mutation; each path occurs exactly once in its parent order. */
export function parseVaultTransfer(value: unknown): VaultTransfer {
  const v = value as VaultTransfer;
  if (!v || v.format !== "yuque-vault-transfer" || v.version !== 1 || !Array.isArray(v.items)
    || !v.orders || typeof v.orders !== "object" || Array.isArray(v.orders)) throw new Error("不是有效的跨 Vault 顺序包 v1");
  const paths = new Map<string, TransferItem>();
  for (const item of v.items) {
    if (!item || !safeTransferPath(item.path) || !["file", "folder"].includes(item.kind)
      || typeof item.guid !== "string" || !/^[A-Za-z0-9:_-]+$/.test(item.guid) || item.guid.length > 256
      || ["__proto__", "constructor", "prototype"].includes(item.guid)) throw new Error("顺序包包含无效路径或身份");
    if (paths.has(item.path)) throw new Error(`来源存在重复路径：${item.path}`);
    paths.set(item.path, item);
  }
  const ordered = new Set<string>();
  for (const [parent, children] of Object.entries(v.orders)) {
    if (!safeTransferPath(parent, true) || (parent && paths.get(parent)?.kind !== "folder") || !Array.isArray(children)) throw new Error(`目录索引无效：${parent}`);
    for (const child of children) {
      if (typeof child !== "string" || !paths.has(child) || child.split("/").slice(0, -1).join("/") !== parent || ordered.has(child)) throw new Error(`子项索引无效：${child}`);
      ordered.add(child);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(v.orders, "") || ordered.size !== paths.size
    || v.items.some(item => item.kind === "folder" && !Object.prototype.hasOwnProperty.call(v.orders, item.path))) throw new Error("来源目录索引不完整");
  const mergeChoices: Record<string, boolean> = Object.create(null);
  if (v.mergeChoices && typeof v.mergeChoices === "object") {
    for (const [token, choice] of Object.entries(v.mergeChoices)) if (/^[A-Za-z0-9_-]+$/.test(token) && typeof choice === "boolean") mergeChoices[token] = choice;
  }
  return { format: v.format, version: 1, items: v.items, orders: v.orders, mergeChoices };
}

/** Reserve source identities first; collisions never steal another incoming identity. */
export function planTransferGuids(items: TransferItem[], occupied: Set<string>, generate: (kind: "f" | "d", used: Set<string>) => string): Map<string, string> {
  const used = new Set(occupied);
  const byPath = new Map(items.map(item => [item.path, item]));
  const result = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.guid, (counts.get(item.guid) || 0) + 1);
  const conflict = (guid: string): boolean => occupied.has(guid) || counts.get(guid)! > 1;
  for (const item of items) used.add(item.guid);
  for (const item of items.filter(item => item.kind === "folder").concat(items.filter(item => item.kind === "file"))) {
    if (result.has(item.path)) continue;
    const name = item.path.split("/").pop()!;
    const note = item.kind === "folder" ? byPath.get(`${item.path}/${name}.md`) : undefined;
    const token = /^d[:-]([A-Za-z0-9_-]+)$/.exec(item.guid)?.[1];
    if (note?.kind === "file" && token && note.guid.slice(2) === token && /^f[:-]/.test(note.guid)) {
      let folderGuid = item.guid;
      let noteGuid = note.guid;
      if (conflict(folderGuid) || conflict(noteGuid)) {
        let found = false;
        for (let attempt = 0; attempt < 32; attempt++) {
          folderGuid = generate("d", used); noteGuid = `f-${folderGuid.slice(2)}`;
          if (!used.has(noteGuid)) { used.add(noteGuid); found = true; break; }
        }
        if (!found) throw new Error("无法生成唯一配对 GUID");
      }
      result.set(item.path, folderGuid); result.set(note.path, noteGuid);
    } else result.set(item.path, conflict(item.guid) ? generate(item.kind === "folder" ? "d" : "f", used) : item.guid);
  }
  return result;
}
