#!/usr/bin/env node
/**
 * 广告清道夫 · 端到端自测
 *
 * 用无头（实际是屏幕外有头）Chrome + CDP 真的去操作：
 *   ① 打开测试页
 *   ② 面板里点「选中要拦的东西」进入选择模式
 *   ③ 在页面上真的移动鼠标 → 看面板的 DOM 树是否跟着变
 *   ④ 真的点一下 → 锁定
 *   ⑤ 在面板的树里点祖先那一行 → 往外扩一层，选择器跟着变
 *   ⑥ 确认拦截 → 页面上那块东西真的没了
 *   ⑦ 取消勾选 → 它又回来了
 *   ⑧ 悬浮规则 → 已隐藏的元素临时显形
 *   ⑨ 「命中 N 处」
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.ADC_PORT || 10230);
const EXT = path.resolve(__dirname, '../.output/chrome-mv3');
const PAGE = `http://127.0.0.1:${process.env.FIXTURE_PORT || 8941}/`;

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-'));

const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${udd}`,
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    // ⚠️ 真·无头：**完全不出窗口**，不抢焦点、不在 Dock 里出现
    '--headless=new',
    '--disable-gpu',
    '--window-size=1200,900',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 80) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(url);
            if (r.ok) return r.json();
        } catch { /* retry */ }
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
            setTimeout(() => {
                if (this.pending.delete(id)) rej(new Error('timeout: ' + method));
            }, 30000);
        });
    }
}

const ev = async (s, expr) => {
    const r = await s.send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
        throw new Error('页面报错: ' + (r.exceptionDetails.exception?.description ?? '').slice(0, 300));
    }
    return r.result.value;
};

/** 按字段名取面板里的值（选择器/条件/范围/方式/命中）—— 比按位置稳 */
const infoVal = (panel, key) => ev(panel, `(() => {
    const rows = [...document.querySelectorAll('.info-row')];
    const r = rows.find((x) => (x.querySelector('.k')?.innerText ?? '').trim() === ${JSON.stringify(key)});
    return (r?.querySelector('.v')?.innerText ?? '').trim();
})()`);

async function openTab(bg, windowId, url) {
    const { targetId } = await bg.send('Target.createTarget', { url, windowId, newWindow: false });
    let p = null;
    for (let i = 0; i < 80 && !p; i++) {
        await sleep(300);
        const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
        const t = list.find((x) => x.id === targetId);
        if (t && t.webSocketDebuggerUrl) {
            try {
                p = await Session.open(t.webSocketDebuggerUrl);
                await p.send('Runtime.enable');
                for (let k = 0; k < 20; k++) {
                    try {
                        await p.send('Runtime.evaluate', { expression: '1', returnByValue: true });
                        break;
                    } catch { await sleep(300); }
                }
            } catch { /* retry */ }
        }
    }
    if (!p) throw new Error('打不开标签页: ' + url);
    return { session: p, targetId };
}

