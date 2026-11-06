/**
 * Internet Archive FLAC source for BitChord.
 * Searches Archive items and returns only tracks matching the requested song.
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../flac.js';
import { httpJson, httpGet, TtlCache, settleAll, NotFound } from '../http.js';

const BASE = 'https://archive.org';
const QUERY = 'mediatype:(audio) AND format:(Flac)';

const ITEM_LIMIT = 20;
const EXPAND_LIMIT = 10;
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

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\.flac$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/[()[\]{}.,!?'"“”‘’]/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10) / 10;
}

function titleFromFilename(name) {
  let title = String(name ?? '')
    .replace(/\.flac$/i, '')
    .replace(/_/g, ' ')
    .replace(LEADING_TRACK_NUMBER, '')
    .trim();

  return title || String(name ?? '').replace(/\.flac$/i, '');
}

/**
 * Extract artist information from filenames such as:
 * Tum Hi Ho - Arijit Singh, Mithoon.flac
 */
function splitTrackName(filename) {
  const full = titleFromFilename(filename);
  const parts = full.split(/\s+-\s+/);

  if (parts.length >= 2) {
    return {
      title: parts[0].trim(),
      artist: parts.slice(1).join(' - ').trim(),
      fullTitle: full,
    };
  }

  return {
    title: full,
    artist: '',
    fullTitle: full,
  };
}

/**
 * Require every meaningful search word to appear in the track filename.
 * Album names are deliberately excluded so unrelated album tracks
 * cannot appear just because their album matched the search.
 */
function matchesTrack(filename, query) {
  const track = splitTrackName(filename);
  const searchable = normalize(track.fullTitle);
  const words = normalize(query)
    .split(/\s+/)
    .filter(word => word.length > 1);

  if (!words.length) return false;

  return words.every(word => searchable.includes(word));
}

/**
 * Rank exact title matches above remix/extended versions.
 */
function scoreTrack(filename, query) {
  const track = splitTrackName(filename);
  const title = normalize(track.title);
  const artist = normalize(track.artist);
  const queryText = normalize(query);

  const words = queryText.split(/\s+/).filter(Boolean);
  const titleWords = title.split(/\s+/).filter(Boolean);

  let score = 0;

  if (title === queryText) score += 100;
  if (title.startsWith(queryText)) score += 50;

  for (const word of words) {
    if (title.includes(word)) score += 10;
    else if (artist.includes(word)) score += 5;
  }

  // Prefer shorter, cleaner title matches over longer remix filenames.
  score -= Math.max(0, titleWords.length - words.length);

  if (/\b(remix|rework|karaoke|cover|instrumental|slowed|sped up)\b/i.test(title)) {
    score -= 15;
  }

  return score;
}

function rowId(identifier, filename) {
  return `archive:${identifier}:${Buffer.from(filename, 'utf8').toString('base64url')}`;
}

