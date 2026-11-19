// Continuous speech transcription with Apple's SpeechAnalyzer (iOS 26+).
// The microphone stays on for the whole session; no restarts between phrases.
import { requireOptionalNativeModule } from 'expo';

export type LiveResult = { text: string; finalizedText: string; isFinal: boolean };
type Native = {
  isAvailable(): boolean;
  start(locale: string): Promise<void>;
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
  start: (locale = 'en-US') => mod!.start(locale),
  stop: () => (mod ? mod.stop() : Promise.resolve()),
  onResult: (cb: (e: LiveResult) => void) => mod!.addListener('onResult', cb),
  onState: (cb: (e: { state: string }) => void) => mod!.addListener('onState', cb),
  onError: (cb: (e: { message: string }) => void) => mod!.addListener('onError', cb),
};
