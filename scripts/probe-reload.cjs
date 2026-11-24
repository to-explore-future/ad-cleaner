/**
 * 复现用户场景：扩展已经加载、页面开着 → **重新加载扩展** → 看页面里还报不报错。
 *
 * 这是最容易被忽略的一类报错：旧内容脚本的上下文失效了，
 * 但它还在跑定时器 / 监听消息，每次调 chrome.* 都抛一次异常。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 10320;
const EXT = path.resolve(__dirname, '../.output/chrome-mv3');
const PAGE = process.argv[2] || 'https://www.bilibili.com/';

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-rl-'));
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
    constructor(ws) { this.ws = ws; this.i = 0; this.p = new Map(); this.events = []; this.dead = false; }
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
            } else if (m.method) s.events.push(m);
        });
        ws.addEventListener('close', () => { s.dead = true; });
        return s;
    }
    send(method, params = {}, t = 20000) {
        const id = ++this.i;
        return new Promise((res, rej) => {
            this.p.set(id, { resolve: res, reject: rej });
            try { this.ws.send(JSON.stringify({ id, method, params })); } catch (e) { rej(e); return; }
            setTimeout(() => { if (this.p.delete(id)) rej(new Error('timeout ' + method)); }, t);
        });
    }
}

function collectErrors(events) {
    const out = [];
    for (const ev of events) {
        if (ev.method === 'Runtime.exceptionThrown') {
            const d = ev.params?.exceptionDetails;
            out.push((d?.exception?.description || d?.text || '').slice(0, 300));
        }
        if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
            out.push(String(ev.params.entry.text).slice(0, 300));
        }
    }
    return out;
}

(async () => {
    await getJson(`http://127.0.0.1:${PORT}/json/version`);
    let sw = null, extId = null;
    for (let i = 0; i < 120 && !sw; i++) {
        await sleep(400);
        sw = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
        if (sw) extId = new URL(sw.url).host;
    }
    console.log('· 扩展 id:', extId);
    const bg = await S.open(sw.webSocketDebuggerUrl);
    await bg.send('Runtime.enable');
    const host = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
    const { windowId } = await bg.send('Browser.getWindowForTarget', { targetId: host.id });

    const { targetId } = await bg.send('Target.createTarget', { url: 'about:blank', windowId, newWindow: false });
    await sleep(800);
    const t = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.id === targetId);
    const page = await S.open(t.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await page.send('Log.enable').catch(() => {});

    console.log('· 打开页面', PAGE);
    await page.send('Page.navigate', { url: PAGE });
    await sleep(10000);

    page.events.length = 0; // 清掉加载阶段的噪音

    console.log('· 调用 chrome.runtime.reload() 重新加载扩展…');
    await bg.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()', returnByValue: true }).catch(() => {});

    // 等 8 秒：如果旧脚本还在跑定时器，这段时间会持续抛异常
    await sleep(8000);

    // 敏感性检查：确认此刻页面里的 chrome.* 确实已经失效（旧代码在这里必抛）
    const probe = await page.send('Runtime.evaluate', {
        expression: `(() => {
            const out = { storage: typeof chrome?.storage, runtimeId: chrome?.runtime?.id ?? null };
            try { chrome.storage.local.get('x'); out.getOk = true; }
            catch (e) { out.getOk = false; out.err = String(e.message).slice(0, 80); }
            return JSON.stringify(out);
        })()`,
        returnByValue: true,
    }).catch((e) => ({ result: { value: 'ERR ' + e.message } }));
    console.log('· 重载后页面里的 chrome 状态:', probe.result.value);

    const errs = collectErrors(page.events);
    const relevant = errs.filter((e) => /invalidated|chrome\.|adc|picker|Extension context/i.test(e));
    console.log('\n=== 重载后 8 秒内页面报错 ===');
    if (errs.length === 0) console.log('（无任何报错）');
    else {
        console.log(`共 ${errs.length} 条，其中与扩展相关 ${relevant.length} 条`);
        errs.slice(0, 8).forEach((e) => console.log(' •', e));
    }

    console.log(relevant.length === 0
        ? '\n✓ 重载扩展后不再往页面刷错误'
        : '\n✗ 仍有扩展相关报错');

    try { chrome.kill(); } catch { /* ignore */ }
})().catch((e) => { console.error('✗', e?.message ?? e); process.exitCode = 1; })
    .finally(async () => {
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
