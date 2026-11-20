import AsyncStorage from '@react-native-async-storage/async-storage';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Strictness } from './match';
import { Btn, C } from './ui';

export type Settings = {
  strict: Strictness;
  view: 'one' | 'scroll';
  fade: boolean;
  debug: boolean;
  bam: boolean;
  engine: 'live' | 'dictation' | 'classic';
};
export const DEFAULT_SETTINGS: Settings = { strict: 'normal', view: 'one', fade: true, debug: true, bam: true, engine: 'live' };
const KEY = 'settings_v1';

export async function loadSettings(): Promise<Settings> {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse((await AsyncStorage.getItem(KEY)) || '{}') };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
export function saveSettings(s: Settings) {
  AsyncStorage.setItem(KEY, JSON.stringify(s)).catch(() => {});
}

function Seg<T extends string | boolean>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <View style={st.seg}>
      {options.map(([v, label]) => (
        <Pressable key={String(v)} onPress={() => onChange(v)} style={[st.segB, value === v && st.segSel]}>
          <Text style={[st.segT, value === v && { color: '#fff' }]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

type Props = { visible: boolean; settings: Settings; onChange: (s: Settings) => void; onClose: () => void; onShareLog: () => void };
export function SettingsSheet({ visible, settings, onChange, onClose, onShareLog }: Props) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={st.bg}>
        <View style={st.panel}>
          <ScrollView>
            <Text style={st.h}>Settings</Text>
            <Text style={st.l}>Strictness</Text>
            <Seg value={settings.strict} onChange={(v) => set('strict', v)} options={[['easy', 'Easy'], ['normal', 'Normal'], ['strict', 'Strict']]} />
            <Text style={st.note}>Easy forgives small words (a, the, and…) that the phone did not catch. Easy and Normal also forgive one word per sentence that the phone garbled into a similar sound, or lost if it is a small word or the first word.</Text>
            <Text style={st.l}>Text view</Text>
            <Seg value={settings.view} onChange={(v) => set('view', v)} options={[['one', 'One sentence'], ['scroll', 'Whole story, scrolling']]} />
            <Text style={st.l}>Read text (scrolling view)</Text>
            <Seg value={settings.fade} onChange={(v) => set('fade', v)} options={[[true, 'Fade'], [false, 'Keep']]} />
            <Text style={st.l}>Error sound “bam”</Text>
            <Seg value={settings.bam} onChange={(v) => set('bam', v)} options={[[true, 'On'], [false, 'Off']]} />
            <Text style={st.l}>Speech recognizer</Text>
            <Seg value={settings.engine} onChange={(v) => set('engine', v)} options={[['live', 'New'], ['dictation', 'New + hints'], ['classic', 'Old']]} />
            <Text style={st.note}>New: listens all the time without stops (iOS 26+). New + hints: the same, and the phone is told the words of the sentence you read. Old: restarts after every pause.</Text>
            <Text style={st.l}>Debug log</Text>
            <Seg value={settings.debug} onChange={(v) => set('debug', v)} options={[[true, 'On'], [false, 'Off']]} />
            <Btn label="Share log" onPress={onShareLog} style={{ marginTop: 8 }} />
            <Text style={st.note}>Sends the log as text. Choose Copy or a messenger, then paste it to Claude.</Text>
            <Btn label="Done" primary onPress={onClose} style={{ marginTop: 16 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  bg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  panel: { backgroundColor: C.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 34, maxHeight: '85%' },
  h: { fontSize: 22, fontWeight: '700', color: C.ink, marginBottom: 8 },
  l: { fontSize: 16, fontWeight: '700', color: C.ink, marginTop: 14, marginBottom: 6 },
  note: { fontSize: 13, color: C.soft, marginTop: 4 },
  seg: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  segB: { flexGrow: 1, minHeight: 44, borderWidth: 2, borderColor: C.ink, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, backgroundColor: '#fff' },
  segSel: { backgroundColor: C.ink },
  segT: { fontSize: 15, fontWeight: '700', color: C.ink },
});
