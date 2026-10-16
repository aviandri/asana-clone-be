/** Mentions are written as `@[Display Name](userId)` in comment markdown (SPEC §1). */
const MENTION = /@\[[^\]\n]*\]\(([0-9a-fA-F-]{36})\)/g;

/** Distinct user ids mentioned in a comment body, lowercased, in order of appearance. */
export function extractMentionIds(body: string): string[] {
  const ids = new Set<string>();
  for (const match of body.matchAll(MENTION)) ids.add(match[1]!.toLowerCase());
  return [...ids];
}
