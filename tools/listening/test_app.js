// 听力页冒烟测试：天数、首日内容、念题提示、音频可播、挖空渲染、提交答案
const fs = require('fs');
const path = require('path');
const { launch, CDP, sleep } = require('./cdp');

const APP = 'http://127.0.0.1:8000/';

const HARD = setTimeout(() => { console.log('!!! 测试超时，强制退出'); process.exit(2); }, 90000);

(async () => {
  const ud = path.join(__dirname, '_chrome_' + Date.now());
  const proc = await launch(ud);
  let cdp;
  const fails = [];
  const ok = (cond, msg, extra) => {
    console.log((cond ? '  OK   ' : '  FAIL ') + msg + (extra ? '  ' + extra : ''));
    if (!cond) fails.push(msg);
  };
  try {
    cdp = await CDP.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    // 页面里的 window.confirm 会卡住渲染线程，导致 evaluate 永远不返回 —— 一律自动确认
    cdp.on('Page.javascriptDialogOpening', function (p) {
      console.log('  [dialog] ' + p.type + ': ' + (p.message || '').slice(0, 40));
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(function () {});
    });
    // 页面里的 window.confirm 会卡住渲染线程，导致 evaluate 永远不返回 —— 一律自动确认
    cdp.on('Page.javascriptDialogOpening', function (p) {
      console.log('  [dialog] ' + p.type + ': ' + (p.message || '').slice(0, 40));
      cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(function () {});
    });
    const bad = [];
    cdp.evs = [];
    await cdp.send('Page.navigate', { url: APP });
    await sleep(2500);

    // 网络 4xx/5xx
    const checkNet = async () => {
      const list = await cdp.eval(`JSON.stringify(performance.getEntriesByType('resource')
        .filter(r => r.responseStatus && r.responseStatus >= 400)
        .map(r => r.name + ' ' + r.responseStatus))`);
      return JSON.parse(list);
    };

    const dayTotal = await cdp.eval(`document.getElementById('dayMeta').textContent`);
    ok(/\/\s*\d+/.test(dayTotal), '顶部天数显示正常', dayTotal);

    // 切到听力页
    await cdp.eval(`document.querySelector('[data-tab="listening"]').click(); true`);
    await sleep(900);

    const title = await cdp.eval(`document.getElementById('listeningDate').textContent`);
    ok(/2025年12月 第一套 · Conversation One/.test(title), 'Day 1 内容正确', title);

    const qHint = await cdp.eval(`(document.querySelector('.q-hint')||{}).textContent || ''`);
    ok(/从念题开始听/.test(qHint), '① 步有念题提示', qHint.replace(/\s+/g, ' ').slice(0, 70));

    const qBtns = await cdp.eval(`document.querySelectorAll('#qList .opt').length`);
    ok(qBtns === 16, '① 步选项渲染（4 题 × 4 项）', '按钮 ' + qBtns);

    // 音频可达 + 时长
    const audio = await cdp.eval(`new Promise(function(res){
      var a = new Audio('audio/seg/2025-12-1_conversationone.mp3');
      a.addEventListener('loadedmetadata', function(){ res({ok:true, dur:a.duration}); });
      a.addEventListener('error', function(){ res({ok:false, dur:0}); });
      setTimeout(function(){ res({ok:false, dur:-1}); }, 8000);
    })`);
    ok(audio.ok && Math.abs(audio.dur - 204.62) < 1.5, '音频可加载且时长对',
      'dur=' + (audio.dur || 0).toFixed(2) + ' 期望 204.62');

    // ② 步挖空
    await cdp.eval(`document.querySelector('[data-act="step"][data-step="2"]').click(); true`);
    await sleep(700);
    const inputs = await cdp.eval(`document.querySelectorAll('#clozeList .cloze-in').length`);
    ok(inputs > 5, '② 步挖空渲染', inputs + ' 个空');

    // ③ 步原文
    await cdp.eval(`document.querySelector('[data-act="step"][data-step="3"]').click(); true`);
    await sleep(700);
    const rows = await cdp.eval(`document.querySelectorAll('#stepBody .full-line').length`);
    const zhN = await cdp.eval(`document.querySelectorAll('#stepBody .full-line .zh').length`);
    ok(rows >= 20 && zhN === rows, '③ 步原文 + 译文渲染', '行 ' + rows + ' 译文 ' + zhN);

    // 把备考天数调到 77，再看最后一天
    await cdp.eval(`(function(){ var i=document.getElementById('totalDays');
      i.value=77; i.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(800);
    const dayTotal2 = await cdp.eval(`document.getElementById('dayMeta').textContent`);
    ok(/\/\s*77/.test(dayTotal2), '备考天数可调到 77', dayTotal2);

    // 跳到第 77 天
    await cdp.eval(`(function(){
      var b = document.getElementById('prevDay');
      for (var i = 0; i < 200; i++) b.click();
      return true;
    })()`);
    await sleep(600);
    await cdp.eval(`(function(){
      var b = document.getElementById('nextDay');
      for (var i = 0; i < 76; i++) b.click();
      return true;
    })()`);
    await sleep(1200);
    await cdp.eval(`document.querySelector('[data-tab="listening"]').click(); true`);
    await sleep(800);
    const t77 = await cdp.eval(`document.getElementById('listeningDate').textContent`);
    const d77 = await cdp.eval(`document.getElementById('dayNum').textContent`);
    ok(/2023年6月 第二套 · Recording Three/.test(t77), 'Day 77 内容正确', 'day=' + d77 + ' ' + t77);

    const audio77 = await cdp.eval(`new Promise(function(res){
      var a = new Audio('audio/seg/2023-06-2_recordingthree.mp3');
      a.addEventListener('loadedmetadata', function(){ res({ok:true, dur:a.duration}); });
      a.addEventListener('error', function(){ res({ok:false, dur:0}); });
      setTimeout(function(){ res({ok:false, dur:-1}); }, 8000);
    })`);
    ok(audio77.ok && Math.abs(audio77.dur - 262.6) < 1.5, 'Day 77 音频可加载',
      'dur=' + (audio77.dur || 0).toFixed(2) + ' 期望 262.6');

    const errs = await cdp.eval(`JSON.stringify((window.__errs||[]).slice(0,5))`);
    ok(errs === '[]', '无 JS 异常', errs);

    const net4xx = await checkNet();
    ok(net4xx.length === 0, '无 4xx/5xx 资源', JSON.stringify(net4xx.slice(0, 4)));

    console.log('\n失败项 ' + fails.length);
    clearTimeout(HARD);
  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch (e) {}
    await sleep(500);
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
