// Continuous speech transcription with Apple's SpeechAnalyzer (iOS 26+).
// The microphone stays on for the whole session; no restarts between phrases.
import { requireOptionalNativeModule } from 'expo';

export type LiveResult = { text: string; finalizedText: string; isFinal: boolean };
type Native = {
  isAvailable(): boolean;
  start(locale: string, engine: string): Promise<void>;
  setContext(words: string[]): Promise<void>;
  stop(): Promise<void>;
  addListener(event: string, cb: (e: any) => void): { remove(): void };
};

const mod = requireOptionalNativeModule<Native>('LiveTranscriber');

export const LiveTranscriber = {
  isAvailable: () => {
    try {
      return !!mod && mod.isAvailable();
    } catch {
      return false;
    }
  },
  // engine: 'speech' (SpeechTranscriber) or 'dictation' (DictationTranscriber, accepts word hints)
  start: (locale = 'en-US', engine: 'speech' | 'dictation' = 'speech') => mod!.start(locale, engine),
  setContext: (words: string[]) => (mod ? mod.setContext(words).catch(() => {}) : Promise.resolve()),
  stop: () => (mod ? mod.stop() : Promise.resolve()),
  onResult: (cb: (e: LiveResult) => void) => mod!.addListener('onResult', cb),
  onState: (cb: (e: { state: string }) => void) => mod!.addListener('onState', cb),
  onError: (cb: (e: { message: string }) => void) => mod!.addListener('onError', cb),
};
