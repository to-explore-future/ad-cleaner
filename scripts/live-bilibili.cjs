#!/usr/bin/env node
/**
 * B 站首页实战演练（可见窗口，用户盯着看）。
 *
 * 关键点：
 *   · 用**真正的侧边栏**（chrome.sidePanel.open + userGesture）
 *   · 鼠标由 CDP 派发，页面上的高亮框肉眼可见地跟着走
 *   · 侧边栏里的 DOM 树同步（能读到就读，读不到就靠肉眼看）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.ADC_PORT || 10290);
const EXT = path.resolve(__dirname, '../.output/chrome-mv3');
const PAGE = process.argv[2] || 'https://www.bilibili.com/';

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-bili-'));
const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${udd}`,
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1500,950',
    '--window-position=80,60',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 150) {
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
    send(method, params = {}, timeout = 45000) {
        const id = ++this.i;
        return new Promise((res, rej) => {
            this.pending.set(id, { resolve: res, reject: rej });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, timeout);
        });
    }
}

/** 带重试的 evaluate（页面忙的时候偶发超时） */
async function ev(s, expr, opts = {}) {
    const { userGesture = false, tries = 3 } = opts;
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
        try {
            const r = await s.send('Runtime.evaluate', {
                expression: expr, awaitPromise: true, returnByValue: true, userGesture,
            }, 45000);
            if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description).slice(0, 300));
            return r.result.value;
        } catch (e) {
            lastErr = e;
            await sleep(800);
        }
    }
    throw lastErr;
}

