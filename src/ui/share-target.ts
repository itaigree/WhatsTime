/** Web Share Target launches arrive as ./?title=…&text=…&url=… (see the manifest's share_target). */

const SHARE_PARAMS = ['title', 'text', 'url'] as const;

/**
 * The shared title/text/url joined with newlines (skipping parts that repeat each other, as Android often
 * puts the URL inside the text), or null when this is not a share launch. Removes the query from the URL.
 */
export function takeSharedText(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (!SHARE_PARAMS.some((key) => params.has(key))) return null;
  history.replaceState(history.state, '', window.location.pathname + window.location.hash);

  let parts: string[] = [];
  for (const key of SHARE_PARAMS) {
    const value = (params.get(key) ?? '').trim();
    if (!value || parts.some((part) => part.includes(value))) continue;
    parts = [...parts.filter((part) => !value.includes(part)), value];
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * The message to open after a share launch: the shared text, or, when an unsent draft already has a different
 * message, that draft with the shared text added after a blank line (a share never silently replaces a draft).
 */
export function messageWithShared(draft: string | undefined, shared: string): string {
  const current = (draft ?? '').trimEnd();
  if (!current.trim()) return shared;
  // Identical, or added by an earlier share of the same text.
  if (current.trim() === shared.trim() || current.endsWith(`\n\n${shared.trim()}`)) return draft ?? '';
  return `${current}\n\n${shared}`;
}
