// 极简 CDP 客户端（Node 22 自带 WebSocket）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 上一轮可能留下仍占着调试端口的 Chrome（proc.kill() 只杀得掉启动器进程，
// 浏览器本体常驻），不清掉的话下一轮会连到旧实例、读到旧页面状态，
// 测试就会出现「tab 点得到、面板却是空的」这种假失败。
async function killStale() {
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
    if (!r.ok) return;
    const v = await r.json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(400);
    try { ws.close(); } catch (e) { /* ignore */ }
  } catch (e) {
    return;                       // 没有旧实例
  }
  for (let i = 0; i < 24; i++) {  // 等端口真正释放，最多 6 秒
    try { await fetch('http://127.0.0.1:' + PORT + '/json/version'); }
    catch (e) { return; }
    await sleep(250);
  }
}

async function launch(userDir) {
  await killStale();
  fs.mkdirSync(userDir, { recursive: true });
  const p = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--mute-audio',
    // 默认绕过代理（本地 127.0.0.1 测试用）；验证线上站点时用
    // CHROME_PROXY=http://127.0.0.1:7897 走梯子
    ...(process.env.CHROME_PROXY
      ? ['--proxy-server=' + process.env.CHROME_PROXY]
      : ['--no-proxy-server', '--proxy-bypass-list=*']),
    '--disable-background-timer-throttling',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) return p;
    } catch (e) { /* not up yet */ }
    await sleep(300);
  }
  throw new Error('Chrome 没起来');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); this.evs = []; this.hooks = {}; }
  on(method, fn) { (this.hooks[method] = this.hooks[method] || []).push(fn); }
  static async connect() {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    const page = list.find(t => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && c.pend.has(d.id)) {
        const { res, rej } = c.pend.get(d.id);
        c.pend.delete(d.id);
        d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result);
      } else if (d.method) {
        c.evs.push(d);
        (c.hooks[d.method] || []).forEach(f => { try { f(d.params); } catch (e) {} });
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pend.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, timeout = 600000) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, timeout,
    });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 800));
    return r.result.value;
  }
  // 收尾：让浏览器自己退出，光 close() 关 ws 是关不掉 Chrome 的
  async quit() {
    try { await this.send('Browser.close'); } catch (e) { /* ignore */ }
    this.close();
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

module.exports = { launch, CDP, sleep, PORT };