const checks = [];
function check(name, ok, detail = '') {
    checks.push({ name, ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
}

/** 面板里按选择器点一个元素 */
async function clickPanel(panel, sel) {
    return ev(panel, `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return false;
        el.click();
        return true;
    })()`);
}

/** 在页面上真的走一遍鼠标移动 */
async function moveMouse(page, x, y) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
}

/** 在页面上真的点一下 */
async function clickMouse(page, x, y) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const displayOf = (page, sel) => ev(page, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    return getComputedStyle(el).display;
})()`);

(async () => {
    await getJson(`http://127.0.0.1:${PORT}/json/version`);

    // ── 拿扩展 id ──
    let sw = null;
    let extId = null;
    for (let i = 0; i < 80 && !sw; i++) {
        await sleep(400);
        const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
        sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
        if (sw) extId = new URL(sw.url).host;
    }
    if (!sw) throw new Error('扩展没加载起来');
    const bg = await Session.open(sw.webSocketDebuggerUrl);
    await bg.send('Runtime.enable');

    const list0 = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const host = list0.find((t) => t.type === 'page');
    const { windowId } = await bg.send('Browser.getWindowForTarget', { targetId: host.id });

    // ── 打开测试页 ──
    const { session: page } = await openTab(bg, windowId, PAGE);
    await sleep(2500);

    // 测试页对应的 tabId
    const pageTabId = await ev(page, '1').then(async () => {
        const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
        return targets;
    });
    // 用 background 的 chrome.tabs 查（targetId → tabId 不可直连，按 url 匹配）
    const tabId = await ev(bg, `(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => (x.url || '').startsWith('http://127.0.0.1:${process.env.FIXTURE_PORT || 8941}/'));
        return t ? t.id : null;
    })()`);
    if (tabId == null) throw new Error('找不到测试页标签');

    // ── 打开面板（当普通标签页跑，显式指定 tabId）──
    const { session: panel } = await openTab(
        bg, windowId, `chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`,
    );
    await sleep(3000);
    await panel.send('Emulation.setDeviceMetricsOverride', {
        width: 420, height: 900, deviceScaleFactor: 2, mobile: false,
    });

    // ═══════════ ① 初始状态 ═══════════
    check('① 初始时广告容器可见', (await displayOf(page, '.ad-box')) !== 'none');
    check('① 面板显示"还没有拦截规则"',
        /还没有拦截规则/.test(await ev(panel, 'document.body.innerText')));
    check('① 面板显示了当前域名',
        /127\.0\.0\.1/.test(await ev(panel, 'document.body.innerText')));

    // ═══════════ ② 进入选择模式 ═══════════
    await clickPanel(panel, '.primary');
    await sleep(1500);
    check('② 点按钮后进入选择模式',
        /选择模式/.test(await ev(panel, 'document.body.innerText')));

    // ═══════════ ③ 悬停：右侧树跟着鼠标走 ═══════════
    await moveMouse(page, 150, 150);
    await sleep(800);
    const hoverChain = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        return rows.map((r) => r.innerText.replace(/\\s+/g, ' ').trim());
    })()`);
    console.log('   · 悬停时的树:', JSON.stringify(hoverChain));
    check('③ 悬停页面时右侧树自动展开祖先链', hoverChain.length >= 5,
        `${hoverChain.length} 层`);
    const curTag = await ev(panel, `document.querySelector('.tree .row.current .html')?.textContent?.trim() ?? ''`);
    check('③ 当前行是 img（鼠标实际命中的）', /^<img/.test(curTag), curTag || '(无)');

    // ═══════════ ④ 点击锁定 ═══════════
    await clickMouse(page, 150, 150);
    await sleep(800);
    const selAfterClick = await ev(panel, `(() => {
        const v = document.querySelectorAll('.info-row .v')[0];
        return v ? v.innerText.trim() : '';
    })()`);
    check('④ 点击后锁定并生成选择器', !!selAfterClick && selAfterClick !== '—', selAfterClick);

    // ═══════════ ⑤ 在树里点祖先，往外扩一层 ═══════════
    const clickRow = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => (x.querySelector('.html')?.textContent ?? '').includes('ad-box'));
        if (!r) return -1;
        r.querySelector('.name').click();
        return 1;
    })()`);
    await sleep(800);
    check('⑤ 树里能找到 ad-box 这一层', clickRow >= 0, 'index=' + clickRow);
    const selAfterWiden = await infoVal(panel, '选择器');
    const matchAfterWiden = await infoVal(panel, '命中');
    console.log('   · 扩一层后:', selAfterWiden, '/', matchAfterWiden);
    check('⑤ 往外扩之后选择器变成外层容器',
        selAfterWiden.includes('ad-box'), selAfterWiden);
    check('⑤ 命中数正确', /1 个元素/.test(matchAfterWiden), matchAfterWiden);

    // （截图：选择模式的样子）
    {
        const shotPick = await panel.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync('/tmp/adc-picker.png', Buffer.from(shotPick.data, 'base64'));
    }

    // ═══════════ ⑥ 确认拦截 ═══════════
    await clickPanel(panel, '.foot.three .primary');
    await sleep(1500);
    check('⑥ 拦截后广告容器被隐藏',
        (await displayOf(page, '.ad-box')) === 'none',
        await displayOf(page, '.ad-box'));
    check('⑥ 正文没被误伤',
        (await displayOf(page, '#keep')) !== 'none');

    const ruleCount = await ev(panel, "document.querySelectorAll('.rule').length");
    check('⑥ 面板里出现 1 条规则', ruleCount === 1, `${ruleCount} 条`);
    const ruleText = await ev(panel, "document.querySelector('.rule')?.innerText.replace(/\\s+/g,' ').trim() ?? ''");
    console.log('   · 规则行:', ruleText);
    check('⑥ 规则行显示命中数', /\b1\b/.test(ruleText), ruleText);

    // ═══════════ ⑦ 取消勾选 → 元素回来 ═══════════
    await clickPanel(panel, '.rule .check');
    await sleep(1200);
    check('⑦ 取消勾选后元素重新出现',
        (await displayOf(page, '.ad-box')) !== 'none',
        await displayOf(page, '.ad-box'));

    // 再勾上
    await clickPanel(panel, '.rule .check');
    await sleep(1200);
    check('⑦ 重新勾选后又隐藏', (await displayOf(page, '.ad-box')) === 'none');

    // ═══════════ ⑧ 悬浮规则 → 已隐藏元素临时显形 ═══════════
    await ev(panel, `(() => {
        const r = document.querySelector('.rule');
        r.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        return true;
    })()`);
    await sleep(1000);
    const ghostDisplay = await displayOf(page, '.ad-box');
    const ghostOutline = await ev(page, `document.querySelector('.ad-box').classList.contains('__adc_outline')`);
    check('⑧ 悬浮已生效的规则 → 元素临时显形', ghostDisplay !== 'none',
        `display=${ghostDisplay}`);
    check('⑧ 显形时带虚线标记', ghostOutline === true, String(ghostOutline));

    await ev(panel, `(() => {
        const r = document.querySelector('.rule');
        r.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
        return true;
    })()`);
    await sleep(1000);
    check('⑧ 鼠标移开后恢复隐藏', (await displayOf(page, '.ad-box')) === 'none');

    // ═══════════ ⑧b 刷新页面后规则仍然生效 ═══════════
    await page.send('Page.reload');
    await sleep(3000);
    check('⑧b 刷新页面后规则依然生效',
        (await displayOf(page, '.ad-box')) === 'none',
        await displayOf(page, '.ad-box'));

    // ═══════════ ⑨ 命中 N 处（多元素选择器）═══════════
    await ev(panel, `(async () => {
        const got = await chrome.storage.local.get('blockRules');
        const all = got.blockRules || {};
        const d = Object.keys(all)[0];
        all[d].push({ id: 'dup1', domain: d, selector: '.dup', action: 'hide', enabled: false,
                      label: 'div.dup', createdAt: Date.now() });
        await chrome.storage.local.set({ blockRules: all });
        return 'ok';
    })()`);
    await sleep(2000);
    const dupText = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.rule')];
        const r = rows.find((x) => x.innerText.includes('.dup'));
        return r ? r.innerText.replace(/\\s+/g, ' ').trim() : '';
    })()`);
    console.log('   · .dup 规则行:', dupText);
    check('⑨ 多元素选择器显示命中 3 处', /3/.test(dupText), dupText);

    // ═══════════ ⑩ 编辑已有规则（重新进入选择模式 + 定位原目标）═══════════
    await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.rule')];
        const r = rows.find((x) => x.innerText.includes('.dup'));
        const btn = r && [...r.querySelectorAll('.icon')].find((b) => b.title === '编辑');
        btn && btn.click();
        return !!btn;
    })()`);
    await sleep(1500);
    check('⑩ 点编辑能重新进入选择模式',
        /选择模式|修改规则/.test(await ev(panel, 'document.body.innerText')));
    const editSel = await ev(panel, `(() => {
        const v = document.querySelectorAll('.info-row .v')[0];
        return v ? v.innerText.trim() : '';
    })()`);
    check('⑩ 编辑时自动定位到原选择器', editSel.includes('.dup'), editSel);

    // ═══════════ ⑪ 删除模式（真的从 DOM 移除）═══════════
    // 先取消掉编辑
    await ev(panel, `(() => { document.querySelector('.foot.three .ghost')?.click(); return true; })()`);
    await sleep(1000);

    // 新建一条 remove 规则：拦 .dup 里的"同款 1"
    await ev(panel, `(async () => {
        const got = await chrome.storage.local.get('blockRules');
        const all = got.blockRules || {};
        const d = Object.keys(all)[0];
        all[d].push({ id: 'rm1', domain: d, selector: '.dup.a', action: 'remove', enabled: true,
                      label: 'div.dup.a', createdAt: Date.now() });
        await chrome.storage.local.set({ blockRules: all });
        return 'ok';
    })()`);
    await sleep(2000);
    const removedStill = await ev(page, `!!document.querySelector('.dup.a')`);
    check('⑪ 删除模式真的把节点从 DOM 里移除了', removedStill === false, String(removedStill));
    check('⑪ 其它同款元素没被误删', (await ev(page, `!!document.querySelector('.dup.b')`)) === true);

    // 截图留档
    const shot = await panel.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/adc-panel.png', Buffer.from(shot.data, 'base64'));

    // ── 汇总 ──
    console.log('\n========== 汇总 ==========');
    const failed = checks.filter((c) => !c.ok);
    console.log(`${checks.length - failed.length}/${checks.length} 项通过`);
    failed.forEach((f) => console.log(`  ✗ ${f.name}  ${f.detail}`));
    process.exitCode = failed.length ? 1 : 0;
})().catch((e) => {
    console.error('✗', e && e.message ? e.message : e);
    process.exitCode = 1;
}).finally(async () => {
    try { chrome.kill(); } catch { /* ignore */ }
    await sleep(400);
    try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
});
