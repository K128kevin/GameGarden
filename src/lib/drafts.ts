/**
 * Last-line cleanup for AI-written drafts before they're shown to the user.
 * The planner is told not to use em/en dashes; this guarantees it.
 */
export function stripDashes(text: string): string {
  let t = text;
  // Number ranges ("3–5", "2024—2025") become hyphens.
  t = t.replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2");
  // A dash starting a line (used as a bullet) becomes a hyphen bullet.
  t = t.replace(/^([ \t]*)[–—][ \t]*/gm, "$1- ");
  // Any other em/en dash becomes a comma.
  t = t.replace(/[ \t]*[–—][ \t]*/g, ", ");
  // Tidy the punctuation the replacement can leave behind.
  t = t
    .replace(/,\s*([,.!?;:)])/g, "$1") // ", ." → "."
    .replace(/([(])\s*,\s*/g, "$1") // "(, " → "("
    .replace(/,[ \t]*$/gm, "") // trailing comma at end of line
    .replace(/^([ \t]*),[ \t]*/gm, "$1"); // leading comma at start of line
  return t;
}

export function cleanDraft(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = stripDashes(text).trim();
  // Nothing but punctuation left means there was no real draft.
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : null;
}
