import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

/** Small square icon button with a tooltip-style title. */
export function IconButton({
  label,
  onClick,
  children,
  className = '',
  active = false,
  href,
  download,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  active?: boolean;
  href?: string;
  download?: boolean;
}) {
  const cls = `inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink active:bg-press ${active ? 'bg-hover text-ink' : ''} ${className}`;
  if (href)
    return (
      <a href={href} download={download} aria-label={label} title={label} className={cls}>
        {children}
      </a>
    );
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-secure contexts.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function CopyButton({ text, label = 'Copy', className = '', size = 15 }: { text: string | (() => string); label?: string; className?: string; size?: number }) {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <button
      type="button"
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
      onClick={() => {
        void writeClipboard(typeof text === 'function' ? text() : text);
        setDone(true);
        clearTimeout(t.current);
        t.current = setTimeout(() => setDone(false), 1400);
      }}
      className={`inline-flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-hover hover:text-ink ${className}`}
    >
      {done ? <Check size={size - 1} className="text-ok" /> : <Copy size={size - 1} />}
    </button>
  );
}

/** Quiet segmented control (radio group). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = '',
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex rounded-[7px] bg-hover p-0.5 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`inline-flex h-6 min-w-0 flex-1 items-center justify-center gap-1.5 truncate rounded-[5px] px-2 text-[11.5px] font-medium transition-colors ${
            value === o.value ? 'bg-canvas text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_0.5px_var(--line)] dark:bg-raised-2' : 'text-muted hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Popover anchored to a trigger; closes on outside click / Escape. */
export function Popover({ trigger, children, align = 'end', label }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: ReactNode; align?: 'start' | 'end'; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={`animate-pop absolute top-full z-40 mt-1.5 w-80 max-w-[calc(100vw-24px)] rounded-xl border border-line bg-canvas p-1 shadow-pop dark:bg-raised ${align === 'end' ? 'right-0' : 'left-0'}`}
        >
          {children}
        </div>
      )}
    </div>
  );
}
