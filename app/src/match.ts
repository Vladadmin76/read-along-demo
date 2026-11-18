// Word comparison: spelling + rough sound-alike key.
// Same rules as the tested web demo.

export type Strictness = 'easy' | 'normal' | 'strict';

export const norm = (w: string) =>
  w.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9']/g, '');

export const FUNC_WORDS = new Set(['a', 'an', 'the', 'and', 'is', 'it', 'to', 'on', 'in', 'of', 'he', 'she', 'there']);

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let p = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const c = [i];
    for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[n];
}

const ratio = (a: string, b: string) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

function phon(w: string): string {
  const s = w.replace(/'/g, '').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/sh|ch/g, 's').replace(/th/g, 't')
    .replace(/wh/g, 'w').replace(/^kn/, 'n').replace(/gh/g, '').replace(/c(?=[eiy])/g, 's').replace(/[cq]/g, 'k')
    .replace(/x/g, 'ks').replace(/z/g, 's').replace(/v/g, 'f').replace(/d/g, 't').replace(/b/g, 'p').replace(/g/g, 'k');
  const f = s[0] || '';
  return (f + s.slice(1).replace(/[aeiouy]/g, '')).replace(/(.)\1+/g, '$1');
}

export function sim(a: string, b: string): number {
  if (a === b) return 1;
  const r = ratio(a, b), pa = phon(a), pb = phon(b);
  return Math.max(r, pa && pb ? 0.85 * ratio(pa, pb) : 0);
}

export const THRESHOLD: Record<Strictness, number> = { easy: 0.6, normal: 0.72, strict: 0.88 };
export const NEAR = 0.55;

// Decision for one heard word against the expected position in the sentence.
export type Verdict =
  | { kind: 'ok'; advance: number; consume: number }
  | { kind: 'wait' }
  | { kind: 'error'; why: string }
  | { kind: 'ignore'; why: string };

export function judge(words: string[], pos: number, tok: string, next: string | undefined, isLast: boolean, strict: Strictness): Verdict {
  const exp = words[pos];
  const th = THRESHOLD[strict];
  if (!exp) return { kind: 'ignore', why: 'sentence done' };
  if (sim(tok, exp) >= th) return { kind: 'ok', advance: 1, consume: 1 };
  if (next && sim(tok + next, exp) >= th) return { kind: 'ok', advance: 1, consume: 2 };
  if (isLast) return { kind: 'wait' };
  if (exp.startsWith(tok) && !next) return { kind: 'wait' };
  const n1 = words[pos + 1];
  if (n1 && sim(tok, n1) >= th) {
    if (strict === 'easy' && FUNC_WORDS.has(exp)) return { kind: 'ok', advance: 2, consume: 1 };
    return { kind: 'error', why: 'skipped word' };
  }
  if (pos > 0 && sim(tok, words[pos - 1]) >= th) return { kind: 'ignore', why: 'repeat' };
  if (sim(tok, exp) >= NEAR) return { kind: 'error', why: 'wrong word' };
  return { kind: 'ignore', why: 'not like text' };
}
