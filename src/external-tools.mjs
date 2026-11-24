/**
 * external-tools.mjs —— 外挂工具模块（网页搜索、网页内容抓取、HTML实体解码）
 *
 * 彻底解除外挂搜索与核心网关的寄生耦合，提供标准化的外部工具调用接口。
 * 具备高性能 LRU + TTL 缓存与并发请求去重，防范上游防爬频控。
 */
import { fetchPublicBytes } from './public-http.mjs';

// 搜索缓存与网页抓取缓存
const SEARCH_CACHE_TTL = 10 * 60 * 1000; // 10 分钟
const FETCH_CACHE_TTL = 5 * 60 * 1000;   // 5 分钟
const MAX_SEARCH_CACHE = 200;
const MAX_FETCH_CACHE = 100;

export const SEARCH_CACHE = new Map(); // key -> { results, expiresAt }
export const FETCH_CACHE = new Map();  // key -> { content, expiresAt }
const IN_FLIGHT_SEARCHES = new Map();  // key -> Promise

/**
 * 清除外挂工具所有缓存（测试或维护用）
 */
export function clearExternalToolsCache() {
  SEARCH_CACHE.clear();
  FETCH_CACHE.clear();
  IN_FLIGHT_SEARCHES.clear();
}

/**
 * 获取外挂工具缓存运行状态
 */
export function getExternalToolsCacheStats() {
  const now = Date.now();
  let searchActive = 0;
  for (const item of SEARCH_CACHE.values()) {
    if (item.expiresAt > now) searchActive++;
  }
  let fetchActive = 0;
  for (const item of FETCH_CACHE.values()) {
    if (item.expiresAt > now) fetchActive++;
  }
  return {
    searchEntries: SEARCH_CACHE.size,
    searchActive,
    fetchEntries: FETCH_CACHE.size,
    fetchActive,
    inFlightSearches: IN_FLIGHT_SEARCHES.size,
  };
}

/**
 * HTML 实体解码工具
 * @param {string} str
 * @returns {string}
 */
export function decodeHtmlEntities(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCharCode(n) : _;
    });
}

/**
 * 底层执行一次 DuckDuckGo 页面解析
 * @param {string} cleanQuery
 * @param {number} maxCount
 * @param {AbortSignal} [signal]
 */
async function doFetchDuckDuckGo(cleanQuery, maxCount, signal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
  const { bytes } = await fetchPublicBytes(url, { signal, accept: 'text/html' });
  const html = bytes.toString('utf8');
  const results = [];
  const parts = html.split(/class="[^"]*result\s+results_links[^"]*"/i);

  for (let i = 1; i < parts.length && results.length < maxCount; i++) {
    const chunk = parts[i];
    const titleMatch = chunk.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const snippetMatch = chunk.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);

    if (titleMatch) {
      let rawUrl = titleMatch[1];
      if (rawUrl.includes('uddg=')) {
        try {
          const u = new URL(rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl);
          const decoded = u.searchParams.get('uddg');
          if (decoded) rawUrl = decoded;
        } catch {}
      }

      const title = decodeHtmlEntities(titleMatch[2].replace(/<[^>]+>/g, '').trim());
      const snippet = snippetMatch ? decodeHtmlEntities(snippetMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

      if (rawUrl && title) {
        results.push({
          url: rawUrl,
          title,
          snippet: snippet || title,
          summary: snippet || title,
          date: null,
        });
      }
    }
  }

  return results;
}

/**
 * 免费 DuckDuckGo 网页搜索
 * 兼容 DeepSeek Search API 的数据格式返回
 * 内置 LRU+TTL 缓存与并发合并
 * @param {string} query
 * @param {number} [count=10]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Array<{url: string, title: string, snippet: string, summary: string, date: null}>>}
 */
export async function searchDuckDuckGo(query, count = 10, signal) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return [];
  }
  const cleanQuery = query.trim();
  const maxCount = Math.max(1, Math.min(Number.isFinite(count) ? Math.floor(count) : 10, 50));
  const cacheKey = `${cleanQuery.toLowerCase()}:${maxCount}`;

  // 1. 尝试读取缓存
  const cached = SEARCH_CACHE.get(cacheKey);
  if (cached) {
    if (Date.now() < cached.expiresAt) {
      return cached.results;
    }
    SEARCH_CACHE.delete(cacheKey);
  }

  // 2. 并发合并（In-flight deduplication）
  if (IN_FLIGHT_SEARCHES.has(cacheKey)) {
    return IN_FLIGHT_SEARCHES.get(cacheKey);
  }

  const execute = (async () => {
    try {
      let results = await doFetchDuckDuckGo(cleanQuery, maxCount, signal);

      // 若未搜出结果且原词包含复杂标点，尝试清洗后重试一次
      if ((!results || !results.length) && /["'+\\-]/i.test(cleanQuery)) {
        const simplified = cleanQuery.replace(/["'+\\-]/g, ' ').replace(/\s+/g, ' ').trim();
        if (simplified && simplified !== cleanQuery) {
          try {
            results = await doFetchDuckDuckGo(simplified, maxCount, signal);
          } catch {}
        }
      }

      // 写入缓存
      if (Array.isArray(results)) {
        SEARCH_CACHE.set(cacheKey, {
          results,
          expiresAt: Date.now() + SEARCH_CACHE_TTL,
        });
        while (SEARCH_CACHE.size > MAX_SEARCH_CACHE) {
          SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value);
        }
      }
      return results;
    } finally {
      IN_FLIGHT_SEARCHES.delete(cacheKey);
    }
  })();

  IN_FLIGHT_SEARCHES.set(cacheKey, execute);
  return execute;
}

/**
 * 免费网页抓取（内置 5 分钟 TTL 缓存）
 * @param {string} targetUrl
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function fetchWebContent(targetUrl, signal) {
  if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
    const err = new Error('url is required');
    err.status = 400;
    throw err;
  }
  const cleanUrl = targetUrl.trim();

  // 缓存命中检查
  const cached = FETCH_CACHE.get(cleanUrl);
  if (cached) {
    if (Date.now() < cached.expiresAt) {
      return cached.content;
    }
    FETCH_CACHE.delete(cleanUrl);
  }

  const { bytes } = await fetchPublicBytes(cleanUrl, { signal, accept: 'text/html,text/plain' });
  const html = bytes.toString('utf8');
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const content = text.slice(0, 50000);

  FETCH_CACHE.set(cleanUrl, {
    content,
    expiresAt: Date.now() + FETCH_CACHE_TTL,
  });
  while (FETCH_CACHE.size > MAX_FETCH_CACHE) {
    FETCH_CACHE.delete(FETCH_CACHE.keys().next().value);
  }

  return content;
}
