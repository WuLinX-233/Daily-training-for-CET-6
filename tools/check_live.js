// 线上站点验收：确认 GitHub Pages 上的页面能真正跑起来（不只是 curl 200）
const path = require('path');
const { launch, CDP, sleep } = require('./listening/cdp.js');

const URL = 'https://wulinx-233.github.io/Daily-training-for-CET-6/';
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

(async () => {
  // 无头 Chrome 的临时 profile，跟着仓库走（_probe/ 已 gitignore），
  // 不再写死某个绝对路径，仓库搬到哪都能跑
  const profile = path.join(__dirname, '..', '_probe', 'chrome');
  const proc = await launch(profile);
  const cdp = await CDP.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Page.javascriptDialogOpening', () =>
    cdp.send('Page.handleJavaScriptDialog', { accept: true }));

  try {
    await cdp.send('Page.navigate', { url: URL });
    await sleep(6000);

    const r0 = await cdp.eval(`(function(){
      return { title: document.title, url: location.href,
               hasApp: !!document.getElementById('readingBody') };
    })()`);
    ok('页面标题正常', /六级|CET/i.test(r0.title), r0.title);
    ok('主界面渲染', r0.hasApp);

    // 三个模块各点一次，确认 JSON 是从 Pages 上取的
    const r1 = await cdp.eval(`(function(){
      document.querySelector('[data-tab="reading"]').click();
      var p = document.getElementById('passageBox');
      var d = document.getElementById('readingDate');
      return { words: p ? p.innerText.trim().split(/\\s+/).length : 0,
               date: d ? d.innerText.trim() : '' };
    })()`);
    await sleep(1500);
    const r1b = await cdp.eval(`(function(){
      var p = document.getElementById('passageBox');
      return p ? p.innerText.trim().split(/\\s+/).length : 0;
    })()`);
    ok('阅读正文从线上载入', r1b > 300, r1b + ' 词');

    await cdp.eval(`document.querySelector('[data-tab="translation"]').click(), 1`);
    await sleep(800);
    const r2 = await cdp.eval(`(function(){
      var z = document.querySelector('.prompt-zh');
      var d = document.getElementById('translationDate');
      return { zh: z ? z.innerText.trim().length : 0, date: d ? d.innerText.trim() : '' };
    })()`);
    ok('翻译原文从线上载入', r2.zh > 100, r2.zh + ' 字');
    ok('翻译出处显示真题来源', /·.*套/.test(r2.date), r2.date);

    await cdp.eval(`document.querySelector('[data-tab="listening"]').click(), 1`);
    await sleep(800);
    // 音频元素是 new Audio() 动态建的，不在 DOM 里；
    // 直接验证 listening.json 能取到、且第一段 mp3 能从 Pages 上拉到
    const r3 = await cdp.eval(`(async function(){
      const arr = await (await fetch('listening.json')).json();
      const url = arr[0].audio;
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      return { n: arr.length, url: url, ok: res.ok, bytes: buf.byteLength };
    })()`);
    ok('听力数据从线上载入（77 段）', r3.n === 77, String(r3.n));
    ok('音频路径是相对路径', !/^https?:/.test(r3.url), r3.url);
    ok('音频文件可从 Pages 取到', r3.ok && r3.bytes > 500000, r3.bytes + ' bytes');

    const r4 = await cdp.eval(`navigator.serviceWorker.getRegistrations().then(r=>r.length)`);
    ok('Service Worker 已注册', r4 >= 1, String(r4));

    console.log('\\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } catch (e) {
    console.log('异常: ' + e.message);
    fail++;
  } finally {
    try { await cdp.quit(); } catch (e) {}   // Browser.close：真正关掉 Chrome
    try { proc.kill(); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();
