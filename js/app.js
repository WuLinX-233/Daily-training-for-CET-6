/* =========================================================================
   CET-6 每日训练 —— 主逻辑（纯前端，无框架、无构建）
   -------------------------------------------------------------------------
   【改词库】      编辑 words.json：{"en","zh","pos","us","level"}
                   us 是美式音标（不带斜杠），pos 是词性，zh 是中文释义
   【加新一天内容】在 reading.json / listening.json / translation.json
                   末尾各追加一条对象即可。
                   ★ 数组顺序 = 第几天（第 1 条就是 Day 1），date 字段只用于显示
   【加音频】      mp3 放进 audio/，listening.json 的 "audio" 写相对路径
   【加原文】      listening.json 的 "lines": ["第一行", "第二行", ...]
   【阅读取词词典】dict.json：words = 常用词补充，phrases = 词组/固定搭配
   【清空本机进度】浏览器控制台：localStorage.removeItem('cet6.v1')
   ========================================================================= */

(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  var STORE_KEY = 'cet6.v1';
  var DEFAULT_COUNT = 20;
  var DEFAULT_DAYS = 57;          // 默认备考天数（可在设置里改）
  var TABS = ['words', 'reading', 'listening', 'intensive', 'translation', 'vocab'];
  var SPEAK_API = 'https://dict.youdao.com/dictvoice?type=2&audio=';   // type=2 → 美式发音
  var ONLINE_DICT = 'https://api.dictionaryapi.dev/api/v2/entries/en/'; // 本地未收录时的兜底
  var YOUDAO_PAGE = 'https://dict.youdao.com/result?lang=en&word=';

  // 发音按钮图标（内联 SVG，避免 emoji 在不同系统上渲染不一致）
  var ICON_SPEAK = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">' +
    '<path d="M4 9.5v5h3.6l4.6 3.7V5.8L7.6 9.5H4z" fill="currentColor"/>' +
    '<path d="M15.8 8.6a4.8 4.8 0 0 1 0 6.8M18.6 6a8.4 8.4 0 0 1 0 12" fill="none" ' +
    'stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  /* ---------- 运行时数据 ---------- */
  var DATA = { words: [], reading: [], listening: [], translation: [], dict: { words: [], phrases: [] } };
  var WORD_MAP = Object.create(null);   // en -> 词条（words.json）
  var DICT_MAP = Object.create(null);   // en -> 词条（dict.json 的常用词）
  var PHRASE_MAP = Object.create(null); // "in other words" -> 词组条目
  // 词库排序版本：2 = 真题高频词排在最前（tools/mark-high-freq.py 生成）
  // 改了 words.json 的顺序就把这个数字 +1，旧进度里的 cursor 会自动归零重来
  var WORDS_ORDER = 2;
  var HF_N = 0;                          // 高频词个数（= 前 HF_N 条）
  var HF_SET = Object.create(null);      // en -> 1，判断某个词是不是高频
  // 每日听力素材版本：改了 listening.json 的篇目/顺序就 +1，
  // 旧进度（state.listening 按天号存）会整块作废，避免「第 3 天显示已完成、内容却换了」
  var LISTEN_VER = 2;
  var state = null;
  var revealed = false;
  var currentTab = 'words';
  var popToken = 0;                        // 取词请求序号，防止旧结果覆盖新卡片

  /* =====================================================================
     一、小工具
     ===================================================================== */
  function $(id) { return document.getElementById(id); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function dayDiff(a, b) {
    if (!a || !b) return 0;
    var pa = String(a).split('-'), pb = String(b).split('-');
    return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  // 内容池大小：reading / listening / translation 里最长的那份
  function contentDays() {
    return Math.max(DATA.reading.length, DATA.listening.length, DATA.translation.length);
  }

  // 第几天取哪条素材：素材不够就循环（第 13 天回到第 1 条），永远有内容
  function pickByDay(list, day) {
    if (!Array.isArray(list) || !list.length) return null;
    if (day < 1) day = 1;
    return list[(day - 1) % list.length];
  }

  // 现在是第几轮（素材循环了几遍）：1 = 第一遍，2 = 二刷
  function roundOf(day) {
    var n = contentDays();
    if (!n) return 1;
    return Math.floor(((day || 1) - 1) / n) + 1;
  }

  // 二刷提示条
  function cycleNote() {
    var r = roundOf(state.day);
    if (r <= 1) return '';
    return '<p class="cycle-note">第 ' + r + ' 轮：素材只有 ' + contentDays() +
      ' 天，往后自动循环复用（二刷、三刷）。想换新内容，往 reading.json / listening.json / translation.json 末尾追加即可。</p>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function optionLetter(i) { return String.fromCharCode(65 + i); }

  function stripLetterPrefix(text, letter) {
    return String(text == null ? '' : text).trim()
      .replace(new RegExp('^' + letter + '\\s*[.、,:：)）]\\s*'), '');
  }

  function answerLetter(ans, options) {
    if (typeof ans === 'number') return optionLetter(ans);
    var s = String(ans == null ? '' : ans).trim();
    if (/^[A-Za-z]$/.test(s)) return s.toUpperCase();
    var idx = (options || []).indexOf(s);
    if (idx >= 0) return optionLetter(idx);
    var m = s.match(/^([A-Za-z])\b/);
    return m ? m[1].toUpperCase() : '';
  }

  /* =====================================================================
     二、本地存储
     ===================================================================== */
  function defaultState() {
    return {
      settings: { startDate: todayStr(), dailyCount: DEFAULT_COUNT, autoSpeak: true, totalDays: DEFAULT_DAYS },
      day: 1,
      lastAutoDay: 1,
      words: { cursor: 0, order: WORDS_ORDER, known: {}, unknown: {}, deck: null },
      listenVer: LISTEN_VER,
      listening: {},
      translation: {},
      vocab: {}
    };
  }

  function loadState() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { saved = null; }
    var d = defaultState();
    if (!saved || typeof saved !== 'object') return d;

    var words = Object.assign(d.words, saved.words || {});
    // 词库顺序变了（比如这版把高频词挪到了最前）：cursor 归零、当天这组重抽，
    // 但已掌握 / 待复习的标记全部保留。
    // 注意要比 saved.words 里的原值：defaultState 已经带了新版本号，合并后就看不出来了
    if (!saved.words || saved.words.order !== WORDS_ORDER) {
      words.order = WORDS_ORDER;
      words.cursor = 0;
      words.deck = null;
    }

    return {
      settings: Object.assign(d.settings, saved.settings || {}),
      day: saved.day || 1,
      lastAutoDay: saved.lastAutoDay || 1,
      words: words,
      // 素材换过一轮（篇目/顺序变了），旧的按天号存的听力进度就对应不上了，整块清掉
      listenVer: LISTEN_VER,
      listening: saved.listenVer === LISTEN_VER ? (saved.listening || {}) : {},
      translation: saved.translation || {},
      vocab: (saved.vocab && typeof saved.vocab === 'object') ? saved.vocab : {}
    };
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 忽略 */ }
  }

  /* =====================================================================
     三、加载数据
     ===================================================================== */
  function loadJson(name) {
    return fetch(name + '.json', { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error(name + '.json 加载失败（HTTP ' + res.status + '）');
      return res.json();
    });
  }

  function loadAll() {
    return Promise.all([
      loadJson('words'), loadJson('reading'), loadJson('listening'),
      loadJson('translation'), loadJson('dict')
    ]).then(function (arr) {
      DATA.words = Array.isArray(arr[0]) ? arr[0] : [];
      DATA.reading = Array.isArray(arr[1]) ? arr[1] : [];
      DATA.listening = Array.isArray(arr[2]) ? arr[2] : [];
      DATA.translation = Array.isArray(arr[3]) ? arr[3] : [];
      DATA.dict = (arr[4] && typeof arr[4] === 'object') ? arr[4] : { words: [], phrases: [] };

      DATA.words.forEach(function (w) { if (w && w.en) WORD_MAP[w.en.toLowerCase()] = w; });
      countHighFreq();
      (DATA.dict.words || []).forEach(function (w) { if (w && w.en) DICT_MAP[w.en.toLowerCase()] = w; });
      (DATA.dict.phrases || []).forEach(function (p) {
        if (p && p.en) PHRASE_MAP[p.en.toLowerCase().replace(/\s+/g, ' ').trim()] = p;
      });
    });
  }

  /* =====================================================================
     四、天数
     ===================================================================== */
  function countHighFreq() {
    HF_N = 0;
    HF_SET = Object.create(null);
    DATA.words.forEach(function (w) {
      if (w && w.hf && w.en) { HF_SET[w.en.toLowerCase()] = 1; HF_N++; }
    });
  }

  function dailyCount() {
    var n = parseInt(state.settings.dailyCount, 10);
    if (isNaN(n)) n = DEFAULT_COUNT;
    return clamp(n, 1, 200);
  }

  function totalDays() {
    // 总天数 = 设置里填的备考天数；没填过就退回"素材天数"
    var n = parseInt(state.settings.totalDays, 10);
    if (!isNaN(n) && n > 0) return clamp(n, 1, 365);
    var byContent = contentDays();
    if (byContent > 0) return byContent;
    return DATA.words.length ? Math.max(1, Math.ceil(DATA.words.length / dailyCount())) : 1;
  }

  // 改备考天数：当天超出范围就拉回来，其余进度不动
  function setTotalDays(n) {
    n = clamp(parseInt(n, 10) || DEFAULT_DAYS, 1, 365);
    state.settings.totalDays = n;
    state.day = clamp(state.day || 1, 1, n);
    save();
    renderAll();
  }

  // 第 N 天对应的日历日期（startDate + N-1 天）
  function dateOfDay(day) {
    var s = state.settings.startDate;
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—';
    var p = s.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + ((day || 1) - 1) * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function initDay() {
    var auto = clamp(dayDiff(state.settings.startDate, todayStr()) + 1, 1, totalDays());
    if (auto > state.lastAutoDay && auto > state.day) {
      state.day = auto;
      state.lastAutoDay = auto;
    }
    state.day = clamp(state.day || 1, 1, totalDays());
    save();
  }

  function setDay(n) {
    state.day = clamp(n, 1, totalDays());
    closeDict();
    save();
    renderAll();
  }

  /* =====================================================================
     五、发音（有道词典发音接口，type=2 为美音；不需要后端）
     ===================================================================== */
  var audioEl = null;
  var audioFailed = false;

  function speak(text, btn) {
    if (!text) return;
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.preload = 'auto';
    }
    audioEl.onerror = function () {
      audioFailed = true;
      if (btn) btn.classList.add('fail');
    };
    audioEl.src = SPEAK_API + encodeURIComponent(text);
    var p = audioEl.play();
    if (p && typeof p.catch === 'function') {
      p.catch(function () { if (btn) btn.classList.add('fail'); });
    }
    if (btn) {
      btn.classList.remove('fail');
      btn.classList.add('playing');
      setTimeout(function () { btn.classList.remove('playing'); }, 600);
    }
  }

  /* =====================================================================
     六、词典（阅读取词）
     ---------------------------------------------------------------------
     查词顺序：词组 → words.json → dict.json → 词形还原再查 → 在线词典兜底
     ===================================================================== */

  // 不规则变化表
  var IRREGULAR = {
    found: 'find', left: 'leave', took: 'take', taken: 'take', went: 'go', gone: 'go',
    has: 'have', had: 'have', is: 'be', are: 'be', was: 'be', were: 'be', been: 'be',
    being: 'be', did: 'do', does: 'do', done: 'do', said: 'say', made: 'make',
    came: 'come', saw: 'see', seen: 'see', got: 'get', gotten: 'get', gave: 'give',
    given: 'give', knew: 'know', known: 'know', thought: 'think', brought: 'bring',
    bought: 'buy', caught: 'catch', taught: 'teach', told: 'tell', felt: 'feel',
    kept: 'keep', held: 'hold', lost: 'lose', met: 'meet', paid: 'pay', sent: 'send',
    spent: 'spend', stood: 'stand', understood: 'understand', won: 'win', wrote: 'write',
    written: 'write', children: 'child', men: 'man', women: 'woman', feet: 'foot',
    teeth: 'tooth', mice: 'mouse', lives: 'life', wives: 'wife', knives: 'knife',
    better: 'good', best: 'good', worse: 'bad', worst: 'bad'
  };

  // 生成可能的原形候选（按可能性排序）
  function lemmaCandidates(w) {
    var out = [];
    function add(x) { if (x && x.length > 1 && out.indexOf(x) < 0) out.push(x); }

    if (IRREGULAR[w]) add(IRREGULAR[w]);

    if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ves$/.test(w)) { add(w.slice(0, -3) + 'f'); add(w.slice(0, -3) + 'fe'); }
    if (/(ses|xes|zes|ches|shes)$/.test(w)) add(w.slice(0, -2));
    if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
    if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ed$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
    if (/ing$/.test(w)) {
      var base = w.slice(0, -3);
      add(base); add(base + 'e');
      if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) add(base.slice(0, -1));
    }
    if (/ier$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/est$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -2)); }
    if (/er$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
    if (/ily$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ly$/.test(w)) add(w.slice(0, -2));
    return out;
  }

  function findEntry(raw) {
    var key = String(raw || '').toLowerCase().replace(/^[^a-z]+|[^a-z'-]+$/g, '');
    if (!key) return null;

    var ph = PHRASE_MAP[key];
    if (ph) return { type: 'phrase', en: ph.en, zh: ph.zh, usage: ph.usage, word: key };

    if (WORD_MAP[key]) return { type: 'word', en: WORD_MAP[key].en, zh: WORD_MAP[key].zh, pos: WORD_MAP[key].pos, us: WORD_MAP[key].us, word: key };
    if (DICT_MAP[key]) return { type: 'word', en: DICT_MAP[key].en, zh: DICT_MAP[key].zh, pos: DICT_MAP[key].pos, us: DICT_MAP[key].us, word: key };

    var cands = lemmaCandidates(key);
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var src = WORD_MAP[c] || DICT_MAP[c];
      if (src) {
        return { type: 'word', en: src.en, zh: src.zh, pos: src.pos, us: src.us, word: key, lemma: c };
      }
    }
    return null;
  }

  // 本地查不到 → 在线词典（只补音标 + 英文释义 + 发音，失败就显示未收录）
  function onlineLookup(word) {
    var url = ONLINE_DICT + encodeURIComponent(word);
    return fetch(url, { cache: 'force-cache' }).then(function (res) {
      if (!res.ok) throw new Error('404');
      return res.json();
    }).then(function (arr) {
      if (!Array.isArray(arr) || !arr.length) throw new Error('empty');
      var e = arr[0];
      var ipa = e.phonetic || '';
      var audio = '';
      (e.phonetics || []).forEach(function (p) {
        if (!ipa && p.text) ipa = p.text;
        if (p.audio && /-us\.mp3$/i.test(p.audio)) audio = p.audio;
        if (p.audio && !audio) audio = p.audio;
      });
      var m = (e.meanings || [])[0] || {};
      var def = (m.definitions || [])[0] || {};
      return {
        ipa: String(ipa || '').replace(/^\/+|\/+$/g, ''),   // 在线接口常自带斜杠，去掉避免 //...//
        pos: m.partOfSpeech || '',
        def: def.definition || '',
        example: def.example || '',
        audio: audio
      };
    });
  }

  /* ---------- 取词浮层 ---------- */
  var popCtx = '';        // 这次取词所在的句子（存进生词本，复习时能看回原句）
  var popExtra = null;    // 本地没收录时，在线词典补到的释义/音标

  function closeDict() {
    var pop = $('dictPop');
    if (!pop) return;
    pop.classList.add('hidden');
    pop.innerHTML = '';
    var act = document.querySelector('.w.active');
    if (act) act.classList.remove('active');
    popToken++;
  }

  // 取词浮层统一由 paintPop 输出：正文 + 底部的「加入生词本」按钮
  function paintPop(pop, html, word) {
    pop.innerHTML = html + vocabBtnHtml(word);
  }

  function openDict(rawText, anchorEl, spanText, keepHighlight) {
    var pop = $('dictPop');
    if (!pop) return;

    var entry = findEntry(spanText || rawText);
    var display = (spanText || rawText || '').trim();
    var token = ++popToken;

    popCtx = contextOf(anchorEl, display);
    popExtra = null;

    if (entry) {
      display = entry.en;
      if (entry.type === 'phrase') {
        paintPop(pop,
          '<div class="dp-head"><span class="dp-word">' + esc(entry.en) + '</span>' +
            '<span class="dp-tag">词组</span>' +
            '<button type="button" class="dp-speak" data-speak="' + esc(entry.en) + '" aria-label="发音">' + ICON_SPEAK + '</button>' +
            '<button type="button" class="dp-close" data-close="1" aria-label="关闭">×</button></div>' +
          '<div class="dp-zh">' + esc(entry.zh || '') + '</div>' +
          (entry.usage ? '<div class="dp-usage"><b>用法</b>' + esc(entry.usage) + '</div>' : ''), display);
      } else {
        paintPop(pop,
          '<div class="dp-head"><span class="dp-word">' + esc(entry.en) + '</span>' +
            (entry.pos ? '<span class="dp-pos">' + esc(entry.pos) + '</span>' : '') +
            '<button type="button" class="dp-speak" data-speak="' + esc(entry.en) + '" aria-label="发音">' + ICON_SPEAK + '</button>' +
            '<button type="button" class="dp-close" data-close="1" aria-label="关闭">×</button></div>' +
          (entry.us ? '<div class="dp-ipa">/' + esc(entry.us) + '/</div>' : '') +
          '<div class="dp-zh">' + esc(entry.zh || '') + '</div>' +
          (entry.lemma ? '<div class="dp-note">原文 ' + esc(entry.word) + ' 是 ' + esc(entry.lemma) + ' 的变化形式</div>' : ''), display);
      }
    } else {
      paintPop(pop,
        '<div class="dp-head"><span class="dp-word">' + esc(display) + '</span>' +
          '<button type="button" class="dp-speak" data-speak="' + esc(display) + '" aria-label="发音">' + ICON_SPEAK + '</button>' +
          '<button type="button" class="dp-close" data-close="1" aria-label="关闭">×</button></div>' +
        '<div class="dp-zh muted">本地词典未收录，正在查在线词典…</div>' +
        '<a class="dp-link" target="_blank" rel="noopener" href="' + YOUDAO_PAGE + encodeURIComponent(display) + '">在网页词典中查看 →</a>', display);

      onlineLookup(display).then(function (r) {
        if (token !== popToken) return;
        popExtra = r;
        paintPop(pop,
          '<div class="dp-head"><span class="dp-word">' + esc(display) + '</span>' +
            (r.pos ? '<span class="dp-pos">' + esc(r.pos) + '</span>' : '') +
            '<button type="button" class="dp-speak" data-speak="' + esc(display) + '" data-audio="' + esc(r.audio || '') + '" aria-label="发音">' + ICON_SPEAK + '</button>' +
            '<button type="button" class="dp-close" data-close="1" aria-label="关闭">×</button></div>' +
          (r.ipa ? '<div class="dp-ipa">/' + esc(r.ipa) + '/</div>' : '') +
          '<div class="dp-zh">' + esc(r.def || '（无释义）') + '</div>' +
          (r.example ? '<div class="dp-usage"><b>例</b>' + esc(r.example) + '</div>' : '') +
          '<div class="dp-note">来源：在线词典（英文释义）</div>' +
          '<a class="dp-link" target="_blank" rel="noopener" href="' + YOUDAO_PAGE + encodeURIComponent(display) + '">在网页词典中查看 →</a>', display);
      }).catch(function () {
        if (token !== popToken) return;
        paintPop(pop,
          '<div class="dp-head"><span class="dp-word">' + esc(display) + '</span>' +
            '<button type="button" class="dp-speak" data-speak="' + esc(display) + '" aria-label="发音">' + ICON_SPEAK + '</button>' +
            '<button type="button" class="dp-close" data-close="1" aria-label="关闭">×</button></div>' +
          '<div class="dp-zh muted">本地和在线词典都没有查到（可能是专有名词或拼写特殊）。</div>' +
          '<a class="dp-link" target="_blank" rel="noopener" href="' + YOUDAO_PAGE + encodeURIComponent(display) + '">在网页词典中查看 →</a>', display);
      });
    }

    pop.classList.remove('hidden');
    positionDict(anchorEl);

    if (!keepHighlight) {
      var act = document.querySelector('.w.active');
      if (act) act.classList.remove('active');
      if (anchorEl && anchorEl.classList && anchorEl.classList.contains('w')) {
        anchorEl.classList.add('active');
      }
    }
  }

  function positionDict(anchorEl) {
    var pop = $('dictPop');
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    if (vw < 640 || !anchorEl) {          // 手机：底部弹层，永远不被裁切
      pop.classList.add('sheet');
      pop.style.left = '';
      pop.style.top = '';
      pop.style.width = '';
      return;
    }
    pop.classList.remove('sheet');
    var r = anchorEl.getBoundingClientRect();
    var w = Math.min(360, vw - 24);
    pop.style.width = w + 'px';

    var sx = window.scrollX, sy = window.scrollY;
    var left = clamp(r.left + sx - 16, sx + 8, sx + vw - w - 8);
    pop.style.left = left + 'px';

    var below = r.bottom + sy + 10;
    pop.style.top = below + 'px';
    var h = pop.offsetHeight;
    if (r.bottom + 10 + h > vh - 8) {
      pop.style.top = Math.max(sy + 8, r.top + sy - h - 10) + 'px';
    }
  }

  /* =====================================================================
     七、自由取词（选中多少就翻译多少）
     ---------------------------------------------------------------------
     用鼠标（手机上是长按拖选）在正文里选中任意一段文字，松手就翻译整段。
     单句 / 半个句子 / 词组都行；选中一个单词时仍然走原来的取词卡片。
     翻译源：MyMemory（免费、带 CORS，不需要后端和 key）。
     ===================================================================== */
  var SEL = { cache: Object.create(null), timer: 0, last: '', token: 0, rect: null };

  function selAllowed(sel) {
    var node = sel.anchorNode;
    if (!node) return false;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest) return false;
    if (el.closest('input, textarea, select, button, #selPop, #dictPop')) return false;
    return !!el.closest('#main');
  }

  function selText() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) return '';
    if (!selAllowed(sel)) return '';
    return String(sel.toString() || '').replace(/\s+/g, ' ').trim();
  }

  function selRect(sel) {
    try {
      var r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && (r.width || r.height)) return r;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function closeSelPop() {
    var pop = $('selPop');
    if (!pop) return;
    pop.classList.add('hidden');
    pop.innerHTML = '';
    SEL.last = '';
    SEL.token++;
  }

  // 拆掉 MyMemory 返回里的 <bx id="1"/> 之类标记和 HTML 实体
  function cleanMT(t) {
    return String(t || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ').replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  function translateText(text) {
    var url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
              '&langpair=' + encodeURIComponent('en|zh-CN');
    return fetch(url, { cache: 'force-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (j) {
      if (j && j.quotaFinished) throw new Error('今天的翻译额度用完了');
      var raw = j && j.responseData && j.responseData.translatedText;
      var t = cleanMT(raw);
      if (!t) throw new Error('没有返回译文');
      if (/MYMEMORY WARNING/i.test(t)) throw new Error('今天的翻译额度用完了');
      if (t.toLowerCase() === text.toLowerCase()) throw new Error('没拿到中文译文');
      return t;
    });
  }

  function openSelPop(text, rect) {
    var pop = $('selPop');
    if (!pop) return;
    closeDict();

    var token = ++SEL.token;
    SEL.last = text;
    SEL.rect = rect;

    var words = text.split(/\s+/).filter(Boolean).length;
    var canVocab = words <= 4 && text.length <= 60;

    pop.innerHTML =
      '<div class="sp-head">' +
        '<span class="sp-src">' + esc(text) + '</span>' +
        '<button type="button" class="sp-close" data-sp="close" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="sp-zh loading" id="spZh">翻译中…</div>' +
      '<div class="sp-acts">' +
        '<button type="button" data-sp="copy">复制译文</button>' +
        '<button type="button" data-sp="dict">网页词典</button>' +
        (canVocab ? '<button type="button" data-sp="vocab">＋ 生词本</button>' : '') +
      '</div>';

    pop.classList.remove('hidden');
    positionSelPop(pop, rect);

    var hit = SEL.cache[text];
    if (hit) { setSelZh(hit); return; }

    // 只选中一个单词：本地词典有就直接给释义，比机翻准
    if (/^[A-Za-z][A-Za-z'-]*$/.test(text)) {
      var local = findEntry(text);
      if (local && local.zh) {
        SEL.cache[text] = local.zh;
        setSelZh(local.zh);
        return;
      }
    }

    translateText(text).then(function (zh) {
      SEL.cache[text] = zh;
      if (token !== SEL.token) return;
      setSelZh(zh);
    }).catch(function (err) {
      if (token !== SEL.token) return;
      setSelZh('翻译失败：' + ((err && err.message) || '网络不通') +
        '。可以点「网页词典」查这段，或稍后再试。', true);
    });
  }

  function setSelZh(zh, isErr) {
    var el = $('spZh');
    if (!el) return;
    el.textContent = zh;
    el.className = 'sp-zh' + (isErr ? ' err' : '');
    var pop = $('selPop');
    if (pop && SEL.rect) positionSelPop(pop, SEL.rect);   // 内容变长了重新定位
  }

  function positionSelPop(pop, rect) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    if (vw < 640 || !rect) {
      pop.classList.add('sheet');
      pop.style.left = '';
      pop.style.top = '';
      pop.style.width = '';
      return;
    }
    pop.classList.remove('sheet');
    var w = Math.min(380, vw - 24);
    pop.style.width = w + 'px';
    var left = clamp(rect.left + rect.width / 2 - w / 2, 8, vw - w - 8);
    pop.style.left = left + 'px';
    pop.style.top = (rect.bottom + 8) + 'px';
    var h = pop.offsetHeight;
    if (rect.bottom + 8 + h > vh - 8) {
      pop.style.top = Math.max(8, rect.top - h - 8) + 'px';
    }
  }

  // 松手 / 选区稳定后判断要不要弹
  function maybeShowSel() {
    var sel = window.getSelection();
    var text = selText();
    if (!text || text.length < 2) {
      closeSelPop();
      return;
    }
    if (text === SEL.last) return;
    if (text.length > 400) text = text.slice(0, 400);
    var rect = selRect(sel);
    if (!rect) return;
    openSelPop(text, rect);
  }

  function bindSelectionEvents() {
    var pop = $('selPop');
    if (!pop) return;

    // 点浮层里的按钮时别把选区弄没（否则 selectionchange 会立刻把浮层关掉）
    pop.addEventListener('mousedown', function (e) { e.preventDefault(); });

    pop.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-sp]');
      if (!btn) return;
      e.stopPropagation();
      var act = btn.getAttribute('data-sp');
      var zhEl = $('spZh');

      if (act === 'close') { closeSelPop(); return; }
      if (act === 'copy') {
        var txt = zhEl ? zhEl.textContent : '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(function () {
            btn.textContent = '已复制';
            setTimeout(function () { btn.textContent = '复制译文'; }, 1200);
          }).catch(function () { btn.textContent = '复制失败'; });
        } else {
          btn.textContent = '长按译文复制';
        }
        return;
      }
      if (act === 'dict') {
        window.open(YOUDAO_PAGE + encodeURIComponent(SEL.last), '_blank', 'noopener');
        return;
      }
      if (act === 'vocab') {
        var en = SEL.last;
        if (vocabHas(en)) {
          vocabRemove(en);
          btn.textContent = '＋ 生词本';
        } else {
          vocabAdd(en, {
            en: en,
            zh: zhEl ? zhEl.textContent : '',
            type: 'phrase',
            ctx: '',
            src: '自由取词'
          });
          btn.textContent = '✓ 已加入';
        }
        renderVocab();
        return;
      }
    });

    document.addEventListener('mouseup', function (e) {
      if (e.button !== 0) return;                       // 只认左键，右键划词走原来的逻辑
      if (e.target.closest && e.target.closest('#selPop')) return;
      setTimeout(maybeShowSel, 10);                     // 等浏览器把选区定下来
    });

    // 手机上长按拖选不会触发 mouseup，靠 selectionchange 兜底（只在触屏设备上生效）
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    document.addEventListener('selectionchange', function () {
      if (!coarse) return;
      if (SEL.timer) clearTimeout(SEL.timer);
      SEL.timer = setTimeout(maybeShowSel, 420);
    });

    document.addEventListener('click', function (e) {
      if (pop.classList.contains('hidden')) return;
      if (pop.contains(e.target)) return;
      closeSelPop();
    }, true);
  }

  /* =====================================================================
     七、单词闪卡
     ===================================================================== */
  function ensureDeck() {
    var w = state.words;
    if (!w.deck || !Array.isArray(w.deck.items) || w.deck.day !== state.day) {
      w.deck = buildDeck(state.day);
      save();
    }
    return w.deck;
  }

  function buildDeck(day) {
    var w = state.words;
    var count = dailyCount();
    var items = [];
    var used = Object.create(null);

    var review = Object.keys(w.unknown).filter(function (en) { return !w.known[en]; });
    review.sort(function (a, b) { return (w.unknown[a] || 0) - (w.unknown[b] || 0); });
    for (var r = 0; r < review.length; r++) {
      if (items.length >= count) break;
      if (used[review[r]]) continue;
      items.push(review[r]);
      used[review[r]] = 1;
    }

    var i = w.cursor || 0;
    while (items.length < count && i < DATA.words.length) {
      // 高频闸门：高频词里还有标了"不认识"没消化的，就先别放行扩展词
      // （哪怕它们今天已经排进这一组，也只是这组少排几个，不会提前上扩展词）
      if (i >= HF_N && hfPending()) break;
      var en = DATA.words[i].en;
      if (en && !w.known[en] && !used[en]) {
        items.push(en);
        used[en] = 1;
      }
      i++;
    }
    w.cursor = i;
    return { day: day, items: items, pos: 0, results: {} };
  }

  // 还有多少高频词没掌握（标了"不认识"、还没转成"认识"）
  function hfPending() {
    if (!HF_N) return 0;
    var ks = Object.keys(state.words.unknown), n = 0;
    for (var i = 0; i < ks.length; i++) {
      if (!state.words.known[ks[i]] && HF_SET[ks[i]]) n++;
    }
    return n;
  }

  function setRevealed(v) {
    revealed = v;
    $('wordZh').classList.toggle('hidden', !v);
    $('wordMeta').classList.toggle('hidden', !v);
    $('wordVocab').classList.toggle('hidden', !v);
    $('wordHint').textContent = v ? '选“认识”或“不认识”' : '点一下卡片看中文 · 听发音';
    $('btnKnown').disabled = !v;
    $('btnUnknown').disabled = !v;
  }

  // 单词卡背面的「加入生词本」按钮：文案随是否已收录变化
  function paintAddVocab(en) {
    var b = $('btnAddVocab');
    if (!b) return;
    var has = vocabHas(en);
    b.setAttribute('data-en', en || '');
    b.textContent = has ? '✓ 已在生词本（点击移出）' : '＋ 加入生词本';
    b.classList.toggle('on', has);
  }

  function renderWords() {
    var deck = ensureDeck();
    var total = deck.items.length;
    var pos = clamp(deck.pos || 0, 0, total);
    var done = pos >= total;

    $('wordProgress').textContent = total ? Math.min(pos + 1, total) + ' / ' + total : '0 / 0';
    $('cardWrap').classList.toggle('hidden', done);
    $('wordDone').classList.toggle('hidden', !done);

    if (done) {
      var right = 0;
      deck.items.forEach(function (en) { if (deck.results[en] === 'known') right++; });
      var hfDone = 0;
      Object.keys(state.words.known).forEach(function (k) { if (state.words.known[k] && HF_SET[k]) hfDone++; });
      var leftHf = hfPending();
      $('wordDoneStat').textContent = total === 0
        ? '今天没有可背的词了：词库已经全部掌握，或者词库是空的。'
        : '本组 ' + total + ' 个词，认识 ' + right + ' 个，不认识 ' + (total - right) +
          ' 个。标了“不认识”的词明天会自动再出现。' +
          (HF_N && hfDone >= HF_N
            ? ' 高频 ' + HF_N + ' 词已经全部掌握，接下来是扩展词。'
            : (leftHf ? ' 高频还有 ' + leftHf + ' 个没掌握，先把它们消化完再进扩展词。' : ''));
    } else {
      var en = deck.items[pos];
      var w = WORD_MAP[String(en).toLowerCase()] || { en: en, zh: '（词库中已找不到这个词）', pos: '', us: '' };
      $('wordEn').textContent = w.en;
      $('wordZh').textContent = w.zh || '';
      $('wordPos').textContent = w.pos || '';
      $('wordIpa').textContent = w.us ? '/' + w.us + '/' : '';
      $('wordLevel').textContent = w.level || '';
      paintFreq(w);
      $('wordSpeak').setAttribute('data-speak', w.en);
      paintAddVocab(w.en);
      setRevealed(false);
    }

    var knownN = 0, hfKnown = 0;
    Object.keys(state.words.known).forEach(function (k) {
      if (state.words.known[k]) { knownN++; if (HF_SET[k]) hfKnown++; }
    });
    var reviewN = Object.keys(state.words.unknown).filter(function (k) { return !state.words.known[k]; }).length;
    var pendingHf = hfPending();
    $('wordStats').textContent = '高频 ' + hfKnown + ' / ' + HF_N +
      ' · 已掌握 ' + knownN + ' / 词库 ' + DATA.words.length +
      ' 词 · 待复习 ' + reviewN + ' 词 · 每天 ' + dailyCount() + ' 词' +
      (pendingHf && (state.words.cursor || 0) >= HF_N
        ? '（高频还剩 ' + pendingHf + ' 个没消化，复习完才进扩展词）'
        : '');

    // 设置里的说明：按"剩下的天数"反推每天该背多少
    var leftDays = Math.max(1, totalDays() - state.day + 1);
    var leftWords = Math.max(0, DATA.words.length - knownN);
    var per = leftWords ? Math.ceil(leftWords / leftDays) : 0;
    $('wordLibNote').innerHTML =
      '词库共 ' + DATA.words.length + ' 词，其中 <b>真题高频 ' + HF_N + ' 词</b>排在最前面，学完才进扩展词。' +
      (per
        ? '按剩下的 ' + leftDays + ' 天算，每天约 <b>' + per + '</b> 个。'
        : '词库已经全部掌握了。') +
      '改动后：本组还没开始答会立刻按新词量重抽，已经开始答则下一组生效。';
  }

  // 卡片上的「高频 / 扩展」徽标：高频词标红，扩展词标灰，鼠标悬停给真题出处
  function paintFreq(w) {
    var fq = $('wordFreq');
    if (!fq) return;
    if (w.hf) {
      fq.className = 'word-freq';
      fq.textContent = '高频';
      fq.title = '2020–2025 真题出现 ' + (w.fc || 0) + ' 次 / ' + (w.fd || 0) + ' 篇';
    } else {
      fq.className = 'word-freq ext';
      fq.textContent = '扩展';
      fq.title = w.fs
        ? '真题里出现得少（' + (w.fc || 0) + ' 次 / ' + (w.fd || 0) + ' 篇），高频词学完再来'
        : '2020–2025 真题没出现过，属于扩展词';
    }
  }

  function answerWord(kind) {
    var deck = state.words.deck;
    if (!deck) return;
    var en = deck.items[deck.pos];
    if (!en) return;

    if (kind === 'known') {
      state.words.known[en] = true;
      delete state.words.unknown[en];
    } else {
      state.words.unknown[en] = state.day;
      delete state.words.known[en];
    }
    deck.results[en] = kind;
    deck.pos = (deck.pos || 0) + 1;

    save();
    renderWords();
  }

  function newDeck() {
    state.words.deck = buildDeck(state.day);
    save();
    renderWords();
  }

  function retryUnknownOfToday() {
    var deck = state.words.deck;
    if (!deck) return;
    var bad = deck.items.filter(function (en) { return deck.results[en] === 'unknown'; });
    if (!bad.length) { alert('本组没有标“不认识”的词。'); return; }
    deck.items = bad;
    deck.pos = 0;
    deck.results = {};
    save();
    renderWords();
  }

  function resetWordProgress() {
    if (!confirm('确定清空所有单词进度（已掌握 + 待复习）吗？此操作不可撤销。')) return;
    state.words = { cursor: 0, known: {}, unknown: {}, deck: null };
    save();
    renderWords();
  }

  /* =====================================================================
     八、每日阅读（支持右键取词 / 按住右键划词 / 手机上点词）
     ===================================================================== */
  function tokenize(text) {
    var src = String(text || '');
    var out = '';
    var last = 0;
    var re = /[A-Za-z][A-Za-z'\u2019-]*/g;
    var m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      out += '<span class="w" data-w="' + esc(m[0]) + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    out += esc(src.slice(last));
    return out;
  }

  function renderReading() {
    var item = pickByDay(DATA.reading, state.day);
    var box = $('readingBody');
    // date 是日历日期，title 是真题出处（哪年哪套哪篇），有 title 就一起显示
    $('readingDate').textContent = (item && item.date)
      ? (item.title ? item.date + ' · ' + item.title : item.date)
      : '';

    if (!item) {
      box.innerHTML = '<p class="empty">第 ' + state.day +
        ' 天还没有阅读内容。打开 reading.json，在数组末尾追加一条即可。</p>';
      return;
    }

    box.innerHTML = cycleNote() +
      '<p class="tip-line">右键（手机长按/点一下）任意单词可查词义、音标、发音；按住右键划过多个词可查词组。' +
        '也可以直接用鼠标<b>选中任意一段文字</b>（手机是长按拖选），松手就翻译整句。</p>' +
      '<div class="passage" id="passageBox">' + tokenize(item.passage) + '</div>' +
      '<h3 class="sub-title">长难句</h3>' +
      '<div class="sentence" id="sentenceBox">' + tokenize(item.sentence) + '</div>' +
      '<button type="button" class="btn ghost" data-act="analysis">显示解析</button>' +
      '<p class="analysis hidden" data-role="analysis">' + esc(item.analysis || '（这条没有填写 analysis）') + '</p>';
  }

  /* =====================================================================
     九、历年听力精听（按年份/套卷自由选，全文 + 逐行翻译）
     ===================================================================== */
  var INT = {
    index: null,          // listen/index.json
    setId: null,
    data: Object.create(null),   // setId -> listen/<id>.json
    open: Object.create(null)    // "setId-lineIndex" -> true（翻译已展开）
  };

  function loadListenIndex() {
    if (INT.index) return Promise.resolve(INT.index);
    return fetch('listen/index.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        INT.index = Array.isArray(list) ? list : [];
        return INT.index;
      })
      .catch(function () { INT.index = []; return INT.index; });
  }

  function loadListenSet(id) {
    if (INT.data[id]) return Promise.resolve(INT.data[id]);
    return fetch('listen/' + id + '.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { INT.data[id] = d; return d; });
  }

  function renderIntensive() {
    var body = $('intensiveBody');
    var meta = $('intensiveMeta');
    if (!body) return;

    if (!INT.index) {
      body.innerHTML = '<p class="muted tiny">正在加载套卷清单…</p>';
      loadListenIndex().then(function (list) {
        if (!list.length) {
          body.innerHTML = '<p class="empty">没有找到 listen/index.json。<br>' +
            '用 tools/build-listen-data.py 生成，或手动放一个套卷清单。</p>';
          return;
        }
        buildIntensivePickers();
        renderIntensive();
      });
      return;
    }
    if (!INT.index.length) {
      body.innerHTML = '<p class="empty">还没有可精听的套卷。</p>';
      return;
    }

    var id = INT.setId || INT.index[0].id;
    INT.setId = id;
    var item = INT.data[id];
    if (!item) {
      body.innerHTML = '<p class="muted tiny">正在加载《' + esc(labelOf(id)) + '》…</p>';
      loadListenSet(id).then(renderIntensiveBody).catch(function (e) {
        body.innerHTML = '<p class="empty">加载失败：' + esc(e.message) + '</p>';
      });
      return;
    }
    renderIntensiveBody(item);
  }

  function labelOf(id) {
    var it = (INT.index || []).filter(function (x) { return x.id === id; })[0];
    return it ? it.label : id;
  }

  function buildIntensivePickers() {
    var years = [];
    INT.index.forEach(function (x) { if (years.indexOf(x.year) < 0) years.push(x.year); });
    years.sort(function (a, b) { return b - a; });
    var ySel = $('pickYear');
    ySel.innerHTML = years.map(function (y) {
      return '<option value="' + y + '">' + y + ' 年</option>';
    }).join('');
    ySel.value = INT.index[0].year;
    fillSetPicker(INT.index[0].year);
  }

  function fillSetPicker(year) {
    var sSel = $('pickSet');
    var list = INT.index.filter(function (x) { return x.year === +year; });
    sSel.innerHTML = list.map(function (x) {
      return '<option value="' + x.id + '">' + esc(x.label.replace(/^\d+年/, '')) + '</option>';
    }).join('');
    if (list.length) sSel.value = list[0].id;
  }

  function renderIntensiveBody(item) {
    var meta = $('intensiveMeta');
    var body = $('intensiveBody');
    if (meta) meta.textContent = item.lines.length + ' 句 · 翻译 ' + item.lines.filter(function (l) { return l.zh; }).length + ' 条';

    var html = '';
    var lastSec = '';
    item.lines.forEach(function (ln, i) {
      if (ln.section && ln.section !== lastSec) {
        lastSec = ln.section;
        html += '<h4 class="il-sec">' + esc(ln.section) + '</h4>';
      }
      var open = !!INT.open[item.id + '-' + i];
      var who = ln.sp || ln.speaker || '';
      html += '<div class="il" data-i="' + i + '">' +
        '<p class="il-text">' +
          (who ? '<span class="spk">' + esc(who) + '</span>' : '') +
          '<span class="body">' + esc(ln.text) + '</span>' +
        '</p>' +
        (ln.zh
          ? '<button type="button" class="il-toggle' + (open ? ' hidden' : '') + '" data-act="il-toggle" data-i="' + i + '">点击此处显示翻译</button>' +
            '<p class="il-zh' + (open ? '' : ' hidden') + '">' + esc(ln.zh) + '</p>'
          : '') +
      '</div>';
    });
    body.innerHTML = html;
  }

  function toggleIntensiveLine(i) {
    var id = INT.setId;
    var key = id + '-' + i;
    var open = !INT.open[key];
    INT.open[key] = open;
    var row = document.querySelector('#intensiveBody .il[data-i="' + i + '"]');
    if (!row) return;
    var btn = row.querySelector('.il-toggle');
    var zh = row.querySelector('.il-zh');
    if (btn) btn.classList.toggle('hidden', open);
    if (zh) zh.classList.toggle('hidden', !open);
  }

  function setIntensiveAll(open) {
    var item = INT.data[INT.setId];
    if (!item) return;
    item.lines.forEach(function (l, i) { INT.open[INT.setId + '-' + i] = open; });
    renderIntensiveBody(item);
  }

  /* =====================================================================
     十、每日听力：盲听做题 → 精听填空 → 原文翻译 → 连读弱读
     ===================================================================== */
  var STEP = 1;
  var segAudio = null;
  var segSrc = '';
  var segStop = 0;
  var segOnEnd = null;
  var segSession = false;      // 当前是否在一次"整段播放"里（暂停不算结束）
  var segTimer = null;

  function listenState() {
    var d = state.listening[state.day];
    if (!d || typeof d !== 'object') { d = {}; state.listening[state.day] = d; }
    if (typeof d.plays !== 'number') d.plays = 2;
    if (!d.picks) d.picks = {};
    if (!d.cloze) d.cloze = {};
    return d;
  }

  function ensureSegAudio() {
    if (segAudio) return segAudio;
    segAudio = new Audio();
    segAudio.preload = 'auto';
    segAudio.addEventListener('timeupdate', function () {
      if (segStop && segAudio.currentTime >= segStop) {
        segAudio.pause();
        segSession = false;
        var cb = segOnEnd; segOnEnd = null;
        if (cb) cb();
      }
      paintPlayer();
    });
    segAudio.addEventListener('ended', function () {
      segSession = false;
      paintPlayer();
    });
    return segAudio;
  }

  function playRange(src, from, to, onEnd) {
    var a = ensureSegAudio();
    var go = function () {
      try { a.currentTime = from; } catch (e) { /* 忽略 */ }
      segStop = to;
      segOnEnd = onEnd || null;
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
    };
    if (segSrc !== src) {
      segSrc = src;
      a.src = src;
      a.addEventListener('loadedmetadata', function once() {
        a.removeEventListener('loadedmetadata', once);
        go();
      });
    } else if (a.readyState >= 1) {
      go();
    } else {
      a.addEventListener('loadedmetadata', function once2() {
        a.removeEventListener('loadedmetadata', once2);
        go();
      });
    }
  }

  function stopSegment() {
    var a = ensureSegAudio();
    try { a.pause(); } catch (e) { /* 忽略 */ }
    segSession = false;
    segStop = 0;
    segOnEnd = null;
  }

  function fmtTime(s) {
    s = Math.max(0, Math.round(s || 0));
    return Math.floor(s / 60) + ':' + pad2(s % 60);
  }

  function paintPlayer() {
    var bar = $('pBar');
    var cur = $('pCur');
    var a = segAudio;
    if (!bar || !a) return;
    var item = pickByDay(DATA.listening, state.day);
    var total = item && item.dur ? item.dur : (a.duration || 0);
    var t = Math.max(0, Math.min(total, a.currentTime || 0));
    bar.style.width = (total ? (t / total) * 100 : 0) + '%';
    if (cur) cur.textContent = fmtTime(t) + ' / ' + fmtTime(total);
    var btn = $('pToggle');
    if (btn) btn.innerHTML = a.paused ? ICON_PLAY : ICON_PAUSE;
  }

  var ICON_PLAY = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor"/></svg>';
  var ICON_SPEAK_S = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
    '<path d="M4 9.5v5h3.6l4.6 3.7V5.8L7.6 9.5H4z" fill="currentColor"/>' +
    '<path d="M15.8 8.6a4.8 4.8 0 0 1 0 6.8" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round"/></svg>';

  function renderListening() {
    var item = pickByDay(DATA.listening, state.day);
    var box = $('listeningBody');
    var dateEl = $('listeningDate');
    if (dateEl) dateEl.textContent = item ? (item.title || item.date || '') : '';
    stopSegment();

    if (!item) {
      box.innerHTML = '<p class="empty">第 ' + state.day +
        ' 天还没有听力内容。打开 listening.json，在数组末尾追加一条即可。</p>';
      return;
    }
    if (!item.lines || !item.lines.length) {
      box.innerHTML = '<p class="empty">这一天的听力还没有原文数据。</p>';
      return;
    }
    if (!STEP || STEP < 1 || STEP > 4) STEP = 1;

    var html = cycleNote() + '<div class="steps">' +
      [['1', '① 盲听'], ['2', '② 填空'], ['3', '③ 原文'], ['4', '④ 语音']]
        .map(function (s) {
          return '<button type="button" class="step-chip' + (+s[0] === STEP ? ' active' : '') +
            '" data-act="step" data-step="' + s[0] + '">' + s[1] + '</button>';
        }).join('') +
      '</div><div id="stepBody"></div>';
    box.innerHTML = html;

    if (STEP === 1) renderBlind(item);
    else if (STEP === 2) renderCloze(item);
    else if (STEP === 3) renderFullText(item);
    else renderPhon(item);
  }

  /* ---------- 第 1 步：盲听做题 ---------- */
  function renderBlind(item) {
    var d = listenState();
    var left = d.plays;
    var html = '<div class="player">' +
      '<button type="button" class="player-btn" id="pToggle" data-act="play">' + ICON_PLAY + '</button>' +
      '<div class="player-main">' +
        '<div class="player-bar"><i id="pBar"></i></div>' +
        '<div class="player-info"><span id="pCur">0:00 / ' + fmtTime(item.dur) + '</span>' +
        '<span class="left' + (left > 0 ? '' : ' ok') + '" id="pLeft">' +
        (left > 0 ? '还可播放 ' + left + ' 次' : '播放次数已用完') + '</span></div>' +
      '</div></div>';

    if (left <= 0) {
      html += '<p class="tip-line">两次机会用完了。凭记忆选，选完提交就能看答案。</p>';
    }

    // 六级真题里题目是"念"出来的，不在纸面上。片段已经包含念题的部分，
    // 这里给一个直达按钮，免得每次都从头听。
    if (item.qAt) {
      html += '<p class="tip-line q-hint">原文念到 <b>' + fmtTime(item.qAt) + '</b> 结束，' +
        '之后录音会<b>逐题念出问题</b>，每题后留 13–15 秒作答时间。' +
        '<button type="button" class="link-btn" data-act="play-q">从念题开始听</button>' +
        '<span class="tiny muted">（全长 ' + fmtTime(item.dur) + '，含原文 + 念题）</span></p>';
    }

    html += '<h3 class="sub-title">题目<span class="tiny muted">（题目在录音里念，这里只给选项；按顺序一一对应）</span></h3>';
    html += '<div id="qList">';
    item.questions.forEach(function (q, qi) {
      var opts = Array.isArray(q.options) ? q.options : [];
      var stem = (q.q && String(q.q).trim())
        ? (qi + 1) + '. ' + esc(q.q)
        : '<span class="q-badge">第 ' + (qi + 1) + ' 题</span>';
      var picked = d.picks[qi];
      var ans = answerLetter(q.answer, opts);
      var show = !!d.submitted;
      var optsHtml = opts.map(function (text, oi) {
        var letter = optionLetter(oi);
        var cls = 'opt';
        if (picked === letter) cls += ' selected';
        if (show) {
          if (letter === ans) cls += ' correct';
          else if (picked === letter) cls += ' wrong';
        }
        return '<button type="button" class="' + cls + '" data-act="opt" data-qi="' + qi +
          '" data-opt="' + letter + '">' +
          '<span class="opt-letter">' + letter + '</span>' +
          '<span class="opt-text">' + esc(stripLetterPrefix(text, letter)) + '</span></button>';
      }).join('');
      html += '<div class="q" data-qi="' + qi + '"><p class="q-text">' + stem + '</p>' +
        '<div class="opts">' + optsHtml + '</div></div>';
    });
    html += '</div>';

    if (!d.submitted) {
      html += '<button type="button" class="btn" data-act="submit">提交答案</button>';
    } else {
      html += renderBlindReview(item, d);
      html += '<button type="button" class="btn" data-act="step" data-step="2">进入第 ② 步 · 精听填空</button>';
    }
    $('stepBody').innerHTML = html;
  }

  function renderBlindReview(item, d) {
    var right = 0;
    var rows = item.questions.map(function (q, qi) {
      var opts = Array.isArray(q.options) ? q.options : [];
      var ans = answerLetter(q.answer, opts);
      var picked = d.picks[qi] || '—';
      var ok = picked === ans;
      if (ok) right++;
      var at = (typeof q.at === 'number' && item.lines[q.at]) ? item.lines[q.at] : null;
      return '<div class="phon-item">' +
        '<div class="phon-head">' +
          '<span class="phon-tag ' + (ok ? 'lia' : 'weak') + '" style="background:' +
            (ok ? 'var(--ok)' : 'var(--no)') + '">' + (ok ? '对' : '错') + '</span>' +
          '<span class="phon-say">第 ' + (qi + 1) + ' 题：答案 ' + ans +
            (ok ? '' : '（你选了 ' + picked + '）') + '</span>' +
        '</div>' +
        (at
          ? '<div class="phon-tip">原文出处：' + esc((at.sp ? at.sp + ': ' : '') + at.t) + '</div>' +
            (at.zh ? '<div class="phon-from">' + esc(at.zh) + '</div>' : '')
          : '') +
      '</div>';
    }).join('');
    return '<p class="result">答对 ' + right + ' / ' + item.questions.length + ' 题</p>' + rows;
  }

  /* ---------- 第 2 步：精听填空 ---------- */
  function renderCloze(item) {
    var d = listenState();
    var html = '<p class="tip-line">点左边的喇叭反复听这一句，把空格里的词填进去。填完点"核对答案"。</p>';
    html += '<div id="clozeList">';
    item.lines.forEach(function (ln, li) {
      if (!ln.cloze) {
        html += '<div class="cloze-line">' +
          '<button type="button" class="cloze-play" data-act="play-line" data-li="' + li + '">' + ICON_SPEAK_S + '</button>' +
          '<div class="cloze-body"><span class="cloze-spk">' + esc(ln.sp || '') + '</span>' + esc(ln.t) + '</div>' +
        '</div>';
        return;
      }
      var parts = ln.cloze.map(function (p, pi) {
        if (typeof p === 'string') return esc(p);
        var val = (d.cloze[li] || [])[pi] || '';
        return '<input class="cloze-in" type="text" autocomplete="off" autocapitalize="off" ' +
          'spellcheck="false" data-li="' + li + '" data-pi="' + pi + '" data-ans="' + esc(p.a) + '" ' +
          'value="' + esc(val) + '" style="width:' + Math.max(74, p.a.length * 10 + 16) + 'px">';
      }).join('');
      html += '<div class="cloze-line">' +
        '<button type="button" class="cloze-play" data-act="play-line" data-li="' + li + '">' + ICON_SPEAK_S + '</button>' +
        '<div class="cloze-body"><span class="cloze-spk">' + esc(ln.sp || '') + '</span>' + parts + '</div>' +
      '</div>';
    });
    html += '</div>';
    html += d.clozeOk
      ? '<p class="result" id="clozeResult"></p><button type="button" class="btn" data-act="step" data-step="3">进入第 ③ 步 · 原文翻译</button>'
      : '<button type="button" class="btn" data-act="check-cloze">核对答案</button>';
    $('stepBody').innerHTML = html;
    if (d.clozeOk) markCloze();
  }

  function normText(s) {
    return String(s || '').toLowerCase()
      .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function markCloze() {
    var d = listenState();
    var inputs = document.querySelectorAll('#clozeList .cloze-in');
    var right = 0, total = 0;
    Array.prototype.forEach.call(inputs, function (inp) {
      var ans = inp.getAttribute('data-ans');
      var val = inp.value;
      total++;
      var ok = normText(val) === normText(ans);
      if (ok) right++;
      inp.classList.toggle('right', ok);
      inp.classList.toggle('wrong', !ok);
      var next = inp.nextElementSibling;
      if (next && next.classList.contains('cloze-fix')) next.parentNode.removeChild(next);
      if (!ok) {
        var sp = document.createElement('span');
        sp.className = 'cloze-fix';
        sp.textContent = ans;
        inp.parentNode.insertBefore(sp, inp.nextSibling);
      }
    });
    var res = $('clozeResult');
    if (res) res.textContent = '填对 ' + right + ' / ' + total + ' 空';
    return { right: right, total: total };
  }

  /* ---------- 第 3 步：原文 + 翻译 ---------- */
  function renderFullText(item) {
    var html = '<p class="tip-line">先不看中文，跟着音频再听一遍；听不懂的句子再看下面的译文。</p>';
    html += '<div class="player">' +
      '<button type="button" class="player-btn" id="pToggle" data-act="play-free">' + ICON_PLAY + '</button>' +
      '<div class="player-main"><div class="player-bar"><i id="pBar"></i></div>' +
      '<div class="player-info"><span id="pCur">0:00 / ' + fmtTime(item.dur) + '</span>' +
      '<span>可以随便听，不限次数</span></div></div></div>';
    html += item.lines.map(function (ln) {
      return '<p class="full-line">' +
        (ln.sp ? '<span class="spk">' + esc(ln.sp) + '</span>' : '') + esc(ln.t) +
        (ln.zh ? '<span class="zh">' + esc(ln.zh) + '</span>' : '') +
      '</p>';
    }).join('');
    html += '<button type="button" class="btn" data-act="step" data-step="4">进入第 ④ 步 · 连读弱读</button>';
    $('stepBody').innerHTML = html;
  }

  /* ---------- 第 4 步：连读 / 弱读 / 失去爆破 / 闪音 ---------- */
  var WEAK_FORM = {
    a: 'ə', an: 'ən', the: 'ðə', of: 'əv', to: 'tə', for: 'fə', and: 'ən', or: 'ə',
    as: 'əz', at: 'ət', from: 'frəm', than: 'ðən', that: 'ðət', but: 'bət',
    can: 'kən', could: 'kəd', have: 'əv', has: 'əz', had: 'əd', was: 'wəz',
    were: 'wə', are: 'ə', do: 'də', does: 'dəz', some: 'səm', them: 'əm',
    us: 'əs', you: 'jə', your: 'jə', him: 'ɪm', her: 'ə', his: 'ɪz', me: 'mi'
  };
  var VOWELS = 'aeiou';

  function tokensOf(text) {
    // 保留原始大小写与标点，另给出去掉标点的小写形
    return String(text).split(/\s+/).filter(Boolean).map(function (w) {
      return { raw: w, low: w.toLowerCase().replace(/[^a-z']/g, '') };
    });
  }

  function analyzePhon(text) {
    var toks = tokensOf(text);
    var out = [];
    var used = {};

    function push(type, from, to, tip) {
      for (var i = from; i <= to; i++) { if (used[i]) return; }
      for (var j = from; j <= to; j++) used[j] = true;
      out.push({
        type: type,
        span: toks.slice(from, to + 1).map(function (t) { return t.raw; }).join(' '),
        tip: tip
      });
    }

    // 1) 连读：辅音结尾 + 元音开头
    for (var i = 0; i < toks.length - 1; i++) {
      var a = toks[i].low, b = toks[i + 1].low;
      if (!a || !b) continue;
      var last = a.charAt(a.length - 1);
      if ('bcdfgklmnpqrstvxz'.indexOf(last) >= 0 && VOWELS.indexOf(b.charAt(0)) >= 0) {
        push('lia', i, i + 1, '/' + last + '/ 和 ' + b.charAt(0) + ' 连起来读，听起来像一个词');
      }
    }
    // 2) 失去爆破：爆破音结尾 + 辅音开头
    for (var k = 0; k < toks.length - 1; k++) {
      var c = toks[k].low, dd = toks[k + 1].low;
      if (!c || !dd) continue;
      var end = c.charAt(c.length - 1);
      if ('pbtdkg'.indexOf(end) >= 0 && 'bcdfgklmnpqrstvxz'.indexOf(dd.charAt(0)) >= 0) {
        push('loss', k, k + 1, '/' + end + '/ 只做口型不出声，稍停一下就接下一个词');
      }
    }
    // 3) 闪音：美音里两个元音之间的 t/d
    for (var m = 0; m < toks.length; m++) {
      if (/^[a-z]*[aeiou](tt|t|dd|d)[aeiou][a-z]*$/.test(toks[m].low)) {
        push('flap', m, m, '美音里 ' + toks[m].raw + ' 中间的 t/d 读成轻轻的 /ɾ/，像汉语"啦"的起音');
      }
    }
    // 4) 弱读：虚词
    for (var n = 0; n < toks.length; n++) {
      var w = toks[n].low;
      if (WEAK_FORM[w]) push('weak', n, n, w + ' 在句子里弱读成 /' + WEAK_FORM[w] + '/，又轻又快');
    }
    return out.slice(0, 6);
  }

  function renderPhon(item) {
    var TYPE = { lia: ['连读', 'lia'], weak: ['弱读', 'weak'], loss: ['失去爆破', 'loss'], flap: ['闪音', 'flap'] };
    var html = '<p class="tip-line">这些是这句话里最值得模仿的发音现象。先看清"怎么连"，再回去听那一句。</p>';
    var total = 0;
    html += item.lines.map(function (ln, li) {
      var pts = analyzePhon(ln.t);
      if (!pts.length) return '';
      total += pts.length;
      var body = '<p class="full-line" style="margin:0 0 6px">' +
        (ln.sp ? '<span class="spk">' + esc(ln.sp) + '</span>' : '') + esc(ln.t) + '</p>';
      var list = pts.map(function (p) {
        var t = TYPE[p.type] || ['', 'lia'];
        return '<div class="phon-item" style="background:#fff">' +
          '<div class="phon-head"><span class="phon-tag ' + t[1] + '">' + t[0] + '</span>' +
          '<span class="phon-say">' + esc(p.span) + '</span>' +
          '<button type="button" class="il-play" data-act="play-line" data-li="' + li + '" style="margin-left:auto">' +
          ICON_SPEAK_S + '</button></div>' +
          '<div class="phon-tip">' + esc(p.tip) + '</div>' +
        '</div>';
      }).join('');
      return '<div style="margin-bottom:16px">' + body + list + '</div>';
    }).join('');
    if (!total) html += '<p class="empty">这一段没有检测到明显的连读/弱读点。</p>';
    $('stepBody').innerHTML = html;
  }

  /* ---------- 播放控制（第 1/3 步整段，第 2/4 步单句） ---------- */
  function toggleSegment(item) {
    var d = listenState();
    if (segSession) {                    // 正在播 → 暂停
      segAudio.pause();
      segSession = false;
      paintPlayer();
      return;
    }
    if (d.plays <= 0) return;
    d.plays--;
    save();
    var left = $('pLeft');
    if (left) {
      left.textContent = d.plays > 0 ? '还可播放 ' + d.plays + ' 次' : '播放次数已用完';
      left.classList.toggle('ok', d.plays <= 0);
    }
    var btn = $('pToggle');
    if (btn) btn.disabled = d.plays <= 0 && false;
    segSession = true;
    playRange(item.audio, 0, item.dur || 9999, function () { paintPlayer(); });
    if (btn) btn.innerHTML = ICON_PAUSE;
  }

  function playLine(item, li) {
    var ln = item.lines[li];
    if (!ln || typeof ln.a !== 'number') return;
    playRange(item.audio, ln.a, ln.b + 0.15, null);
  }

  /* =====================================================================
     十四、每日翻译
     ===================================================================== */
  var transTimer = null;

  function renderTranslation() {
    var item = pickByDay(DATA.translation, state.day);
    var box = $('translationBody');
    // 与阅读一致：有 title 就把真题出处一起显示
    $('translationDate').textContent = (item && item.date)
      ? (item.title ? item.date + ' · ' + item.title : item.date)
      : '';

    if (!item) {
      box.innerHTML = '<p class="empty">第 ' + state.day +
        ' 天还没有翻译内容。打开 translation.json，在数组末尾追加一条即可。</p>';
      return;
    }

    box.innerHTML = cycleNote() +
      '<p class="prompt-zh">' + esc(item.zh || '（这条没有填写 zh）') + '</p>' +
      '<textarea id="transInput" rows="6" placeholder="在这里写你的译文，边写边自动保存…"></textarea>' +
      '<div class="row-between">' +
        '<span class="muted tiny" id="transState">自动保存到本机</span>' +
        '<span class="muted tiny" id="transCount">0 字</span>' +
      '</div>' +
      '<button type="button" class="btn ghost" data-act="ref">显示参考译文</button>' +
      '<p class="analysis hidden" data-role="ref">' + esc(item.ref || '（这条没有填写 ref）') + '</p>' +
      '<div class="btn-row small"><button type="button" class="mini danger" data-act="clear">清空本日草稿</button></div>';

    $('transInput').value = state.translation[state.day] || '';
    updateTransCount();
  }

  function updateTransCount() {
    var ta = $('transInput'), c = $('transCount');
    if (ta && c) c.textContent = ta.value.length + ' 字';
  }

  function scheduleTransSave() {
    var st = $('transState');
    if (st) st.textContent = '保存中…';
    if (transTimer) clearTimeout(transTimer);
    transTimer = setTimeout(flushTransDraft, 400);
  }

  function flushTransDraft() {
    var ta = $('transInput');
    if (!ta) return;
    state.translation[state.day] = ta.value;
    save();
    var st = $('transState');
    if (st) {
      var d = new Date();
      st.textContent = '已保存 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
  }

  /* =====================================================================
     十五、生词本
     ---------------------------------------------------------------------
     数据存在 state.vocab：
       { "dose": { en, zh, pos, us, type, ctx, src, at, done } }
       en   词条原形（点的是 doses，收进来的是 dose）
       ctx  取词时所在的那一句原文，复习时能看回语境
       src  从哪儿收的（阅读 / 单词卡）
       at   加入时间戳
       done 1 = 已掌握（只是打个标记，不会从本子里删掉）

     收集入口有两个：阅读取词浮层底部的「＋ 加入生词本」、单词卡背面的同一个按钮。
     ===================================================================== */
  var VB_FILTER = 'all';   // all | todo | done
  var VB_SORT = 'new';     // new（最近加入在前） | az
  var VB_REVIEW = { on: false, list: [], pos: 0, show: false };

  function vocab() {
    if (!state.vocab || typeof state.vocab !== 'object') state.vocab = {};
    return state.vocab;
  }

  function vkey(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/^[^a-z]+|[^a-z'-]+$/g, '');
  }

  function vocabHas(en) {
    var k = vkey(en);
    return !!(k && vocab()[k]);
  }

  function vocabAdd(en, extra) {
    var k = vkey(en);
    if (!k || vocab()[k]) return false;
    vocab()[k] = Object.assign({
      en: String(en), zh: '', pos: '', us: '', type: 'word',
      ctx: '', src: '', at: Date.now(), done: 0
    }, extra || {});
    save();
    return true;
  }

  function vocabRemove(en) {
    var k = vkey(en);
    if (!k || !vocab()[k]) return;
    delete vocab()[k];
    save();
  }

  function vocabList() {
    var v = vocab(), out = [];
    Object.keys(v).forEach(function (k) { out.push(v[k]); });
    if (VB_SORT === 'az') {
      out.sort(function (a, b) {
        var x = String(a.en).toLowerCase(), y = String(b.en).toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
      });
    } else {
      out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    }
    return out;
  }

  function fmtDay(ts) {
    var d = new Date(ts || Date.now());
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // 取词浮层 / 单词卡上的那个按钮（同一个函数，保证两处文案一致）
  function vocabBtnHtml(word, labelAdd) {
    var k = vkey(word);
    if (!k) return '';
    var has = vocabHas(k);
    return '<div class="dp-acts"><button type="button" class="dp-vocab' + (has ? ' on' : '') +
      '" data-vocab="' + esc(k) + '">' +
      (has ? '✓ 已在生词本 · 点击移出' : (labelAdd || '＋ 加入生词本')) +
      '</button></div>';
  }

  // 取词时抓一下所在的句子，存进生词本当语境
  function contextOf(el, word) {
    var box = el && el.closest ? el.closest('.sentence, .passage') : null;
    if (!box) return '';
    var t = String(box.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    var w = String(word || '').toLowerCase();
    var hit = w ? t.toLowerCase().indexOf(w) : -1;
    if (hit < 0) return t.length > 200 ? t.slice(0, 200) + '…' : t;

    // 手写句子边界扫描，不用后行断言（老 Safari 不支持 (?<=)）
    var start = 0, end = t.length, i, j;
    for (i = hit; i > 0; i--) {
      if (/[.!?]/.test(t.charAt(i - 1))) { start = i; break; }
    }
    for (j = hit; j < t.length; j++) {
      if (/[.!?]/.test(t.charAt(j))) { end = j + 1; break; }
    }
    var s = t.slice(start, end).trim();
    return s.length > 220 ? s.slice(0, 220) + '…' : s;
  }

  function vocabEntryOf(en) {
    var e = findEntry(en);
    if (e) {
      return { en: e.en, zh: e.zh || '', pos: e.pos || '', us: e.us || '', type: e.type };
    }
    var x = popExtra || {};
    return { en: String(en), zh: x.def || '', pos: x.pos || '', us: x.ipa || '', type: 'word' };
  }

  function renderVocabBadge(n) {
    var b = $('vocabBadge');
    if (!b) return;
    b.textContent = n > 99 ? '99+' : n;
    b.classList.toggle('hidden', !n);
  }

  // 本地词典没收录的词（收进来时释义是空的）：渲染时补一次在线释义，成功后回写
  var VB_BACKFILL = Object.create(null);

  function backfillVocab(en, k) {
    if (VB_BACKFILL[k]) return;
    VB_BACKFILL[k] = 1;
    onlineLookup(en).then(function (r) {
      var w = vocab()[k];
      if (!w || w.zh) return;
      w.zh = r.def || '';
      if (!w.us) w.us = r.ipa || '';
      if (!w.pos) w.pos = r.pos || '';
      save();
      if (currentTab === 'vocab') renderVocab();
    }).catch(function () { });
  }

  function renderVocab() {
    var box = $('vocabBody');
    if (!box) return;

    var all = vocabList();
    var todo = all.filter(function (w) { return !w.done; });
    var done = all.filter(function (w) { return !!w.done; });

    var meta = $('vocabMeta');
    if (meta) meta.textContent = all.length ? '共 ' + all.length + ' 词 · 未掌握 ' + todo.length : '还是空的';
    renderVocabBadge(all.length);

    if (!all.length) {
      VB_REVIEW.on = false;
      box.innerHTML =
        '<p class="empty">生词本还是空的。<br>' +
        '去「阅读」点任意单词，弹出的小卡片底部有「＋ 加入生词本」；' +
        '「单词」页把卡片翻到背面也有同一个按钮。</p>';
      return;
    }

    if (VB_REVIEW.on) { box.innerHTML = vocabReviewHtml(); return; }

    var list = VB_FILTER === 'todo' ? todo : VB_FILTER === 'done' ? done : all;

    var html = '<div class="vb-bar">' +
      vbChip('all', '全部', all.length) +
      vbChip('todo', '未掌握', todo.length) +
      vbChip('done', '已掌握', done.length) +
      '</div>' +
      '<div class="vb-tools">' +
        '<button type="button" class="mini" data-vb="review">' +
          (todo.length ? '复习这 ' + todo.length + ' 个' : '全部再过一遍') + '</button>' +
        '<button type="button" class="mini" data-vb="sort">' +
          (VB_SORT === 'az' ? '按加入时间' : '按字母排') + '</button>' +
        '<button type="button" class="mini" data-vb="export">导出 CSV</button>' +
        '<button type="button" class="mini danger" data-vb="clear">清空</button>' +
      '</div>';

    if (!list.length) {
      html += '<p class="empty">这个筛选下没有词。</p>';
    } else {
      html += '<div class="vb-list">';
      list.forEach(function (w) {
        var k = vkey(w.en);
        if (!w.zh) backfillVocab(w.en, k);
        html += '<div class="vb-item' + (w.done ? ' is-done' : '') + '" data-k="' + esc(k) + '">' +
          '<div class="vb-head">' +
            '<span class="vb-word">' + esc(w.en) + '</span>' +
            (w.pos ? '<span class="vb-pos">' + esc(w.pos) + '</span>' : '') +
            '<button type="button" class="vb-speak" data-vb="speak" data-w="' + esc(w.en) + '" aria-label="发音">' + ICON_SPEAK_S + '</button>' +
            '<button type="button" class="vb-x" data-vb="del" aria-label="移出生词本">×</button>' +
          '</div>' +
          (w.us ? '<div class="vb-ipa">/' + esc(w.us) + '/</div>' : '') +
          '<div class="vb-zh">' + esc(w.zh || '（没有释义，可点右上角发音或去网页词典查）') + '</div>' +
          (w.ctx ? '<div class="vb-ctx">' + esc(w.ctx) + '</div>' : '') +
          '<div class="vb-foot">' +
            '<span class="vb-time">' + fmtDay(w.at) + (w.src ? ' · ' + esc(w.src) : '') + '</span>' +
            '<button type="button" class="vb-flag" data-vb="flag">' +
              (w.done ? '↩ 标回未掌握' : '✓ 标为已掌握') + '</button>' +
          '</div>' +
        '</div>';
      });
      html += '</div>';
    }
    box.innerHTML = html;
  }

  function vbChip(f, label, n) {
    return '<button type="button" class="vb-chip' + (VB_FILTER === f ? ' active' : '') +
      '" data-vb="filter" data-f="' + f + '">' + label + ' <b>' + n + '</b></button>';
  }

  function vocabReviewHtml() {
    var R = VB_REVIEW;
    if (!R.list.length) {
      return '<p class="empty">没有可复习的词。</p>' +
        '<div class="btn-row"><button type="button" class="btn ghost" data-vb="rv-exit">回到列表</button></div>';
    }
    if (R.pos >= R.list.length) {
      var got = 0;
      R.list.forEach(function (k) { if (vocab()[k] && vocab()[k].done) got++; });
      return '<div class="vb-done">' +
        '<p class="done-title">这一轮复习完了</p>' +
        '<p class="muted">' + R.list.length + ' 个词，标记为「已掌握」的有 ' + got + ' 个。</p>' +
        '<div class="btn-row">' +
          '<button type="button" class="btn" data-vb="rv-restart">再来一轮</button>' +
          '<button type="button" class="btn ghost" data-vb="rv-exit">回到列表</button>' +
        '</div></div>';
    }

    var w = vocab()[R.list[R.pos]];
    if (!w) { R.pos++; return vocabReviewHtml(); }

    return '<div class="vb-review">' +
      '<div class="vb-rv-top">' +
        '<span class="muted tiny">复习 ' + (R.pos + 1) + ' / ' + R.list.length + '</span>' +
        '<button type="button" class="mini ghost" data-vb="rv-exit">退出</button>' +
      '</div>' +
      '<div class="vb-rv-bar"><i style="width:' + Math.round(R.pos * 100 / R.list.length) + '%"></i></div>' +
      '<div class="vb-rv-card" data-vb="rv-flip">' +
        '<div class="vb-rv-word">' + esc(w.en) + '</div>' +
        (w.pos ? '<div class="vb-rv-pos">' + esc(w.pos) + '</div>' : '') +
        (R.show
          ? (w.us ? '<div class="vb-ipa">/' + esc(w.us) + '/</div>' : '') +
            '<div class="vb-rv-zh">' + esc(w.zh || '（没有释义）') + '</div>' +
            (w.ctx ? '<div class="vb-ctx">' + esc(w.ctx) + '</div>' : '')
          : '<div class="vb-rv-hint muted">点一下卡片看释义</div>') +
      '</div>' +
      '<div class="btn-row">' +
        '<button type="button" class="btn no" data-vb="rv-again">还不熟</button>' +
        '<button type="button" class="btn ok" data-vb="rv-got">记住了</button>' +
      '</div>' +
    '</div>';
  }

  function startVocabReview() {
    var all = vocabList();
    var todo = all.filter(function (w) { return !w.done; });
    var src = todo.length ? todo : all;
    if (!src.length) return;
    VB_REVIEW = {
      on: true,
      list: src.map(function (w) { return vkey(w.en); }),
      pos: 0,
      show: false
    };
    renderVocab();
  }

  function exportVocab() {
    var list = vocabList();
    if (!list.length) return;
    var rows = [['单词', '词性', '音标', '释义', '例句', '加入时间', '已掌握']];
    list.forEach(function (w) {
      rows.push([
        w.en || '', w.pos || '', w.us ? '/' + w.us + '/' : '', w.zh || '',
        w.ctx || '', fmtDay(w.at), w.done ? '是' : '否'
      ]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');

    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '生词本-' + todayStr() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function bindVocabEvents() {
    var box = $('vocabBody');
    if (!box) return;

    box.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-vb]');
      if (!btn) return;
      var act = btn.getAttribute('data-vb');
      var itemEl = btn.closest('.vb-item');
      var k = itemEl ? itemEl.getAttribute('data-k') : '';

      if (act === 'filter') { VB_FILTER = btn.getAttribute('data-f'); renderVocab(); return; }
      if (act === 'sort') { VB_SORT = VB_SORT === 'az' ? 'new' : 'az'; renderVocab(); return; }
      if (act === 'export') { exportVocab(); return; }
      if (act === 'clear') {
        if (!window.confirm('确定清空生词本里的全部 ' + vocabList().length + ' 个词？这一步没法撤销。')) return;
        state.vocab = {};
        VB_REVIEW.on = false;
        save();
        renderVocab();
        return;
      }
      if (act === 'speak') { speak(btn.getAttribute('data-w'), btn); return; }
      if (act === 'del') {
        vocabRemove(k);
        renderVocab();
        return;
      }
      if (act === 'flag') {
        var w = vocab()[k];
        if (w) { w.done = w.done ? 0 : 1; save(); }
        renderVocab();
        return;
      }
      if (act === 'review') { startVocabReview(); return; }

      if (act === 'rv-flip') { VB_REVIEW.show = true; renderVocab(); return; }
      if (act === 'rv-got' || act === 'rv-again') {
        var cur = vocab()[VB_REVIEW.list[VB_REVIEW.pos]];
        if (cur) { cur.done = act === 'rv-got' ? 1 : 0; save(); }
        VB_REVIEW.pos++;
        VB_REVIEW.show = false;
        renderVocab();
        return;
      }
      if (act === 'rv-exit') { VB_REVIEW.on = false; renderVocab(); return; }
      if (act === 'rv-restart') { startVocabReview(); return; }
    });
  }

  /* =====================================================================
     十六、渲染总入口
     ===================================================================== */
  function renderHeader() {
    $('dayNum').textContent = state.day;
    var date = dateOfDay(state.day);
    var round = roundOf(state.day);
    // 二刷时把 2026-10-19 缩成 10-19，给「第 N 轮」腾地方
    if (round > 1 && /^\d{4}-\d{2}-\d{2}$/.test(date)) date = date.slice(5);

    $('dayMeta').textContent = '/ ' + totalDays() + ' · ' +
      (round > 1 ? '第 ' + round + ' 轮 · ' + date : date);
    $('prevDay').disabled = state.day <= 1;
    $('nextDay').disabled = state.day >= totalDays();
    $('dailyCount').value = dailyCount();
    $('totalDays').value = totalDays();
    $('autoSpeak').checked = !!state.settings.autoSpeak;

    var pool = contentDays();
    var left = totalDays() - state.day + 1;
    $('daysNote').textContent = pool
      ? ('素材共 ' + pool + ' 天，第 ' + (pool + 1) + ' 天起自动循环二刷。' +
         '今天 Day ' + state.day + ' / ' + totalDays() + '，还剩 ' + left + ' 天。')
      : ('今天 Day ' + state.day + ' / ' + totalDays() + '，还剩 ' + left + ' 天。');
  }

  function renderAll() {
    renderHeader();
    renderWords();
    renderReading();
    renderListening();
    renderIntensive();
    renderTranslation();
    renderVocab();
  }

  /* =====================================================================
     十七、交互
     ===================================================================== */
  function switchTab(name) {
    if (TABS.indexOf(name) < 0) name = 'words';
    currentTab = name;
    TABS.forEach(function (t) {
      var btn = document.querySelector('.tab[data-tab="' + t + '"]');
      var view = $('view-' + t);
      if (btn) btn.classList.toggle('active', t === name);
      if (view) view.classList.toggle('active', t === name);
    });
    if (name !== 'listening') stopSegment();
    closeDict();
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    window.scrollTo(0, 0);
  }

  function setCount(n) {
    n = clamp(n, 1, 200);
    state.settings.dailyCount = n;
    $('dailyCount').value = n;
    if (!state.words.deck || state.words.deck.pos === 0) {
      state.words.deck = buildDeck(state.day);
    }
    save();
    renderAll();
  }

  /* ---------- 阅读取词：右键 / 划词 / 点击 ---------- */
  var sweeping = false;
  var sweepStart = -1;

  function wordIndex(el) {
    if (!el || !el.closest) return -1;
    var w = el.closest('.w');
    if (!w) return -1;
    var box = w.closest('.passage, .sentence');
    if (!box) return -1;
    var all = Array.prototype.slice.call(box.querySelectorAll('.w'));
    return all.indexOf(w);
  }

  function sweepPhrase(box, from, to) {
    if (from < 0 || to < 0) return null;
    var a = Math.min(from, to), b = Math.max(from, to);
    var words = Array.prototype.slice.call(box.querySelectorAll('.w'))
      .map(function (el) { return el.textContent.toLowerCase(); });
    var maxLen = Math.min(5, b - a + 1);
    for (var len = maxLen; len >= 2; len--) {
      for (var s = a; s + len - 1 <= b; s++) {
        var key = words.slice(s, s + len).join(' ');
        if (PHRASE_MAP[key]) {
          return { entry: PHRASE_MAP[key], key: key, start: s, end: s + len - 1 };
        }
      }
    }
    return null;
  }

  function handleLookup(target, isSweep) {
    var wEl = target && target.closest ? target.closest('.w') : null;
    if (!wEl) return;
    var box = wEl.closest('.passage, .sentence');
    if (!box) return;

    // 有选区说明用户是在"自由取词"，别再抢成单词卡
    if (!isSweep) {
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed && String(sel.toString() || '').trim()) return;
    }

    if (isSweep && sweepStart >= 0) {
      var to = wordIndex(wEl);
      var hit = sweepPhrase(box, sweepStart, to);
      if (hit) {
        highlightRange(box, hit.start, hit.end);
        openDict(hit.entry.en, wEl, hit.key, true);
        return;
      }
    }
    openDict(wEl.textContent, wEl, wEl.textContent);
  }

  // 整段词组一起高亮，让"划到了哪几个词"看得见
  function highlightRange(box, a, b) {
    var prev = document.querySelectorAll('.w.active');
    for (var i = 0; i < prev.length; i++) prev[i].classList.remove('active');
    var all = box.querySelectorAll('.w');
    for (var j = a; j <= b && j < all.length; j++) all[j].classList.add('active');
  }

  function bindReadingEvents() {
    var body = $('readingBody');

    body.addEventListener('contextmenu', function (e) {
      if (e.target.closest && e.target.closest('.w')) {
        e.preventDefault();
        handleLookup(e.target, sweeping);
      }
    });

    body.addEventListener('mousedown', function (e) {
      if (e.button !== 2) return;                 // 只处理右键
      var wEl = e.target.closest && e.target.closest('.w');
      if (!wEl) return;
      e.preventDefault();
      sweeping = true;
      sweepStart = wordIndex(wEl);
      handleLookup(e.target, true);
    });

    body.addEventListener('mousemove', function (e) {
      if (!sweeping) return;
      var wEl = e.target.closest && e.target.closest('.w');
      if (!wEl) return;
      handleLookup(e.target, true);
    });

    document.addEventListener('mouseup', function () { sweeping = false; });

    // 手机：点一下词也能查（长按会触发 contextmenu）
    body.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.w')) {
        handleLookup(e.target, false);
      }
    });
  }

  function bindDictEvents() {
    document.addEventListener('click', function (e) {
      var pop = $('dictPop');
      if (!pop || pop.classList.contains('hidden')) return;
      if (pop.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.w')) return;   // 点别的词交给阅读区处理
      closeDict();
    });

    $('dictPop').addEventListener('click', function (e) {
      var vbBtn = e.target.closest('[data-vocab]');
      if (vbBtn) {
        e.stopPropagation();
        var en = vbBtn.getAttribute('data-vocab');
        if (vocabHas(en)) {
          vocabRemove(en);
        } else {
          var info = vocabEntryOf(en);
          // 本地词典没收录、在线词典还没回来时，直接抓浮层上已经显示出来的释义/音标
          var zhEl = $('dictPop').querySelector('.dp-zh');
          var ipaEl = $('dictPop').querySelector('.dp-ipa');
          if (!info.zh && zhEl && !/^本地/.test(zhEl.textContent)) info.zh = zhEl.textContent.trim();
          if (!info.us && ipaEl) info.us = ipaEl.textContent.replace(/\//g, '').trim();
          info.ctx = popCtx;
          info.src = currentTab === 'reading' ? '阅读' : '';
          vocabAdd(en, info);
        }
        var on = vocabHas(en);
        vbBtn.classList.toggle('on', on);
        vbBtn.textContent = on ? '✓ 已在生词本 · 点击移出' : '＋ 加入生词本';
        renderVocab();
        return;
      }

      var speakBtn = e.target.closest('[data-speak]');
      if (speakBtn) {
        var word = speakBtn.getAttribute('data-speak');
        var audioUrl = speakBtn.getAttribute('data-audio');
        if (audioUrl) {
          if (!audioEl) { audioEl = new Audio(); }
          audioEl.src = audioUrl;
          var p = audioEl.play();
          if (p && p.catch) p.catch(function () { speak(word, speakBtn); });
        } else {
          speak(word, speakBtn);
        }
        e.stopPropagation();
        return;
      }
      if (e.target.closest('[data-close]')) {
        e.stopPropagation();
        closeDict();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDict(); closeSelPop(); }
    });
  }

  function bindStaticEvents() {
    document.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
    });

    $('prevDay').addEventListener('click', function () { setDay(state.day - 1); });
    $('nextDay').addEventListener('click', function () { setDay(state.day + 1); });
    $('btnToday').addEventListener('click', function () {
      var d = clamp(dayDiff(state.settings.startDate, todayStr()) + 1, 1, totalDays());
      state.lastAutoDay = d;
      setDay(d);
      switchTab('words');
    });

    /* ---- 单词卡 ---- */
    $('btnAddVocab').addEventListener('click', function (e) {
      e.stopPropagation();                 // 别让点击冒泡到 flashcard 去翻面
      var en = this.getAttribute('data-en');
      if (!en) return;
      if (vocabHas(en)) {
        vocabRemove(en);
      } else {
        var info = vocabEntryOf(en);
        info.src = '单词卡';
        vocabAdd(en, info);
      }
      paintAddVocab(en);
      renderVocab();
    });
    $('flashcard').addEventListener('click', function () {
      if (!revealed) {
        setRevealed(true);
        var en = $('wordEn').textContent;
        if (state.settings.autoSpeak && en && en !== '—') speak(en, $('wordSpeak'));
      }
    });
    $('wordSpeak').addEventListener('click', function (e) {
      e.stopPropagation();
      speak(this.getAttribute('data-speak'), this);
    });
    $('btnKnown').addEventListener('click', function () { answerWord('known'); });
    $('btnUnknown').addEventListener('click', function () { answerWord('unknown'); });
    $('btnRetry').addEventListener('click', retryUnknownOfToday);
    $('btnResetWords').addEventListener('click', resetWordProgress);
    $('btnNextDeck').addEventListener('click', newDeck);

    /* ---- 备考天数 ---- */
    $('totalDays').addEventListener('change', function () {
      setTotalDays(parseInt(this.value, 10) || DEFAULT_DAYS);
    });
    document.querySelectorAll('[data-days]').forEach(function (b) {
      b.addEventListener('click', function () { setTotalDays(parseInt(b.getAttribute('data-days'), 10)); });
    });
    $('daysDown').addEventListener('click', function () { setTotalDays(totalDays() - 1); });
    $('daysUp').addEventListener('click', function () { setTotalDays(totalDays() + 1); });

    /* ---- 每天词量 ---- */
    $('dailyCount').addEventListener('change', function () {
      setCount(parseInt(this.value, 10) || DEFAULT_COUNT);
    });
    document.querySelectorAll('[data-count]').forEach(function (b) {
      b.addEventListener('click', function () { setCount(parseInt(b.getAttribute('data-count'), 10)); });
    });
    $('countDown').addEventListener('click', function () { setCount(dailyCount() - 5); });
    $('countUp').addEventListener('click', function () { setCount(dailyCount() + 5); });
    $('autoSpeak').addEventListener('change', function () {
      state.settings.autoSpeak = this.checked;
      save();
    });

    /* ---- 阅读：解析展开 ---- */
    $('readingBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act="analysis"]');
      if (!btn) return;
      var p = $('readingBody').querySelector('[data-role="analysis"]');
      if (!p) return;
      var open = !p.classList.contains('hidden');
      p.classList.toggle('hidden', open);
      btn.textContent = open ? '显示解析' : '收起解析';
    });

    /* ---- 每日听力（四步） ---- */
    $('listeningBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      var item = pickByDay(DATA.listening, state.day);
      if (!item) return;
      var d = listenState();

      if (act === 'step') {
        var to = parseInt(btn.getAttribute('data-step'), 10);
        if (!to || to === STEP) return;
        if (to > 1 && !d.submitted && STEP === 1) {
          // 没提交就跳步：允许，但提示一下
          if (!window.confirm('还没提交答案，确定跳过盲听做题吗？')) return;
        }
        STEP = to;
        stopSegment();
        renderListening();
        var body = $('stepBody');
        if (body) body.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } else if (act === 'play') {
        toggleSegment(item);
      } else if (act === 'play-free') {
        if (segSession) { segAudio.pause(); segSession = false; paintPlayer(); }
        else {
          segSession = true;
          playRange(item.audio, 0, item.dur || 9999, null);
          var pb = $('pToggle');
          if (pb) pb.innerHTML = ICON_PAUSE;
        }
      } else if (act === 'play-q') {
        // 直接跳到"开始念题目"的位置，不消耗播放次数
        if (!item.qAt) return;
        segSession = true;
        playRange(item.audio, item.qAt, item.dur || 9999, null);
        var qb = $('pToggle');
        if (qb) qb.innerHTML = ICON_PAUSE;
      } else if (act === 'play-line') {
        playLine(item, parseInt(btn.getAttribute('data-li'), 10));
      } else if (act === 'opt') {
        if (d.submitted) return;
        var qi = parseInt(btn.getAttribute('data-qi'), 10);
        d.picks[qi] = btn.getAttribute('data-opt');
        save();
        var group = btn.closest('.opts');
        if (group) {
          Array.prototype.forEach.call(group.querySelectorAll('.opt'), function (b) {
            b.classList.toggle('selected', b === btn);
          });
        }
      } else if (act === 'submit') {
        var answered = Object.keys(d.picks).length;
        if (answered < item.questions.length) {
          if (!window.confirm('还有 ' + (item.questions.length - answered) + ' 题没选，确定提交吗？')) return;
        }
        d.submitted = true;
        save();
        stopSegment();
        renderListening();
      } else if (act === 'check-cloze') {
        Array.prototype.forEach.call(document.querySelectorAll('#clozeList .cloze-in'), function (inp) {
          var li = inp.getAttribute('data-li');
          var pi = inp.getAttribute('data-pi');
          if (!d.cloze[li]) d.cloze[li] = {};
          d.cloze[li][pi] = inp.value;
        });
        d.clozeOk = true;
        save();
        renderListening();
      }
    });

    // 填空输入时静默保存，刷新不丢
    $('listeningBody').addEventListener('input', function (e) {
      if (!e.target.classList.contains('cloze-in')) return;
      var d = listenState();
      var li = e.target.getAttribute('data-li');
      var pi = e.target.getAttribute('data-pi');
      if (!d.cloze[li]) d.cloze[li] = {};
      d.cloze[li][pi] = e.target.value;
      if (segTimer) clearTimeout(segTimer);
      segTimer = setTimeout(save, 500);
    });

    /* ---- 历年听力精听 ---- */
    $('pickYear').addEventListener('change', function () {
      fillSetPicker(this.value);
      INT.setId = $('pickSet').value;
      renderIntensive();
    });
    $('pickSet').addEventListener('change', function () {
      INT.setId = this.value;
      renderIntensive();
    });
    $('btnZhAll').addEventListener('click', function () { setIntensiveAll(true); });
    $('btnZhNone').addEventListener('click', function () { setIntensiveAll(false); });
    $('intensiveBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      if (btn.getAttribute('data-act') === 'il-toggle') {
        toggleIntensiveLine(parseInt(btn.getAttribute('data-i'), 10));
      }
    });

    /* ---- 翻译 ---- */
    $('translationBody').addEventListener('input', function (e) {
      if (e.target && e.target.id === 'transInput') { updateTransCount(); scheduleTransSave(); }
    });
    $('translationBody').addEventListener('focusout', function (e) {
      if (e.target && e.target.id === 'transInput') flushTransDraft();
    });
    $('translationBody').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');

      if (act === 'ref') {
        var p = $('translationBody').querySelector('[data-role="ref"]');
        if (!p) return;
        var open = !p.classList.contains('hidden');
        p.classList.toggle('hidden', open);
        btn.textContent = open ? '显示参考译文' : '收起参考译文';
      } else if (act === 'clear') {
        if (!confirm('清空第 ' + state.day + ' 天的翻译草稿？')) return;
        state.translation[state.day] = '';
        save();
        var ta = $('transInput');
        if (ta) ta.value = '';
        updateTransCount();
        var st = $('transState');
        if (st) st.textContent = '已清空';
      }
    });

    /* ---- 桌面快捷键 ---- */
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (currentTab !== 'words') return;
      if (e.code === 'Space' || e.key === 'Enter') {
        if (!revealed) { e.preventDefault(); $('flashcard').click(); }
      } else if (e.key === '1' && revealed) {
        answerWord('known');
      } else if (e.key === '2' && revealed) {
        answerWord('unknown');
      }
    });

    window.addEventListener('hashchange', function () {
      var h = (location.hash || '').replace('#', '');
      if (TABS.indexOf(h) >= 0 && h !== currentTab) switchTab(h);
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushTransDraft();
    });
    window.addEventListener('pagehide', flushTransDraft);

    bindReadingEvents();
    bindDictEvents();
    bindSelectionEvents();
    bindVocabEvents();
  }

  /* =====================================================================
     十三、启动
     ===================================================================== */
  function fatal(msg) {
    var loading = $('loading');
    if (loading) {
      loading.className = 'empty';
      loading.innerHTML = msg;
      loading.style.textAlign = 'left';
    }
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    navigator.serviceWorker.register('sw.js').catch(function () { /* 失败不影响使用 */ });
  }

  function boot() {
    state = loadState();
    bindStaticEvents();

    loadAll().then(function () {
      var loading = $('loading');
      if (loading) loading.classList.add('hidden');

      initDay();
      renderAll();

      var h = (location.hash || '').replace('#', '');
      switchTab(TABS.indexOf(h) >= 0 ? h : 'words');

      registerSW();
    }).catch(function (err) {
      var isFile = location.protocol === 'file:';
      fatal(
        '<strong>数据加载失败：</strong>' + esc(err.message || err) + '<br><br>' +
        (isFile
          ? '你正在用 <code>file://</code> 直接打开这个页面，浏览器不允许读取本地 JSON。<br>' +
            '请双击同目录的 <b>start-server.bat</b>（或运行 <code>python -m http.server 8000</code>），' +
            '然后访问 <code>http://localhost:8000</code>。'
          : '请检查 words.json / reading.json / listening.json / translation.json / dict.json ' +
            '是否存在、是否是合法 JSON（逗号、引号最容易写错）。')
      );
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
