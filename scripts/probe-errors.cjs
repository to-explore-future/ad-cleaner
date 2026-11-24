/** 抓内容脚本在真实页面上抛的所有异常/报错。 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 10310;
const EXT = path.resolve(__dirname, '../.output/chrome-mv3');
const PAGE = process.argv[2] || 'https://www.bilibili.com/';

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-err-'));
const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', '--headless=new', '--disable-gpu', '--window-size=1400,950',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(u, n = 120) {
    for (let i = 0; i < n; i++) {
        try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* retry */ }
        await sleep(300);
    }
    throw new Error('连不上 ' + u);
}
class S {
    constructor(ws) { this.ws = ws; this.i = 0; this.p = new Map(); this.events = []; }
    static async open(url) {
        const ws = new WebSocket(url);
        await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', rej, { once: true });
        });
        const s = new S(ws);
        ws.addEventListener('message', (e) => {
            const m = JSON.parse(e.data);
            if (m.id && s.p.has(m.id)) {
                const { resolve, reject } = s.p.get(m.id);
                s.p.delete(m.id);
                m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
            } else if (m.method) {
                s.events.push(m);
            }
        });
        return s;
    }
    send(method, params = {}, t = 30000) {
        const id = ++this.i;
        return new Promise((res, rej) => {
            this.p.set(id, { resolve: res, reject: rej });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (this.p.delete(id)) rej(new Error('timeout ' + method)); }, t);
        });
    }
}

(async () => {
    await getJson(`http://127.0.0.1:${PORT}/json/version`);
    let sw = null, extId = null;
    for (let i = 0; i < 120 && !sw; i++) {
        await sleep(400);
        sw = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
        if (sw) extId = new URL(sw.url).host;
    }
    const bg = await S.open(sw.webSocketDebuggerUrl);
    await bg.send('Runtime.enable');
    await bg.send('Log.enable').catch(() => {});
    const host = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
    const { windowId } = await bg.send('Browser.getWindowForTarget', { targetId: host.id });

    const { targetId } = await bg.send('Target.createTarget', { url: 'about:blank', windowId, newWindow: false });
    await sleep(800);
    const t = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.id === targetId);
    const page = await S.open(t.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await page.send('Log.enable').catch(() => {});

    console.log('· 打开', PAGE);
    await page.send('Page.navigate', { url: PAGE });
    await sleep(12000);

    // 触发一次选择模式，看有没有运行时异常
    const tabId = await (async () => {
        const r = await bg.send('Runtime.evaluate', {
            expression: `(async()=>{const ts=await chrome.tabs.query({});const t=ts.find(x=>(x.url||'').startsWith(${JSON.stringify(new URL(PAGE).origin)}));return t?t.id:null;})()`,
            awaitPromise: true, returnByValue: true,
        });
        return r.result.value;
    })();
    console.log('· tabId:', tabId);

    const startRes = await bg.send('Runtime.evaluate', {
        expression: `(async()=>{try{return JSON.stringify(await chrome.tabs.sendMessage(${tabId},{type:'adc:startPicker'}))}catch(e){return 'ERR '+e.message}})()`,
        awaitPromise: true, returnByValue: true,
    });
    console.log('· startPicker:', startRes.result.value);
    await sleep(1500);

    // 采集异常
    const errors = [];
    for (const ev of page.events) {
        if (ev.method === 'Runtime.exceptionThrown') {
            const d = ev.params?.exceptionDetails;
            errors.push('EXCEPTION: ' + (d?.exception?.description || d?.text || '').slice(0, 400));
        }
        if (ev.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(ev.params.type)) {
            const txt = (ev.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
            if (/adc|picker|content script|invalidated|chrome\./i.test(txt)) {
                errors.push(ev.params.type.toUpperCase() + ': ' + txt.slice(0, 400));
            }
        }
        if (ev.method === 'Log.entryAdded') {
            const e = ev.params.entry;
            if (['error', 'warning'].includes(e.level)) {
                errors.push('LOG(' + e.source + '): ' + String(e.text).slice(0, 300));
            }
        }
    }

    console.log('\n=== 与扩展相关的异常/报错 ===');
    if (errors.length === 0) console.log('（无）');
    else errors.slice(0, 15).forEach((e) => console.log(' •', e));

    console.log('\n=== 内容脚本是否还活着 ===');
    const alive = await bg.send('Runtime.evaluate', {
        expression: `(async()=>{try{return JSON.stringify(await chrome.tabs.sendMessage(${tabId},{type:'adc:ping'}))}catch(e){return 'ERR '+e.message}})()`,
        awaitPromise: true, returnByValue: true,
    });
    console.log('· ping:', alive.result.value);

    try { chrome.kill(); } catch { /* ignore */ }
})().catch((e) => { console.error('✗', e?.message ?? e); process.exitCode = 1; })
    .finally(async () => {
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
