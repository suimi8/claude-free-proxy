// hCaptcha canvas 挑战本地求解器（0 积分）：数数题 v4（动态网格 + 双极坐标）+ 拖拽题。
// 由 VM 已验证的 probe-drag.mjs 拼接生成（脚本在 tools/make-canvas-solvers.mjs），勿手改算法参数。
// 输入是 canvas 位图（decodePng 的返回 {W,H,data}），坐标全部为位图像素。
import zlib from 'node:zlib';

// ─────────────── 拖拽求解器（drag-match.mjs 已验证算法，位图坐标）───────────────
function decodePng(buf) {
  let pos = 8, W = 0, H = 0, bd = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { W = data.readUInt32BE(0); H = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) throw new Error(`不支持的PNG depth=${bd} color=${ct}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : 3;
  const stride = W * bpp;
  const out = Buffer.alloc(W * H * 4);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const bb = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + bb) & 255;
      else if (f === 3) v = (v + ((a + bb) >> 1)) & 255;
      else if (f === 4) {
        const p = a + bb - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      out[i] = cur[x * bpp]; out[i + 1] = cur[x * bpp + 1]; out[i + 2] = cur[x * bpp + 2]; out[i + 3] = 255;
    }
    prev.set(cur);
  }
  return { W, H, data: out };
}

function solveDrag(img) {
  const { W, H, data } = img;
  const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };

  // 0) 深色「動く」徽章（RGB 全 <95 的横向圆角块）锚定字块位置
  let badge = null;
  {
    const dark = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b2] = px(x, y); if (r < 95 && g < 95 && b2 < 95) dark[y * W + x] = 1; }
    const seen0 = new Uint8Array(W * H);
    const comps = [];
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      if (!dark[y * W + x] || seen0[y * W + x]) continue;
      const st = [[x, y]]; seen0[y * W + x] = 1;
      let x0 = x, y0 = y, x1 = x, y1 = y, n = 0;
      while (st.length) {
        const [cx, cy] = st.pop(); n++;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen0[ny * W + nx] || !dark[ny * W + nx]) continue;
          seen0[ny * W + nx] = 1; st.push([nx, ny]);
        }
      }
      const w2 = x1 - x0, h2 = y1 - y0;
      if (n > 150 && w2 > 80 && w2 < 400 && h2 > 30 && h2 < 150 && w2 / h2 > 1.2) comps.push({ x0, y0, x1, y1, n });
    }
    comps.sort((a, b2) => b2.n - a.n);
    badge = comps[0] || null;
  }
  if (!badge) return { error: '无徽章（非拖拽题？）' };

  // 1) 磨砂字块：light 图 → 9x9 核心图(≥0.7) → 连通域（靠近徽章的最大方形 blob）→ 列/行剖面精修
  let tileBox = null;
  {
    const light = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [r, g, b2] = px(x, y);
      const mn = Math.min(r, g, b2), mx = Math.max(r, g, b2);
      if (mn > 110 && mx - mn < 95) light[y * W + x] = 1;
    }
    const integral = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) integral[(y + 1) * (W + 1) + x + 1] = integral[y * (W + 1) + x + 1] + integral[(y + 1) * (W + 1) + x] - integral[y * (W + 1) + x] + light[y * W + x];
    const boxLight = (x0, y0, x1, y1) => {
      x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0)); x1 = Math.min(W, Math.round(x1)); y1 = Math.min(H, Math.round(y1));
      return (integral[y1 * (W + 1) + x1] - integral[y0 * (W + 1) + x1] - integral[y1 * (W + 1) + x0] + integral[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0) || 1);
    };
    const core = new Uint8Array(W * H);
    for (let y = 5; y < H - 5; y++) for (let x = 5; x < W - 5; x++) if (light[y * W + x] && boxLight(x - 4, y - 4, x + 5, y + 5) >= 0.7) core[y * W + x] = 1;
    const BAND = 70; // 边框白带清零
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < BAND || x >= W - BAND || y < BAND || y >= H - BAND) core[y * W + x] = 0;
    const seen = new Uint8Array(W * H);
    const stack = [];
    const badgeCx = (badge.x0 + badge.x1) / 2, badgeCy = (badge.y0 + badge.y1) / 2;
    const comps = [];
    for (let y = BAND; y < H - BAND; y++) for (let x = BAND; x < W - BAND; x++) {
      const s0 = y * W + x;
      if (!core[s0] || seen[s0]) continue;
      seen[s0] = 1; stack.length = 0; stack.push(s0);
      let n = 0, bx0 = x, by0 = y, bx1 = x, by1 = y;
      while (stack.length) {
        const s = stack.pop(); n++;
        const cy2 = (s / W) | 0, cx2 = s - cy2 * W;
        if (cx2 < bx0) bx0 = cx2; if (cx2 > bx1) bx1 = cx2;
        if (cy2 < by0) by0 = cy2; if (cy2 > by1) by1 = cy2;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx2 + dx, ny = cy2 + dy, ns = ny * W + nx;
          if (core[ns] && !seen[ns]) { seen[ns] = 1; stack.push(ns); }
        }
      }
      comps.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, n, w: bx1 - bx0, h: by1 - by0 });
    }
    for (const c of comps) {
      if (c.n < 12000) continue;
      if (c.w < 140 || c.w > 400 || c.h < 140 || c.h > 400) continue;
      if (c.w / c.h < 0.6 || c.w / c.h > 1.8) continue;
      const ccx = (c.x0 + c.x1) / 2, ccy = (c.y0 + c.y1) / 2;
      if (Math.hypot(ccx - badgeCx, ccy - badgeCy) > 450) continue;
      if (!tileBox || c.n > tileBox.n) tileBox = { ...c };
    }
    if (tileBox) {
      // 剖面精修：40% p95 阈值游程 + 间距<170px 合并（字母洞把字块劈成两段要接回来）
      const colH = new Int32Array(tileBox.w), rowH = new Int32Array(tileBox.h);
      for (let y = tileBox.y0; y <= tileBox.y1; y++) for (let x = tileBox.x0; x <= tileBox.x1; x++) { if (!core[y * W + x]) continue; colH[x - tileBox.x0]++; rowH[y - tileBox.y0]++; }
      const pct95 = (arr) => { const s = [...arr].sort((a, b2) => a - b2); return s[Math.floor(s.length * 0.95)] || 0; };
      const runsMerged = (arr, th, maxGap) => {
        const rs = [];
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] >= th) { if (rs.length && i - rs[rs.length - 1][1] <= maxGap) rs[rs.length - 1][1] = i; else rs.push([i, i]); }
        }
        rs.sort((a, b2) => (b2[1] - b2[0]) - (a[1] - a[0]));
        return rs[0] || null;
      };
      const cr = runsMerged(colH, pct95(colH) * 0.4, 170), rr = runsMerged(rowH, pct95(rowH) * 0.4, 170);
      if (cr && rr) tileBox = { x0: tileBox.x0 + cr[0], y0: tileBox.y0 + rr[0], x1: tileBox.x0 + cr[1], y1: tileBox.y0 + rr[1], n: tileBox.n };
    }
  }
  if (!tileBox) return { error: '未定位磨砂字块' };
  const tcx = (tileBox.x0 + tileBox.x1) / 2, tcy = (tileBox.y0 + tileBox.y1) / 2;

  // 2) 字母掩码（比磨砂底暗 25，排除徽章 ±4px）→ 最大连通域
  const grays = [];
  for (let y = tileBox.y0; y < tileBox.y1; y += 2) for (let x = tileBox.x0; x < tileBox.x1; x += 2) {
    if (x >= badge.x0 - 4 && x <= badge.x1 + 4 && y >= badge.y0 - 4 && y <= badge.y1 + 4) continue;
    const [r, g, b2] = px(x, y);
    grays.push([x, y, (r + g + b2) / 3]);
  }
  grays.sort((a, b2) => a[2] - b2[2]);
  const medGray = grays[grays.length >> 1][2];
  const mask = grays.filter(([, , v]) => v < medGray - 25).map(([x, y]) => [x - tcx, y - tcy]);
  if (mask.length < 200) return { error: '掩码过小' };
  {
    const mset = new Set(mask.map(([x, y]) => `${x},${y}`));
    const seenm = new Set();
    let bc = null;
    for (const [sx, sy] of mask) {
      const key = `${sx},${sy}`;
      if (seenm.has(key)) continue;
      const st = [[sx, sy]]; seenm.add(key);
      const comp = [];
      while (st.length) {
        const [cx, cy] = st.pop(); comp.push([cx, cy]);
        for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [2, -2], [-2, 2], [-2, -2]]) {
          const k2 = `${cx + dx},${cy + dy}`;
          if (mset.has(k2) && !seenm.has(k2)) { seenm.add(k2); st.push([cx + dx, cy + dy]); }
        }
      }
      if (!bc || comp.length > bc.length) bc = comp;
    }
    if (bc && bc.length >= 200) { mask.length = 0; mask.push(...bc); }
  }

  // 3) gx 横向差分边缘图（条纹是横向的，gx 天然免疫；禁用中值滤波——会抹掉字母横向边缘）
  const grayA = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b2] = px(x, y); grayA[y * W + x] = (r + g + b2) / 3; }
  const grad = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) grad[y * W + x] = Math.abs(grayA[y * W + x + 1] - grayA[y * W + x - 1]);
  const edgeMap = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (grad[i] > 25) edgeMap[i] = 1;
  // chamfer 3-4 距离变换
  const INF = 1e9;
  const dt = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) dt[i] = edgeMap[i] ? 0 : INF;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let d = dt[y * W + x];
    if (x > 0) d = Math.min(d, dt[y * W + x - 1] + 3);
    if (y > 0) {
      d = Math.min(d, dt[(y - 1) * W + x] + 3);
      if (x > 0) d = Math.min(d, dt[(y - 1) * W + x - 1] + 4);
      if (x < W - 1) d = Math.min(d, dt[(y - 1) * W + x + 1] + 4);
    }
    dt[y * W + x] = d;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    let d = dt[y * W + x];
    if (x < W - 1) d = Math.min(d, dt[y * W + x + 1] + 3);
    if (y < H - 1) {
      d = Math.min(d, dt[(y + 1) * W + x] + 3);
      if (x < W - 1) d = Math.min(d, dt[(y + 1) * W + x + 1] + 4);
      if (x > 0) d = Math.min(d, dt[(y + 1) * W + x - 1] + 4);
    }
    dt[y * W + x] = d;
  }

  // 4) 掩码轮廓点（±2 邻域，匹配掩码步长 2 采样）+ 字母质心 = 拖拽起点
  const maskSet = new Set(mask.map(([x, y]) => `${x},${y}`));
  const outline = mask.filter(([x, y]) =>
    maskSet.has(`${x + 2},${y}`) !== maskSet.has(`${x - 2},${y}`) ||
    maskSet.has(`${x},${y + 2}`) !== maskSet.has(`${x},${y - 2}`));
  if (!outline.length) return { error: '无轮廓点' };
  let mcx = 0, mcy = 0;
  for (const [x, y] of mask) { mcx += x; mcy += y; }
  mcx = tcx + mcx / mask.length; mcy = tcy + mcy / mask.length;
  const outlineC = outline.map(([x, y]) => [x - (mcx - tcx), y - (mcy - tcy)]);

  // 5) chamfer 命中率匹配：score = dt<8px 的轮廓点占比（粗扫 sc0.9-1.65 步6px + 精修）
  const inTileZone = (cx, cy) => cx > tileBox.x0 - 110 && cx < tileBox.x1 + 110 && cy > tileBox.y0 - 130 && cy < tileBox.y1 + 110;
  const chamferAt = (cx0, cy0, sc) => {
    let hit = 0, cnt = 0;
    for (const [dx, dy] of outlineC) {
      const sx = Math.round(cx0 + dx * sc), sy = Math.round(cy0 + dy * sc);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) return 0;
      if (dt[sy * W + sx] < 24) hit++; // dt 以 1/3 像素为单位，24 = 8px
      cnt++;
    }
    return cnt ? hit / cnt : 0;
  };
  let best = null;
  for (let sc = 0.9; sc <= 1.65; sc += 0.15) {
    for (let cy0 = 70; cy0 < H - 70; cy0 += 6) {
      for (let cx0 = 70; cx0 < W - 70; cx0 += 6) {
        if (inTileZone(cx0, cy0)) continue;
        const s = chamferAt(cx0, cy0, sc);
        if (!best || s > best.score) best = { score: s, cx: cx0, cy: cy0, sc };
      }
    }
  }
  if (best) {
    const b0 = { ...best };
    for (let sc = Math.max(0.5, b0.sc - 0.15); sc <= b0.sc + 0.15; sc += 0.05) {
      for (let cy0 = b0.cy - 8; cy0 <= b0.cy + 8; cy0 += 2) {
        for (let cx0 = b0.cx - 8; cx0 <= b0.cx + 8; cx0 += 2) {
          if (inTileZone(cx0, cy0)) continue;
          const s = chamferAt(cx0, cy0, sc);
          if (s > best.score) best = { score: s, cx: cx0, cy: cy0, sc };
        }
      }
    }
  }
  if (!best || best.score < 0.3) return { error: `匹配过弱 ${((best?.score || 0) * 100) | 0}%` };
  return { fx: mcx, fy: mcy, tx: best.cx, ty: best.cy, score: best.score, tile: tileBox, badge };
}

// ─────────────── 数数题求解器 v3（动态网格 3x4/4x4 + 单/多胶囊 + 双极坐标，位图坐标）───────────────
function solveIcons(img, log = () => {}) {
  const { W, H, data } = img;
  const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };

  // A) 侧栏深色胶囊（右侧 30% 区域）
  const SX0 = Math.round(W * 0.70);
  const pills = [];
  {
    const dark = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = SX0; x < W; x++) { const [r, g, b2] = px(x, y); if (r < 95 && g < 95 && b2 < 95) dark[y * W + x] = 1; }
    const seen0 = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 2) for (let x = SX0; x < W; x += 2) {
      if (!dark[y * W + x] || seen0[y * W + x]) continue;
      const st = [[x, y]]; seen0[y * W + x] = 1;
      let x0 = x, y0 = y, x1 = x, y1 = y, n = 0;
      while (st.length) {
        const [cx, cy] = st.pop(); n++;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < SX0 || ny < 0 || nx >= W || ny >= H || seen0[ny * W + nx] || !dark[ny * W + nx]) continue;
          seen0[ny * W + nx] = 1; st.push([nx, ny]);
        }
      }
      const w2 = x1 - x0, h2 = y1 - y0;
      if (n > 300 && w2 > 60 && w2 < 220 && h2 > 25 && h2 < 90 && w2 / h2 > 1.15) pills.push({ x0, y0, x1, y1, n });
    }
    pills.sort((a, b2) => a.y0 - b2.y0);
  }
  log(`胶囊 ${pills.length}: ` + pills.map((p) => `(${p.x0},${p.y0}-${p.x1},${p.y1})`).join(' '));
  if (!pills.length || pills.length > 4) return { error: `胶囊数异常 ${pills.length}` };

  // B) 范例图标：胶囊正下方、与侧栏底色（逐通道中位色）差异大的行带 → 126px 方形裁剪
  //    （v4：饱和带对白羊毛/蓝灰鸽这类低饱和范例失效，改用与底色的绝对色差，
  //     黑白贴纸靠描边和深色脸部命中；iconTop = 带顶-9 吸收描边到贴纸顶的偏移）
  const exemplars = [];
  for (let i = 0; i < pills.length; i++) {
    const p = pills[i];
    const pcx = (p.x0 + p.x1) / 2;
    const yEnd = i + 1 < pills.length ? pills[i + 1].y0 - 5 : Math.min(H - 8, p.y1 + 340);
    const rs = [], gs = [], bs = [];
    for (let y = p.y1 + 8; y < yEnd; y += 3) for (let x = SX0 + 8; x < W - 8; x += 3) {
      const [r, g, b2] = px(x, y); rs.push(r); gs.push(g); bs.push(b2);
    }
    const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1] || 0; };
    const mr = med(rs), mg = med(gs), mb = med(bs);
    const bands = [];
    for (let y = p.y1 + 5; y < yEnd; y++) {
      let c = 0;
      for (let x = Math.round(pcx) - 75; x <= Math.round(pcx) + 75; x++) {
        const [r, g, b2] = px(x, y);
        if (Math.abs(r - mr) + Math.abs(g - mg) + Math.abs(b2 - mb) > 110) c++;
      }
      if (c > 20) {
        if (bands.length && y - bands[bands.length - 1][1] <= 24) bands[bands.length - 1][1] = y;
        else bands.push([y, y]);
      }
    }
    if (!bands.length) return { error: '无范例色差带' };
    const iconTop = Math.max(0, bands[0][0] - 9);
    exemplars.push({ pill: p, pcx, ex: { x0: Math.round(pcx - 63), y0: iconTop, x1: Math.round(pcx + 63), y1: Math.min(H - 1, iconTop + 126) } });
  }

  // C) 动态网格检测：亮度横向/纵向对比度积分峰（亮暗背景通吃），峰间距 90-210px
  const lum = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b2] = px(x, y); lum[y * W + x] = (r + g + b2) / 3; }
  const GX1 = Math.round(W * 0.70), GY0 = Math.round(H * 0.27), GY1 = H - 20;
  // vScore 从 x=45 起：题框左边框竖线（x≈20-35）不是网格线，别进峰
  const vScore = new Float64Array(W), hScore = new Float64Array(H);
  for (let x = 45; x < GX1; x++) {
    let s = 0;
    for (let y = GY0; y < GY1; y += 2) s += Math.abs(lum[y * W + x] - lum[y * W + x - 4]) + Math.abs(lum[y * W + x] - lum[y * W + x + 4]);
    vScore[x] = s;
  }
  for (let y = GY0; y < GY1; y++) {
    let s = 0;
    for (let x = 45; x < GX1; x += 2) s += Math.abs(lum[y * W + x] - lum[(y - 4) * W + x]) + Math.abs(lum[y * W + x] - lum[(y + 4) * W + x]);
    hScore[y] = s;
  }
  const pickPeaks = (score, lo, hi, minGap) => {
    const cand = [];
    for (let i = Math.max(14, lo); i < hi - 14; i++) {
      let isPeak = score[i] > 0;
      for (let d = -14; d <= 14 && isPeak; d++) if (score[i + d] > score[i]) isPeak = false;
      if (isPeak) cand.push([i, score[i]]);
    }
    cand.sort((a, b2) => b2[1] - a[1]);
    const mx = cand.length ? cand[0][1] : 0;
    const taken = [];
    for (const [i, s] of cand) {
      if (s < mx * 0.25) break;
      if (taken.some((t) => Math.abs(t - i) < minGap)) continue;
      taken.push(i);
    }
    return taken.sort((a, b2) => a - b2);
  };
  const vx = pickPeaks(vScore, 45, GX1, 90), hy = pickPeaks(hScore, GY0, GY1, 90);
  log(`竖线 ${vx.length}: ${vx.join(',')}  横线 ${hy.length}: ${hy.join(',')}`);
  const cells = [];
  for (let r = 0; r + 1 < hy.length; r++) for (let c = 0; c + 1 < vx.length; c++) {
    const pw = vx[c + 1] - vx[c], ph = hy[r + 1] - hy[r];
    if (pw < 100 || pw > 210 || ph < 100 || ph > 210) continue;
    cells.push({ cx: (vx[c] + vx[c + 1]) / 2, cy: (hy[r] + hy[r + 1]) / 2, w: pw, h: ph });
  }
  if (cells.length < 6) return { error: `格子过少 ${cells.length}` };
  const pitch = cells.reduce((a, c) => a + (c.w + c.h) / 2, 0) / cells.length;
  log(`格子 ${cells.length} 个, pitch ${pitch | 0}px`);

  // D) 双极坐标描述子：6 比例环 x 16 扇区，亮度/饱和度各一套，分数取 max（背景无关）
  //    格子采样半径 = pitch*0.44；范例盒 100-126px → 半径 {48,54,60} × 偏移 dx{-5,0,5} dy{-8,0,8}
  const FR = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9], SEC = 16;
  const sat = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) { const r = data[i * 4], g = data[i * 4 + 1], b2 = data[i * 4 + 2]; sat[i] = Math.max(r, g, b2) - Math.min(r, g, b2); }
  const polarOf = (field, cx, cy, R) => {
    const v = [];
    for (const f of FR) for (let s = 0; s < SEC; s++) {
      const a = (s * 2 * Math.PI) / SEC, r = f * R;
      const x = Math.min(W - 1, Math.max(0, Math.round(cx + r * Math.cos(a))));
      const y = Math.min(H - 1, Math.max(0, Math.round(cy + r * Math.sin(a))));
      v.push(field[y * W + x]);
    }
    const m = v.reduce((a2, b2) => a2 + b2, 0) / v.length;
    return v.map((x) => x - m);
  };
  const cos = (a, b2) => {
    let dot = 0, na = 0, nb = 0;
    for (let i2 = 0; i2 < a.length; i2++) { dot += a[i2] * b2[i2]; na += a[i2] * a[i2]; nb += b2[i2] * b2[i2]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  };
  const RC = Math.round(pitch * 0.44);
  const cellPolars = cells.map((c) => ({ lum: polarOf(lum, c.cx, c.cy, RC), sat: polarOf(sat, c.cx, c.cy, RC) }));
  for (const e of exemplars) {
    const ec0 = { cx: (e.ex.x0 + e.ex.x1) / 2, cy: (e.ex.y0 + e.ex.y1) / 2 };
    const variants = [];
    for (const R of [48, 54, 60]) for (const dy of [-8, 0, 8]) for (const dx of [-5, 0, 5]) {
      variants.push({ lum: polarOf(lum, ec0.cx + dx, ec0.cy + dy, R), sat: polarOf(sat, ec0.cx + dx, ec0.cy + dy, R) });
    }
    e.cells = cells.map((c, ci) => {
      const cp = cellPolars[ci];
      let s = -1;
      for (const ev of variants) {
        for (let sh = 0; sh < SEC; sh++) {
          const shiftedL = [], shiftedS = [];
          for (let ri = 0; ri < FR.length; ri++) {
            for (let s2 = 0; s2 < SEC; s2++) {
              const idx = ((ri * SEC + ((s2 + sh) % SEC)) * 1);
              shiftedL.push(cp.lum[idx]); shiftedS.push(cp.sat[idx]);
            }
          }
          const v = Math.max(cos(ev.lum, shiftedL), cos(ev.sat, shiftedS));
          if (v > s) s = v;
        }
      }
      return { ...c, score: s };
    }).sort((a, b2) => b2.score - a.score);
  }

  // E) 计数 OCR：数字字形中部 40-70% 带列跨度（"1"细杆 ~6px / "2"宽腰 ~14px），字高 24-38 sanity
  for (const e of exemplars) {
    const p = e.pill;
    const ink = [];
    for (let y = p.y0 + 5; y < p.y1 - 5; y++) for (let x = p.x0 + 10; x < p.x1 - 10; x++) {
      const [r, g, b2] = px(x, y);
      if (r > 190 && g > 190 && b2 > 190) ink.push([x, y]);
    }
    if (ink.length < 40) return { error: '胶囊无数字墨水' };
    const xs = [...new Set(ink.map(([x]) => x))].sort((a, b2) => a - b2);
    const clusters = [];
    for (const x of xs) {
      if (clusters.length && x - clusters[clusters.length - 1][1] <= 4) clusters[clusters.length - 1][1] = x;
      else clusters.push([x, x]);
    }
    const [d0, d1] = clusters[0];
    const digit = ink.filter(([x]) => x >= d0 && x <= d1);
    const yMin = Math.min(...digit.map(([, y]) => y)), yMax = Math.max(...digit.map(([, y]) => y));
    const digitH = yMax - yMin + 1;
    if (digitH < 24 || digitH > 38) return { error: `胶囊字高异常 ${digitH}` };
    const midCols = digit.filter(([, y]) => y > yMin + (yMax - yMin) * 0.4 && y <= yMin + (yMax - yMin) * 0.7).map(([x]) => x);
    const midSpan = midCols.length ? Math.max(...midCols) - Math.min(...midCols) + 1 : 0;
    e.count = midSpan >= 10 ? 2 : 1;
    log(`  范例${exemplars.indexOf(e)}: 中部跨 ${midSpan}px → ${e.count}x, top2 ` + e.cells.slice(0, 2).map((c) => `${(c.score * 100 | 0)}% @(${c.cx | 0},${c.cy | 0})`).join(' / '));
  }
  // F) 点击计划：top1 分高的范例先挑格（count 个），被占的格顺延次佳
  const plan = [], claimed = new Set();
  for (const e of [...exemplars].sort((a, b2) => b2.cells[0].score - a.cells[0].score)) {
    let taken = 0;
    for (const c of e.cells) {
      const key = `${c.cx | 0},${c.cy | 0}`;
      if (claimed.has(key)) continue;
      claimed.add(key); plan.push({ x: c.cx, y: c.cy, score: c.score });
      if (++taken >= e.count) break;
    }
  }
  log(`  计划: ` + plan.map((p) => `(${p.x | 0},${p.y | 0})${(p.score * 100 | 0)}%`).join(' '));
  return { pills, exemplars, cells, plan };
}

export { decodePng, solveDrag, solveIcons };
