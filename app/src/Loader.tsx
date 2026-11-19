// Download screen: a bar with the running boy and girl (loader-running.mp4, looped)
// moving from left to right as the cartoon files arrive.
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Btn, C } from './ui';

const RUNNER = require('../assets/loader-running.mp4');

type Props = { done: number; total: number; error?: string; onRetry?: () => void };

export default function Loader({ done, total, error, onRetry }: Props) {
  const [w, setW] = useState(0);
  const player = useVideoPlayer(RUNNER, (p) => {
    p.muted = true;
    p.loop = true;
    p.audioMixingMode = 'mixWithOthers';
    p.play();
  });
  const frac = total ? Math.min(1, done / total) : 0;
  const size = 96;
  const left = Math.max(0, (w - size) * frac);
  return (
    <View style={st.wrap}>
      <Text style={st.t}>{error ? 'Download stopped' : 'Loading the cartoon…'}</Text>
      <View style={st.track} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
        <View style={[st.runner, { left, width: size, height: size }]}>
          <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} allowsPictureInPicture={false} />
        </View>
        <View style={st.bar}>
          <View style={[st.fill, { width: `${frac * 100}%` }]} />
        </View>
      </View>
      <Text style={st.s}>
        {done} of {total} files
      </Text>
      {!!error && (
        <>
          <Text style={st.err}>{error}</Text>
          {onRetry && <Btn label="Try Again" primary onPress={onRetry} />}
        </>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#fff', justifyContent: 'center', paddingHorizontal: 20, gap: 6 },
  t: { fontSize: 18, fontWeight: '700', color: C.ink, textAlign: 'center' },
  track: { height: 112, justifyContent: 'flex-end' },
  runner: { position: 'absolute', bottom: 10 },
  bar: { height: 8, borderRadius: 4, backgroundColor: C.bar, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: C.read },
  s: { fontSize: 14, color: C.soft, textAlign: 'center' },
  err: { fontSize: 14, color: C.red, textAlign: 'center', marginBottom: 6 },
});
