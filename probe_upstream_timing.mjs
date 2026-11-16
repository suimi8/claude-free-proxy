// probe_upstream_timing.mjs —— 直接打 claude.ai 上游，逐条记录 SSE 到达时间
//
// 目的：判定「输出速度慢」到底是
//   A) 上游把 SSE 连接吊着不关（内容早就发完，连接还挂着）  -> 反代侧已修（message_stop 即收尾）
//   B) 上游每 15 秒才 flush 一批内容                        -> 只能靠降思考档位
// 看法：
//   - 若「最后一个数据块」远早于「连接关闭」-> A
//   - 若数据块一路滴到最后一刻、间隔约 15s -> B
//
// 用法：node probe_upstream_timing.mjs        （默认 effort=max）
//      PROBE_EFFORT=off node probe_upstream_timing.mjs
import fs from 'node:fs';

const ACC = JSON.parse(fs.readFileSync(new URL('./accounts.json', import.meta.url), 'utf8'));
const accounts = ACC.accounts.filter(a => a.enabled && a.sessionKey && a.org);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const PROMPT = process.env.PROBE_PROMPT ||
  '写一篇 400 字左右的短文，主题是「深夜的地铁末班车」，要有具体场景细节。';
const EFFORT = process.env.PROBE_EFFORT || 'max';

function headers(a) {
  return {
    'cookie': a.cookie || `sessionKey=${a.sessionKey}`,
    'user-agent': a.ua || UA,
    'accept': 'application/json, text/event-stream',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'origin': a.base || 'https://claude.ai',
    'referer': (a.base || 'https://claude.ai') + '/',
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (const a of accounts) {
  const base = a.base || 'https://claude.ai';
  const t0 = Date.now();
  const at = () => ((Date.now() - t0) / 1000).toFixed(2);
  let conv;
  try {
    const cr = await fetch(`${base}/api/organizations/${a.org}/chat_conversations`, {
      method: 'POST', headers: headers(a),
      body: JSON.stringify({ uuid: crypto.randomUUID(), name: 'probe', is_temporary: true }),
    });
    if (!cr.ok) { console.log(`[${a.label}] 建会话 ${cr.status}，换下一个`); continue; }
    conv = (await cr.json()).uuid;
  } catch (e) { console.log(`[${a.label}] 建会话异常 ${e.message}`); continue; }

  console.log(`\n=== 账号 ${a.label} (effort=${EFFORT}) ===`);
  const body = {
    prompt: PROMPT, model: 'claude-sonnet-5-5', parent_message_uuid: crypto.randomUUID(),
    timezone: 'Asia/Shanghai', attachments: [], files: [], rendering_mode: 'messages',
  };
  if (EFFORT !== 'none') body.effort = EFFORT;

  let res;
  try {
    res = await fetch(`${base}/api/organizations/${a.org}/chat_conversations/${conv}/completion`, {
      method: 'POST', headers: headers(a), body: JSON.stringify(body),
    });
  } catch (e) { console.log(`  completion 异常 ${e.message}`); continue; }
  if (!res.ok) {
    console.log(`  HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
    continue;
  }

  const dec = new TextDecoder();
  const reader = res.body.getReader();
  let buf = '', text = '', summary = '', lastDataAt = null, n = 0;
  const timeline = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const p of parts) {
      const dm = p.match(/^data: (.+)$/m);
      if (!dm) continue;
      let ev; try { ev = JSON.parse(dm[1]); } catch { continue; }
      n++;
      const t = Number(at());
      const gap = lastDataAt == null ? 0 : t - lastDataAt;
      lastDataAt = t;
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        const s = d.text || d.summary?.summary || d.thinking || '';
        if (d.type === 'text_delta') text += d.text; else summary += s;
        timeline.push(`${t}s  ${d.type}  +${s.length}字  (距上条 ${gap.toFixed(2)}s)`);
      } else {
        timeline.push(`${t}s  ${ev.type}  (距上条 ${gap.toFixed(2)}s)`);
      }
    }
  }
  const closedAt = Number(at());
  console.log(`  连接在 ${closedAt}s 关闭；最后一个数据块在 ${lastDataAt}s -> 收尾空闲 ${(closedAt - lastDataAt).toFixed(2)}s`);
  console.log(`  事件数=${n}  可见文本=${text.length}字  思考摘要=${summary.length}字`);
  const gaps = timeline.map(x => { const g = /距上条 ([\d.]+)s/.exec(x); return g ? Number(g[1]) : 0; });
  const big = gaps.filter(g => g > 5).sort((a, b) => b - a).slice(0, 10);
  console.log(`  >5s 的空档: ${big.length ? big.join(', ') + ' 秒' : '无'}`);
  console.log(`  前 6 个: ${timeline.slice(0, 6).join(' | ')}`);
  console.log(`  后 6 个: ${timeline.slice(-6).join(' | ')}`);
  console.log(`\n  判定：${(closedAt - lastDataAt) > 5 ? 'A) 上游吊着连接（反代侧已修 message_stop 即收尾）' : 'B) 数据一路滴到结束（更可能是上游 flush 节拍，只能降思考档位）'}`);
  break;   // 找到一个能用的账号就够了
}
