import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { addFromUrl, addFromZipBytes, cleanupOld, fileIfPresent, loadLibrary, readManifest, refreshCatalog, removeStory, Story } from './library';
import { Btn, C } from './ui';

export default function Library({ onOpen }: { onOpen: (s: Story) => void }) {
  const [list, setList] = useState<Story[]>([]);
  const [covers, setCovers] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  const log = (m: string) => console.log(m);

  const loadCovers = async (l: Story[]) => {
    const c: Record<string, string | null> = {};
    for (const s of l) {
      try {
        const m = await readManifest(s);
        c[s.id] = m.cover ? fileIfPresent(s, m.cover) || (s.remoteBase ? s.remoteBase + m.cover : null) : null;
      } catch {
        c[s.id] = null;
      }
    }
    setCovers(c);
  };

  useEffect(() => {
    (async () => {
      const local = await loadLibrary();
      setList(local);
      loadCovers(local);
      setBusy('Checking for new stories…');
      await cleanupOld(log).catch(() => {});
      const l = await refreshCatalog(log);
      setList(l);
      loadCovers(l);
      setBusy('');
    })();
  }, []);

  const after = async (s: Story) => {
    const l = await loadLibrary();
    setList(l);
    loadCovers(l);
    setAdding(false);
    setUrl('');
    Alert.alert('Story added', s.title);
  };
  const pickZip = async () => {
    setErr('');
    const r = await DocumentPicker.getDocumentAsync({ type: ['application/zip', 'application/x-zip-compressed', '*/*'], copyToCacheDirectory: true });
    if (r.canceled || !r.assets?.[0]) return;
    setBusy('Unpacking the story…');
    try {
      const bytes = await new File(r.assets[0].uri).bytes();
      await after(await addFromZipBytes(bytes, log));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  const addUrl = async () => {
    setErr('');
    setBusy('Downloading the story…');
    try {
      await after(await addFromUrl(url, log));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  const confirmRemove = (s: Story) =>
    Alert.alert('Delete story?', s.title, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => setList(await removeStory(s.id)) },
    ]);

  return (
    <SafeAreaView style={st.safe}>
      <Text style={st.h}>Choose a Story</Text>
      {!!busy && (
        <View style={st.busy}>
          <ActivityIndicator />
          <Text style={st.busyT}>{busy}</Text>
        </View>
      )}
      <FlatList
        data={list}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListEmptyComponent={<Text style={st.empty}>{busy ? '' : 'No stories yet. Tap “Add Story”.'}</Text>}
        renderItem={({ item }) => (
          <Pressable style={st.card} onPress={() => onOpen(item)} onLongPress={() => confirmRemove(item)}>
            {covers[item.id] ? <Image source={{ uri: covers[item.id]! }} style={st.cover} /> : <View style={[st.cover, { backgroundColor: C.paper }]} />}
            <View style={{ flex: 1 }}>
              <Text style={st.title}>{item.title}</Text>
              <Text style={st.sub}>{item.level}</Text>
            </View>
            <Text style={st.read}>Read</Text>
          </Pressable>
        )}
      />
      <Text style={st.hint}>Long press a story to delete it.</Text>
      <View style={{ padding: 16 }}>
        <Btn label="Add Story" primary onPress={() => { setErr(''); setAdding(true); }} />
      </View>

      <Modal visible={adding} transparent animationType="slide" onRequestClose={() => setAdding(false)}>
        <View style={st.mbg}>
          <View style={st.panel}>
            <Text style={st.h2}>Add Story</Text>
            <Btn label="Choose a ZIP file" onPress={pickZip} />
            <Text style={st.or}>or paste a link to a ZIP file or a story folder</Text>
            <TextInput
              value={url}
              onChangeText={setUrl}
              placeholder="https://…"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={st.input}
            />
            <Btn label="Add from link" disabled={!url.trim()} onPress={addUrl} />
            {!!busy && <Text style={st.busyT}>{busy}</Text>}
            {!!err && <Text style={st.err}>{err}</Text>}
            <Btn label="Close" onPress={() => setAdding(false)} style={{ marginTop: 12 }} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  h: { fontSize: 30, fontWeight: '700', color: C.ink, paddingHorizontal: 16, paddingTop: 12 },
  h2: { fontSize: 22, fontWeight: '700', color: C.ink, marginBottom: 12 },
  busy: { flexDirection: 'row', gap: 8, alignItems: 'center', paddingHorizontal: 16, paddingTop: 8 },
  busyT: { color: C.soft, fontSize: 14, marginTop: 6 },
  empty: { color: C.soft, fontSize: 16, textAlign: 'center', marginTop: 40 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderWidth: 2, borderColor: C.ink, borderRadius: 14, backgroundColor: '#fff' },
  cover: { width: 96, height: 54, borderRadius: 8 },
  title: { fontSize: 18, fontWeight: '700', color: C.ink },
  sub: { fontSize: 14, color: C.soft, marginTop: 2 },
  read: { fontSize: 16, fontWeight: '700', color: C.read },
  hint: { textAlign: 'center', color: C.soft, fontSize: 13 },
  mbg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  panel: { backgroundColor: C.bg, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, paddingBottom: 34, gap: 8 },
  or: { color: C.soft, fontSize: 14, marginTop: 8 },
  input: { borderWidth: 2, borderColor: C.line, borderRadius: 12, padding: 12, fontSize: 16, backgroundColor: '#fff', color: C.ink },
  err: { color: C.red, fontSize: 14, marginTop: 6 },
});
