
import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../flac.js';
import { httpJson, httpGet, TtlCache, settleAll, NotFound } from '../http.js';

const BASE = 'https://archive.org';
const QUERY = 'mediatype:(audio) AND format:(Flac)';

const ITEM_LIMIT = 50;
const EXPAND_LIMIT = 20;
const SEARCH_BUDGET_MS = 12000;
const ITEM_TIMEOUT_MS = 8000;
const MIN_SECONDS = 20;
const MAX_SECONDS = 45 * 60;

const probeCache = new TtlCache(4000);
const searchCache = new TtlCache(2000);
const itemCache = new TtlCache(4000);
const SEARCH_TTL_MS = 5 * 60 * 1000;
const ITEM_TTL_MS = 30 * 60 * 1000;

const LEADING_TRACK_NUMBER = /^\s*\d{1,3}\s*[-._)\]]*\s+/;

function titleFromFilename(name) {
  return String(name ?? '')
    .replace(/\.flac$/i, '')
    .replace(/_/g, ' ')
    .replace(LEADING_TRACK_NUMBER, '')
    .trim();
}

function seconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : null;
}

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreMatch(query, title, artist, album) {
  const q = normalize(query);
  const t = normalize(title);
  const a = normalize(artist);
  const b = normalize(album);

  if (!q || !t) return 0;
  if (t === q) return 100;
  if (t.includes(q)) return 85;
  if (q.includes(t) && t.length > 3) return 75;

  const words = q.split(/\s+/).filter(Boolean);
  const haystack = `${t} ${a} ${b}`;
  const matched = words.filter(word => haystack.includes(word)).length;
  return Math.round((matched / Math.max(words.length, 1)) * 65);
}

function rowId(identifier, filename) {
  return `archive:${identifier}:${Buffer.from(filename, 'utf8').toString('base64url')}`;
}

export function parseArchiveId(id) {
  const raw = String(id ?? '');
  const rest = raw.startsWith('archive:') ? raw.slice(8) : raw;
  const cut = rest.indexOf(':');
  if (cut < 1) return null;
  try {
    return {
      identifier: rest.slice(0, cut),
      filename: Buffer.from(rest.slice(cut + 1), 'base64url').toString('utf8'),
    };
  } catch {
    return null;
  }
}

