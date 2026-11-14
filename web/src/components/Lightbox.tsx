import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

const Ctx = createContext<(src: string) => void>(() => {});
export const useLightbox = () => useContext(Ctx);

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [src, setSrc] = useState<string>();
  const open = useCallback((s: string) => setSrc(s), []);
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSrc(undefined);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src]);
  return (
    <Ctx.Provider value={open}>
      {children}
      {src && (
        <div role="dialog" aria-modal="true" aria-label="Image" className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setSrc(undefined)}>
          <img src={src} alt="" className="max-h-full max-w-full rounded shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <button type="button" autoFocus aria-label="Close" className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" onClick={() => setSrc(undefined)}>
            <X size={18} />
          </button>
        </div>
      )}
    </Ctx.Provider>
  );
}