async function attach(targetId) {
    for (let i = 0; i < 150; i++) {
        const t = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.id === targetId);
        if (t && t.webSocketDebuggerUrl) {
            try {
                const s = await Session.open(t.webSocketDebuggerUrl);
                await s.send('Runtime.enable');
                for (let k = 0; k < 40; k++) {
                    try { await s.send('Runtime.evaluate', { expression: '1', returnByValue: true }, 5000); return s; }
                    catch { await sleep(400); }
                }
            } catch { /* retry */ }
        }
        await sleep(300);
    }
    throw new Error('attach 失败');
}

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
    if (!sw) throw new Error('扩展没起来');
    console.log('· 扩展 id:', extId);

    const bg = await Session.open(sw.webSocketDebuggerUrl);
    await bg.send('Runtime.enable');
    const initial = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
    const { windowId } = await bg.send('Browser.getWindowForTarget', { targetId: initial.id });

    // ① 直接导航首页（不新建标签，避免 target 抖动）
    console.log('· 打开', PAGE);
    const pageSession = await attach(initial.id);
    await pageSession.send('Page.enable');
    await pageSession.send('Page.navigate', { url: PAGE });
    await sleep(12000);

    const title = await ev(pageSession, 'document.title');
    check('① B 站首页加载', !!title, String(title).slice(0, 40));

    // ② 开扩展页做手势来源，调 sidePanel.open
    const { targetId: openerId } = await bg.send('Target.createTarget', {
        url: `chrome-extension://${extId}/sidepanel.html`, windowId, newWindow: false,
    });
    await sleep(3000);
    const opener = await attach(openerId);

    const openRes = await ev(opener, `(async () => {
        const w = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: w.id });
        return 'ok';
    })()`, { userGesture: true }).catch((e) => 'ERR ' + e.message);
    console.log('· sidePanel.open:', openRes);
    await sleep(3000);

    // ③ 找侧边栏 target
    const all = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    console.log('· targets:');
    all.forEach((t) => console.log(`   [${t.type}] ${t.url.slice(0, 80)}`));
    /**
     * 真侧边栏在 CDP 里不是 `type: other`，而是**又一个 page target**，
     * URL 同样是 sidepanel.html。排除掉我自己开的那个 opener 标签，剩下的就是它。
     */
    const sp = all.find((t) => t.type === 'page'
        && t.url.includes('sidepanel.html')
        && t.id !== openerId)
        ?? all.find((t) => t.type === 'other' && t.url.includes('sidepanel.html'));
    let panel = null;
    if (sp?.webSocketDebuggerUrl) {
        panel = await attach(sp.id);
        console.log('✓ 真侧边栏可接管');
    } else {
        console.log('· 侧边栏未作为 target 暴露，界面请肉眼确认');
    }

    // ④ 一切都在**真侧边栏**里做：它自己找标签页、自己点按钮
    if (panel) {
        const site = await ev(panel, `document.querySelector('.site')?.innerText ?? ''`).catch(() => '');
        console.log('   · 侧边栏认出的站点:', site);
        check('④ 真侧边栏自动认出 B 站', /bilibili/.test(site), site);

        const dis = await ev(panel, `document.querySelector('.smart-manual')?.disabled ?? true`).catch(() => true);
        check('④ 按钮可用', dis === false, 'disabled=' + dis);

        await ev(panel, `(() => { document.querySelector('.smart-manual')?.click(); return true; })()`);
        await sleep(2000);
        const inPick = await ev(panel, `document.body.innerText.includes('选择模式')`).catch(() => false);
        check('④ 点按钮进入选择模式', inPick === true, String(inPick));

        const warn = await ev(panel, `!!document.querySelector('.warn-bar')`).catch(() => true);
        check('④ 没有"和页面连不上"警告', warn === false, 'warn=' + warn);
    } else {
        console.log('· 没接管到侧边栏，跳过');
    }

    await sleep(1200);

    // ⑤ 慢慢扫过几个区域，让高亮框肉眼可见地跟着走
    const points = [
        { x: 300, y: 200, label: '顶部导航' },
        { x: 750, y: 480, label: '轮播区' },
        { x: 400, y: 780, label: '视频卡片区' },
        { x: 1150, y: 700, label: '右侧列表' },
        { x: 200, y: 120, label: '左上 logo' },
    ];
    const seen = [];
    for (const pt of points) {
        await pageSession.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' });
        await sleep(1800);
        const tag = await ev(pageSession, `(() => {
            const h = document.getElementById('__adc_overlay');
            const r = h && h.shadowRoot;
            const t = r && r.querySelector('.tag');
            return t && !t.hidden ? t.textContent : '';
        })()`).catch(() => '');
        console.log(`   · ${pt.label} (${pt.x},${pt.y}) → ${tag || '(无高亮)'}`);
        if (tag) seen.push(tag);
    }
    check('⑤ 鼠标移动时高亮框跟着走', seen.length >= 3, `${seen.length}/${points.length} 个位置有高亮`);

    if (panel) {
        // 同类元素是否被标出来（B 站首页的视频卡片应该有很多）
        const marked = await ev(pageSession, `document.querySelectorAll('.__adc_match').length`).catch(() => 0);
        console.log('   · 页面上标记出的同类元素:', marked);
        check('⑦ 页面上同类元素被虚线标出', Number(marked) > 1, `${marked} 个`);

        // 直接问页面：内容脚本的状态到底有没有更新（隔离问题）
        const direct = await ev(opener, `(async () => {
            const tabs = await chrome.tabs.query({});
            const t = tabs.find(x => (x.url||'').startsWith('https://www.bilibili.com/'));
            if (!t) return 'no-tab';
            try {
                const r = await chrome.tabs.sendMessage(t.id, { type: 'adc:state' });
                return JSON.stringify({ locked: r.locked, chainLen: r.chain.length,
                    last: r.chain[r.chain.length-1]?.tag,
                    sel: (r.selector||'').slice(0,50), broad: r.broadSelector, broadCount: r.broadCount });
            } catch (e) { return 'ERR ' + e.message; }
        })()`).catch((e) => 'ERR ' + e.message);
        console.log('   · 页面直报状态:', direct);

        const panelWarn = await ev(panel, `!!document.querySelector('.warn-bar')`).catch(() => null);
        console.log('   · 面板是否显示"连不上":', panelWarn);

        const hint = await ev(panel, `document.querySelector('.broad-hint')?.innerText.replace(/\\s+/g,' ').trim() ?? ''`).catch(() => '');
        console.log('   · 面板提示:', hint || '(无)');
        check('⑦ 面板提示"同类还有 N 个"', /还有\s*\d+\s*个/.test(hint), hint);

        const rows = await ev(panel, `[...document.querySelectorAll('.tree .row')].map(r => r.innerText.replace(/\\s+/g,' ').trim())`).catch(() => []);
        console.log('   · 侧边栏树:', JSON.stringify(rows));
        const info = await ev(panel, `[...document.querySelectorAll('.info-row .v')].map(v => v.innerText.trim())`).catch(() => []);
        console.log('   · 侧边栏信息:', JSON.stringify(info));
        check('⑥ 真侧边栏的树同步', Array.isArray(rows) && rows.length > 0, `${rows.length} 层`);
        check('⑦ 树里不出现内部标记类', !rows.some((r) => r.includes('__adc_')),
            rows.find((r) => r.includes('__adc_')) ?? '干净');
    }

    const shot = await pageSession.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/adc-bili.png', Buffer.from(shot.data, 'base64'));
    if (panel) {
        const s2 = await panel.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync('/tmp/adc-bili-panel.png', Buffer.from(s2.data, 'base64'));
    }

    console.log('\n========== 汇总 ==========');
    const failed = checks.filter((c) => !c.ok);
    console.log(`${checks.length - failed.length}/${checks.length} 项通过`);
    console.log('\n窗口留 45 秒 —— 你现在可以自己动鼠标试（Esc 退出选择模式）');
    await sleep(45000);

    try { chrome.kill(); } catch { /* ignore */ }
})().catch((e) => { console.error('✗', e?.message ?? e); process.exitCode = 1; })
    .finally(async () => {
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
