// Story library: catalog from the internet + stories added by the user (ZIP file or link).
// Files of every story are kept on the phone, so reading works without re-downloading.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import JSZip from 'jszip';
import { norm } from './match';

export const CATALOG_URL = 'https://vladadmin76.github.io/read-along-demo/stories.json';

export type WordMark = { w: string; t: number };
export type Segment = {
  id: string;
  order: number;
  text_en: string;
  trigger_words?: string[];
  words?: WordMark[];
  video: string;
};
export type Manifest = {
  id: string;
  title_en: string;
  level?: string;
  cover?: string;
  success_audio?: string;
  segments: Segment[];
  generic_error?: { audio?: string };
};
export type Story = {
  id: string;
  title: string;
  level: string;
  remoteBase?: string; // where files can be downloaded from (folder URL ending with /)
  localOnly?: boolean; // added from a ZIP file
};

const LIB_KEY = 'library_v1';
const root = () => {
  const d = new Directory(Paths.document, 'stories');
  if (!d.exists) d.create({ intermediates: true });
  return d;
};
export const storyDir = (id: string) => {
  const d = new Directory(root(), safe(id));
  if (!d.exists) d.create({ intermediates: true });
  return d;
};
const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

function localFile(id: string, rel: string): File {
  const parts = rel.split('/').filter(Boolean);
  let dir = storyDir(id);
  for (const p of parts.slice(0, -1)) {
    const next = new Directory(dir, safe(p));
    if (!next.exists) next.create({ intermediates: true });
    dir = next;
  }
  return new File(dir, safe(parts[parts.length - 1]));
}
function writeFile(f: File, content: string | Uint8Array) {
  if (!f.exists) f.create({ intermediates: true });
  f.write(content);
}

export async function loadLibrary(): Promise<Story[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(LIB_KEY)) || '[]');
  } catch {
    return [];
  }
}
async function saveLibrary(list: Story[]) {
  await AsyncStorage.setItem(LIB_KEY, JSON.stringify(list));
}
async function upsert(s: Story) {
  const list = await loadLibrary();
  const i = list.findIndex((x) => x.id === s.id);
  if (i >= 0) list[i] = { ...list[i], ...s };
  else list.push(s);
  await saveLibrary(list);
  return list;
}
export async function removeStory(id: string) {
  const list = (await loadLibrary()).filter((s) => s.id !== id);
  await saveLibrary(list);
  try {
    storyDir(id).delete();
  } catch {}
  return list;
}

export function validateManifest(m: any): Manifest {
  if (!m || typeof m !== 'object') throw new Error('manifest.json could not be read');
  if (!m.id) throw new Error('manifest.json has no "id"');
  if (!Array.isArray(m.segments) || !m.segments.length) throw new Error('manifest.json has no segments');
  for (const s of m.segments) {
    if (!s.text_en) throw new Error(`Segment ${s.id || '?'} has no text_en`);
    if (!s.video) throw new Error(`Segment ${s.id || '?'} has no video`);
  }
  m.segments.sort((a: Segment, b: Segment) => (a.order ?? 0) - (b.order ?? 0));
  return m as Manifest;
}

async function fetchJson(url: string) {
  const r = await fetch(url, { cache: 'no-store' } as any);
  if (!r.ok) throw new Error(`Could not download ${url} (${r.status})`);
  return r.json();
}

// Catalog: { "stories": [ { "base": "https://.../story-001-.../" } ] }
export async function refreshCatalog(log: (m: string) => void): Promise<Story[]> {
  let list = await loadLibrary();
  try {
    const cat = await fetchJson(CATALOG_URL + '?t=' + Date.now());
    for (const entry of cat.stories || []) {
      const base = String(entry.base).replace(/\/?$/, '/');
      try {
        const m = validateManifest(await fetchJson(base + 'manifest.json?t=' + Date.now()));
        writeFile(localFile(m.id, 'manifest.json'), JSON.stringify(m));
        list = await upsert({ id: m.id, title: m.title_en, level: m.level || '', remoteBase: base });
        if (m.cover) ensureFile(list.find((s) => s.id === m.id)!, m.cover).catch(() => {});
      } catch (e: any) {
        log('catalog story failed: ' + e.message);
      }
    }
  } catch (e: any) {
    log('catalog not available: ' + e.message);
  }
  return list;
}

export async function readManifest(story: Story): Promise<Manifest> {
  const f = localFile(story.id, 'manifest.json');
  if (f.exists) return validateManifest(JSON.parse(await f.text()));
  if (!story.remoteBase) throw new Error('manifest.json is missing for this story');
  const m = validateManifest(await fetchJson(story.remoteBase + 'manifest.json'));
  writeFile(f, JSON.stringify(m));
  return m;
}

