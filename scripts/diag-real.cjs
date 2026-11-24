#!/usr/bin/env node
/**
 * 按**生产语义**复现：面板不使用 ?tabId=，而是像真实侧边栏一样自己去找当前标签页。
 *
 * 关键：把页面标签设为 active，面板标签设为非 active ——
 * 这样面板里的 chrome.tabs.query({active:true}) 拿到的就是页面，和真实侧边栏一致。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.ADC_PORT || 10250);
const EXT = path.resolve(__dirname, '../.output/chrome-mv3');
const FIXTURE_PORT = process.env.FIXTURE_PORT || 8941;
const PAGE = `http://127.0.0.1:${FIXTURE_PORT}/`;

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-real-'));
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
            setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 30000);
        });
    }
}

const ev = async (s, expr) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description).slice(0, 300));
    return r.result.value;
};

async function openTab(bg, windowId, url) {
    const { targetId } = await bg.send('Target.createTarget', { url, windowId, newWindow: false });
    let p = null;
    for (let i = 0; i < 80 && !p; i++) {
        await sleep(300);
        const t = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.id === targetId);
        if (t && t.webSocketDebuggerUrl) {
            try {
                p = await Session.open(t.webSocketDebuggerUrl);
                await p.send('Runtime.enable');
                for (let k = 0; k < 20; k++) {
                    try { await p.send('Runtime.evaluate', { expression: '1', returnByValue: true }); break; }
                    catch { await sleep(300); }
                }
            } catch { /* retry */ }
        }
    }
    if (!p) throw new Error('打不开 ' + url);
    return { session: p, targetId };
}

(async () => {
    await getJson(`http://127.0.0.1:${PORT}/json/version`);
    let sw = null, extId = null;
    for (let i = 0; i < 80 && !sw; i++) {
        await sleep(400);
        const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
        sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
        if (sw) extId = new URL(sw.url).host;
    }
    const bg = await Session.open(sw.webSocketDebuggerUrl);
    await bg.send('Runtime.enable');
    const host = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
    const { windowId } = await bg.send('Browser.getWindowForTarget', { targetId: host.id });

    /**
     * ⚠️ 顺序很关键：**先开面板，后开页面**。
     *    最后创建的那个标签页才是 active 的 —— 于是页面是 active、面板不是，
     *    和真实侧边栏（侧边栏不是标签页）的语义一致。
     */
    const { session: panel } = await openTab(
        bg, windowId, `chrome-extension://${extId}/sidepanel.html`,
    );
    await sleep(2000);

    const { session: page } = await openTab(bg, windowId, PAGE);
    await sleep(3000);

    const state = await ev(panel, `JSON.stringify({
        domain: document.querySelector('.site')?.innerText ?? null,
        btnDisabled: document.querySelector('.smart-manual')?.disabled ?? null,
        body: document.body.innerText.slice(0, 120).replace(/\\s+/g, ' '),
    })`);
    console.log('· 面板眼中的状态:', state);

    const s = JSON.parse(state);
    console.log(s.domain && s.domain !== '当前页面不可用'
        ? '✓ 面板能自己找到当前标签页'
        : '✗ 面板找不到当前标签页 —— 这就是真实环境里点不动的原因');

    // 试着进选择模式
    await ev(panel, `(() => { document.querySelector('.smart-manual')?.click(); return true; })()`);
    await sleep(1500);
    const picking = await ev(panel, `document.body.innerText.includes('选择模式')`);
    console.log(picking ? '✓ 能进入选择模式' : '✗ 进不了选择模式');

    if (picking) {
        // 真的在页面上移动鼠标
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
        await sleep(800);
        const rows = await ev(panel, `[...document.querySelectorAll('.tree .row')].map(r => r.innerText.replace(/\\s+/g,' ').trim())`);
        console.log('· 树:', JSON.stringify(rows));
        console.log(rows.length > 0 ? '✓ 鼠标一动，树跟着更新' : '✗ 鼠标移动，树没反应');
    }

    try { chrome.kill(); } catch { /* ignore */ }
})().catch((e) => { console.error('✗', e?.message ?? e); process.exitCode = 1; })
    .finally(async () => {
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
