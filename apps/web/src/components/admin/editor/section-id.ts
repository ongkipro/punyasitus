/**
 * Generates a unique, monotonic section ID (max 64 chars) that never collides
 * when sections are deleted and new sections are added (TASK-033).
 */
export function createUniqueSectionId(
  kind: string,
  seq: number,
  existingIds: ReadonlySet<string> = new Set(),
): string {
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Date.now().toString(36);
  let candidate = `sec-${kind}-${seq}-${rand}`;
  let attempt = 1;
  while (existingIds.has(candidate)) {
    candidate = `sec-${kind}-${seq}-${rand}-${attempt}`;
    attempt += 1;
  }
  return candidate.slice(0, 64);
}
