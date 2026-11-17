import assert from 'node:assert/strict';
import http from 'node:http';

// We will test against the proxy server directly or spawn an instance to verify endpoints.
// Let's create an isolated test for the search function and response structure.
import { fetch as undiciFetch } from 'undici';

console.log('=== 测试 DuckDuckGo 搜索与 DeepSeek Search API 响应兼容性 ===');

// 1. 测试 searchDuckDuckGo 逻辑返回格式
async function testSearchFormat() {
  const query = 'Node.js 官方文档';
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await undiciFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });

  assert.equal(res.status, 200, 'DuckDuckGo HTTP 应为 200');
  const html = await res.text();
  assert.ok(html.length > 1000, 'HTML 响应长度应大于 1000');

  const parts = html.split(/class="[^"]*result\s+results_links[^"]*"/i);
  assert.ok(parts.length > 1, '应解析出多个结果块');

  const results = [];
  for (let i = 1; i < parts.length && results.length < 5; i++) {
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

      const title = titleMatch[2].replace(/<[^>]+>/g, '').trim();
      const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';

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

  assert.ok(results.length > 0, '搜索结果数量应大于 0');
  for (const item of results) {
    assert.equal(typeof item.url, 'string', 'item.url 必须是 string');
    assert.ok(item.url.startsWith('http'), 'item.url 必须是 http 链接');
    assert.equal(typeof item.title, 'string', 'item.title 必须是 string');
    assert.equal(typeof item.snippet, 'string', 'item.snippet 必须是 string');
    assert.equal(typeof item.summary, 'string', 'item.summary 必须是 string');
    assert.equal(item.date, null, 'item.date 必须符合 nullable 规则');
  }

  console.log(`✓ 成功检索并验证 ${results.length} 条 DuckDuckGo 搜索结果格式`);
}

testSearchFormat()
  .then(() => {
    console.log('所有 DuckDuckGo 搜索格式测试通过！');
    process.exit(0);
  })
  .catch(err => {
    console.error('测试失败:', err);
    process.exit(1);
  });
