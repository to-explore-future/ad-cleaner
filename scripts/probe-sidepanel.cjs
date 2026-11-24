/**
 * 探测：能不能用 CDP 的 userGesture 真正打开 Chrome 的**侧边栏**（而不是开成标签页），
 * 然后找到它的 target 并验证 F12 联动。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 10270;
const EXT = path.resolve(__dirname, '../.output/chrome-mv3');
const PAGE = `http://127.0.0.1:${process.env.FIXTURE_PORT || 8941}/`;

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-sp-'));
const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', '--headless=new', '--disable-gpu', '--window-size=1200,900',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 80) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(url); if (r.ok) return r.json(); } catch { /* retry */ }
        await sleep(300);
    }
    throw new Error('连不上 ' + url);
}
class Session {
    constructor(ws) { this.ws = ws; this.i = 0; this.pending = new Map(); }
    static async open(url) {
        const ws = new WebSocket(url);
        await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', rej, { once: true });
        });
        const s = new Session(ws);
        ws.addEventListener('message', (e) => {
            const m = JSON.parse(e.data);
            if (m.id && s.pending.has(m.id)) {
                const { resolve, reject } = s.pending.get(m.id);
                s.pending.delete(m.id);
                m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
            }
        });
        return s;
    }
    send(method, params = {}) {
        const id = ++this.i;
        return new Promise((res, rej) => {
            this.pending.set(id, { resolve: res, reject: rej });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 20000);
        });
    }
}
const ev = async (s, expr, userGesture = false) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture });
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description).slice(0, 300));
    return r.result.value;
};

(async () => {
    await getJson(`http://127.0.0.1:${PORT}/json/version`);
    let sw = null, extId = null;
    for (let i = 0; i < 80 && !sw; i++) {
        await sleep(400);
        sw = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
        if (sw) extId = new URL(sw.url).host;
    }
    const bg = await Session.open(sw.webSocketDebuggerUrl);
    await bg.send('Runtime.enable');

    // 打开测试页
    const host = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
    const { windowId } = await bg.send('Browser.getWindowForTarget', { targetId: host.id });
    await bg.send('Target.createTarget', { url: PAGE, windowId, newWindow: false });
    await sleep(3000);

    // 开一个扩展页面，用它来调 sidePanel.open（需要 userGesture）
    const { targetId: openerId } = await bg.send('Target.createTarget', {
        url: `chrome-extension://${extId}/sidepanel.html`, windowId, newWindow: false,
    });
    await sleep(2500);

    const opener = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.id === openerId);
    const op = await Session.open(opener.webSocketDebuggerUrl);
    await op.send('Runtime.enable');

    let res;
    try {
        res = await ev(op, `(async () => {
            const w = await chrome.windows.getCurrent();
            await chrome.sidePanel.open({ windowId: w.id });
            return 'opened:' + w.id;
        })()`, true);
    } catch (e) {
        res = 'ERR ' + e.message;
    }
    console.log('· sidePanel.open:', res);
    await sleep(3000);

    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const sidePanelTargets = targets.filter((t) => t.url.includes('sidepanel.html') || t.type === 'other');
    console.log('· 当前 targets:');
    targets.forEach((t) => console.log(`   [${t.type}] ${t.url.slice(0, 90)}`));

    console.log(sidePanelTargets.some((t) => t.type === 'other')
        ? '✓ 找到侧边栏 target（type=other），可以在里面跑验证'
        : '· 没看到 type=other 的侧边栏 target');

    try { chrome.kill(); } catch { /* ignore */ }
})().catch((e) => { console.error('✗', e?.message ?? e); process.exitCode = 1; })
    .finally(async () => {
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
