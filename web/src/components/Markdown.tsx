import { memo, useEffect, useState, type ReactNode } from 'react';
import { CopyButton } from './ui.tsx';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown for untrusted chat content. react-markdown never renders raw
 * HTML (no rehype-raw), so <script>/<img onerror> in a chat stay text.
 * Links open in a new tab with noopener; images are NOT loaded from
 * remote URLs (privacy: a chat must not phone home when you read it).
 */

type Highlighter = { codeToHtml: (code: string, opts: { lang: string; themes: { light: string; dark: string } }) => string };
let highlighterPromise: Promise<Highlighter> | undefined;
const LANGS = ['ts', 'tsx', 'js', 'jsx', 'json', 'bash', 'shell', 'python', 'css', 'html', 'sql', 'yaml', 'markdown', 'diff', 'go', 'rust', 'swift', 'toml'];

function loadHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    const h = await createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/tsx.mjs'),
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/jsx.mjs'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/bash.mjs'),
        import('shiki/langs/shellscript.mjs'),
        import('shiki/langs/python.mjs'),
        import('shiki/langs/css.mjs'),
        import('shiki/langs/html.mjs'),
        import('shiki/langs/sql.mjs'),
        import('shiki/langs/yaml.mjs'),
        import('shiki/langs/markdown.mjs'),
        import('shiki/langs/diff.mjs'),
        import('shiki/langs/go.mjs'),
        import('shiki/langs/rust.mjs'),
        import('shiki/langs/swift.mjs'),
        import('shiki/langs/toml.mjs'),
      ],
      engine: createJavaScriptRegexEngine(),
    });
    return h as unknown as Highlighter;
  })();
  return highlighterPromise;
}

const ALIASES: Record<string, string> = { sh: 'bash', zsh: 'bash', console: 'bash', py: 'python', yml: 'yaml', md: 'markdown', typescript: 'ts', javascript: 'js', rs: 'rust' };
const MAX_HIGHLIGHT = 40_000;

/** Highlighted code. `bare` drops the frame/header (for use inside other panels). */
export const CodeBlock = memo(function CodeBlock({ code, lang, bare = false, className = '' }: { code: string; lang?: string; bare?: boolean; className?: string }) {
  const [html, setHtml] = useState<string>();
  const l = lang ? (ALIASES[lang] ?? lang) : undefined;
  useEffect(() => {
    if (!l || !LANGS.includes(l) || code.length > MAX_HIGHLIGHT) return;
    let alive = true;
    loadHighlighter()
      .then((h) => {
        // shiki escapes the code; output is safe to inject.
        if (alive) setHtml(h.codeToHtml(code, { lang: l === 'shell' ? 'shellscript' : l, themes: { light: 'github-light', dark: 'github-dark' } }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code, l]);
  const body = html ? (
    <div className={bare ? className : 'overflow-x-auto px-3.5 pt-1 pb-3'} dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <pre className={bare ? className : 'overflow-x-auto px-3.5 pt-1 pb-3'}>
      <code>{code}</code>
    </pre>
  );
  if (bare) return body;
  return (
    <div className={`code-block group/code relative !p-0 ${className}`}>
      <div className="flex h-8 items-center justify-between pr-1.5 pl-3.5 font-sans text-[11.5px] text-faint">
        <span>{lang ?? 'text'}</span>
        <CopyButton text={code} label="Copy code" size={14} className="opacity-60 group-hover/code:opacity-100 focus-visible:opacity-100" />
      </div>
      {body}
    </div>
  );
});

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? '');
    const m = /language-([\w+-]+)/.exec(className ?? '');
    if (m || text.includes('\n')) return <CodeBlock code={text.replace(/\n$/, '')} lang={m?.[1]} />;
    return <code>{children}</code>;
  },
  a: ({ href, children }) => {
    const safe = href && /^(https?:|mailto:)/i.test(href) ? href : undefined;
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span className="underline decoration-dotted">{children}</span>
    );
  },
  img: ({ alt, src }) => (
    <span className="text-muted text-sm italic" title={typeof src === 'string' ? src : undefined}>
      [image{alt ? `: ${alt}` : ''}]
    </span>
  ),
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }): ReactNode {
  return (
    <div className={`prose-msg ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  );
});
