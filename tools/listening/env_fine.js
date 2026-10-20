// 把 77 段 mp3 解码成 50 ms 一帧的 RMS 包络，写到 _build/env_fine.json
//
// 为什么要细包络：仓库里 tools/listening/env/*.json 是 1 秒一帧的（当初切点检测用），
// 拿它做「逐句对齐」误差太大。这里用 50 ms，才能把句子边界对齐到 ±0.2 秒。
//
// 用法：先起本地服务器（python server.py 8000），然后
//   node tools/listening/env_fine.js            # 全部 77 段
//   node tools/listening/env_fine.js 2023-12-1  # 只做某一套
const fs = require('fs');
const path = require('path');
const { launch, CDP, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '_build', 'env_fine.json');
const PORT = process.env.PORT || 8000;
const HOP = 0.05;

const only = process.argv.slice(2);

(async () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'listening.json'), 'utf8'));
  const want = list.filter(e => !only.length || only.includes(e.setId));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

  const proc = await launch(path.join(ROOT, '_probe', 'env'));
  const cdp = await CDP.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Page.javascriptDialogOpening', () =>
    cdp.send('Page.handleJavaScriptDialog', { accept: true }));
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
  await sleep(2500);

  for (const e of want) {
    if (res[e.audio] && res[e.audio].env) { process.stdout.write('-'); continue; }
    const r = await cdp.eval(`(async function(){
      const buf = await (await fetch(${JSON.stringify(e.audio)})).arrayBuffer();
      const ctx = new (window.OfflineAudioContext)(1, 1000, 44100);
      const ab = await ctx.decodeAudioData(buf);
      const ch = ab.getChannelData(0), sr = ab.sampleRate;
      const HOP = Math.round(sr * ${HOP});
      const fr = [];
      for (let i = 0; i + HOP <= ch.length; i += HOP) {
        let s = 0;
        for (let j = 0; j < HOP; j++) { const v = ch[i + j]; s += v * v; }
        fr.push(Math.sqrt(s / HOP));
      }
      return { dur: ab.duration, hop: ${HOP}, env: fr.map(v => +v.toFixed(4)) };
    })()`);
    res[e.audio] = r;
    process.stdout.write('.');
  }

  fs.writeFileSync(OUT, JSON.stringify(res));
  console.log('\n写出 ' + OUT + '（' + Object.keys(res).length + ' 段）');

  try { await cdp.quit(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
  process.exit(0);
})();
