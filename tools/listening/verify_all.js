// 全量校验：77 段切片在 qAt 之后是否真的包含 3–4 个作答停顿
const fs = require('fs');
const path = require('path');
const { launch, CDP, sleep } = require('./cdp');

const APP = 'http://127.0.0.1:8000/';
const SR = 8000, BLK = 800;   // BLK/SR = 0.1 秒一块

const PAGE_FN = `
window.__probe = async function(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error('HTTP '+r.status);
  const ab = await new OfflineAudioContext(1,1,${SR}).decodeAudioData(await r.arrayBuffer());
  const ch = ab.getChannelData(0);
  const N = Math.ceil(ch.length / ${BLK});
  const env = new Array(N);
  for (let i = 0; i < N; i++){
    const a = i*${BLK}, b = Math.min(a+${BLK}, ch.length);
    let s = 0;
    for (let j = a; j < b; j++) s += ch[j]*ch[j];
    env[i] = Math.sqrt(s/(b-a));
  }
  // 静音段（>=4 秒）
  const sorted = Array.from(env).sort((x,y)=>x-y);
  const lo = sorted[Math.floor(sorted.length*0.05)];
  const hi = sorted[Math.floor(sorted.length*0.95)];
  const thr = lo + 0.12*(hi-lo);
  const gaps = [];
  let i = 0;
  while (i < env.length){
    if (env[i] < thr){
      let j = i;
      while (j < env.length && env[j] < thr) j++;
      if (j - i >= 40) gaps.push([i/10, j/10]);   // 40 块 = 4 秒
      i = j;
    } else i++;
  }
  return { dur: ab.duration, gaps: gaps, thr: thr };
};
true;`;

(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'listening.json'), 'utf8'));
  const ud = path.join(__dirname, '_chrome_' + Date.now());
  const proc = await launch(ud);
  let cdp;
  const rows = [];
  try {
    cdp = await CDP.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: APP + 'index.html' });
    await sleep(1500);
    await cdp.eval(PAGE_FN);

    for (let k = 0; k < data.length; k++) {
      const e = data[k];
      const r = await cdp.eval(`__probe(${JSON.stringify(APP + e.audio)})`);
      const after = r.gaps.filter(g => g[0] >= e.qAt - 4);
      const first = after.length ? after[0][0] : -1;
      rows.push({
        day: k + 1, title: e.title, qAt: e.qAt, dur: e.dur,
        nGap: after.length, firstGap: first, offset: first >= 0 ? first - e.qAt : null,
        durs: after.map(g => g[1] - g[0]),
      });
      const good = after.length >= 3 && after.length <= 4 && Math.abs(first - e.qAt) <= 4;
      process.stdout.write((good ? '  ok ' : '  !! ') + String(k + 1).padStart(2) +
        ' ' + e.title.padEnd(38) + ' qAt=' + e.qAt.toFixed(0) +
        ' 停顿=' + after.length + ' 首个=' + (first >= 0 ? first.toFixed(0) : '-') +
        ' 偏移=' + (first >= 0 ? (first - e.qAt).toFixed(0) : '-') + '\n');
    }

    const bad = rows.filter(r => !(r.nGap >= 3 && r.nGap <= 4 && Math.abs(r.offset) <= 4));
    const offs = rows.filter(r => r.offset !== null).map(r => r.offset);
    console.log('\n段落 ' + rows.length + '  异常 ' + bad.length);
    console.log('偏移中位 ' + offs.sort((a, b) => a - b)[Math.floor(offs.length / 2)].toFixed(1) +
      ' 秒，范围 ' + Math.min.apply(null, offs).toFixed(0) + ' ~ ' + Math.max.apply(null, offs).toFixed(0));
    fs.writeFileSync(path.join(__dirname, 'verify_all.json'), JSON.stringify(rows, null, 1));
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
    await sleep(500);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
