/** Merge independent edits to the plugin's single synced JSON file. */
const MAP_FIELDS = [
  "settings", "orderByFolder", "folderGuids", "fileGuids",
  "detachedFolderNotes", "folderNoteMergeOverrides", "transferReceipts",
] as const;

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

export interface MergeResult<T> { data: T | null; conflicts: string[]; }

export function mergeOrderData<T extends object>(base: T, local: T, disk: T): MergeResult<T> {
  const baseline = base as Record<string, any>;
  const ours = local as Record<string, any>;
  const theirs = disk as Record<string, any>;
  const result: Record<string, any> = {};
  const conflicts: string[] = [];
  const fields = new Set([...Object.keys(baseline), ...Object.keys(ours), ...Object.keys(theirs)]);

  for (const field of fields) {
    if (MAP_FIELDS.includes(field as typeof MAP_FIELDS[number])) {
      const previous = baseline[field] || {};
      const current = ours[field] || {};
      const incoming = theirs[field] || {};
      const merged: Record<string, unknown> = {};
      const keys = new Set([...Object.keys(previous), ...Object.keys(current), ...Object.keys(incoming)]);
      for (const key of keys) {
        const a = previous[key], b = current[key], c = incoming[key];
        if (same(b, c)) { if (b !== undefined) merged[key] = b; }
        else if (same(a, b)) { if (c !== undefined) merged[key] = c; }
        else if (same(a, c)) { if (b !== undefined) merged[key] = b; }
        else conflicts.push(`${field}.${key}`);
      }
      result[field] = merged;
    } else {
      const a = baseline[field], b = ours[field], c = theirs[field];
      if (same(b, c)) result[field] = b;
      else if (same(a, b)) result[field] = c;
      else if (same(a, c)) result[field] = b;
      else conflicts.push(field);
    }
  }
  if (!conflicts.length) {
    const pathsByGuid = new Map<string, string>();
    for (const field of ["folderGuids", "fileGuids"] as const) {
      for (const [path, guid] of Object.entries(result[field] || {})) {
        if (typeof guid !== "string") continue;
        const previousPath = pathsByGuid.get(guid);
        if (previousPath && previousPath !== `${field}.${path}`) conflicts.push(`duplicateGuid.${guid}`);
        else pathsByGuid.set(guid, `${field}.${path}`);
      }
    }
  }
  return { data: conflicts.length ? null : result as T, conflicts };
}

export function validateStoredOrderData(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("data.json 顶层必须是对象");
  const saved = value as Record<string, unknown>;
  if (saved.version !== undefined && saved.version !== 1 && saved.version !== 2) {
    throw new Error("data.json 版本不受支持");
  }
  // A complete plugin data file always contains its order index. A transient
  // sync write can be valid JSON (for example `{}`) and must not erase it.
  if (saved.orderByFolder === undefined) throw new Error("data.json 缺少目录顺序");
  for (const field of ["settings", ...MAP_FIELDS.filter(name => name !== "settings")]) {
    const mapping = saved[field];
    if (mapping === undefined) continue;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      throw new Error(`data.json 的 ${field} 无效`);
    }
  }
  for (const [key, order] of Object.entries((saved.orderByFolder || {}) as Record<string, unknown>)) {
    if (!Array.isArray(order) || order.some(guid => typeof guid !== "string")) {
      throw new Error(`data.json 的目录顺序 ${key} 无效`);
    }
  }
  for (const field of ["folderGuids", "fileGuids", "detachedFolderNotes"]) {
    for (const [path, guid] of Object.entries((saved[field] || {}) as Record<string, unknown>)) {
      if (typeof guid !== "string") throw new Error(`data.json 的 ${field}.${path} 无效`);
    }
  }
  return saved;
}
