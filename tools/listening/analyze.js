// 计算 12 套源音频的 1 秒 RMS 包络
const fs = require('fs');
const path = require('path');
const { launch, CDP, sleep } = require('./cdp');

const BASE = 'http://127.0.0.1:8123/';
const OUT = path.join(__dirname, 'env');
const SR = 8000;

const SETS = ['2023-06-1', '2023-06-2', '2023-12-1', '2023-12-2', '2024-06-1',
  '2024-06-2', '2024-12-1', '2024-12-2', '2025-06-1', '2025-06-2',
  '2025-12-1', '2025-12-2'];

const PAGE_FN = `
window.__env = async function(url, sr){
  const r = await fetch(url);
  if(!r.ok) throw new Error('HTTP '+r.status);
  const buf = await r.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, sr);
  const ab = await ctx.decodeAudioData(buf);
  const ch = ab.getChannelData(0);
  const n = sr;                        // 1 秒一块
  const N = Math.ceil(ch.length / n);
  const out = new Array(N);
  for (let i = 0; i < N; i++){
    const a = i * n, b = Math.min(a + n, ch.length);
    let s = 0;
    for (let j = a; j < b; j++) s += ch[j] * ch[j];
    out[i] = Math.round(Math.sqrt(s / (b - a)) * 10000) / 10000;
  }
  return { dur: ab.duration, sr: ab.sampleRate, chans: ab.numberOfChannels, env: out };
};
true;`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const ud = path.join(__dirname, '_chrome_' + Date.now());
  const proc = await launch(ud);
  let cdp;
  try {
    cdp = await CDP.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: BASE + 'blank.html' });
    await sleep(800);
    await cdp.eval(PAGE_FN);

    for (const sid of SETS) {
      const dst = path.join(OUT, sid + '.json');
      if (fs.existsSync(dst)) { console.log('[skip]', sid); continue; }
      const t0 = Date.now();
      const r = await cdp.eval(`__env(${JSON.stringify(BASE + 'src/' + sid + '.mp3')}, ${SR})`);
      r.id = sid;
      fs.writeFileSync(dst, JSON.stringify(r));
      console.log('[%s] %.1fs  %d 块  %.0fs', sid, r.dur, r.env.length, (Date.now() - t0) / 1000);
    }
    console.log('包络完成');
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
    await sleep(500);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) { console.log('（用户目录残留，忽略）'); }
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
