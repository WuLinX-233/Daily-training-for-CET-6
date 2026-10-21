/* =========================================================================
   Service Worker —— 只做两件事：
   1) 让页面能"添加到主屏幕"（部分安卓浏览器需要它）
   2) 断网时还能打开（缓存兜底）
   -------------------------------------------------------------------------
   策略：
   · HTML / JSON / JS / CSS：网络优先（network-first）→ 你改完 JSON 刷新就能看到新内容
   · 图标等静态资源：缓存优先
   · 音频（audio/*）完全不拦截：<audio> 会发 Range 请求，拦截反而容易播不出来
   改完代码想强制更新：把下面的 VERSION 数字 +1 即可。
   ========================================================================= */

var VERSION = 'cet6-v13';
var CORE = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'manifest.webmanifest',
  'words.json',
  'reading.json',
  'listening.json',
  'translation.json',
  'dict.json',
  'listen/index.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (cache) {
      // 单个文件失败不影响整体安装
      return Promise.all(CORE.map(function (url) {
        return cache.add(url).catch(function () { /* 忽略 */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== location.origin) return;          // 跨域交给浏览器
  if (url.pathname.indexOf('/audio/') !== -1) return;   // 音频不拦截

  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(VERSION).then(function (cache) { cache.put(req, copy); });
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('index.html');
      });
    })
  );
});
