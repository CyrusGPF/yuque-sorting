export type GuidBits = 64 | 72;
export type IdentityKind = "file" | "folder";

export interface IdentityEntry {
  path: string;
  kind: IdentityKind;
  guid: string;
}

export function normalizeGuidBits(value: unknown): GuidBits {
  return Number(value) === 72 ? 72 : 64;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function encodeBase62(bytes: Uint8Array, length: number): string {
  const quotient = Array.from(bytes);
  const encoded: string[] = [];
  let first = 0;
  while (first < quotient.length) {
    let remainder = 0;
    for (let index = first; index < quotient.length; index += 1) {
      const value = remainder * 256 + quotient[index];
      quotient[index] = Math.floor(value / 62);
      remainder = value % 62;
    }
    encoded.push(BASE62[remainder]);
    while (first < quotient.length && quotient[first] === 0) first += 1;
  }
  return encoded.reverse().join("").padStart(length, "0");
}

export function createTypedGuid(
  kind: "f" | "d",
  bits: GuidBits = 64,
  used?: Set<string>,
  random: Crypto = globalThis.crypto,
): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = new Uint8Array(bits / 8);
    random.getRandomValues(bytes);
    const guid = `${kind}-${encodeBase62(bytes, bits === 72 ? 13 : 11)}`;
    if (!used || !used.has(guid)) {
      used?.add(guid);
      return guid;
    }
  }
  throw new Error("无法生成唯一 GUID");
}

/** Allocates arrays only for values that are actually duplicated. */
export function findDuplicateIdentities(entries: IdentityEntry[]): IdentityEntry[][] {
  const first = new Map<string, IdentityEntry>();
  const duplicate = new Map<string, IdentityEntry[]>();
  for (const entry of entries) {
    const initial = first.get(entry.guid);
    if (!initial) {
      first.set(entry.guid, entry);
      continue;
    }
    const group = duplicate.get(entry.guid);
    if (group) group.push(entry);
    else duplicate.set(entry.guid, [initial, entry]);
  }
  return [...duplicate.values()];
}

export function remapOrderSnapshot(
  folderChildrenByPath: Record<string, string[]>,
  guidByPath: ReadonlyMap<string, string>,
  folderGuidByPath: ReadonlyMap<string, string>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [folderPath, childPaths] of Object.entries(folderChildrenByPath)) {
    const key = folderPath ? folderGuidByPath.get(folderPath) : "__root__";
    if (!key) continue;
    result[key] = childPaths.map((path) => guidByPath.get(path)).filter((guid): guid is string => Boolean(guid));
  }
  return result;
}

export async function mapLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await task(item);
    }
  });
  await Promise.all(workers);
}
