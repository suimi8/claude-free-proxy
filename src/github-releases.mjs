import { readFileSync } from 'node:fs';

export const PROJECT = 'suimi8/claude-free-proxy';
export const REPO_URL = `https://github.com/${PROJECT}`;
export const AUTHOR_URL = 'https://github.com/suimi8';
export const RELEASE_API = `https://api.github.com/repos/${PROJECT}/releases/latest`;
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const MANUAL_INTERVAL = 60 * 1000;

export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:\.(0|[1-9]\d{0,8}))?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

export function versionAfter(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

export function displayVersion(version) {
  const parts = parseVersion(version);
  if (!parts) throw new Error('Invalid application version');
  if (version === '0.4.0' || version === '0.4' || version === 'v0.4.0' || version === 'v0.4') return 'v0.4';
  return 'v' + parts.join('.');
}

async function readMetadata(response) {
  const limit = 256 * 1024;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('版本信息超过大小限制');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createReleaseChecker({ fetchImpl = fetch, now = Date.now, version = VERSION } = {}) {
  const current = displayVersion(version);
  let asset = null;
  let latest = null, etag = '', checkedAt = null, nextCheck = 0, manualAfter = 0;
  let error = '', pending = null, timer = null, started = false, stopped = false;
  const lifecycle = new AbortController();

  function snapshot() {
    return {
      version, current, latest: latest?.tag || null,
      available: Boolean(latest && versionAfter(latest.tag, version)),
      verifiedAsset: Boolean(asset),
      url: latest ? `${REPO_URL}/releases/tag/${latest.tag}` : `${REPO_URL}/releases`,
      notes: latest?.notes || '', checkedAt, nextCheck: nextCheck || null, error,
    };
  }

  async function request() {
    let retryIn = FIVE_MINUTES;
    try {
      const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `claude-free-proxy/${version}` };
      if (etag) headers['If-None-Match'] = etag;
      const response = await fetchImpl(RELEASE_API, {
        headers, credentials: 'omit', redirect: 'error',
        signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(8000)]),
      });
      if (response.status === 200) {
        const release = await readMetadata(response);
        if (release.draft !== false || release.prerelease !== false || !parseVersion(release.tag_name)) {
          throw new Error('GitHub 返回了无法识别的正式版本');
        }
        latest = { tag: release.tag_name, notes: typeof release.body === 'string' ? release.body.slice(0, 4096) : '' };
        const name = 'gateway-' + latest.tag + '.update.json.gz';
        const url = REPO_URL + '/releases/download/' + latest.tag + '/' + name;
        const item = Array.isArray(release.assets) && release.assets.find(a => a?.name === name && a.browser_download_url === url);
        asset = item && /^sha256:[a-f0-9]{64}$/.test(item.digest) && Number.isSafeInteger(item.size)
          && item.size > 0 && item.size <= 8 * 1024 * 1024 ? { url, tag: latest.tag, size: item.size, digest: item.digest.slice(7) } : null;
        etag = response.headers.get('etag') || '';
      } else {
        await response.body?.cancel();
        if (response.status === 404) {
          latest = null;
          asset = null;
          etag = '';
        } else if (response.status !== 304 || !etag || !latest) {
          const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
          if (rateLimited) {
            const seconds = Number(response.headers.get('retry-after')) * 1000;
            const untilReset = Number(response.headers.get('x-ratelimit-reset')) * 1000 - now();
            retryIn = Math.max(FIVE_MINUTES, Math.min(24 * 3600_000, Math.max(seconds || 0, untilReset || 0)));
            manualAfter = now() + retryIn;
          }
          throw new Error(`GitHub 返回 HTTP ${response.status}`);
        }
      }
      error = '';
      nextCheck = now() + SIX_HOURS;
    } catch (err) {
      error = /^(GitHub 返回|版本信息超过)/.test(err?.message) ? err.message : '暂时无法读取 GitHub 版本信息';
      nextCheck = now() + retryIn;
    }
    checkedAt = now();
    return snapshot();
  }

  function check(force = false) {
    if (pending) return pending;
    if (stopped || now() < (force ? manualAfter : nextCheck)) return Promise.resolve(snapshot());
    manualAfter = now() + MANUAL_INTERVAL;
    pending = request().finally(() => { pending = null; });
    return pending;
  }

  function start(initialDelay = 1500) {
    if (started || stopped) return;
    started = true;
    const tick = async () => {
      await check();
      if (!stopped) timer = setTimeout(tick, Math.max(1000, nextCheck - now())).unref();
    };
    timer = setTimeout(tick, initialDelay).unref();
  }
  function close() {
    stopped = true;
    clearTimeout(timer);
    lifecycle.abort();
  }
  return { snapshot, check, start, close, asset: () => error || !asset ? null : { ...asset } };
}
