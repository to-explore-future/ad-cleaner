/**
 * B 站真页面：锁定之后，框 / 标签 / 树 / 选择器 是否**一动不动**。
 * 用户反馈"选中之后还在变"，这里用真实页面复现并定位。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 10330;
const EXT = path.resolve(__dirname, '../.output/chrome-mv3');
const PAGE = 'https://www.bilibili.com/';

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-lock-'));
const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${udd}`,
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--no-first-run', '--disable-blink-features=AutomationControlled',
    '--window-size=1400,950', '--window-position=80,60',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(u, n = 150) {
    for (let i = 0; i < n; i++) {
        try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* retry */ }
        await sleep(300);
    }
    throw new Error('连不上 ' + u);
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
            if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description).slice(0, 250));
            return r.result.value;
        } catch (e) { err = e; await sleep(700); }
    }
    throw err;
};

const checks = [];
const check = (n, ok, d = '') => { checks.push({ n, ok, d }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? '  — ' + d : ''}`); };

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
    const pt = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.id === pageId);
    const page = await S.open(pt.webSocketDebuggerUrl);
    await page.send('Runtime.enable');

    // 开真侧边栏
    const { targetId: opId } = await bg.send('Target.createTarget', {
        url: `chrome-extension://${extId}/sidepanel.html`, windowId, newWindow: false,
    });
    await sleep(2500);
    const opT = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.id === opId);
    const op = await S.open(opT.webSocketDebuggerUrl);
    await op.send('Runtime.enable');

    await ev(op, `(async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id }); return 'ok'; })()`, 2).catch(async () => {
        await op.send('Runtime.evaluate', {
            expression: `(async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id }); return 'ok'; })()`,
            awaitPromise: true, returnByValue: true, userGesture: true,
        });
    });
    await sleep(3000);

    const all = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const spT = all.find((t) => t.type === 'page' && t.url.includes('sidepanel.html') && t.id !== opId);
    if (!spT) { console.log('✗ 没接管到侧边栏'); chrome.kill(); return; }
    const panel = await S.open(spT.webSocketDebuggerUrl);
    await panel.send('Runtime.enable');
    console.log('· 已接管真侧边栏');

    // 进选择模式
    await ev(panel, `(() => { document.querySelector('.smart-manual')?.click(); return true; })()`);
    await sleep(1500);
    console.log('· 选择模式:', await ev(panel, `document.body.innerText.includes('选择模式')`));

    // 点一个视口内的卡片
    const spot = await ev(page, `(() => {
        const vh = window.innerHeight, vw = window.innerWidth;
        const list = [...document.querySelectorAll('.floor-single-card, .bili-video-card')];
        const el = list.find((e) => {
            const r = e.getBoundingClientRect();
            return r.top > 60 && r.bottom < vh - 20 && r.left > 0 && r.right < vw && r.width > 100;
        });
        if (!el) return '';
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`);
    if (!spot) { console.log('✗ 没找到可点的卡片'); chrome.kill(); return; }
    const c = JSON.parse(spot);
    console.log('· 点击坐标:', c);

    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y, button: 'none' });
    await sleep(500);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    await sleep(1200);

    const snap = async () => JSON.stringify({
        box: await ev(page, `(() => { const h=document.getElementById('__adc_overlay'); const r=h&&h.shadowRoot; const b=r&&r.querySelector('.box'); return b&&!b.hidden?[b.style.left,b.style.top,b.style.width,b.style.height,b.style.borderColor].join(','):'hidden'; })()`),
        tag: await ev(page, `(() => { const h=document.getElementById('__adc_overlay'); const r=h&&h.shadowRoot; const t=r&&r.querySelector('.tag'); return t&&!t.hidden?t.textContent:'hidden'; })()`),
        treeCur: await ev(panel, `document.querySelector('.tree .row.current')?.innerText.replace(/\\s+/g,' ').trim() ?? ''`),
        sel: await ev(panel, `[...document.querySelectorAll('.info-row .v')][0]?.innerText.trim() ?? ''`),
        markCount: await ev(page, `document.querySelectorAll('.__adc_match').length`),
    });

    const before = await snap();
    console.log('· 锁定后快照:', before);

    // 到处动鼠标
    for (const p2 of [{ x: 200, y: 200 }, { x: 900, y: 400 }, { x: 400, y: 700 }, { x: 1100, y: 250 }]) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p2.x, y: p2.y, button: 'none' });
        await sleep(700);
        const now = await snap();
        if (now !== before) {
            const a = JSON.parse(before), b = JSON.parse(now);
            for (const k of Object.keys(a)) {
                if (a[k] !== b[k]) console.log(`   · (${p2.x},${p2.y}) 变了: ${k}: ${a[k]} → ${b[k]}`);
            }
            break;
        }
    }
    const after = await snap();
    check('锁定后框/标签/树/选择器全都不变', before === after,
        before === after ? '完全一致' : '有变化（见上）');

    await sleep(300);
    try { chrome.kill(); } catch { /* ignore */ }
    console.log('\n========== 汇总 ==========');
    console.log(`${checks.filter((x) => x.ok).length}/${checks.length} 项通过`);
})().catch((e) => { console.error('✗', e?.message ?? e); process.exitCode = 1; })
    .finally(async () => {
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
