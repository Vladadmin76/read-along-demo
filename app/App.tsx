import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Library from './src/Library';
import type { Story } from './src/library';
import Reader from './src/Reader';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, Settings } from './src/Settings';

export default function App() {
  const [story, setStory] = useState<Story | null>(null);
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(() => {
    loadSettings().then(setSettingsState);
  }, []);
  const setSettings = (s: Settings) => {
    setSettingsState(s);
    saveSettings(s);
  };
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {story ? (
        <Reader key={story.id} story={story} settings={settings} setSettings={setSettings} onBack={() => setStory(null)} />
      ) : (
        <Library onOpen={setStory} />
      )}
    </SafeAreaProvider>
  );
}
