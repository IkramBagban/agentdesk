import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.ts';
import { time } from '../format.ts';

/**
 * The outline spine: one tick per human prompt along the full length of
 * the chat, so a 2,000-message session can be navigated without paging
 * through it. Hovering a tick shows the prompt.
 */
export function Spine({ sessionId, onJump, current }: { sessionId: string; onJump: (seq: number) => void; current?: number }) {
  const q = useQuery({ queryKey: ['outline', sessionId], queryFn: () => api.outline(sessionId), staleTime: 30_000 });
  const [hover, setHover] = useState<number>();
  const items = q.data ?? [];
  if (items.length < 2) return null;
  const maxSeq = Math.max(...items.map((i) => i.seq), 1);
  const h = items[hover ?? -1];

  return (
    <nav aria-label="Prompts in this chat" className="relative hidden w-10 shrink-0 border-l border-rule py-4 md:block">
      <div className="absolute inset-y-4 left-1/2 w-px -translate-x-1/2 bg-rule" />
      <ol className="relative h-full" onMouseLeave={() => setHover(undefined)}>
        {items.map((it, i) => (
          <li key={it.seq} className="absolute left-0 w-full" style={{ top: `${(it.seq / maxSeq) * 100}%` }}>
            <button
              type="button"
              aria-label={`Prompt ${i + 1}: ${it.preview}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onClick={() => onJump(it.seq)}
              className="group flex h-3 w-full -translate-y-1/2 items-center justify-center"
            >
              <span
                className={`block h-[3px] rounded-full transition-all ${current === it.seq ? 'w-6 bg-mark' : it.offBranch ? 'w-2 bg-faint/50' : 'w-3 bg-prompt/70 group-hover:w-6 group-hover:bg-prompt'}`}
              />
            </button>
          </li>
        ))}
      </ol>
      {h && (
        <div
          className="pointer-events-none absolute right-full z-20 mr-2 w-72 -translate-y-1/2 rounded-md border border-rule bg-surface px-3 py-2 text-[13px] shadow-lg"
          style={{ top: `calc(1rem + (100% - 2rem) * ${h.seq / maxSeq})` }}
        >
          <div className="mb-0.5 text-[11.5px] text-faint">
            Prompt {(hover ?? 0) + 1} of {items.length} · {time(h.timestamp)}
          </div>
          <div className="line-clamp-4 text-prompt">{h.preview}</div>
        </div>
      )}
    </nav>
  );
}
