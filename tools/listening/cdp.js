// 极简 CDP 客户端（Node 22 自带 WebSocket）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function launch(userDir) {
  fs.mkdirSync(userDir, { recursive: true });
  const p = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--mute-audio',
    '--no-proxy-server', '--proxy-bypass-list=*',
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
  close() { try { this.ws.close(); } catch (e) {} }
}

module.exports = { launch, CDP, sleep, PORT };
