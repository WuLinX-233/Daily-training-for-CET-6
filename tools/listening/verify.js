// 校验切片：对给定音频算 0.1 秒包络，打印静音段（用来确认念题停顿真的在片段里）
const fs = require('fs');
const path = require('path');
const { launch, CDP, sleep } = require('./cdp');

const BASE = 'http://127.0.0.1:8123/';
const FILES = process.argv.slice(2);   // 形如 seg/2024-12-1_conversationtwo.mp3
const SR = 8000, BLK = 800;

const PAGE_FN = `
window.__env = async function(url){
  const buf = await (await fetch(url)).arrayBuffer();
  const ab = await new OfflineAudioContext(1,1,${SR}).decodeAudioData(buf);
  const ch = ab.getChannelData(0);
  const N = Math.ceil(ch.length / ${BLK});
  const out = new Array(N);
  for (let i = 0; i < N; i++){
    const a = i*${BLK}, b = Math.min(a+${BLK}, ch.length);
    let s = 0;
    for (let j = a; j < b; j++) s += ch[j]*ch[j];
    out[i] = Math.round(Math.sqrt(s/(b-a))*10000)/10000;
  }
  return { dur: ab.duration, env: out };
};
true;`;

(async () => {
  const ud = path.join(__dirname, '_chrome_' + Date.now());
  const proc = await launch(ud);
  let cdp;
  const res = {};
  try {
    cdp = await CDP.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: BASE + 'blank.html' });
    await sleep(700);
    await cdp.eval(PAGE_FN);
    for (const f of FILES) {
      const r = await cdp.eval(`__env(${JSON.stringify(BASE + f)})`);
      res[f] = r;
      console.log(f, 'dur=' + r.dur.toFixed(2), 'blocks=' + r.env.length);
    }
    fs.writeFileSync(path.join(__dirname, 'verify_out.json'), JSON.stringify(res));
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
