import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { time } from '../format.ts';

/**
 * Minimap: one tick per human prompt, evenly spaced, beside the
 * conversation. The current prompt is drawn longer; hovering a tick
 * previews the prompt, clicking jumps to it — even if it isn't loaded yet.
 */
export function Minimap({ sessionId, current, onJump }: { sessionId: string; current?: number; onJump: (seq: number) => void }) {
  const q = useQuery({ queryKey: ['outline', sessionId], queryFn: () => api.outline(sessionId), staleTime: 30_000 });
  const [hover, setHover] = useState<number>();
  const items = q.data ?? [];
  if (items.length < 3) return null;
  const n = items.length;
  // ~9px per tick, capped so long chats stay compact.
  const height = `min(${n * 9}px, 62vh)`;
  const h = hover != null ? items[hover] : undefined;
  const pos = (i: number) => (n === 1 ? 0 : i / (n - 1));
  const currentIndex = current == null ? -1 : items.reduce((best, it, i) => (it.seq <= current ? i : best), -1);

  return (
    <nav aria-label="Prompts in this chat" className="absolute top-1/2 right-3 z-10 hidden w-6 -translate-y-1/2 md:block" style={{ height }} onMouseLeave={() => setHover(undefined)}>
      <ol className="relative h-full">
        {items.map((it, i) => (
          <li key={it.seq} className="absolute right-0 w-full" style={{ top: `${pos(i) * 100}%` }}>
            <button
              type="button"
              aria-label={`Prompt ${i + 1} of ${n}: ${it.preview}`}
              aria-current={i === currentIndex ? 'true' : undefined}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(undefined)}
              onClick={() => onJump(it.seq)}
              className="group flex h-2 w-full -translate-y-1/2 items-center justify-end rounded-none focus-visible:outline-offset-0"
            >
              <span
                className={`block h-[2px] rounded-full transition-all duration-150 ${
                  i === currentIndex ? 'w-5 bg-ink' : hover === i ? 'w-5 bg-muted' : it.offBranch ? 'w-2 bg-line-strong' : 'w-3 bg-faint/60'
                }`}
              />
            </button>
          </li>
        ))}
      </ol>
      {h && (
        <div
          className="animate-pop pointer-events-none absolute right-full z-20 mr-3 w-72 -translate-y-1/2 rounded-xl border border-line bg-canvas px-3 py-2.5 text-[13px] shadow-pop dark:bg-raised"
          style={{ top: `${pos(hover!) * 100}%` }}
        >
          <div className="mb-1 text-[11px] text-faint tabular-nums">
            Prompt {hover! + 1} of {n}
            {h.timestamp ? ` · ${time(h.timestamp)}` : ''}
          </div>
          <div className="line-clamp-4 leading-snug text-ink">{h.preview}</div>
        </div>
      )}
    </nav>
  );
}
