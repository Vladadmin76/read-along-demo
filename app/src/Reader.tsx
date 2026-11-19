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
import { align, findMistake, norm, readPrefix } from './match';
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
    toks: [] as string[], base: 0, finalCount: 0, changedAt: 0, settled: true, lastEv: 0,
    classic: false, liveFailed: false,
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
  const mistake = () => {
    E.errs++; E.errRow++; E.pos = 0; E.freeze = true;
    E.base = E.toks.length;
    showSeg(E.sent);
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

  // The whole heard phrase is aligned to the sentence (see match.ts).
  // Words light up as soon as they match; a cross only comes from settled text.
  const evaluate = (settledAll: boolean) => {
    if (E.freeze || E.finished || !E.started) { E.base = E.toks.length; return; }
    for (let guard = 0; guard < 50 && !E.finished; guard++) {
      const s = E.sents[E.sent];
      const hyp = E.toks.slice(E.base);
      if (!hyp.length) return;
      const a = align(s.words, hyp, S.current.strict);
      const pr = readPrefix(s.words, a, S.current.strict);
      if (pr.pos > E.pos) {
        L(`S${E.sent + 1}: ${pr.pos}/${s.words.length} read ("${hyp.slice(0, pr.hypAfter).join(' ')}")`);
        if (accept(pr.pos)) { E.base += pr.hypAfter; continue; } // leftover words belong to the next sentence
      }
      const settledN = settledAll ? hyp.length : Math.max(0, E.finalCount - E.base);
      if (settledN > 0) {
        const sa = settledN >= hyp.length ? a : align(s.words, hyp.slice(0, settledN), S.current.strict);
        const mk = findMistake(s.words, sa, S.current.strict);
        if (mk) {
          L(`S${E.sent + 1}w${mk.at + 1} "${s.words[mk.at]}" ERROR ${mk.why} (heard "${hyp.slice(0, settledN).join(' ')}")`);
          mistake();
        }
      }
      return;
    }
  };
  const onTranscript = (toks: string[], finalCount: number) => {
    if (toks.length < E.base) E.base = toks.length;
    if (toks.join(' ') !== E.toks.join(' ')) { E.changedAt = Date.now(); E.settled = false; }
    E.toks = toks;
    E.finalCount = finalCount;
    evaluate(false);
  };
  // Text that has not changed for 1.5 s counts as settled (for mistakes).
  useEffect(() => {
    const t = setInterval(() => {
      if (E.want && !E.settled && E.toks.length > E.base && Date.now() - E.changedAt > 1500) {
        E.settled = true;
        evaluate(true);
      }
    }, 250);
    return () => clearInterval(t);
  }, []);

  // ---------- speech ----------
  const tokens = (text: string) => text.split(/\s+/).map(norm).filter(Boolean);
  const useLive = () => S.current.engine === 'live' && !E.liveFailed && LiveTranscriber.isAvailable();
  const startRec = async () => {
    E.toks = []; E.base = 0; E.finalCount = 0; E.lastEv = Date.now(); E.changedAt = Date.now(); E.settled = true;
    if (useLive()) {
      L('mic: starting (continuous SpeechAnalyzer)');
      try {
        await LiveTranscriber.start('en-US');
        E.running = true;
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
    E.toks = []; E.base = 0; E.finalCount = 0; E.lastEv = Date.now();
    const words = Array.from(new Set(E.sents.flatMap((s) => s.display.map((w) => w.replace(/[^A-Za-z']/g, ''))))).filter(Boolean).slice(0, 100);
    L('mic: starting (classic)');
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
  const stopMic = () => {
    E.want = false;
    if (E.classic) {
      try { ExpoSpeechRecognitionModule.abort(); } catch {}
      E.classic = false;
    } else if (E.running) {
      LiveTranscriber.stop().catch(() => {});
    }
    E.running = false;
    bump();
  };

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
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
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
    Object.assign(E, { sent: from, pos: 0, errs, errRow: 0, started: false, finished: false, freeze: false });
    setShowEnd(false);
    setHeard('');
    L('start over from sentence ' + (from + 1));
    showSeg(from);
    bump();
  };
  const skip = () => {
    const s = E.sent;
    L(`sentence ${s + 1} skipped`);
    E.errRow = 0; E.pos = 0;
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
                  return (
                    <Text key={k} style={[ok && st.ok, next && st.next]}>
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
