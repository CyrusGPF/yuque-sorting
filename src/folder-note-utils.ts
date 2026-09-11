export interface PairedIdentityInput {
  folderName: string;
  fileBasename: string;
  folderGuid: unknown;
  fileGuid: unknown;
  directChild: boolean;
}

export function typedGuidToken(value: unknown, expectedKind: "f" | "d"): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const guid = String(value).trim();
  if (!guid || guid[0] !== expectedKind || (guid[1] !== "-" && guid[1] !== ":")) return null;
  return guid.slice(2) || null;
}

/** Folder-note pairing is identity based, never name-only. */
export function pairedFolderNoteToken(input: PairedIdentityInput): string | null {
  if (!input.directChild || input.folderName !== input.fileBasename) return null;
  const folderToken = typedGuidToken(input.folderGuid, "d");
  const fileToken = typedGuidToken(input.fileGuid, "f");
  return folderToken && fileToken && folderToken === fileToken ? folderToken : null;
}

export function mergeChoice(
  globalEnabled: boolean,
  overrides: Readonly<Record<string, boolean>>,
  token: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, token) ? overrides[token] : globalEnabled;
}
