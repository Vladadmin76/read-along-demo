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

// ---------- Whole-phrase alignment (how reading tutors track position) ----------
// The recognizer keeps revising what it heard ("on a" -> "one day"), so instead of judging
// word by word we align the whole heard phrase to the sentence and only then decide.
export type RefOp = { kind: 'ok' | 'sub' | 'del'; h: number; sim: number }; // h = hyp index used (-1 for del)
export type Alignment = { ops: RefOp[]; refEnd: number };

const INS = 0.6; // extra heard word (um, repeat, other people talking)
const DEL = 1.0; // sentence word not heard
const SUB = 1.0; // heard a different word in its place

export function align(ref: string[], hyp: string[], strict: Strictness): Alignment {
  const th = THRESHOLD[strict];
  const n = hyp.length, m = ref.length;
  const S: number[][] = hyp.map((h) => ref.map((r) => sim(h, r)));
  const D: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const B: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0)); // 0 diag,1 ins,2 del
  for (let i = 1; i <= n; i++) { D[i][0] = i * INS; B[i][0] = 1; }
  for (let j = 1; j <= m; j++) { D[0][j] = j * DEL; B[0][j] = 2; }
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const d = D[i - 1][j - 1] + (S[i - 1][j - 1] >= th ? 0 : SUB);
      const a = D[i - 1][j] + INS;
      const b = D[i][j - 1] + DEL;
      if (d <= a && d <= b) { D[i][j] = d; B[i][j] = 0; }
      else if (a <= b) { D[i][j] = a; B[i][j] = 1; }
      else { D[i][j] = b; B[i][j] = 2; }
    }
  // The reader may be in the middle of the sentence: pick the best prefix end (longest on ties).
  let best = 0;
  for (let j = 1; j <= m; j++) if (D[n][j] <= D[n][best] + 1e-9) best = j;
  const ops: RefOp[] = [];
  let i = n, j = best;
  while (i > 0 || j > 0) {
    const k = B[i][j];
    if (i > 0 && j > 0 && k === 0) {
      const s = S[i - 1][j - 1];
      ops.unshift({ kind: s >= th ? 'ok' : 'sub', h: i - 1, sim: s });
      i--; j--;
    } else if (i > 0 && (j === 0 || k === 1)) i--;
    else { ops.unshift({ kind: 'del', h: -1, sim: 0 }); j--; }
  }
  return { ops, refEnd: best };
}

const funcForgiven = (op: RefOp, word: string, strict: Strictness) => op.kind === 'del' && strict === 'easy' && FUNC_WORDS.has(word);

// The phone often garbles or loses a word. In Easy and Normal ONE such word per sentence is forgiven,
// but only when the reader went on and read later words correctly (so it is the phone's loss, not a pause):
//  - a heard word that SOUNDS like the expected one, but not enough to count as read
//    (FORGIVE_SIM <= sim < NEAR: "oh" for "out", "got" for "goes"). Unrelated words ("cat" for "boy",
//    sim ~0) and near-misses ("toy" for "boy") stay real mistakes;
//  - a lost small word (a, the, to, in...) or the lost FIRST word of the sentence ("far away" -> "away").
// Returns the index of the forgiven word or -1. Only the first failing word can be forgiven.
export const FORGIVE_SIM = 0.4;
function lostWordGrace(ref: string[], a: Alignment, strict: Strictness): number {
  if (strict === 'strict') return -1;
  let lastOk = -1;
  a.ops.forEach((op, k) => { if (op.kind === 'ok') lastOk = k; });
  for (let k = 0; k < lastOk; k++) {
    const op = a.ops[k];
    if (op.kind === 'ok' || funcForgiven(op, ref[k], strict)) continue;
    if (op.kind === 'sub') return op.sim >= FORGIVE_SIM && op.sim < NEAR ? k : -1;
    return k === 0 || FUNC_WORDS.has(ref[k]) ? k : -1; // lost word
  }
  return -1;
}

// Number of sentence words read correctly from the start, and the hyp index right after the last of them.
// Highlighting only: one word that did not match, followed by two matching words, is stepped over so the
// cartoon does not wait while the text settles. The mistake itself is still reported by findMistake.
// A step-over never finishes the sentence (the last word stays open), so the cross can still come.
export function readPrefix(ref: string[], a: Alignment, strict: Strictness): { pos: number; hypAfter: number } {
  const grace = lostWordGrace(ref, a, strict);
  let pos = 0, hypAfter = 0, stepped = false;
  for (let k = 0; k < a.ops.length; k++) {
    const op = a.ops[k];
    if (op.kind === 'ok') { pos = k + 1; hypAfter = op.h + 1; continue; }
    if (k === grace || funcForgiven(op, ref[k], strict)) { pos = k + 1; if (op.h >= 0) hypAfter = op.h + 1; continue; }
    if (!stepped && a.ops[k + 1]?.kind === 'ok' && a.ops[k + 2]?.kind === 'ok') {
      stepped = true;
      pos = k + 1;
      if (op.h >= 0) hypAfter = op.h + 1;
      continue;
    }
    break;
  }
  if (stepped && pos >= ref.length) pos = ref.length - 1;
  return { pos, hypAfter };
}

// A mistake is only reported on settled text: a word that is wrong or missing while the reader has
// already gone on to a later correct word, or a near-miss word the reader stopped on.
export function findMistake(ref: string[], a: Alignment, strict: Strictness): { at: number; why: string } | null {
  const grace = lostWordGrace(ref, a, strict);
  let lastOk = -1;
  a.ops.forEach((op, k) => { if (op.kind === 'ok') lastOk = k; });
  for (let k = 0; k < a.ops.length; k++) {
    const op = a.ops[k];
    if (op.kind === 'ok' || k === grace || funcForgiven(op, ref[k], strict)) continue;
    if (k < lastOk) return { at: k, why: op.kind === 'del' ? 'skipped word' : 'wrong word' };
    if (op.kind === 'sub' && op.sim >= NEAR) return { at: k, why: 'wrong word' };
    return null;
  }
  return null;
}
