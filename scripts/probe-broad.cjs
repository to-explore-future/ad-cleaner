/** 专门验：B 站上悬停一个卡片时，算出的"同类 class 选择器"和数量对不对。 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 10300;
const EXT = path.resolve(__dirname, '../.output/chrome-mv3');
const PAGE = 'https://www.bilibili.com/';

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-probe-'));
const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', '--disable-blink-features=AutomationControlled',
    '--window-size=1400,950', '--window-position=80,60',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, tries = 150) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(url); if (r.ok) return r.json(); } catch { /* retry */ }
        await sleep(300);
    }
    throw new Error('连不上 ' + url);
}
class S {
    constructor(ws) { this.ws = ws; this.i = 0; this.p = new Map(); }
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
            }
        });
        return s;
    }
    send(method, params = {}, t = 45000) {
        const id = ++this.i;
        return new Promise((res, rej) => {
            this.p.set(id, { resolve: res, reject: rej });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (this.p.delete(id)) rej(new Error('timeout ' + method)); }, t);
        });
    }
}
const ev = async (s, expr, tries = 3) => {
    let err;
    for (let i = 0; i < tries; i++) {
        try {
            const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description).slice(0, 200));
            return r.result.value;
        } catch (e) { err = e; await sleep(700); }
    }
    throw err;
};

(async () => {
    await getJson(`http://127.0.0.1:${PORT}/json/version`);
    let sw = null, extId = null;
    for (let i = 0; i < 150 && !sw; i++) {
        await sleep(400);
        sw = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
        if (sw) extId = new URL(sw.url).host;
    }
    const bg = await S.open(sw.webSocketDebuggerUrl);
    await bg.send('Runtime.enable');
    const host = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
    const { windowId } = await bg.send('Browser.getWindowForTarget', { targetId: host.id });

    const { targetId: pageId } = await bg.send('Target.createTarget', { url: PAGE, windowId, newWindow: false });
    await sleep(12000);

    const t = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.id === pageId);
    const page = await S.open(t.webSocketDebuggerUrl);
    await page.send('Runtime.enable');

    // 扩展页（用来发消息 + 读状态）
    const { targetId: opId } = await bg.send('Target.createTarget', {
        url: `chrome-extension://${extId}/sidepanel.html`, windowId, newWindow: false,
    });
    await sleep(3000);
    const opT = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.id === opId);
    const op = await S.open(opT.webSocketDebuggerUrl);
    await op.send('Runtime.enable');

    const tabId = await ev(op, `(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => (x.url||'').startsWith('https://www.bilibili.com/'));
        return t ? t.id : null;
    })()`);
    console.log('· B站 tabId:', tabId);

    await ev(op, `chrome.tabs.sendMessage(${tabId}, { type: 'adc:startPicker' }).then(r => JSON.stringify(r))`);
    await sleep(1000);

    // 找一个确实重复的元素，坐标从 DOM 算
    const spot = await ev(page, `(() => {
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        for (const sel of ['.floor-single-card', '.bili-video-card', '.bili-video-card__cover']) {
            const list = [...document.querySelectorAll(sel)];
            if (list.length < 2) continue;
            // ⚠️ 必须挑**视口内**的元素，否则 elementFromPoint 拿不到
            const el = list.find((e) => {
                const r = e.getBoundingClientRect();
                return r.width > 8 && r.height > 8 && r.top > 10 && r.bottom < vh - 10 && r.left > 0 && r.right < vw;
            });
            if (!el) continue;
            const r = el.getBoundingClientRect();
            return JSON.stringify({ sel, count: list.length, vw, vh,
                x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
        }
        return '';
    })()`);

    if (!spot) {
        console.log('✗ 没找到重复元素（页面可能没加载出卡片）');
    } else {
        const p = JSON.parse(spot);
        console.log(`· 目标: ${p.sel} 共 ${p.count} 个，坐标 (${p.x},${p.y})`);
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none' });
        await sleep(1200);

        const st = await ev(op, `chrome.tabs.sendMessage(${tabId}, { type: 'adc:state' }).then(r => JSON.stringify({
            lastTag: r.chain[r.chain.length-1]?.tag,
            lastCls: r.chain[r.chain.length-1]?.classes,
            precise: r.selector,
            preciseCount: r.matchCount,
            broad: r.broadSelector,
            broadCount: r.broadCount,
        }))`);
        console.log('· 状态:', st);

        const s = JSON.parse(st);
        console.log(s.broadCount > 1
            ? `✓ 同类识别正确：${s.broad} → ${s.broadCount} 个`
            : `✗ 同类只识别到 ${s.broadCount} 个（broad=${s.broad}）`);

        // 页面上实际标了几个
        const marked = await ev(page, `document.querySelectorAll('.__adc_match').length`);
        console.log(marked > 1 ? `✓ 页面上标出了 ${marked} 个同类元素` : `✗ 页面上只标了 ${marked} 个`);
    }

    await ev(op, `chrome.tabs.sendMessage(${tabId}, { type: 'adc:stopPicker' })`).catch(() => {});
    await sleep(500);

    console.log('\n窗口留 25 秒');
    await sleep(25000);
    try { chrome.kill(); } catch { /* ignore */ }
})().catch((e) => { console.error('✗', e?.message ?? e); process.exitCode = 1; })
    .finally(async () => {
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
