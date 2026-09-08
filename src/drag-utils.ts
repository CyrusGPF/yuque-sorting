export type DropPosition = "before" | "inside" | "after";
export type MoveBlockReason = "self-or-descendant" | "conflict";

/**
 * Split a file-tree title row into explicit drop zones. Nestable targets keep
 * a generous center zone; ordinary rows use their upper/lower halves.
 */
export function dropPositionForPointer(
  clientY: number,
  top: number,
  height: number,
  canNest: boolean,
): DropPosition {
  const ratio = height > 0 ? Math.max(0, Math.min(1, (clientY - top) / height)) : 0.5;
  if (!canNest) return ratio < 0.5 ? "before" : "after";
  if (ratio < 0.3) return "before";
  if (ratio > 0.7) return "after";
  return "inside";
}

/** Validate a filesystem move before any identity or order state is changed. */
export function moveBlockReason(
  sourcePath: string,
  sourceIsFolder: boolean,
  targetFolderPath: string,
  destinationExists: boolean,
): MoveBlockReason | null {
  if (sourceIsFolder
    && (targetFolderPath === sourcePath || targetFolderPath.startsWith(`${sourcePath}/`))) {
    return "self-or-descendant";
  }
  return destinationExists ? "conflict" : null;
}