const inflight = new Map<string, Promise<string>>();
// Returns a local file:// uri, downloading it first if needed.
export function ensureFile(story: Story, rel: string): Promise<string> {
  const key = story.id + '|' + rel;
  const f = localFile(story.id, rel);
  if (f.exists && f.size > 0) return Promise.resolve(f.uri);
  if (inflight.has(key)) return inflight.get(key)!;
  if (!story.remoteBase) return Promise.reject(new Error('Missing file: ' + rel));
  const p = (async () => {
    const tmp = new File(Paths.cache, safe(story.id + '_' + rel) + '.part');
    try { if (tmp.exists) tmp.delete(); } catch {}
    const got = await File.downloadFileAsync(story.remoteBase + rel, tmp, { idempotent: true });
    try { if (f.exists) f.delete(); } catch {}
    await got.move(f);
    return f.uri;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export const fileIfPresent = (story: Story, rel: string) => {
  const f = localFile(story.id, rel);
  return f.exists && f.size > 0 ? f.uri : null;
};

// ---------- Add Story ----------
export async function addFromZipBytes(bytes: Uint8Array, log: (m: string) => void): Promise<Story> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  const manName = names
    .filter((n) => /(^|\/)manifest\.json$/i.test(n) && !n.startsWith('__MACOSX'))
    .sort((a, b) => a.length - b.length)[0];
  if (!manName) throw new Error('No manifest.json inside the ZIP file');
  const prefix = manName.slice(0, manName.length - 'manifest.json'.length);
  const m = validateManifest(JSON.parse(await zip.file(manName)!.async('string')));
  try { storyDir(m.id).delete(); } catch {}
  let n = 0;
  for (const name of names) {
    const e = zip.files[name];
    if (e.dir || !name.startsWith(prefix) || name.includes('__MACOSX')) continue;
    const rel = name.slice(prefix.length);
    writeFile(localFile(m.id, rel), await e.async('uint8array'));
    n++;
  }
  log(`ZIP unpacked: ${n} files`);
  const missing = m.segments.map((s) => s.video).filter((v) => !fileIfPresent({ id: m.id, title: '', level: '' }, v));
  if (missing.length) throw new Error('Missing files in the package: ' + missing.join(', '));
  await upsert({ id: m.id, title: m.title_en, level: m.level || '', localOnly: true });
  return { id: m.id, title: m.title_en, level: m.level || '', localOnly: true };
}

export async function addFromUrl(url: string, log: (m: string) => void): Promise<Story> {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('The link must start with https://');
  if (/\.zip(\?|$)/i.test(url)) {
    const tmp = new File(Paths.cache, 'download.zip');
    try { if (tmp.exists) tmp.delete(); } catch {}
    log('downloading ZIP…');
    const f = await File.downloadFileAsync(url, tmp, { idempotent: true });
    return addFromZipBytes(await f.bytes(), log);
  }
  const base = url.replace(/manifest\.json$/i, '').replace(/\/?$/, '/');
  const m = validateManifest(await fetchJson(base + 'manifest.json'));
  writeFile(localFile(m.id, 'manifest.json'), JSON.stringify(m));
  const s: Story = { id: m.id, title: m.title_en, level: m.level || '', remoteBase: base };
  await upsert(s);
  return s;
}

// Prepared sentence data used by the reader.
export type Sentence = {
  id: string;
  display: string[];
  words: string[];
  marks: number[];
  triggers: string[];
  video: string;
};
export function toSentences(m: Manifest): Sentence[] {
  return m.segments.map((s) => {
    const display = s.text_en.split(/\s+/).filter(Boolean);
    const marks =
      s.words && s.words.length === display.length ? s.words.map((x) => +x.t) : display.map((_, k) => +(k * 0.55).toFixed(2));
    return { id: s.id, display, words: display.map(norm), marks, triggers: (s.trigger_words || []).map(norm), video: s.video };
  });
}

// ---------- whole-story download & 3-day cleanup ----------
const OPENED_KEY = 'opened_v1';
export const KEEP_DAYS = 3;

// Files the reader needs (cover is kept separately for the library list).
export function mediaFiles(m: Manifest): string[] {
  const set = new Set<string>();
  for (const s of m.segments) set.add(s.video);
  if (m.generic_error?.audio) set.add(m.generic_error.audio);
  if (m.success_audio) set.add(m.success_audio);
  return [...set];
}
export function isDownloaded(story: Story, m: Manifest) {
  return mediaFiles(m).every((rel) => !!fileIfPresent(story, rel));
}
export async function downloadAll(story: Story, m: Manifest, onProgress: (done: number, total: number) => void) {
  const files = mediaFiles(m);
  let done = files.filter((rel) => !!fileIfPresent(story, rel)).length;
  onProgress(done, files.length);
  for (const rel of files) {
    if (fileIfPresent(story, rel)) continue;
    await ensureFile(story, rel);
    done++;
    onProgress(done, files.length);
  }
}
async function openedMap(): Promise<Record<string, number>> {
  try {
    return JSON.parse((await AsyncStorage.getItem(OPENED_KEY)) || '{}');
  } catch {
    return {};
  }
}
export async function touchOpened(id: string) {
  const map = await openedMap();
  map[id] = Date.now();
  await AsyncStorage.setItem(OPENED_KEY, JSON.stringify(map)).catch(() => {});
}
// Deletes cartoon files of stories not opened for KEEP_DAYS days.
// Only stories that can be downloaded again (remoteBase) are cleaned; ZIP-added stories are kept.
export async function cleanupOld(log: (m: string) => void) {
  const map = await openedMap();
  const now = Date.now();
  let changed = false;
  for (const s of await loadLibrary()) {
    if (!s.remoteBase) continue;
    let m: Manifest;
    try {
      m = await readManifest(s);
    } catch {
      continue;
    }
    const files = mediaFiles(m);
    if (!files.some((rel) => !!fileIfPresent(s, rel))) continue;
    if (!map[s.id]) { map[s.id] = now; changed = true; continue; }
    if (now - map[s.id] < KEEP_DAYS * 24 * 3600 * 1000) continue;
    for (const rel of files) {
      try { localFile(s.id, rel).delete(); } catch {}
    }
    log(`cleanup: removed cartoon files of ${s.id}`);
  }
  if (changed) await AsyncStorage.setItem(OPENED_KEY, JSON.stringify(map)).catch(() => {});
}
