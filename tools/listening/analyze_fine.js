// 高分辨率（0.1 秒）包络，用于找短停顿
const fs = require('fs');
const path = require('path');
const { launch, CDP, sleep } = require('./cdp');

const BASE = 'http://127.0.0.1:8123/';
const IDS = process.argv.slice(2);
const OUT = path.join(__dirname, 'env_fine');
const SR = 8000, BLK = 800;   // 0.1 秒

const PAGE_FN = `
window.__env = async function(url, sr, blk){
  const r = await fetch(url);
  const buf = await r.arrayBuffer();
  const ab = await new OfflineAudioContext(1,1,sr).decodeAudioData(buf);
  const ch = ab.getChannelData(0);
  const N = Math.ceil(ch.length / blk);
  const out = new Array(N);
  for (let i = 0; i < N; i++){
    const a = i*blk, b = Math.min(a+blk, ch.length);
    let s = 0;
    for (let j = a; j < b; j++) s += ch[j]*ch[j];
    out[i] = Math.round(Math.sqrt(s/(b-a))*10000)/10000;
  }
  return { dur: ab.duration, blk: blk/sr, env: out };
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
    for (const sid of IDS) {
      const r = await cdp.eval(`__env(${JSON.stringify(BASE + 'src/' + sid + '.mp3')}, ${SR}, ${BLK})`);
      r.id = sid;
      fs.writeFileSync(path.join(OUT, sid + '.json'), JSON.stringify(r));
      console.log('done', sid, r.dur.toFixed(1), r.env.length, '块');
    }
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
