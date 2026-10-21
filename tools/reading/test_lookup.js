// 取词浮层冒烟测试：
//   1. 点一个单词 → 单词卡（音标 / 词性 / 发音按钮 / 生词本按钮）
//   2. 只选中一个单词 → 也必须走单词卡，不能退化成只有译文的自选取词浮层
//   3. 选中一段文字 → 自选取词浮层，带朗读按钮
const path = require('path');
const { launch, CDP, sleep } = require('../listening/cdp.js');

const URL = 'http://127.0.0.1:8124/index.html';
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
}

// 在页内造一个选区并松手，模拟"鼠标拖选/双击"完成的那一刻
const SELECT_JS = `
window.__selWords = function (a, b) {
  var box = document.getElementById('passageBox');
  var ws = [].slice.call(box.querySelectorAll('.w'));
  var r = document.createRange();
  if (b === undefined) { r.selectNodeContents(ws[a]); }
  else { r.setStartBefore(ws[a]); r.setEndAfter(ws[b]); }
  var s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
  return s.toString();
};
window.__pop = function () {
  var d = document.getElementById('dictPop');
  var s = document.getElementById('selPop');
  var q = function (sel) { var e = d.querySelector(sel); return e ? e.textContent.trim() : ''; };
  return {
    dictOn: d && !d.classList.contains('hidden'),
    selOn: s && !s.classList.contains('hidden'),
    word: q('.dp-word'),
    pos: q('.dp-pos'),
    ipa: q('.dp-ipa'),
    zh: q('.dp-zh'),
    hasSpeak: !!d.querySelector('[data-speak]'),
    hasVocab: !!d.querySelector('[data-vocab]'),
    selSpeak: s ? !!s.querySelector('.sp-speak') : false,
    selSrc: s ? (s.querySelector('.sp-src') || {}).textContent || '' : ''
  };
};
`;

(async () => {
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
    await cdp.eval(`document.querySelector('[data-tab="reading"]').click(); 1`);
    await sleep(700);
    await cdp.eval(SELECT_JS);

    // 找一个本地词典确实收录了的词，这样才能断言音标和词性
    const pick = await cdp.eval(`(async function(){
      var w = await (await fetch('words.json')).json();
      var d = await (await fetch('dict.json')).json();
      var have = Object.create(null);
      w.forEach(function (x) { have[x.en.toLowerCase()] = 1; });
      (d.words || []).forEach(function (x) { have[x.en.toLowerCase()] = 1; });
      var box = document.getElementById('passageBox');
      var ws = [].slice.call(box.querySelectorAll('.w'));
      for (var i = 0; i < ws.length; i++) {
        if (have[ws[i].textContent.toLowerCase()]) return { idx: i, word: ws[i].textContent };
      }
      return null;
    })()`);
    ok('正文里能找到本地词典收录的词', !!pick, pick && pick.word);

    // ---- 1. 单击取词 ----
    await cdp.eval(`(function(){
      var box = document.getElementById('passageBox');
      var ws = box.querySelectorAll('.w');
      window.getSelection().removeAllRanges();
      ws[${pick ? pick.idx : 0}].click();
      return 1;
    })()`);
    await sleep(250);
    let p = await cdp.eval(`window.__pop()`);
    ok('单击单词弹出单词卡', p.dictOn, JSON.stringify(p));
    ok('单词卡显示词性', !!p.pos, p.pos || '(空)');
    ok('单词卡显示音标', !!p.ipa, p.ipa || '(空)');
    ok('单词卡有发音按钮', p.hasSpeak);
    ok('单词卡有生词本按钮', p.hasVocab);

    // ---- 2. 只选中一个单词 ----
    await cdp.eval(`(function(){
      document.getElementById('dictPop').classList.add('hidden');
      window.__selWords(${pick ? pick.idx : 0});
      return 1;
    })()`);
    await sleep(300);
    p = await cdp.eval(`window.__pop()`);
    ok('选中单个单词也走单词卡', p.dictOn && !p.selOn, JSON.stringify(p));
    ok('选中单个单词仍带词性/音标/发音',
      !!p.pos && !!p.ipa && p.hasSpeak, [p.pos, p.ipa, p.hasSpeak].join('|'));

    // ---- 3. 只收录在补充词典（dict_extra.json）里的词 ----
    // 后台懒加载，点开后卡片会自己补上音标/词性，所以要等一会儿
    const extra = await cdp.eval(`(async function(){
      var w = await (await fetch('words.json')).json();
      var d = await (await fetch('dict.json')).json();
      var e = await (await fetch('dict_extra.json')).json();
      var have = Object.create(null);
      w.forEach(function (x) { have[x.en.toLowerCase()] = 1; });
      (d.words || []).forEach(function (x) { have[x.en.toLowerCase()] = 1; });
      var extraSet = Object.create(null);
      (e.words || []).forEach(function (x) { extraSet[x.en.toLowerCase()] = 1; });
      var ws = [].slice.call(document.querySelectorAll('#passageBox .w'));
      for (var i = 0; i < ws.length; i++) {
        var k = ws[i].textContent.toLowerCase();
        if (!have[k] && extraSet[k]) return { idx: i, word: ws[i].textContent };
      }
      return null;
    })()`);
    ok('正文里能找到只靠补充词典才有的词', !!extra, extra && extra.word);

    if (extra) {
      await cdp.eval(`(function(){
        document.getElementById('dictPop').classList.add('hidden');
        window.getSelection().removeAllRanges();
        document.querySelectorAll('#passageBox .w')[${extra.idx}].click();
        return 1;
      })()`);
      await sleep(3000);
      p = await cdp.eval(`window.__pop()`);
      ok('补充词典的词也有词性和音标（离线，不靠在线接口）',
        !!p.pos && !!p.ipa, [p.word, p.pos, p.ipa, p.zh.slice(0, 20)].join(' | '));
      ok('补充词典的词有中文释义', /[\u4e00-\u9fa5]/.test(p.zh), p.zh.slice(0, 30));
    }

    // ---- 4. 选中一段文字 ----
    await cdp.eval(`(function(){
      document.getElementById('dictPop').classList.add('hidden');
      window.getSelection().removeAllRanges();
      window.__selWords(4, 7);
      return 1;
    })()`);
    await sleep(400);
    p = await cdp.eval(`window.__pop()`);
    ok('选中一段文字弹出取词浮层', p.selOn, JSON.stringify(p));
    ok('取词浮层有朗读按钮', p.selSpeak);
    ok('取词浮层显示选中的原文', p.selSrc.split(/\s+/).length >= 2, p.selSrc);
  } finally {
    try { await cdp.quit(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
  }

  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.error(e && e.stack || e);
  process.exit(1);
});
