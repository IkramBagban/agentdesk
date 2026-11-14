/**
 * Search query handling and snippet building.
 *
 * The FTS table is contentless (it stores only the inverted index, not the
 * text), so FTS5's snippet() is unavailable. Snippets are built here from the
 * event's searchable text (re-read from the source file by the server, or the
 * stored preview as a fallback), approximating FTS5's unicode61 tokenizer:
 * tokens are runs of letters/digits, compared case- and diacritic-insensitively;
 * every query term matches whole tokens except the last, which is a prefix.
 */

const MAX_TERMS = 16;
const MAX_QUERY_CHARS = 500;
const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;

/** User query → list of terms (each term may contain several tokens, e.g. "foo-bar"). */
export function queryTerms(q: string): string[] {
  return q
    .slice(0, MAX_QUERY_CHARS)
    .replace(/\0/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, MAX_TERMS);
}

/**
 * Turn free text into a safe FTS5 query: every term quoted (so operators and
 * syntax characters are literal), implicit AND, prefix match on the last term.
 * Returns undefined when nothing searchable remains.
 */
export function sanitizeFtsQuery(q: string): string | undefined {
  const terms = queryTerms(q);
  if (!terms.length) return undefined;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? '*' : ''}`).join(' ');
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();

interface Tok {
  start: number;
  end: number;
  hit: boolean;
}

const CONTEXT_BEFORE = 60;
const SNIPPET_CHARS = 220;

/**
 * HTML-escaped excerpt of `text` around the first query match, with every
 * matching token wrapped in <mark>. Returns undefined when nothing matches.
 */
export function makeSnippet(text: string, q: string): string | undefined {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  const terms = queryTerms(q);
  terms.forEach((t, i) => {
    const toks = fold(t).match(TOKEN) ?? [];
    toks.forEach((tok, j) => {
      if (i === terms.length - 1 && j === toks.length - 1) prefixes.push(tok);
      else exact.add(tok);
    });
  });
  if (!exact.size && !prefixes.length) return undefined;

  const toks: Tok[] = [];
  let firstHit = -1;
  for (const m of text.matchAll(TOKEN)) {
    const f = fold(m[0]);
    const hit = exact.has(f) || prefixes.some((p) => f.startsWith(p));
    if (hit && firstHit < 0) firstHit = m.index;
    toks.push({ start: m.index, end: m.index + m[0].length, hit });
    if (firstHit >= 0 && m.index > firstHit + SNIPPET_CHARS) break;
  }
  if (firstHit < 0) return undefined;

  let from = Math.max(0, firstHit - CONTEXT_BEFORE);
  let to = Math.min(text.length, from + SNIPPET_CHARS);
  // snap to token boundaries so words are not cut
  const cut = toks.find((t) => t.start < from && t.end > from);
  if (cut) from = cut.end;
  const cutEnd = toks.find((t) => t.start < to && t.end > to);
  if (cutEnd) to = cutEnd.start;

  let out = from > 0 ? '…' : '';
  let pos = from;
  for (const t of toks) {
    if (!t.hit || t.start < from || t.end > to) continue;
    out += escapeHtml(text.slice(pos, t.start)) + '<mark>' + escapeHtml(text.slice(t.start, t.end)) + '</mark>';
    pos = t.end;
  }
  out += escapeHtml(text.slice(pos, to));
  if (to < text.length) out += '…';
  return out.replace(/\s+/g, ' ').trim();
}
