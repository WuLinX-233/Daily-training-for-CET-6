// 把上游源音频（tools/listening/src/*.mp3）解码成 50ms 包络，写到 _build/env_src.json
//
// 给 align_sections.py 用：那三套的时间轴相对音频是压缩的，只能拿音频本身当基准。
//
// 用法：先起静态服务（python tools/listening/srv.py . 8123），然后
//   node tools/listening/env_src.js 2023-12-1 2023-12-2 2025-06-1
const fs = require('fs');
const path = require('path');
const { launch, CDP, sleep } = require('./cdp.js');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, '_build', 'env_src.json');
const PORT = process.env.SRV_PORT || 8123;
const HOP = 0.05;

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('用法：node tools/listening/env_src.js <setId> [...]');
  process.exit(1);
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};

  const proc = await launch(path.join(ROOT, '_probe', 'env'));
  const cdp = await CDP.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Page.javascriptDialogOpening', () =>
    cdp.send('Page.handleJavaScriptDialog', { accept: true }));
  await cdp.send('Page.navigate',
    { url: 'http://127.0.0.1:' + PORT + '/tools/listening/blank.html' });
  await sleep(1000);

  for (const sid of ids) {
    const key = '/tools/listening/src/' + sid + '.mp3';
    if (res[key] && res[key].env) { process.stdout.write('-'); continue; }
    const r = await cdp.eval(`(async function(){
      const buf = await (await fetch(${JSON.stringify(key)})).arrayBuffer();
      const ab = await new OfflineAudioContext(1,1,44100).decodeAudioData(buf);
      const ch = ab.getChannelData(0), sr = ab.sampleRate;
      const HOP = Math.round(sr * ${HOP});
      const fr = [];
      for (let i = 0; i + HOP <= ch.length; i += HOP) {
        let s = 0;
        for (let j = 0; j < HOP; j++) { const v = ch[i + j]; s += v * v; }
        fr.push(Math.sqrt(s / HOP));
      }
      return { dur: ab.duration, env: fr.map(v => +v.toFixed(4)) };
    })()`);
    res[key] = r;
    console.log('\n' + sid + '  ' + r.dur.toFixed(1) + 's  ' + r.env.length + ' 帧');
  }

  fs.writeFileSync(OUT, JSON.stringify(res));
  console.log('写出 ' + OUT);
  try { await cdp.quit(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
  process.exit(0);
})();
