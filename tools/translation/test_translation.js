// 翻译模块冒烟测试：57 篇真题是否渲染、参考译文能否展开、草稿是否自动保存
const path = require('path');
const { launch, CDP, sleep } = require('../listening/cdp.js');

const URL = 'http://127.0.0.1:8124/index.html';
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

(async () => {
  // 无头 Chrome 的临时 profile，跟着仓库走（_probe/ 已 gitignore）
  const profile = path.join(__dirname, '..', '..', '_probe', 'chrome');
  const proc = await launch(profile);
  const cdp = await CDP.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Page.javascriptDialogOpening', () =>
    cdp.send('Page.handleJavaScriptDialog', { accept: true }));

  try {
    await cdp.send('Page.navigate', { url: URL });
    await sleep(2500);

    await cdp.eval(`document.querySelector('[data-tab="translation"]').click(), 1`);
    await sleep(600);

    const r1 = await cdp.eval(`(function(){
      var z = document.querySelector('.prompt-zh');
      var d = document.getElementById('translationDate');
      return {
        zh: z ? z.innerText.trim() : '',
        date: d ? d.innerText.trim() : '',
        hasBtn: !!document.querySelector('[data-act="ref"]'),
        hasInput: !!document.getElementById('transInput')
      };
    })()`);
    ok('中文原文渲染（>100 字）', r1.zh.length > 100, r1.zh.length + ' 字');
    ok('出处标签含年月与套数', /·.*年.*月.*套/.test(r1.date), r1.date);
    ok('有“显示参考译文”按钮', r1.hasBtn);
    ok('有译文输入框', r1.hasInput);

    const r2 = await cdp.eval(`(function(){
      document.querySelector('[data-act="ref"]').click();
      var a = document.querySelector('[data-role="ref"]');
      return { hidden: a.classList.contains('hidden'),
               words: a.innerText.trim().split(/\\s+/).length };
    })()`);
    ok('参考译文可以展开', !r2.hidden);
    ok('参考译文超过 80 词', r2.words > 80, r2.words + ' 词');

    // 草稿自动保存
    const r3 = await cdp.eval(`(function(){
      var t = document.getElementById('transInput');
      t.value = 'test draft 123';
      t.dispatchEvent(new Event('input', {bubbles:true}));
      return 1;
    })()`);
    await sleep(400);
    const saved = await cdp.eval(
      `JSON.parse(localStorage.getItem('cet6.v1')).translation['1'] || ''`);
    ok('草稿写入 localStorage', saved === 'test draft 123', JSON.stringify(saved));

    // 第 57 天
    await cdp.eval(`(function(){
      var b = document.querySelector('[data-days="57"]');
      if (b) b.click();
      var n = document.getElementById('nextDay');
      for (var i = 0; i < 60; i++) { if (n.disabled) break; n.click(); }
      return 1;
    })()`);
    await sleep(800);
    const r4 = await cdp.eval(`(function(){
      var z = document.querySelector('.prompt-zh');
      var d = document.getElementById('translationDate');
      return { zh: z ? z.innerText.trim().length : 0, date: d ? d.innerText.trim() : '' };
    })()`);
    ok('第 57 天有内容', r4.zh > 100, r4.zh + ' 字');
    ok('第 57 天出处正确', /2017/.test(r4.date), r4.date);

    const n = await cdp.eval(`fetch('translation.json').then(r=>r.json()).then(a=>a.length)`);
    ok('translation.json 载入 57 篇', n === 57, String(n));

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