export function parseArchiveId(id) {
  const raw = String(id ?? '');
  const rest = raw.startsWith('archive:') ? raw.slice(8) : raw;
  const cut = rest.indexOf(':');

  if (cut < 1) return null;

  const identifier = rest.slice(0, cut);
  const encoded = rest.slice(cut + 1);

  try {
    return {
      identifier,
      filename: Buffer.from(encoded, 'base64url').toString('utf8'),
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

    return searchCache.wrap(
      `archive:${text.toLowerCase()}:${fanout}`,
      SEARCH_TTL_MS,
      async () => {
        const budget = AbortSignal.timeout(SEARCH_BUDGET_MS);
        const scoped = signal
          ? AbortSignal.any([budget, signal])
          : budget;

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
          {
            timeoutMs: 10000,
            signal: scoped,
          },
        );

        const docs = Array.isArray(payload?.response?.docs)
          ? payload.response.docs
          : [];

        const items = docs.slice(0, EXPAND_LIMIT);

        const expanded = await settleAll(
          items.map(doc => async () => ({
            rows: await this.expand(doc, scoped),
          })),
          items.length,
        );

        const rows = [];

        for (const entry of expanded) {
          if (!entry.ok) continue;

          for (const row of entry.value.rows) {
            if (matchesTrack(row._nativeId, text)) {
              row._matchScore = scoreTrack(row._nativeId, text);
              rows.push(row);
            }
          }
        }

        // Best title/artist matches first.
        rows.sort((a, b) => b._matchScore - a._matchScore);

        return rows.slice(0, fanout).map(row => {
          delete row._matchScore;
          return row;
        });
      },
    );
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
          {
            timeoutMs: ITEM_TIMEOUT_MS,
            retries: 0,
            signal,
          },
        );

        return payload ?? {};
      },
    );

    const files = Array.isArray(metadata?.files)
      ? metadata.files
      : [];

    if (!files.length) return [];

    const meta = metadata?.metadata ?? {};
    const album = String(doc?.title ?? meta.title ?? '').trim();

    const rawCreator = doc?.creator ?? meta.creator;
    const albumArtist = Array.isArray(rawCreator)
      ? rawCreator.join(', ')
      : String(rawCreator ?? '');

    const flacs = files.filter(file => {
      const name = String(file?.name ?? '');

      if (!/\.flac$/i.test(name)) return false;
      if (/^(__|spectrogram)/i.test(name)) return false;

      const length = seconds(file.length);

      return length !== null &&
        length >= MIN_SECONDS &&
        length <= MAX_SECONDS;
    });

    const artwork = files.some(
      file => /^__ia_thumb\.jpg$/i.test(file.name ?? ''),
    )
      ? `${BASE}/download/${encodeURIComponent(identifier)}/__ia_thumb.jpg`
      : undefined;

    return flacs.map(file => {
      const name = String(file.name);
      const parsed = splitTrackName(name);

      if (!parsed.title) return null;

      return {
        id: rowId(identifier, name),
        title: parsed.title,
        artist: parsed.artist || albumArtist,
        album,
        duration: seconds(file.length),
        artworkURL: artwork,
        format: 'flac',
        audioQuality: 'LOSSLESS',
        _source: this.id,
        _nativeId: name,
        _identifier: identifier,
      };
    }).filter(Boolean);
  },

  mediaUrl(identifier, filename) {
    const dir = encodeURIComponent(String(identifier));
    const file = String(filename)
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    return `${BASE}/download/${dir}/${file}`;
  },

  async resolve(nativeId, tier, context = {}, signal) {
    const identifier = context.identifier;

    if (!identifier) {
      throw new NotFound('archive row carries no item identifier');
    }

    const filename = String(nativeId ?? '');

    if (!filename) {
      throw new NotFound('no filename');
    }

    const url = this.mediaUrl(identifier, filename);
    const probe = await this.probe(
      url,
      `${identifier}/${filename}`,
      signal,
    );

    return {
      url,
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      sampleRate: probe?.sampleRate ?? null,
      bitDepth: probe?.bitDepth ?? null,
      bitrate: probe
        ? flacKbps(probe.byteLength, probe.durationSec)
        : null,
      channels: probe?.channels ?? null,
      probed: Boolean(probe),
      error: probe
        ? undefined
        : 'served, but the FLAC header could not be read',
    };
  },

  async probe(url, cacheKey, signal) {
    return probeCache.wrap(
      `probe:${cacheKey}`,
      Number.MAX_SAFE_INTEGER,
      async () => {
        let response;

        try {
          response = await httpGet(url, {
            timeoutMs: 12000,
            retries: 1,
            range: `bytes=0-${STREAMINFO_BYTES - 1}`,
            signal,
          });
        } catch {
          return null;
        }

        const head = Buffer.from(await response.arrayBuffer());
        const info = parseFlacStreamInfo(head);

        if (!info) return null;

        const contentRange =
          response.headers.get('content-range') ?? '';

        const slash = contentRange.lastIndexOf('/');
        const total = slash >= 0
          ? Number(contentRange.slice(slash + 1))
          : NaN;

        return {
          ...info,
          byteLength: Number.isFinite(total) && total > 0
            ? total
            : null,
        };
      },
    );
  },

  async health() {
    try {
      const payload = await httpJson(
        `${BASE}/advancedsearch.php?q=${encodeURIComponent(QUERY)}&rows=1&output=json`,
        {
          timeoutMs: 8000,
          retries: 0,
        },
      );

      const count = Number(payload?.response?.numFound ?? 0);

      return {
        ok: true,
        detail: `${count.toLocaleString('en-US')} FLAC items indexed`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error.message,
      };
    }
  },
};
