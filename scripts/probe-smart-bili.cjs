/**
 * B 站真页面跑「点一下广告，剩下的我来」：
 * 自动在页面里找带「广告」标记的元素，点它，看推断出什么。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 10340;
const EXT = path.resolve(__dirname, '../.output/chrome-mv3');
const PAGE = process.argv[2] || 'https://www.bilibili.com/';

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-smart-'));

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
    await sleep(13000);
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
    await op.send('Runtime.evaluate', {
        expression: `(async () => { const w = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: w.id }); return 'ok'; })()`,
        awaitPromise: true, returnByValue: true, userGesture: true,
    }).catch(() => {});
    await sleep(3000);

    const all = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const spT = all.find((t) => t.type === 'page' && t.url.includes('sidepanel.html') && t.id !== opId);
    if (!spT) { console.log('✗ 没接管到侧边栏'); chrome.kill(); return; }
    const panel = await S.open(spT.webSocketDebuggerUrl);
    await panel.send('Runtime.enable');
    console.log('· 已接管侧边栏');

    // 在页面里找一个"短文本 广告/推广"的元素
    const badge = await ev(page, `(() => {
        const cands = [];
        document.querySelectorAll('span, div, i, em, b, label').forEach((el) => {
            const t = (el.textContent || '').trim();
            if (t.length <= 4 && /广告|推广|赞助/.test(t)) {
                const r = el.getBoundingClientRect();
                if (r.width > 4 && r.height > 4 && r.top > 10 && r.bottom < window.innerHeight - 10) {
                    cands.push({ t, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
                                 cls: el.className, area: r.width * r.height });
                }
            }
        });
        cands.sort((a, b) => a.area - b.area);
        return JSON.stringify(cands.slice(0, 5));
    })()`);
    console.log('· 页面里找到的广告标记:', badge);

    const list = JSON.parse(badge || '[]');
    if (list.length === 0) {
        console.log('· 这个页面当前没有带「广告」字样的元素，改用视频卡片测试');
        const card = await ev(page, `(() => {
            const list = [...document.querySelectorAll('.floor-single-card, .bili-video-card')];
            const el = list.find((e) => { const r = e.getBoundingClientRect();
                return r.top > 60 && r.bottom < window.innerHeight - 20 && r.width > 100; });
            if (!el) return '';
            const r = el.getBoundingClientRect();
            return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
        })()`);
        if (!card) { console.log('✗ 连卡片也没找到'); chrome.kill(); return; }
        list.push({ ...JSON.parse(card), t: '(卡片)' });
    }

    // 诊断：面板现在是什么状态
    const panelState = await ev(panel, `JSON.stringify({
        text: document.body.innerText.replace(/\\s+/g,' ').slice(0, 120),
        hasSmartBtn: !!document.querySelector('.smart-main'),
        disabled: document.querySelector('.smart-main')?.disabled ?? null,
        domain: document.querySelector('.site')?.innerText ?? null,
    })`);
    console.log('· 面板状态:', panelState);

    // 进智能模式
    await ev(panel, `(() => { document.querySelector('.smart-main')?.click(); return true; })()`);
    await sleep(1500);
    const waiting = await ev(panel, `document.body.innerText.includes('在页面上点一下那个广告')`);
    console.log('· 进入智能等待:', waiting);

    const target = list[0];
    console.log(`· 点击目标: ${target.t}  @(${target.x},${target.y})  class=${target.cls}`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
    await sleep(400);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await sleep(2500);

    const resultText = await ev(panel, `document.querySelector('.smart-result')?.innerText?.replace(/\\s+/g,' ') ?? '(无结果页)'`);
    console.log('· 推断结果:', resultText);
    const marked = await ev(page, `document.querySelectorAll('.__adc_match').length`);
    console.log('· 页面上圈出的元素数:', marked);

    const shotP = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/adc-smart-bili-page.png', Buffer.from(shotP.data, 'base64'));
    const shotS = await panel.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/adc-smart-bili-panel.png', Buffer.from(shotS.data, 'base64'));

    console.log('\n窗口留 20 秒');
    await sleep(20000);
    try { chrome.kill(); } catch { /* ignore */ }
})().catch((e) => { console.error('✗', e?.message ?? e); process.exitCode = 1; })
    .finally(async () => {
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
