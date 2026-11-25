import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { useKeepAwake } from 'expo-keep-awake';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { downloadAll, ensureFile, isDownloaded, Manifest, readManifest, Sentence, Story, toSentences, touchOpened } from './library';
import Loader from './Loader';
import { norm } from './match';
import { MAX_FAILS, newState, stepSentence, type RState, type StepEvent } from './reading';
import { LiveTranscriber } from '../modules/live-transcriber';
import { Settings, SettingsSheet } from './Settings';
import { C, Btn } from './ui';

const IOS_SESSION = {
  category: 'playAndRecord' as const,
  categoryOptions: ['defaultToSpeaker' as const, 'allowBluetooth' as const, 'mixWithOthers' as const],
  mode: 'default' as const,
};
function keepRecordingSession() {
  if (Platform.OS !== 'ios') return;
  try {
    ExpoSpeechRecognitionModule.setCategoryIOS(IOS_SESSION);
  } catch {}
}

type Props = { story: Story; settings: Settings; setSettings: (s: Settings) => void; onBack: () => void };

export default function Reader({ story, settings, setSettings, onBack }: Props) {
  useKeepAwake();
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [msg, setMsg] = useState('');
  const [heard, setHeard] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [ask, setAsk] = useState<null | { sent: number; errs: number }>(null);
  const [showEnd, setShowEnd] = useState(false);
  const [loading, setLoading] = useState<null | { done: number; total: number; error?: string }>(null);
  const manRef = useRef<Manifest | null>(null);
  const [cross, setCross] = useState(false);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const logRef = useRef<string[]>([]);
  const t0 = useRef(Date.now());
  const L = useCallback((m: string) => {
    const line = ((Date.now() - t0.current) / 1000).toFixed(1) + 's ' + m;
    logRef.current.push(line);
    if (logRef.current.length > 500) logRef.current.shift();
    bump();
  }, []);
  const S = useRef(settings);
  S.current = settings;

  // Mutable reading state (kept in a ref so speech/timer callbacks always see current values).
  const E = useRef({
    sent: 0, pos: 0, errs: 0, errRow: 0,
    started: false, finished: false, freeze: false, want: false, running: false,
    vidSeg: -1, target: 0, segReady: false, ended: false,
    toks: [] as string[], base: 0, finalCount: 0, changedAt: 0, times: [] as number[], settled: true, lastEv: 0,
    classic: false, liveFailed: false,
    rs: null as null | RState, warns: {} as Record<number, number[]>,
    vosk: false, voskLoaded: false, voskT0: 0, voskFin: [] as string[], voskPart: [] as string[],
    sents: [] as Sentence[], dur: 0,
  }).current;

  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.loop = false;
    p.audioMixingMode = 'mixWithOthers';
  });
  const bam = useRef<AudioPlayer | null>(null);
  const fin = useRef<AudioPlayer | null>(null);

  // ---------- load story ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true, interruptionMode: 'mixWithOthers' });
      } catch (e: any) {
        L('audio mode failed: ' + e.message);
      }
      keepRecordingSession();
      try {
        const m = await readManifest(story);
        if (!alive) return;
        manRef.current = m;
        touchOpened(story.id);
        if (!isDownloaded(story, m)) {
          const ok = await fetchAll(m);
          if (!ok || !alive) return;
        }
        const ss = toSentences(m);
        E.sents = ss;
        setSentences(ss);
        L(`story ${m.id}: ${ss.length} sentences`);
        const errAudio = m.generic_error?.audio;
        if (errAudio) ensureFile(story, errAudio).then((u) => (bam.current = createAudioPlayer(u))).catch((e) => L('bam sound: ' + e.message));
        if (m.success_audio) ensureFile(story, m.success_audio).then((u) => (fin.current = createAudioPlayer(u))).catch(() => {});
        const saved = JSON.parse((await AsyncStorage.getItem('pos_' + m.id)) || 'null');
        if (saved && saved.sent > 0 && saved.sent < ss.length) setAsk(saved);
        showSeg(0);
      } catch (e: any) {
        setMsg(e.message);
        L('load failed: ' + e.message);
      }
    })();
    return () => {
      alive = false;
      E.want = false;
      try { ExpoSpeechRecognitionModule.abort(); } catch {}
      bam.current?.remove();
      fin.current?.remove();
    };
  }, [story.id]);

  // ---------- whole-story download ----------
  const fetchAll = async (m: Manifest) => {
    setLoading({ done: 0, total: 1 });
    L('downloading the whole cartoon');
    try {
      await downloadAll(story, m, (done, total) => setLoading({ done, total }));
      L('download complete');
      setLoading(null);
      return true;
    } catch (e: any) {
      L('download failed: ' + e.message);
      setLoading((p) => ({ done: p?.done ?? 0, total: p?.total ?? 1, error: 'Check the internet connection. ' + e.message }));
      return false;
    }
  };
  const retry = async () => {
    const m = manRef.current;
    if (!m) return;
    if (await fetchAll(m)) {
      const ss = toSentences(m);
      E.sents = ss;
      setSentences(ss);
      showSeg(0);
    }
  };

  // ---------- video ----------
  const segDur = (i: number) => {
    const s = E.sents[i];
    const last = s ? s.marks[s.marks.length - 1] + 0.2 : 1;
    return i === E.vidSeg && E.dur > 0 ? Math.max(E.dur, last) : Math.max(last, 1);
  };
  const showSeg = async (i: number) => {
    const s = E.sents[i];
    if (!s) return;
    E.vidSeg = i; E.target = 0; E.segReady = false; E.ended = false; E.dur = 0;
    try {
      const uri = await ensureFile(story, s.video);
      if (E.vidSeg !== i) return;
      await player.replaceAsync({ uri });
      if (E.vidSeg !== i) return;
      player.pause();
      player.currentTime = 0;
      E.dur = player.duration || 0;
      E.segReady = true;
      L(`video ${s.id} ready (${E.dur.toFixed(1)}s)`);
    } catch (e: any) {
      setMsg('Could not load ' + s.video + ': ' + e.message);
      L('video load failed ' + s.id + ': ' + e.message);
    }
    for (const k of [i + 1, i + 2]) if (E.sents[k]) ensureFile(story, E.sents[k].video).catch(() => {});
  };
  useEffect(() => {
    const a = player.addListener('playToEnd', () => (E.ended = true));
    const b = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'readyToPlay' && player.duration > 0) E.dur = player.duration;
      if (status === 'error') L('video error: ' + (error?.message || ''));
    });
    const timer = setInterval(() => {
      if (!E.segReady) return;
      const t = player.currentTime;
      const d = segDur(E.vidSeg);
      if (!E.freeze && t < E.target - 0.05 && !player.playing && !E.ended) {
        keepRecordingSession();
        player.play();
      }
      if (player.playing && t >= E.target - 0.02) player.pause();
      if (E.vidSeg < E.sent && !E.finished && E.target >= d - 0.01 && (E.ended || t >= d - 0.15)) showSeg(E.sent);
    }, 50);
    return () => { a.remove(); b.remove(); clearInterval(timer); };
  }, [player]);

  const goWord = () => {
    const s = E.sents[E.sent];
    if (E.vidSeg !== E.sent) showSeg(E.sent);
    E.target = E.pos > 0 ? s.marks[Math.min(E.pos, s.marks.length) - 1] : 0;
    if (E.pos >= s.words.length) E.target = segDur(E.sent);
  };

  // ---------- reading ----------
  const save = (done = false) =>
    AsyncStorage.setItem('pos_' + story.id, JSON.stringify(done ? { sent: 0 } : { sent: E.sent, errs: E.errs })).catch(() => {});

  const finish = () => {
    E.finished = true;
    stopMic();
    L('story finished');
    save(true);
    setTimeout(() => {
      setShowEnd(true);
      try { fin.current?.seekTo(0); fin.current?.play(); } catch {}
    }, 1500);
  };
  // Sets the number of correctly read words; returns true when the sentence is finished.
  const accept = (newPos: number) => {
    const s = E.sents[E.sent];
    E.pos = Math.min(newPos, s.words.length);
    goWord();
    if (E.pos >= s.words.length) {
      L(`sentence ${E.sent + 1} done`);
      E.rs = null;
      E.target = segDur(E.sent);
      E.errRow = 0;
      E.sent++;
      E.pos = 0;
      save();
      if (E.sent >= E.sents.length) finish();
      bump();
      return true;
    }
    bump();
    return false;
  };
  // Cross + "bam". Strict: the sentence starts again (video rewinds). Adult: the repeat starts at the wrong word,
  // the words read before it stay painted and the video simply waits where it is.
  const mistake = (restart: boolean, posAfter: number) => {
    E.errs++; E.errRow++; E.freeze = true;
    E.pos = restart ? 0 : posAfter;
    E.base = E.toks.length;
    if (restart) showSeg(E.sent);
    setCross(true);
    if (S.current.bam && bam.current) {
      try { bam.current.seekTo(0); bam.current.play(); } catch {}
    }
    setTimeout(() => {
      setCross(false);
      E.freeze = false;
      E.base = E.toks.length; // words said during the cross do not count
      bump();
    }, 1000);
    bump();
  };

  // The whole heard phrase is aligned to the sentence (see match.ts, rules per mode in reading.ts).
  // Words light up as soon as they match; a mistake only comes from settled text.
  const evaluate = (settledAll: boolean) => {
    if (E.freeze || E.finished || !E.started) { E.base = E.toks.length; return; }
    for (let guard = 0; guard < 50 && !E.finished; guard++) {
      const s = E.sents[E.sent];
      if (!E.rs || E.rs.sent !== E.sent) E.rs = newState(E.sent, s.words);
      const hyp = E.toks.slice(E.base);
      if (!hyp.length) return;
      const settledN = settledAll ? hyp.length : Math.max(0, E.finalCount - E.base);
      const r = stepSentence(E.rs, hyp, E.times.slice(E.base), settledN, S.current.strict);
      if (r.pos > E.pos) {
        L(`S${E.sent + 1}: ${r.pos}/${s.words.length} read ("${hyp.slice(0, r.hypAfter).join(' ')}")`);
        if (accept(r.pos)) { E.base += r.hypAfter; continue; } // leftover words belong to the next sentence
      }
      const ev: StepEvent | null = r.event;
      if (!ev) return;
      const where = `S${E.sent + 1}w${ev.at + 1} "${s.words[ev.at]}"`;
      const heard = `heard "${hyp.slice(0, settledN).join(' ')}"`;
      if (ev.type === 'cross') {
        L(ev.restart
          ? `${where} ERROR ${ev.why} (${heard})`
          : `${where} attempt ${ev.attempt}/${MAX_FAILS} forced=no CROSS (${ev.why}; ${heard})`);
        mistake(ev.restart, r.posAfter);
        return;
      }
      // yellow: counted as read, reading goes on (no cross, no "bam")
      E.errs++;
      E.warns[E.sent] = [...(E.warns[E.sent] || []), ev.at];
      L(`${where} attempt ${ev.attempt}${ev.forced ? '/' + MAX_FAILS : ''} forced=${ev.forced ? 'yes' : 'no'} -> counted, yellow (${ev.why}; ${heard})`);
      E.base += r.consumed;
      if (r.posAfter > E.pos) accept(r.posAfter);
      bump();
    }
  };
  const onTranscript = (toks: string[], finalCount: number) => {
    if (toks.length < E.base) E.base = toks.length;
    if (toks.join(' ') !== E.toks.join(' ')) { E.changedAt = Date.now(); E.settled = false; }
    const now = Date.now();
    E.times = toks.map((t, i) => (E.toks[i] === t && E.times[i] !== undefined ? E.times[i] : now)); // arrival time of each word
    E.toks = toks;
    E.finalCount = finalCount;
    evaluate(false);
  };
  // Text that has not changed for 1.5 s counts as settled (for mistakes).
  useEffect(() => {
    const t = setInterval(() => {
      if (E.want && !E.settled && E.toks.length > E.base && Date.now() - E.changedAt > 1500) {
        E.settled = true;
        L(`text settled after 1.5 s: "${E.toks.slice(E.base).join(' ')}"`);
        evaluate(true);
      }
    }, 250);
    return () => clearInterval(t);
  }, []);

  // ---------- speech ----------
  const tokens = (text: string) => text.split(/\s+/).map(norm).filter(Boolean);
  const useLive = () => S.current.engine !== 'classic' && !E.liveFailed && LiveTranscriber.isAvailable();
  const cleanWords = (i: number) =>
    (E.sents[i]?.display || []).map((w: string) => w.replace(/[^A-Za-z']/g, '')).filter(Boolean);
  // Word hints for the "New + hints" engine: the sentence being read and the next one (each call replaces the previous hints).
  const pushContext = () => {
    if (S.current.engine !== 'dictation' || !E.running || E.classic) return;
    const words = Array.from(new Set([...cleanWords(E.sent), ...cleanWords(E.sent + 1)]));
    if (words.length) {
      L(`hints: ${words.length} words`);
      LiveTranscriber.setContext(words);
    }
  };
  // ---------- Vosk (offline). One grammar for the whole story: every word of the manifest + "[unk]". ----------
  const getVosk = (): any => { try { return require('react-native-vosk'); } catch { return null; } };
  const voskTokens = (text: string) => text.split(/\s+/).map((t) => (t === '[unk]' ? 'zzunk' : norm(t))).filter(Boolean);
  // Full text of an error (message, code, native details) for the log.
  const errText = (e: any): string => {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    const parts = [e.code ? `[${e.code}]` : '', e.message || String(e)];
    if (e.userInfo && Object.keys(e.userInfo).length) parts.push('userInfo=' + JSON.stringify(e.userInfo));
    const stack = Array.isArray(e.nativeStackIOS) ? e.nativeStackIOS.slice(0, 3).join(' | ') : '';
    if (stack) parts.push('native: ' + stack);
    return parts.filter(Boolean).join(' ');
  };
  const logAudio = (when: string) => {
    const info = LiveTranscriber.audioInfo();
    L(`vosk: audio ${when}: ${info ? JSON.stringify(info) : 'no info (native part missing)'}`);
  };
  // Returns null when Vosk is listening, otherwise the reason it could not start.
  // Every start-up step is written to the log, so a failure shows at which step Vosk broke.
  const startVosk = async (): Promise<string | null> => {
    const V = getVosk();
    if (!V) { L('vosk: step 1/5 module NOT found in the app'); return 'module not available'; }
    L('vosk: step 1/5 module found');
    try {
      const mic = await ExpoSpeechRecognitionModule.getMicrophonePermissionsAsync();
      L(`vosk: step 2/5 microphone permission: ${mic.status}${mic.granted ? '' : ' (NOT granted)'}`);
    } catch (e: any) {
      L('vosk: step 2/5 microphone permission check failed: ' + errText(e));
    }
    logAudio('before start');
    if (!E.voskLoaded) {
      const t = Date.now();
      try {
        await V.loadModel('model-en-us');
      } catch (e: any) {
        const why = errText(e);
        L(`vosk: step 3/5 model load FAILED after ${Date.now() - t} ms: ${why}`);
        return 'model load failed: ' + why;
      }
      E.voskLoaded = true;
      L(`vosk: step 3/5 model loaded in ${Date.now() - t} ms`);
    } else L('vosk: step 3/5 model already loaded');
    try {
      const words = Array.from(new Set(E.sents.flatMap((s) => s.words))).filter(Boolean);
      const grammar = [...words, '[unk]'];
      L(`vosk: step 4/5 grammar ${grammar.length} items, once for the whole story: ${grammar.join(' ')}`);
      E.voskFin = []; E.voskPart = [];
      keepRecordingSession(); // the app owns the iPhone audio session (playAndRecord), Vosk must not change it
      const t1 = Date.now();
      await V.start({ grammar, manageAudioSession: false });
      E.voskT0 = Date.now();
      E.vosk = true; E.running = true;
      L(`vosk: step 5/5 recognizer started in ${E.voskT0 - t1} ms`);
      L('mic: listening (vosk)');
      logAudio('after start');
      // One check 10 s later: no words at all usually means no sound reaches Vosk (microphone, audio route).
      const t0 = E.voskT0;
      setTimeout(() => {
        if (E.vosk && E.voskT0 === t0 && !E.voskFin.length && !E.voskPart.length) {
          L('vosk: no words heard in 10 s after start');
          logAudio('after 10 s without words');
        }
      }, 10000);
      setMsg('');
      return null;
    } catch (e: any) {
      const why = errText(e);
      L('vosk: step 5/5 recognizer start FAILED: ' + why);
      logAudio('after failed start');
      return 'start failed: ' + why;
    }
  };
  const startRec = async () => {
    E.toks = []; E.times = []; E.base = 0; E.finalCount = 0; E.lastEv = Date.now(); E.changedAt = Date.now(); E.settled = true;
    E.voskFin = []; E.voskPart = [];
    // Vosk is being tested on its own: when it does not start, the app says so and does NOT switch to another recognizer.
    if (S.current.engine === 'vosk') {
      L(`mic: starting (vosk, offline) strictness=${S.current.strict} engine=${S.current.engine}`);
      const err = await startVosk();
      if (!err) return;
      L('vosk could not start: ' + err + ' (no switch to another recognizer)');
      E.want = false;
      E.running = false;
      setMsg('Vosk не запустился: ' + (err.length > 80 ? err.slice(0, 80) + '…' : err));
      bump();
      return;
    }
    if (useLive()) {
      const dict = S.current.engine === 'dictation';
      L(`mic: starting (continuous SpeechAnalyzer, ${dict ? 'Dictation + hints' : 'SpeechTranscriber'}) strictness=${S.current.strict} engine=${S.current.engine}`);
      try {
        await LiveTranscriber.start('en-US', dict ? 'dictation' : 'speech');
        E.running = true;
        pushContext();
        L('mic: listening (continuous)');
        setMsg('');
      } catch (e: any) {
        L('continuous mic failed: ' + e.message + ' -> classic recognizer');
        E.liveFailed = true;
        startClassic();
      }
      return;
    }
    startClassic();
  };
  const startClassic = () => {
    E.toks = []; E.times = []; E.base = 0; E.finalCount = 0; E.lastEv = Date.now();
    const words = Array.from(new Set(E.sents.flatMap((s) => s.display.map((w) => w.replace(/[^A-Za-z']/g, ''))))).filter(Boolean).slice(0, 100);
    L(`mic: starting (classic) strictness=${S.current.strict} engine=${S.current.engine}`);
    try {
      ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        interimResults: true,
        continuous: true,
        maxAlternatives: 1,
        addsPunctuation: false,
        contextualStrings: words,
        iosCategory: IOS_SESSION,
      });
      E.running = true;
      E.classic = true;
    } catch (e: any) {
      L('mic start failed: ' + e.message);
    }
  };
  // Engine changed in Settings while reading: stop the old recognizer and start the new one, no app restart.
  const lastEngine = useRef(settings.engine);
  useEffect(() => {
    if (lastEngine.current === settings.engine) return;
    const was = lastEngine.current;
    lastEngine.current = settings.engine;
    L(`engine switched to ${settings.engine} (was ${was}), strictness=${settings.strict}`);
    E.liveFailed = false;
    if (!E.want || !E.started) return; // mic is off: the new engine is used at the next Start
    (async () => {
      const wasClassic = E.classic, wasVosk = E.vosk;
      E.running = false;
      E.classic = false;
      E.vosk = false;
      if (wasClassic) { try { ExpoSpeechRecognitionModule.abort(); } catch {} }
      else if (wasVosk) { try { getVosk()?.stop(); } catch {} }
      else { try { await LiveTranscriber.stop(); } catch {} }
      if (E.want) startRec();
    })();
  }, [settings.engine]);
  const stopMic = () => {
    E.want = false;
    if (E.classic) {
      try { ExpoSpeechRecognitionModule.abort(); } catch {}
      E.classic = false;
    } else if (E.vosk) {
      E.vosk = false;
      try { getVosk()?.stop(); } catch {}
    } else if (E.running) {
      LiveTranscriber.stop().catch(() => {});
    }
    E.running = false;
    bump();
  };

  // Vosk events: partial = current phrase, result = finished phrase (after a silence). Texts are only words, no times:
  // the arrival time of each word is stamped in onTranscript (E.times).
  useEffect(() => {
    const V = getVosk();
    if (!V) return;
    const feed = (kind: string, text: string) => {
      if (!E.vosk || !text) return;
      E.lastEv = Date.now();
      const toks = voskTokens(text);
      L(`vosk ${kind} +${Date.now() - E.voskT0}ms: "${text}"`);
      if (kind === 'partial') E.voskPart = toks;
      else { E.voskFin = [...E.voskFin, ...toks]; E.voskPart = []; }
      const all = [...E.voskFin, ...E.voskPart];
      setHeard(all.slice(-8).join(' '));
      onTranscript(all, E.voskFin.length);
    };
    const subs = [
      V.onPartialResult((t: string) => feed('partial', t)),
      V.onResult((t: string) => feed('final', t)),
      V.onError((e: any) => {
        L('vosk error: ' + errText(e) + (typeof e === 'object' && e ? ' raw=' + JSON.stringify(e) : ''));
        logAudio('at the error');
        if (E.want && E.vosk) {
          E.vosk = false; E.running = false;
          setTimeout(() => { if (E.want && !E.running) startRec(); }, 500);
        }
      }),
    ];
    return () => subs.forEach((s) => s?.remove?.());
  }, []);

  // Continuous recognizer events
  useEffect(() => {
    if (!LiveTranscriber.isAvailable()) return;
    const a = LiveTranscriber.onResult((e) => {
      if (E.classic) return;
      E.lastEv = Date.now();
      const toks = tokens(e.text || '');
      const fin = tokens(e.finalizedText || '').length;
      setHeard(toks.slice(-8).join(' '));
      L(`heard[${toks.length}, settled ${fin}]: ${toks.slice(-6).join(' ')}`);
      onTranscript(toks, fin);
    });
    const b = LiveTranscriber.onState((e) => L('mic state: ' + e.state));
    const c = LiveTranscriber.onError((e) => {
      L('continuous mic error: ' + e.message);
      if (E.want && !E.classic) {
        E.running = false;
        setTimeout(() => { if (E.want && !E.running) startRec(); }, 500);
      }
    });
    return () => { a.remove(); b.remove(); c.remove(); };
  }, []);

  // Classic recognizer events (fallback)
  useSpeechRecognitionEvent('start', () => { E.lastEv = Date.now(); L('mic: listening (classic)'); setMsg(''); });
  useSpeechRecognitionEvent('result', (e) => {
    E.lastEv = Date.now();
    const toks = tokens(e.results[0]?.transcript || '');
    setHeard(toks.slice(-8).join(' '));
    L(`heard[${toks.length}${e.isFinal ? ',final' : ''}]: ${toks.slice(-6).join(' ')}`);
    onTranscript(toks, e.isFinal ? toks.length : 0);
  });
  useSpeechRecognitionEvent('error', (e) => {
    L('mic error: ' + e.error + ' ' + (e.message || ''));
    if (e.error === 'not-allowed') {
      E.want = false;
      setMsg('Microphone or speech recognition is not allowed. Turn them on in iPhone Settings → Read Along.');
    } else if (e.error === 'network') setMsg('No internet connection. Speech recognition needs it.');
  });
  useSpeechRecognitionEvent('end', () => {
    if (!E.classic) return;
    E.running = false;
    L('mic: ended' + (E.want ? ' -> restart' : ''));
    keepRecordingSession();
    if (E.want) setTimeout(() => { if (E.want && !E.running) startClassic(); }, 150);
    bump();
  });
  // Safety net for the classic recognizer: restart if no words come for 10 s while reading.
  useEffect(() => {
    const t = setInterval(() => {
      if (E.classic && E.want && E.running && !E.freeze && !E.finished && Date.now() - E.lastEv > 10000) {
        L('watchdog: no words for 10s -> restart mic');
        E.lastEv = Date.now();
        try { ExpoSpeechRecognitionModule.abort(); } catch {}
      }
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // ---------- buttons ----------
  const begin = async () => {
    if (E.finished || E.want || loading || !E.sents.length) return;
    // Vosk needs only the microphone; Apple speech recognition permission is asked for the Apple recognizers only.
    const vosk = S.current.engine === 'vosk';
    const perm = vosk
      ? await ExpoSpeechRecognitionModule.requestMicrophonePermissionsAsync()
      : await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setMsg('Microphone or speech recognition is not allowed. Turn them on in iPhone Settings → Read Along.');
      L('permission denied');
      return;
    }
    E.started = true; E.want = true;
    if (E.vidSeg !== E.sent) showSeg(E.sent);
    startRec();
    bump();
  };
  const togglePause = () => {
    if (E.want) {
      stopMic();
      E.target = player.currentTime;
      L('microphone paused');
    } else {
      E.want = true;
      startRec();
      goWord();
      L('microphone resumed');
    }
    bump();
  };
  const reset = (from = 0, errs = 0) => {
    stopMic();
    Object.assign(E, { sent: from, pos: 0, errs, errRow: 0, started: false, finished: false, freeze: false, rs: null, warns: {} });
    setShowEnd(false);
    setHeard('');
    L('start over from sentence ' + (from + 1));
    showSeg(from);
    bump();
  };
  const skip = () => {
    const s = E.sent;
    L(`sentence ${s + 1} skipped`);
    E.errRow = 0; E.pos = 0; E.rs = null;
    if (E.vidSeg !== s) showSeg(s);
    E.target = segDur(s);
    E.sent++;
    save();
    if (E.sent >= E.sents.length) finish();
    bump();
  };

  // ---------- teleprompter scroll ----------
  const scroll = useRef<any>(null);
  const ys = useRef<number[]>([]);
  const [areaH, setAreaH] = useState(0);
  useEffect(() => { pushContext(); }, [E.sent]);
  useEffect(() => {
    if (settings.view !== 'scroll') { scroll.current?.scrollTo({ y: 0, animated: false }); return; }
    const y = ys.current[E.sent];
    if (y != null) scroll.current?.scrollTo({ y: Math.max(0, y - areaH * 0.3), animated: true });
  }, [E.sent, settings.view, areaH, sentences.length]);

  const n = sentences.length;
  const W = stage.w, H = stage.h;
  const diag = Math.sqrt(W * W + H * H);
  const ang = (Math.atan2(H, W) * 180) / Math.PI;
  const big = E.errRow >= 3;

  return (
    <SafeAreaView style={st.safe} edges={['top', 'bottom']}>
      <View style={st.stage} onLayout={(e) => setStage({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="cover" nativeControls={false} allowsPictureInPicture={false} />
        {cross && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {[ang, -ang].map((a) => (
              <View key={a} style={[st.bar, { width: diag * 0.92, height: H * 0.11, left: (W - diag * 0.92) / 2, top: H * 0.445, transform: [{ rotate: a + 'deg' }] }]} />
            ))}
          </View>
        )}
        {E.started && !E.want && !E.finished && (
          <View style={st.micoff} pointerEvents="none"><Text style={st.micoffT}>Microphone is off</Text></View>
        )}
        {loading && <Loader done={loading.done} total={loading.total} error={loading.error} onRetry={retry} />}
        {showEnd && (
          <View style={st.end}>
            <Text style={st.endT}>The End</Text>
            <Text style={st.endS}>Mistakes: {E.errs}</Text>
            <Btn label="Read Again" primary onPress={() => { save(true); reset(0); }} />
          </View>
        )}
      </View>

      <View style={st.textArea} onLayout={(e) => setAreaH(e.nativeEvent.layout.height)}>
        <ScrollView ref={scroll} contentContainerStyle={{ padding: 18, paddingBottom: areaH * 0.6 }} scrollEnabled={settings.view === 'scroll'}>
          {sentences.map((s, i) => {
            if (settings.view === 'one' && i !== E.sent) return null;
            const done = i < E.sent || E.finished;
            const active = i === E.sent && !E.finished;
            return (
              <Text
                key={s.id + i}
                onLayout={(e) => (ys.current[i] = e.nativeEvent.layout.y)}
                style={[st.sent, active && big && st.sentBig, settings.view === 'scroll' && !active && st.sentOther, done && settings.fade && settings.view === 'scroll' && st.sentDone]}
              >
                {s.display.map((w, k) => {
                  const ok = done || (active && k < E.pos);
                  const next = active && k === E.pos && E.started;
                  const warn = ok && !!E.warns[i]?.includes(k);
                  const bad = active && !!E.rs && E.rs.sent === i && E.rs.bad === k && k >= E.pos;
                  return (
                    <Text key={k} style={[ok && st.ok, warn && st.warn, bad && st.bad, next && st.next]}>
                      {w}{k < s.display.length - 1 ? ' ' : ''}
                    </Text>
                  );
                })}
              </Text>
            );
          })}
        </ScrollView>
        {settings.debug && (
          <View style={st.dbg} pointerEvents="none">
            <Text style={st.dbgT}>{logRef.current.slice(-9).join('\n')}</Text>
          </View>
        )}
      </View>

      {!!heard && settings.debug && <Text style={st.heard} numberOfLines={1}>Heard: {heard}</Text>}
      <View style={st.prog}>
        <Text style={st.progT}>{Math.min(E.sent + 1, n || 1)} of {n}</Text>
        <View style={st.pb}><View style={[st.pbI, { width: `${n ? (100 * (E.finished ? n : E.sent)) / n : 0}%` }]} /></View>
      </View>
      {!!msg && <Text style={st.msg}>{msg}</Text>}

      <View style={st.ctr}>
        {big && !E.finished && <Btn label="Skip Sentence" warn onPress={skip} style={{ width: '100%' }} />}
        <View style={st.row}>
          <Btn label={E.want ? 'Listening…' : 'Start'} primary live={E.want} disabled={!!loading || !sentences.length} onPress={begin} style={{ flex: 1 }} />
          <Btn label={E.started && !E.want ? 'Resume Microphone' : 'Pause Microphone'} disabled={!E.started || E.finished} onPress={togglePause} style={{ flex: 1 }} />
        </View>
        <View style={st.row}>
          <Btn label="Start Over" onPress={() => { save(true); reset(0); }} style={{ flex: 1 }} />
          <Btn label="Choose a Story" onPress={() => { stopMic(); onBack(); }} style={{ flex: 1 }} />
          <Btn label="Settings" onPress={() => setShowSettings(true)} />
        </View>
      </View>

      <SettingsSheet
        visible={showSettings}
        settings={settings}
        onChange={setSettings}
        onClose={() => setShowSettings(false)}
        onShareLog={() => Share.share({ message: logRef.current.join('\n') }).catch(() => {})}
      />
      <Modal transparent visible={!!ask} animationType="fade">
        <View style={st.askBg}>
          <View style={st.askBox}>
            <Text style={st.askT}>Continue from sentence {(ask?.sent ?? 0) + 1} or start over?</Text>
            <View style={st.row}>
              <Btn label="Continue" primary style={{ flex: 1 }} onPress={() => { const a = ask!; setAsk(null); reset(a.sent, a.errs || 0); }} />
              <Btn label="Start Over" style={{ flex: 1 }} onPress={() => { setAsk(null); save(true); reset(0); }} />
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  stage: { width: '100%', aspectRatio: 16 / 9, backgroundColor: C.paper, overflow: 'hidden' },
  bar: { position: 'absolute', backgroundColor: C.red, borderRadius: 999 },
  micoff: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(30,28,24,0.55)', alignItems: 'center', justifyContent: 'center' },
  micoffT: { color: '#fff', fontSize: 20, fontWeight: '700' },
  end: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(246,240,226,0.93)', alignItems: 'center', justifyContent: 'center', gap: 8 },
  endT: { fontSize: 48, fontWeight: '700', color: C.ink },
  endS: { fontSize: 16, color: C.ink, marginBottom: 6 },
  textArea: { flex: 1 },
  sent: { fontSize: 32, lineHeight: 44, color: C.ink, marginBottom: 14 },
  sentBig: { fontSize: 42, lineHeight: 54 },
  sentOther: { color: C.soft },
  sentDone: { opacity: 0.35 },
  ok: { color: C.read },
  warn: { backgroundColor: '#FFE066', color: C.ink },
  bad: { color: '#D32F2F', textDecorationLine: 'underline', textDecorationColor: '#D32F2F' },
  next: { backgroundColor: C.cur },
  dbg: { position: 'absolute', left: 8, right: 8, bottom: 4, padding: 6, backgroundColor: 'rgba(255,255,255,0.92)', borderRadius: 8, borderWidth: 1, borderColor: C.line },
  dbgT: { fontSize: 10, lineHeight: 13, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), color: '#333' },
  heard: { fontSize: 12, color: C.soft, paddingHorizontal: 18 },
  prog: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 6 },
  progT: { fontSize: 14, color: C.soft },
  pb: { flex: 1, height: 6, backgroundColor: C.bar, borderRadius: 3, overflow: 'hidden' },
  pbI: { height: '100%', backgroundColor: C.read },
  msg: { color: C.red, fontSize: 14, paddingHorizontal: 18, paddingTop: 4 },
  ctr: { padding: 12, gap: 8 },
  row: { flexDirection: 'row', gap: 8 },
  askBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  askBox: { backgroundColor: C.bg, borderRadius: 18, padding: 18, width: '100%', maxWidth: 420, gap: 14 },
  askT: { fontSize: 20, fontWeight: '700', color: C.ink },
});
