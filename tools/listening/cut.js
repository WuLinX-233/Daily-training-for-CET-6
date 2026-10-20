// 按 plan.json 切 77 段音频：解码一次、切 7 段、lamejs 编码成 24kHz 单声道 48kbps mp3
const fs = require('fs');
const path = require('path');
const { launch, CDP, sleep } = require('./cdp');

const BASE = 'http://127.0.0.1:8123/';
const OUT = path.join(__dirname, 'seg');
const SR = 24000, KBPS = 48;

const PAGE_FN = `
window.__load = async function(url){
  const r = await fetch(url);
  if(!r.ok) throw new Error('HTTP '+r.status);
  const buf = await r.arrayBuffer();
  const ab = await new OfflineAudioContext(1,1,${SR}).decodeAudioData(buf);
  window.__pcm = ab.getChannelData(0);
  return { dur: ab.duration, n: window.__pcm.length };
};
window.__cut = function(start, end){
  const pcm = window.__pcm;
  const a = Math.max(0, Math.round(start * ${SR}));
  const b = Math.min(pcm.length, Math.round(end * ${SR}));
  if (b <= a) throw new Error('区间为空 '+start+' '+end);
  const sub = pcm.subarray(a, b);
  const n = sub.length;
  const pcm16 = new Int16Array(n);
  for (let i = 0; i < n; i++){
    let s = sub[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const enc = new window.__lame.Mp3Encoder(1, ${SR}, ${KBPS});
  const parts = [];
  const CH = 1152;
  for (let i = 0; i < n; i += CH){
    const chunk = pcm16.subarray(i, Math.min(i + CH, n));
    const buf = enc.encodeBuffer(chunk);
    if (buf.length) parts.push(buf);
  }
  const tail = enc.flush();
  if (tail.length) parts.push(tail);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts){ out.set(p, off); off += p.length; }
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < out.length; i += STEP){
    bin += String.fromCharCode.apply(null, out.subarray(i, i + STEP));
  }
  return { b64: btoa(bin), bytes: out.length, secs: n / ${SR} };
};
true;`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8'));
  const bySet = new Map();
  for (const e of plan) {
    if (process.argv[2] && e.setId !== process.argv[2]) continue;
    if (!bySet.has(e.setId)) bySet.set(e.setId, []);
    bySet.get(e.setId).push(e);
  }

  const ud = path.join(__dirname, '_chrome_' + Date.now());
  const proc = await launch(ud);
  let cdp;
  const t0 = Date.now();
  let done = 0, bytes = 0;
  try {
    cdp = await CDP.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: BASE + 'blank.html' });
    await sleep(800);
    await cdp.eval(PAGE_FN);
    await cdp.eval(`(function(){ var s=document.createElement('script');
      s.src='/lame.all.js'; document.head.appendChild(s);
      return new Promise(function(r){ s.onload=function(){ window.__lame = lamejs; r(!!window.__lame.Mp3Encoder); }; }); })()`);

    for (const [sid, list] of bySet) {
      const info = await cdp.eval(`__load(${JSON.stringify(BASE + 'src/' + sid + '.mp3')})`);
      console.log('[' + sid + '] 解码 ' + info.dur.toFixed(1) + 's  ' + info.n + ' 采样');
      for (const e of list) {
        const dst = path.join(OUT, path.basename(e.audio));
        if (e.end > info.dur + 0.5) throw new Error(sid + ' 越界 ' + e.end + ' > ' + info.dur);
        const r = await cdp.eval(`__cut(${e.start}, ${e.end})`);
        fs.writeFileSync(dst, Buffer.from(r.b64, 'base64'));
        done++; bytes += r.bytes;
        console.log('  ' + path.basename(e.audio).padEnd(40) +
          String(r.secs.toFixed(1)).padStart(7) + 's  ' +
          String(Math.round(r.bytes / 1024)).padStart(5) + ' KB   (' + done + '/' + plan.length + ')');
      }
      await cdp.eval('window.__pcm = null; true;');
    }
    console.log('\n完成 ' + done + ' 段  合计 ' + (bytes / 1048576).toFixed(1) +
      ' MB  用时 ' + ((Date.now() - t0) / 60000).toFixed(1) + ' 分钟');
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
    await sleep(500);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
