export const ROOT_FOLDER_KEY = "__root__";

export type SortableEntry = {
  path: string;
  name: string;
};

export function normalizeGuid(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const guid = String(value).trim();
  return guid ? guid : null;
}

export function compareEntryNames(a: SortableEntry, b: SortableEntry): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

export function sortEntries<T extends SortableEntry>(
  entries: T[],
  savedOrder: string[],
  guidOf: (entry: T) => string | null,
  fallback: "name" | "name-last" = "name-last",
): T[] {
  const rank = new Map<string, number>();
  savedOrder.forEach((guid, index) => {
    if (!rank.has(guid)) rank.set(guid, index);
  });

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
