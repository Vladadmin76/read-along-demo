// Reading rules per mode, as pure logic (no screen, no timers), so they can be tested on a laptop.
//
//  child : a wrong or missing word is marked yellow quietly and counted; reading goes on (no cross, no "bam").
//  adult : a wrong word gets a cross and a red underline; the reader repeats from that word to the end of the
//          sentence (words read before it stay painted). Same word: failure 1 and 2 -> cross, failure 3 ->
//          counted as yellow without a cross and reading goes on.
//  strict: as before: cross, and the sentence is read again from its start. Nothing is forgiven or forced.
//
// The sentence is compared from `off` (the first word not decided yet), so a repeat from the wrong word works
// the same on every recognizer (New, New + hints, Old, Vosk): they all just deliver heard words.
import { align, findMistake, readPrefix, type Alignment, type Strictness } from './match';

export const MAX_FAILS = 3; // adult: failures 1 and 2 -> cross, failure 3 -> counted (yellow)

export type RState = {
  sent: number;     // sentence number this state belongs to
  words: string[];  // normalized words of the sentence
  off: number;      // first word that is still being compared (words before it are decided)
  failAt: number;   // word that failed last (adult), -1 if none
  failN: number;    // how many times it failed
  bad: number;      // word to underline in red (waiting for the repeat), -1 if none
};

export const newState = (sent: number, words: string[]): RState => ({ sent, words, off: 0, failAt: -1, failN: 0, bad: -1 });

export type StepEvent =
  | { type: 'cross'; at: number; attempt: number; why: string; restart: boolean }
  | { type: 'yellow'; at: number; attempt: number; forced: boolean; why: string };

export type StepResult = {
  pos: number;       // words read so far (absolute index in the sentence), before any decision
  hypAfter: number;  // heard words used by the read words (the rest belongs to the next sentence when it is finished)
  event: StepEvent | null;
  posAfter: number;  // words counted after the decision (adult cross: back to the wrong word)
  consumed: number;  // heard words used up by a yellow word (the caller drops them from the front)
};

// How many heard words a decided (yellow) word used up.
function consumedFor(a: Alignment, rel: number, hypAfter: number, hypLen: number): number {
  const op = a.ops[rel];
  if (op && op.h >= 0) return op.h + 1; // a wrong heard word stood in its place
  if (op) { // the word was not heard: up to the last heard word before it
    let prev = -1;
    for (let k = 0; k < rel; k++) if (a.ops[k].h >= 0) prev = Math.max(prev, a.ops[k].h);
    return prev + 1;
  }
  return Math.min(hypLen, hypAfter + 1); // an extra heard word right after the read words
}

export function stepSentence(st: RState, hyp: string[], times: number[], settledN: number, mode: Strictness): StepResult {
  const ref = st.words.slice(st.off);
  const atStart = st.off === 0;
  const a = align(ref, hyp, mode);
  const pr = readPrefix(ref, a, mode, atStart);
  const pos = st.off + pr.pos;
  const out: StepResult = { pos, hypAfter: pr.hypAfter, event: null, posAfter: pos, consumed: 0 };
  if (pos >= st.words.length) return out; // sentence finished
  // The failed word was really read now (a word only stepped over for the highlight does not count).
  if (st.failAt >= 0 && a.ops[st.failAt - st.off]?.kind === 'ok') { st.failAt = -1; st.failN = 0; st.bad = -1; }
  if (settledN <= 0) return out;

  const sa = settledN >= hyp.length ? a : align(ref, hyp.slice(0, settledN), mode);
  const mk = findMistake(ref, sa, mode, hyp.slice(0, settledN), times.slice(0, settledN), atStart);
  if (!mk) return out;
  const at = st.off + mk.at;

  if (mode === 'strict') {
    out.event = { type: 'cross', at, attempt: 1, why: mk.why, restart: true };
    return out;
  }

  const attempt = st.failAt === at ? st.failN + 1 : 1;
  const counts = mode === 'child' || attempt >= MAX_FAILS; // child: always; adult: on the 3rd failure
  if (!counts) {
    st.failAt = at; st.failN = attempt; st.bad = at; st.off = at;
    out.event = { type: 'cross', at, attempt, why: mk.why, restart: false };
    out.posAfter = at;
    return out;
  }
  // counted as yellow: go on with the next word
  const prSa = readPrefix(ref, sa, mode, atStart);
  out.consumed = consumedFor(sa, mk.at, prSa.hypAfter, settledN);
  st.off = at + 1;
  st.failAt = -1; st.failN = 0; st.bad = -1;
  out.event = { type: 'yellow', at, attempt, forced: mode === 'adult', why: mk.why };
  out.posAfter = at + 1;
  return out;
}
