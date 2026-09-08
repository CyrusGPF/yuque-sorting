export const ROOT_FOLDER_KEY = "__root__";

export type SortableEntry = {
  path: string;
  name: string;
};

const entryNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

// Order arrays are replaced, rather than mutated, whenever plugin state
// changes. A WeakMap therefore avoids rebuilding the same rank table during
// repeated explorer renders without retaining obsolete orders.
const rankByOrder = new WeakMap<string[], Map<string, number>>();

/**
 * 与导出端 utils.sanitizePathComponent 等价的清洗实现（用于按目录名兜底匹配，
 * 保持对语雀标题清洗后目录名的一致理解：NFKC、非法字符→下划线、空白折叠等）。
 */
export function sanitizePortableName(name: string): string {
  if (!name) return "";
  let result = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\\/<>:"|?*]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  if (!result) return "";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(result)) {
    result = `_${result}`;
  }
  if (result.length > 120) {
    result = result.slice(0, 120).replace(/[. ]+$/g, "");
  }
  return result;
}

export function normalizeGuid(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const guid = String(value).trim();
  return guid ? guid : null;
}

export function compareEntryNames(a: SortableEntry, b: SortableEntry): number {
  return entryNameCollator.compare(a.name, b.name);
}

export function sortEntries<T extends SortableEntry>(
  entries: T[],
  savedOrder: string[],
  guidOf: (entry: T) => string | null,
  fallback: "name" | "name-last" = "name-last",
): T[] {
  let rank = rankByOrder.get(savedOrder);
  if (!rank) {
    rank = new Map<string, number>();
    savedOrder.forEach((guid, index) => {
      if (!rank!.has(guid)) rank!.set(guid, index);
    });
    rankByOrder.set(savedOrder, rank);
  }

  return entries
    .map((entry, originalIndex) => ({ entry, originalIndex, guid: guidOf(entry) }))
    .sort((a, b) => {
      const ar = a.guid ? rank.get(a.guid) : undefined;
      const br = b.guid ? rank.get(b.guid) : undefined;
      if (ar !== undefined && br !== undefined) return ar - br;
      if (ar !== undefined) return -1;
      if (br !== undefined) return 1;
      if (fallback === "name" || fallback === "name-last") {
        const byName = compareEntryNames(a.entry, b.entry);
        if (byName !== 0) return byName;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map(({ entry }) => entry);
}

export function uniqueKnownOrder(order: string[], knownGuids: Set<string>): string[] {
  const seen = new Set<string>();
  return order.filter((guid) => {
    if (!knownGuids.has(guid) || seen.has(guid)) return false;
    seen.add(guid);
    return true;
  });
}

/**
 * Reconcile a folder from a potentially partial vault snapshot. Existing
 * identities are retained as tombstones so a late-loaded or restored item
 * returns to its former position; only confirmed create/delete events mutate
 * them destructively.
 */
export function reconcileOrderNonDestructive(
  previousOrder: string[],
  currentChildGuids: string[],
  initialSortedGuids: string[],
  placement: "top" | "bottom",
): string[] {
  const previous = [...new Set(previousOrder)];
  const current = [...new Set(currentChildGuids)];
  if (!previous.length) return [...new Set(initialSortedGuids)];
  const known = new Set(previous);
  const missing = current.filter((guid) => !known.has(guid));
  if (!missing.length) return previous;
  return placement === "top" ? [...missing, ...previous] : [...previous, ...missing];
}

export function moveGuid(
  order: string[],
  sourceGuid: string,
  targetGuid: string,
  insertBefore: boolean,
): string[] {
  const next = order.filter((guid) => guid !== sourceGuid);
  const targetIndex = next.indexOf(targetGuid);
  if (targetIndex < 0) {
    next.push(sourceGuid);
    return next;
  }
  next.splice(insertBefore ? targetIndex : targetIndex + 1, 0, sourceGuid);
  return next;
}

export function removeGuidFromOrders(
  orderByFolder: Record<string, string[]>,
  guid: string,
): boolean {
  let changed = false;
  Object.keys(orderByFolder).forEach((folderKey) => {
    const oldOrder = orderByFolder[folderKey] || [];
    const nextOrder = oldOrder.filter((itemGuid) => itemGuid !== guid);
    if (nextOrder.length !== oldOrder.length) {
      orderByFolder[folderKey] = nextOrder;
      changed = true;
    }
  });
  return changed;
}

export function insertGuid(
  order: string[],
  guid: string,
  placement: "top" | "bottom",
): string[] {
  if (order.includes(guid)) return order;
  return placement === "top" ? [guid, ...order] : [...order, guid];
}

/** Move an identity between folders without disturbing either sibling list. */
export function relocateGuid(
  orderByFolder: Record<string, string[]>,
  targetFolderKey: string,
  guid: string,
  placement: "top" | "bottom",
): void {
  removeGuidFromOrders(orderByFolder, guid);
  orderByFolder[targetFolderKey] = insertGuid(
    orderByFolder[targetFolderKey] || [], guid, placement,
  );
}

/** Replace an identity in place, including an order list owned by that identity. */
export function replaceGuidInOrders(
  orderByFolder: Record<string, string[]>,
  oldGuid: string,
  newGuid: string,
): boolean {
  if (!oldGuid || !newGuid || oldGuid === newGuid) return false;
  let changed = false;
  Object.keys(orderByFolder).forEach((folderKey) => {
    const oldOrder = orderByFolder[folderKey] || [];
    const seen = new Set<string>();
    const nextOrder = oldOrder
      .map((guid) => guid === oldGuid ? newGuid : guid)
      .filter((guid) => {
        if (seen.has(guid)) return false;
        seen.add(guid);
        return true;
      });
    if (nextOrder.length !== oldOrder.length
      || nextOrder.some((guid, index) => guid !== oldOrder[index])) {
      orderByFolder[folderKey] = nextOrder;
      changed = true;
    }
  });
  if (Object.prototype.hasOwnProperty.call(orderByFolder, oldGuid)) {
    const oldChildren = orderByFolder[oldGuid] || [];
    const newChildren = orderByFolder[newGuid] || [];
    orderByFolder[newGuid] = [...new Set([...oldChildren, ...newChildren])];
    delete orderByFolder[oldGuid];
    changed = true;
  }
  return changed;
}

/** Resolve a folder-note relationship from the deleted file's preserved path. */
export function folderIdentityPathForNote(
  notePath: string,
  folderGuids: Record<string, string>,
  guid: string,
): string | null {
  const withoutExtension = notePath.replace(/\.md$/i, "");
  const slash = notePath.lastIndexOf("/");
  const parent = slash < 0 ? "" : notePath.slice(0, slash);
  const noteName = withoutExtension.slice(withoutExtension.lastIndexOf("/") + 1);
  const parentName = parent.slice(parent.lastIndexOf("/") + 1);
  const candidates = noteName === parentName ? [parent, withoutExtension] : [withoutExtension];
  return candidates.find((path) => path && folderGuids[path] === guid) || null;
}

/**
 * A deleted folder note relinquishes only its hidden self-entry. The same GUID
 * remains the stable identity of the folder and keeps its parent-list position.
 */
export function detachFolderNoteFromOrder(
  orderByFolder: Record<string, string[]>,
  folderGuid: string,
): boolean {
  const ownedOrder = orderByFolder[folderGuid];
  if (!ownedOrder) return false;
  const next = ownedOrder.filter((guid) => guid !== folderGuid);
  if (next.length === ownedOrder.length) return false;
  orderByFolder[folderGuid] = next;
  return true;
}

/** Migrate path-keyed identities when a file or an ancestor folder moves. */
export function migratePathMappings(
  mappings: Record<string, string>,
  oldPath: string,
  newPath: string,
): Array<[string, string, string]> {
  const prefix = `${oldPath}/`;
  const updates: Array<[string, string, string]> = [];
  Object.entries(mappings).forEach(([path, guid]) => {
    if (path === oldPath || path.startsWith(prefix)) {
      const nextPath = path === oldPath ? newPath : `${newPath}${path.slice(oldPath.length)}`;
      updates.push([path, nextPath, guid]);
    }
  });
  updates.forEach(([from, to, guid]) => {
    delete mappings[from];
    mappings[to] = guid;
  });
  return updates;
}

/**
 * Remove a deleted folder subtree both as ordered children and as owners of
 * their own order lists. This is intentionally idempotent because Obsidian may
 * emit a parent-folder delete before or after the deletes for its descendants.
 */
export function purgeFolderGuidsFromOrders(
  orderByFolder: Record<string, string[]>,
  guids: Iterable<string>,
): boolean {
  const deleted = new Set(guids);
  if (!deleted.size) return false;

  let changed = false;
  Object.keys(orderByFolder).forEach((folderKey) => {
    if (deleted.has(folderKey)) {
      delete orderByFolder[folderKey];
      changed = true;
      return;
    }
    const oldOrder = orderByFolder[folderKey] || [];
    const nextOrder = oldOrder.filter((guid) => !deleted.has(guid));
    if (nextOrder.length !== oldOrder.length) {
      orderByFolder[folderKey] = nextOrder;
      changed = true;
    }
  });
  return changed;
}

export type InventoryEntry = {
  guid: string;
  parentGuid: string;
  label: string;
};

export type InventoryComparison = {
  missing: InventoryEntry[];
  extra: InventoryEntry[];
  moved: Array<{ expected: InventoryEntry; actual: InventoryEntry }>;
  duplicateManifestGuids: string[];
  duplicateActualGuids: string[];
};

/** Compare identity and hierarchy, deliberately ignoring sibling order. */
export function compareInventories(
  manifestEntries: InventoryEntry[],
  actualEntries: InventoryEntry[],
): InventoryComparison {
  const groupByGuid = (entries: InventoryEntry[]) => {
    const grouped = new Map<string, InventoryEntry[]>();
    entries.forEach((entry) => grouped.set(entry.guid, [...(grouped.get(entry.guid) || []), entry]));
    return grouped;
  };
  const manifestByGuid = groupByGuid(manifestEntries);
  const actualByGuid = groupByGuid(actualEntries);
  const duplicateManifestGuids = [...manifestByGuid]
    .filter(([, entries]) => entries.length > 1).map(([guid]) => guid);
  const duplicateActualGuids = [...actualByGuid]
    .filter(([, entries]) => entries.length > 1).map(([guid]) => guid);
  const missing = manifestEntries.filter((entry) => !actualByGuid.has(entry.guid));
  const extra = actualEntries.filter((entry) => !manifestByGuid.has(entry.guid));
  const moved: Array<{ expected: InventoryEntry; actual: InventoryEntry }> = [];
  manifestByGuid.forEach((expectedEntries, guid) => {
    const actualEntriesForGuid = actualByGuid.get(guid);
    if (expectedEntries.length !== 1 || actualEntriesForGuid?.length !== 1) return;
    const expected = expectedEntries[0];
    const actual = actualEntriesForGuid[0];
    if (expected.parentGuid !== actual.parentGuid) moved.push({ expected, actual });
  });
  return { missing, extra, moved, duplicateManifestGuids, duplicateActualGuids };
}
