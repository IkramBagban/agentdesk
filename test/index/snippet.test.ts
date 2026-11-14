import { describe, expect, it } from 'vitest';
import type { ChatEvent } from '../../src/core/types.ts';
import { FTS_CAP_DETAIL, searchText } from '../../src/index/extract.ts';
import { makeSnippet, sanitizeFtsQuery } from '../../src/index/snippet.ts';

describe('makeSnippet', () => {
  it('marks whole tokens, prefix on the last term, case- and diacritic-insensitive', () => {
    expect(makeSnippet('The Café serves crêpes; cafeteria nearby', 'cafe crep')).toBe(
      'The <mark>Café</mark> serves <mark>crêpes</mark>; cafeteria nearby',
    );
    // non-last terms match whole tokens only; the last is a token prefix
    expect(makeSnippet('foobar foo barn', 'foo bar')).toBe('foobar <mark>foo</mark> <mark>barn</mark>');
    expect(makeSnippet('nothing here', 'zzz')).toBeUndefined();
    expect(makeSnippet('a foo-bar b', 'foo-bar')).toBe('a <mark>foo</mark>-<mark>bar</mark> b');
  });

  it('escapes everything except its own <mark>', () => {
    const s = makeSnippet('<img src=x onerror=alert(1)> & "q" \'s\' hit', 'hit')!;
    expect(s).toBe('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot; &#39;s&#39; <mark>hit</mark>');
  });

  it('cuts a window around the first match on token boundaries', () => {
    const text = 'lorem '.repeat(200) + 'needle ' + 'ipsum '.repeat(200);
    const s = makeSnippet(text, 'needle')!;
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('<mark>needle</mark>');
    expect(s.length).toBeLessThan(300);
    expect(s).not.toMatch(/…\S*rem\b(?<!lorem)/);
  });

  it('bounds the query', () => {
    expect(sanitizeFtsQuery('a '.repeat(100))!.split(' ')).toHaveLength(16);
    expect(sanitizeFtsQuery('x'.repeat(10_000))!.length).toBeLessThan(510);
  });
});

describe('searchText', () => {
  const ev = (over: Partial<ChatEvent>): ChatEvent => ({ seq: 0, role: 'tool', visibility: 'detail', blocks: [], line: 0, offset: 0, length: 0, ...over });
  it('caps detail text, skips meta, images and opaque blobs', () => {
    expect(searchText(ev({ blocks: [{ type: 'text', text: 'word '.repeat(10_000) }] }))!.length).toBeLessThanOrEqual(FTS_CAP_DETAIL);
    expect(searchText(ev({ visibility: 'meta', blocks: [{ type: 'text', text: 'x y' }] }))).toBeNull();
    const t = searchText(
      ev({
        blocks: [
          { type: 'image', mediaType: 'image/png', size: 3, data: 'QUFB'.repeat(1000) },
          { type: 'tool_use', id: 't', name: 'Read', input: { path: '/a/b', blob: 'Q'.repeat(1000) } },
        ],
      }),
    );
    expect(t).toBe('Read\n/a/b');
  });
});
