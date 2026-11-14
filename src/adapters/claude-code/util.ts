export type Rec = Record<string, unknown>;

export function isObj(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export const RAW_STRING_LIMIT = 20_000;

/** Copy a JSON value, truncating long strings / big arrays / deep nesting so raw blocks stay small. */
export function shrink(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') {
    return v.length > RAW_STRING_LIMIT
      ? `${v.slice(0, RAW_STRING_LIMIT)}… [truncated ${v.length - RAW_STRING_LIMIT} chars]`
      : v;
  }
  if (v === null || typeof v !== 'object') return v;
  if (depth > 8) return '[max depth]';
  if (Array.isArray(v)) {
    const out = v.slice(0, 200).map((x) => shrink(x, depth + 1));
    if (v.length > 200) out.push(`… [${v.length - 200} more items]`);
    return out;
  }
  const out: Rec = {};
  let n = 0;
  for (const [k, x] of Object.entries(v)) {
    if (n++ >= 200) {
      out['…'] = 'more keys truncated';
      break;
    }
    out[k] = shrink(x, depth + 1);
  }
  return out;
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
