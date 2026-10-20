// 阅读模块冒烟测试：57 篇真题是否真的渲染出来、长难句是否是原文子串、解析能否展开
const { launch, CDP, sleep } = require('../listening/cdp.js');

const URL = 'http://127.0.0.1:8124/index.html';
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

(async () => {
  const proc = await launch('C:/Users/WuLinX/WorkBuddy AI/2026-10-18-16-15-19/cet6-app/_probe/chrome');
  const cdp = await CDP.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Page.javascriptDialogOpening', () =>
    cdp.send('Page.handleJavaScriptDialog', { accept: true }));

  try {
    await cdp.send('Page.navigate', { url: URL });
    await sleep(2500);

    // 直接进阅读页
    await cdp.eval(`(function(){
      document.querySelector('[data-tab="reading"]').click();
      return 1;
    })()`);
    await sleep(600);

    const r1 = await cdp.eval(`(function(){
      var p = document.getElementById('passageBox');
      var s = document.getElementById('sentenceBox');
      var d = document.getElementById('readingDate');
      return {
        words: p ? p.innerText.trim().split(/\\s+/).length : 0,
        sent: s ? s.innerText.trim() : '',
        passage: p ? p.innerText.trim() : '',
        date: d ? d.innerText.trim() : '',
        hasBtn: !!document.querySelector('[data-act="analysis"]')
      };
    })()`);

    ok('阅读正文渲染出 300 词以上', r1.words > 300, r1.words + ' 词');
    ok('长难句非空', r1.sent.length > 40, r1.sent.slice(0, 50));
    ok('长难句是正文的连续子串',
      r1.passage.replace(/\s+/g, ' ').indexOf(r1.sent.replace(/\s+/g, ' ')) >= 0);
    ok('出处标签含年月与套数', /·.*年.*月.*套/.test(r1.date), r1.date);
    ok('有“显示解析”按钮', r1.hasBtn);

    // 展开解析
    const r2 = await cdp.eval(`(function(){
      document.querySelector('[data-act="analysis"]').click();
      var a = document.querySelector('[data-role="analysis"]');
      return { hidden: a.classList.contains('hidden'), len: a.innerText.trim().length };
    })()`);
    ok('解析可以展开', !r2.hidden);
    ok('解析内容超过 300 字', r2.len > 300, r2.len + ' 字');

    // 跳到第 57 天，确认最后一篇也正常
    await cdp.eval(`(function(){
      var b = document.querySelector('[data-days="57"]');
      if (b) b.click();
      var n = document.getElementById('nextDay');
      for (var i = 0; i < 60; i++) {
        if (n.disabled) break;
        n.click();
      }
      return 1;
    })()`);
    await sleep(800);
    const r4 = await cdp.eval(`(function(){
      var p = document.getElementById('passageBox');
      var s = document.getElementById('sentenceBox');
      var d = document.getElementById('readingDate');
      return {
        words: p ? p.innerText.trim().split(/\\s+/).length : 0,
        sent: s ? s.innerText.trim() : '',
        date: d ? d.innerText.trim() : ''
      };
    })()`);
    ok('第 57 天有内容', r4.words > 300, r4.words + ' 词');
    ok('第 57 天出处正确', /2016/.test(r4.date), r4.date);

    // 内容池长度（DATA 在 IIFE 里，页面外拿不到，直接数 JSON）
    const n = await cdp.eval(`fetch('reading.json').then(r=>r.json()).then(a=>a.length)`);
    ok('reading.json 载入 57 篇', n === 57, String(n));

    console.log('\\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  } catch (e) {
    console.log('异常: ' + e.message);
    fail++;
  } finally {
    cdp.close();
    try { proc.kill(); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})();