export const archive = {
  id: 'archive',
  label: 'Internet Archive',
  lossless: true,
  baseUrl: BASE,

  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    const fanout = Math.min(Math.max(Number(limit) || 20, 1), 40);
    const cacheKey = `archive:${normalize(text)}:${fanout}`;

    return searchCache.wrap(cacheKey, SEARCH_TTL_MS, async () => {
      const budget = AbortSignal.timeout(SEARCH_BUDGET_MS);
      const scoped = signal ? AbortSignal.any([budget, signal]) : budget;

      const params = new URLSearchParams({
        q: `${QUERY} AND (${text})`,
        rows: String(ITEM_LIMIT),
        page: '1',
        output: 'json',
        'sort[]': 'downloads desc',
      });

      for (const field of ['identifier', 'title', 'creator']) {
        params.append('fl[]', field);
      }

      const payload = await httpJson(
        `${BASE}/advancedsearch.php?${params}`,
        { timeoutMs: SEARCH_BUDGET_MS, signal: scoped }
      );

      const docs = Array.isArray(payload?.response?.docs)
        ? payload.response.docs
        : [];

      const items = docs.slice(0, EXPAND_LIMIT);

      const expanded = await settleAll(
        items.map(doc => async () => ({
          doc,
          rows: await this.expand(doc, scoped),
        })),
        items.length
      );

      const rows = [];
      for (const entry of expanded) {
        if (entry.ok) rows.push(...entry.value.rows);
      }

      const ranked = rows
        .map(row => ({
          row,
          score: scoreMatch(text, row.title, row.artist, row.album),
        }))
        .filter(item => item.score >= 25)
        .sort((a, b) => b.score - a.score);

      const seen = new Set();
      return ranked
        .filter(item => {
          if (seen.has(item.row.id)) return false;
          seen.add(item.row.id);
          return true;
        })
        .slice(0, fanout)
        .map(item => item.row);
    });
  },

  async expand(doc, signal) {
    const identifier = String(doc?.identifier ?? '');
    if (!identifier) return [];

    const metadata = await itemCache.wrap(
      `item:${identifier}`,
      ITEM_TTL_MS,
      async () => {
        const payload = await httpJson(
          `${BASE}/metadata/${encodeURIComponent(identifier)}`,
          { timeoutMs: ITEM_TIMEOUT_MS, retries: 0, signal }
        );
        return payload ?? {};
      }
    );

    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    if (!files.length) return [];

    const meta = metadata.metadata ?? {};
    const album = String(doc.title ?? meta.title ?? '').trim();
    const rawCreator = doc.creator ?? meta.creator;
    const artist = Array.isArray(rawCreator)
      ? rawCreator.join(', ')
      : String(rawCreator ?? '');

    const artwork = files.some(f => /^__ia_thumb\.jpg$/i.test(f.name ?? ''))
      ? `${BASE}/download/${encodeURIComponent(identifier)}/__ia_thumb.jpg`
      : undefined;

    return files
      .filter(file => {
        const name = String(file?.name ?? '');
        const length = seconds(file.length);
        return /\.flac$/i.test(name) &&
          !/^(__|spectrogram)/i.test(name) &&
          length !== null &&
          length >= MIN_SECONDS &&
          length <= MAX_SECONDS;
      })
      .map(file => {
        const name = String(file.name);
        const title = titleFromFilename(name);
        if (!title) return null;

        return {
          id: rowId(identifier, name),
          title,
          artist: artist.trim(),
          album,
          duration: seconds(file.length),
          artworkURL: artwork,
          format: 'flac',
          audioQuality: 'LOSSLESS',
          _source: this.id,
          _nativeId: name,
          _identifier: identifier,
        };
      })
      .filter(Boolean);
  },

  mediaUrl(identifier, filename) {
    const dir = encodeURIComponent(String(identifier));
    const file = String(filename).split('/').map(encodeURIComponent).join('/');
    return `${BASE}/download/${dir}/${file}`;
  },

  async resolve(nativeId, tier, context = {}, signal) {
    const identifier = context.identifier;
    if (!identifier) throw new NotFound('missing archive identifier');

    const filename = String(nativeId ?? '');
    if (!filename) throw new NotFound('missing filename');

    const url = this.mediaUrl(identifier, filename);
    const probe = await this.probe(url, `${identifier}/${filename}`, signal);

    return {
      url,
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      sampleRate: probe?.sampleRate ?? null,
      bitDepth: probe?.bitDepth ?? null,
      bitrate: probe ? flacKbps(probe.byteLength, probe.durationSec) : null,
      channels: probe?.channels ?? null,
      probed: Boolean(probe),
    };
  },

  async probe(url, cacheKey, signal) {
    return probeCache.wrap(`probe:${cacheKey}`, Number.MAX_SAFE_INTEGER, async () => {
      try {
        const response = await httpGet(url, {
          timeoutMs: 12000,
          retries: 1,
          range: `bytes=0-${STREAMINFO_BYTES - 1}`,
          signal,
        });

        const head = Buffer.from(await response.arrayBuffer());
        const info = parseFlacStreamInfo(head);
        if (!info) return null;

        const contentRange = response.headers.get('content-range') ?? '';
        const slash = contentRange.lastIndexOf('/');
        const total = slash >= 0 ? Number(contentRange.slice(slash + 1)) : NaN;

        return {
          ...info,
          byteLength: Number.isFinite(total) && total > 0 ? total : null,
        };
      } catch {
        return null;
      }
    });
  },

  async health() {
    try {
      const payload = await httpJson(
        `${BASE}/advancedsearch.php?q=${encodeURIComponent(QUERY)}&rows=1&output=json`,
        { timeoutMs: 8000, retries: 0 }
      );

      const count = Number(payload?.response?.numFound ?? 0);
      return {
        ok: true,
        detail: `${count.toLocaleString('en-US')} FLAC items indexed`,
      };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
      
