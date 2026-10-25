// Pure helpers for @mentions in internal notes (kept free of the database for unit tests).

const SPAN = /<span\b[^>]*>/gi;
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1];

/**
 * The officer ids @mentioned in a note's (sanitised) HTML, each once, in order. A mention is the
 * editor's `<span data-type="mention" data-id="…">`; anything else is ignored.
 */
export function extractMentionIds(html: string): string[] {
  const ids = new Set<string>();
  for (const tag of html.match(SPAN) ?? []) {
    const id = attr(tag, 'data-id');
    if (attr(tag, 'data-type') === 'mention' && id && /^[a-f0-9]{24}$/i.test(id)) ids.add(id.toLowerCase());
  }
  return [...ids];
}
