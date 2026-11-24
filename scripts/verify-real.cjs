#!/usr/bin/env node
/**
 * 生产语义端到端验证（和真实侧边栏一致）：
 *   · 面板不使用 ?tabId=，而是像真侧边栏那样**自己找当前标签页**
 *   · 先开面板、后开页面 → 页面是 active 标签，面板不是（等价于侧边栏不算标签页）
 *
 * 重点验证用户最在意的第一条：**F12 那种"鼠标一动两边对应"**。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.ADC_PORT || 10260);
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

const checks = [];
const check = (n, ok, d = '') => { checks.push({ n, ok, d }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? '  — ' + d : ''}`); };

const treeRows = (panel) => ev(panel, `[...document.querySelectorAll('.tree .row')].map(r => r.innerText.replace(/\\s+/g,' ').trim())`);
const infoVals = (panel) => ev(panel, `[...document.querySelectorAll('.info-row .v')].map(v => v.innerText.trim())`);
const displayOf = (page, sel) => ev(page, `(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    return getComputedStyle(el).display;
})()`);

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
    const host = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
    const { windowId } = await bg.send('Browser.getWindowForTarget', { targetId: host.id });

    // 先面板、后页面 —— 页面成为 active 标签
    const { session: panel } = await openTab(bg, windowId, `chrome-extension://${extId}/sidepanel.html`);
    await sleep(2000);
    const { session: page } = await openTab(bg, windowId, PAGE);
    await sleep(3500);
    await panel.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: false });
    await sleep(2500);

    // ① 面板自己找到页面
    const site = await ev(panel, `document.querySelector('.site')?.innerText ?? ''`);
    check('① 面板自动认出当前标签页', site.includes('127.0.0.1'), site);

    const disabled = await ev(panel, `document.querySelector('.smart-manual')?.disabled ?? true`);
    check('① 按钮可用（不是在"不支持"状态）', disabled === false, 'disabled=' + disabled);

    // ② 进入选择模式
    await ev(panel, `(() => { document.querySelector('.smart-manual')?.click(); return true; })()`);
    await sleep(1800);
    check('② 进入选择模式', /选择模式/.test(await ev(panel, 'document.body.innerText')));

    // 页面上的提示条
    await sleep(500);
    const bannerText = await ev(page, `(() => {
        const h = document.getElementById('__adc_overlay');
        const r = h && h.shadowRoot;
        const b = r && r.querySelector('.banner');
        return b && !b.hidden ? b.textContent : '';
    })()`);
    check('② 页面上有"选择模式"提示条', /选择模式/.test(bannerText), bannerText);

    // ③ F12 效果：鼠标移动 → 树跟着变（**这是用户最在意的一条**）
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(600);
    const rows1 = await treeRows(panel);
    console.log('   · 位置 A 的树:', JSON.stringify(rows1));
    check('③ 鼠标一动，右侧树立刻对应', rows1.length >= 5, `${rows1.length} 层`);
    check('③ 最里层是鼠标下的那个元素', rows1[rows1.length - 1]?.startsWith('img'), rows1[rows1.length - 1] ?? '');

    const vals1 = await infoVals(panel);
    check('③ 选择器随之更新', !!vals1[0] && vals1[0] !== '—', vals1[0] ?? '');

    // 换一个位置 → 树应该变成另一个元素
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 520, y: 110, button: 'none' });
    await sleep(600);
    const rows2 = await treeRows(panel);
    console.log('   · 位置 B（同款元素）的树:', JSON.stringify(rows2));
    check('③ 换位置后树也跟着换',
        rows2[rows2.length - 1] !== rows1[rows1.length - 1],
        `${rows1[rows1.length - 1]} → ${rows2[rows2.length - 1]}`);

    // 面板显示的"命中数"必须等于页面上真实的匹配数（拿页面自己算，别猜）
    const vals2 = await infoVals(panel);
    const match2 = vals2[1] ?? '';
    const sel2 = vals2[0] ?? '';
    const realCount = await ev(page, `document.querySelectorAll(${JSON.stringify(sel2)}).length`);
    check('③ 命中数与页面真实匹配数一致', match2 === `${realCount} 个元素`,
        `面板=${match2} 页面实算=${realCount}`);

    // 故意悬停到"没有区分类名"的那一层，验证多元素时能显示 >1
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 520, y: 260, button: 'none' });
    await sleep(600);
    const v3 = await infoVals(panel);
    const real3 = await ev(page, `document.querySelectorAll(${JSON.stringify(v3[0] ?? '')}).length`);
    check('③ 多元素场景命中数也对得上', (v3[1] ?? '') === `${real3} 个元素`,
        `面板=${v3[1]} 页面实算=${real3}`);

    // ④ 双向：在树里悬停某行 → 页面上高亮那一层
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(600);
    await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find(x => x.innerText.includes('ad-box'));
        r?.dispatchEvent(new MouseEvent('mouseenter'));
        return true;
    })()`);
    await sleep(600);
    const boxSize = await ev(page, `(() => {
        const h = document.getElementById('__adc_overlay');
        const r = h && h.shadowRoot;
        const b = r && r.querySelector('.box');
        return b && !b.hidden ? b.style.width + '×' + b.style.height : '';
    })()`);
    check('④ 树里悬停祖先，页面高亮框跟着变大', boxSize.startsWith('300'), boxSize);

    // ⑤ 点击锁定
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 150, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 150, y: 150, button: 'left', clickCount: 1 });
    await sleep(800);
    const lockedSel = (await infoVals(panel))[0];
    check('⑤ 点击后锁定到一个具体选择器', !!lockedSel && lockedSel !== '—', lockedSel ?? '');

    // 锁定后：把"不该变"的东西全抓一遍，移到几个不同位置，再抓一遍对比
    const snapshot = async () => JSON.stringify({
        box: await ev(page, `(() => { const h=document.getElementById('__adc_overlay'); const r=h&&h.shadowRoot; const b=r&&r.querySelector('.box'); return b&&!b.hidden?[b.style.left,b.style.top,b.style.width,b.style.height].join(','):''; })()`),
        tag: await ev(page, `(() => { const h=document.getElementById('__adc_overlay'); const r=h&&h.shadowRoot; const t=r&&r.querySelector('.tag'); return t&&!t.hidden?t.textContent:''; })()`),
        treeCur: await ev(panel, `document.querySelector('.tree .row.current')?.innerText.replace(/\s+/g,' ').trim() ?? ''`),
        treeAll: await ev(panel, `[...document.querySelectorAll('.tree .row')].map(r=>r.innerText.replace(/\s+/g,' ').trim()).join('|')`),
        sel: (await infoVals(panel))[0] ?? '',
    });

    const snapBefore = await snapshot();
    for (const pt of [{ x: 520, y: 170 }, { x: 300, y: 500 }, { x: 900, y: 300 }]) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' });
        await sleep(500);
    }
    const snapAfter = await snapshot();
    if (snapBefore !== snapAfter) {
        const a = JSON.parse(snapBefore), b = JSON.parse(snapAfter);
        for (const k of Object.keys(a)) {
            if (a[k] !== b[k]) console.log(`   · 锁定后变了: ${k}\n     前: ${a[k]}\n     后: ${b[k]}`);
        }
    }
    check('⑤ 锁定后：框/标签/树/选择器全都不变', snapBefore === snapAfter,
        snapBefore === snapAfter ? '完全一致' : '有变化（见上）');

    // 锁定后再移动鼠标，**高亮框必须钉住不动**
    const boxAt = (p) => ev(page, `(() => {
        const h = document.getElementById('__adc_overlay');
        const r = h && h.shadowRoot;
        const b = r && r.querySelector('.box');
        if (!b || b.hidden) return '';
        return [b.style.left, b.style.top, b.style.width, b.style.height].join(',');
    })()`);
    const boxBefore = await boxAt();
    const before = (await infoVals(panel))[0];
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 520, y: 170, button: 'none' });
    await sleep(700);
    const boxAfter = await boxAt();
    const after = (await infoVals(panel))[0];
    check('⑤ 锁定后高亮框钉住不动', boxBefore !== '' && boxBefore === boxAfter,
        `${boxBefore} → ${boxAfter}`);
    check('⑤ 锁定后选择器不再乱跳', after === before, `${before} → ${after}`);

    // 页面提示条应显示"已锁定"
    const bannerTxt = await ev(page, `(() => {
        const h = document.getElementById('__adc_overlay');
        const r = h && h.shadowRoot;
        const b = r && r.querySelector('.banner');
        return b && !b.hidden ? b.textContent : '';
    })()`);
    check('⑤ 提示条显示"已锁定"', /已锁定/.test(bannerTxt), bannerTxt);

    // 点别处 → 重新锁定到新元素
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 520, y: 170, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 520, y: 170, button: 'left', clickCount: 1 });
    await sleep(700);
    const afterRepick = (await infoVals(panel))[0];
    check('⑤ 点页面别处能换目标', afterRepick !== before, `${before} → ${afterRepick}`);

    // ═══════════ ⑤b 再点一下**已选中的**元素 → 取消选中，恢复悬浮模式 ═══════════
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 520, y: 170, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 520, y: 170, button: 'left', clickCount: 1 });
    await sleep(700);

    const bannerAfterUnlock = await ev(page, `(() => {
        const h = document.getElementById('__adc_overlay');
        const r = h && h.shadowRoot;
        const b = r && r.querySelector('.banner');
        return b && !b.hidden ? b.textContent : '';
    })()`);
    check('⑤b 再点已选中的元素 → 取消选中（提示条回到未锁定）',
        /选择模式/.test(bannerAfterUnlock) && !/已锁定/.test(bannerAfterUnlock), bannerAfterUnlock);

    // 悬浮模式恢复：移动鼠标，右侧树应该又开始跟着变
    const treeA = (await infoVals(panel))[0];
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(700);
    const treeB = (await infoVals(panel))[0];
    check('⑤b 取消选中后，悬浮切换恢复（树跟着鼠标变）', treeA !== treeB, `${treeA} → ${treeB}`);

    // ═══════════ ⑤c 再点一下（换成锁定）→ 又停住 ═══════════
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 150, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 150, y: 150, button: 'left', clickCount: 1 });
    await sleep(700);
    const lockedSel2 = (await infoVals(panel))[0];
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 520, y: 170, button: 'none' });
    await sleep(700);
    const stillLocked = (await infoVals(panel))[0];
    check('⑤c 重新点一下又锁定，鼠标滑动不再变', lockedSel2 === stillLocked, `${lockedSel2} → ${stillLocked}`);

    /**
     * ⚠️ 这里**不要**再点一次 (150,150)。
     *    新行为是"点已选中的元素 = 取消选中"，而 ⑤c 刚刚就是锁在 (150,150) 上 ——
     *    再点一次会把锁定取消，后面 ⑥ 就找不到 ad-box 那一行了。
     *    （这个坑正好证明新行为确实生效了。）
     */

    // ⑥ 往外扩一层并拦截
    await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find(x => x.innerText.includes('ad-box'));
        r?.click();
        return true;
    })()`);
    await sleep(800);
    const widened = (await infoVals(panel))[0];
    check('⑥ 树里点祖先 → 往外扩一层', widened.includes('ad-box'), widened);

    await ev(panel, `(() => { document.querySelector('.foot.three .primary')?.click(); return true; })()`);
    await sleep(1800);
    check('⑥ 确认后广告容器真的被隐藏', (await displayOf(page, '.ad-box')) === 'none', await displayOf(page, '.ad-box'));
    check('⑥ 正文没被误伤', (await displayOf(page, '#keep')) !== 'none');

    const shot = await panel.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/adc-real.png', Buffer.from(shot.data, 'base64'));

    // ═══════════ ⑥c 预览效果：真的应用一次，再点恢复 ═══════════
    // 此时已拦截 .ad-box（规则生效）。先重新进选择模式选一个可见元素。
    await ev(panel, `(() => { document.querySelector('.smart-manual')?.click(); return true; })()`);
    await sleep(1500);
    // 选 .dup.b（三个同款之一）
    const dupRect0 = await ev(page, `(() => {
        const el = document.querySelector('.dup.b');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    })()`);
    const dp0 = JSON.parse(dupRect0);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dp0.x, y: dp0.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dp0.x, y: dp0.y, button: 'left', clickCount: 1 });
    await sleep(900);

    const beforePreview = await displayOf(page, '.dup.a');
    // 点「预览效果」
    const previewBtn = await ev(panel, `(() => {
        const b = [...document.querySelectorAll('.foot button')].find(x => /预览/.test(x.innerText));
        if (!b) return 'none';
        b.click();
        return b.innerText.trim();
    })()`);
    check('⑥c 有「预览效果」按钮', /预览/.test(previewBtn), String(previewBtn));
    await sleep(1200);

    const afterPreview = await displayOf(page, '.dup.a');
    check('⑥c 预览时元素真的被隐藏了（不是只画框）',
        beforePreview !== 'none' && afterPreview === 'none', `${beforePreview} → ${afterPreview}`);

    const barShown = await ev(panel, `!!document.querySelector('.preview-bar')`);
    check('⑥c 面板显示"预览中"状态条', barShown === true, String(barShown));

    // 再点一次恢复
    await ev(panel, `(() => {
        const b = [...document.querySelectorAll('.foot button, .preview-back')].find(x => /退出预览|预览效果/.test(x.innerText));
        b && b.click();
        return true;
    })()`);
    await sleep(1200);
    const restored = await displayOf(page, '.dup.a');
    check('⑥c 再点一次页面恢复原样', restored !== 'none', String(restored));

    // 退出选择模式，避免影响后续
    await ev(panel, `(() => { document.querySelector('.foot.three .ghost')?.click(); return true; })()`);
    await sleep(800);
    // 清理本轮产生的规则（只留最开始那条）
    await ev(panel, `(async () => {
        const got = await chrome.storage.local.get('blockRules');
        const all = got.blockRules || {};
        for (const d of Object.keys(all)) all[d] = all[d].filter(r => r.selector === 'div.ad-box');
        await chrome.storage.local.set({ blockRules: all });
        return 'ok';
    })()`);
    await sleep(1200);

    // ═══════════ ⑦ 同类高亮：指着一个，页面上同款的全都标出来 ═══════════
    await page.send('Page.reload');
    await sleep(2500);
    await ev(panel, `(() => { document.querySelector('.smart-manual')?.click(); return true; })()`);
    await sleep(1800);

    // 坐标从 DOM 算（.dup.b 是三个同款之一）
    const dupRect = await ev(page, `(() => {
        const el = document.querySelector('.dup.b');
        if (!el) return '';
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    })()`);
    const dupPt = JSON.parse(dupRect || '{}');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dupPt.x, y: dupPt.y, button: 'none' });
    await sleep(400);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dupPt.x, y: dupPt.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dupPt.x, y: dupPt.y, button: 'left', clickCount: 1 });
    await sleep(1000);

    const marks = await ev(page, `document.querySelectorAll('.__adc_match').length`);
    check('⑦ 指着一个，同款的 3 个全标高亮', Number(marks) === 3, `${marks} 个`);

    const hintText = await ev(panel, `document.querySelector('.broad-hint')?.innerText.replace(/\s+/g,' ').trim() ?? ''`);
    check('⑦ 面板提示"同类还有 3 个"', /3/.test(hintText), hintText || '(无)');

    // 切到「同类」→ 页面标出的范围跟着变
    const scopeBtn = await ev(panel, `(() => {
        const btns = [...document.querySelectorAll('.seg-btn')];
        const b = btns.find(x => x.innerText.startsWith('同类'));
        if (!b) return 'none';
        const t = b.innerText;
        b.click();
        return t;
    })()`);
    await sleep(900);
    check('⑦ 有「同类 N」按钮', scopeBtn !== 'none' && /同类\s*3/.test(scopeBtn), String(scopeBtn));

    const finalSel = await ev(panel, `[...document.querySelectorAll('.info-row .v')][0]?.innerText.trim() ?? ''`);
    check('⑦ 切到同类后选择器变成宽选择器（无 nth-of-type）',
        finalSel.includes('.dup') && !finalSel.includes('nth-of-type'), finalSel);

    // 确认拦截 → 三个同款全消失
    await ev(panel, `(() => { document.querySelector('.foot.three .primary')?.click(); return true; })()`);
    await sleep(1800);
    const allHidden = await ev(page, `[...document.querySelectorAll('.dup')].every(e => getComputedStyle(e).display === 'none')`);
    check('⑦ 拦同类后三个同款全部消失', allHidden === true, String(allHidden));
    check('⑦ 正文仍然正常', (await displayOf(page, '#keep')) !== 'none');

    // ═══════════ ⑧ 关于页 / 版本进度 / 导入导出 ═══════════
    await ev(panel, `(() => { document.querySelector('.head-btn')?.click(); return true; })()`);
    await sleep(800);

    const aboutText = await ev(panel, `document.querySelector('.about')?.innerText ?? ''`);
    const verShown = await ev(panel, `document.querySelector('.about-ver')?.innerText.trim() ?? ''`);
    check('⑧ 关于页能打开', !!aboutText, aboutText.slice(0, 30).replace(/\s+/g, ' '));
    check('⑧ 显示当前版本（从 manifest 读）', /\d+\.\d+\.\d+/.test(verShown), verShown);
    check('⑧ 有"这个版本做了什么"', /这个版本做了什么/.test(aboutText));
    check('⑧ 有"后面计划做什么"', /后面计划做什么/.test(aboutText));
    check('⑧ 计划里写了规则分享', /规则分享/.test(aboutText));
    check('⑧ 有导出/导入按钮', /导出所有规则/.test(aboutText) && /导入规则/.test(aboutText));
    {
        const shot2 = await panel.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync('/tmp/adc-about.png', Buffer.from(shot2.data, 'base64'));
    }

    // 导入：用 CDP 直接给 file input 塞文件
    const tmpFile = '/tmp/adc-import-test.json';
    fs.writeFileSync(tmpFile, JSON.stringify({
        format: 1, app: '广告清道夫', version: '0.0.1', exportedAt: Date.now(),
        rules: { 'import-test.example': [
            { id: 'i1', domain: 'import-test.example', selector: '.imported-ad', action: 'hide', enabled: true, label: 'div.imported-ad', createdAt: Date.now() },
        ] },
    }));

    await panel.send('DOM.enable');
    const doc = await panel.send('DOM.getDocument', { depth: -1 });
    const node = await panel.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    if (!node.nodeId) {
        check('⑧ 找到导入用的文件输入框', false, '没找到');
    } else {
        await panel.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [tmpFile] });
        await sleep(1500);
        const imported = await ev(panel, `(async () => {
            const got = await chrome.storage.local.get('blockRules');
            const all = got.blockRules || {};
            const list = all['import-test.example'] || [];
            return JSON.stringify({ domains: Object.keys(all).length, imported: list.length, sel: list[0]?.selector ?? '' });
        })()`);
        const imp = JSON.parse(imported);
        check('⑧ 导入规则成功写进存储', imp.imported === 1 && imp.sel === '.imported-ad', imported);
    }

    // ═══════════ ⑨ 智能模式：点一下广告 → 自动推断 ═══════════
    await panel.send('Page.reload').catch(() => {});
    await page.send('Page.reload');
    await sleep(2500);
    // 清掉此前所有规则，保证从干净状态开始
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(1500);
    await ev(panel, `(() => { document.querySelector('.head-btn.on')?.click(); return true; })()`); // 若在关于页，返回
    await sleep(400);

    const smartBtn = await ev(panel, `(() => {
        const b = document.querySelector('.smart-main');
        if (!b) return 'none';
        b.click();
        return b.innerText.trim();
    })()`);
    check('⑨ 有「点一下广告，剩下的我来」按钮', /点一下广告/.test(smartBtn), String(smartBtn));
    await sleep(1500);
    check('⑨ 进入等待点选状态',
        /在页面上点一下那个广告/.test(await ev(panel, 'document.body.innerText')));

    // 在"广告卡片"上点一下（坐标从 DOM 算）
    const adItem = await ev(page, `(() => {
        const el = document.querySelector('.feed-item.is-ad');
        if (!el) return '';
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    })()`);
    const ap = JSON.parse(adItem || '{}');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ap.x, y: ap.y, button: 'none' });
    await sleep(300);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ap.x, y: ap.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ap.x, y: ap.y, button: 'left', clickCount: 1 });
    await sleep(1500);

    const resultText = await ev(panel, `document.querySelector('.smart-result')?.innerText ?? ''`);
    console.log('   · 推断结果页:', resultText.replace(/\s+/g, ' ').slice(0, 120));
    check('⑨ 推断出"同类共几个、其中几个带广告"',
        /这类卡片一共 6 个/.test(resultText) && /2 个/.test(resultText), resultText.replace(/\s+/g,' ').slice(0,80));
    check('⑨ 说明里指出了「广告」这个特征', /广告/.test(resultText), '');
    check('⑨ 有「就这么拦」按钮', /就这么拦/.test(resultText), '');

    {
        const shotSmart = await panel.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync('/tmp/adc-smart.png', Buffer.from(shotSmart.data, 'base64'));
        const shotPage = await page.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync('/tmp/adc-smart-page.png', Buffer.from(shotPage.data, 'base64'));
    }

    // 页面上只标出那 2 个广告
    const markedAd = await ev(page, `document.querySelectorAll('.__adc_match').length`);
    check('⑨ 页面上只圈出符合条件的 2 个', Number(markedAd) === 2, `${markedAd} 个`);

    // 确认拦截
    await ev(panel, `(() => {
        const b = [...document.querySelectorAll('.smart-actions .primary')].find(x => /就这么拦/.test(x.innerText));
        b && b.click();
        return true;
    })()`);
    await sleep(1800);

    const adStates = await ev(page, `JSON.stringify({
        ads: [...document.querySelectorAll('.feed-item.is-ad')].map(e => getComputedStyle(e).display),
        normals: [...document.querySelectorAll('.feed-item:not(.is-ad)')].map(e => getComputedStyle(e).display),
    })`);
    const st9 = JSON.parse(adStates);
    console.log('   · 广告卡片:', JSON.stringify(st9.ads), ' 普通卡片:', JSON.stringify(st9.normals));
    check('⑨ 两个广告卡片被拦掉', st9.ads.every((d) => d === 'none'), JSON.stringify(st9.ads));
    check('⑨ 普通卡片一个没动', st9.normals.every((d) => d !== 'none'), JSON.stringify(st9.normals));

    // 规则里应该带条件
    const savedRule = await ev(panel, `(async () => {
        const got = await chrome.storage.local.get('blockRules');
        const all = got.blockRules || {};
        const list = Object.values(all).flat();
        return JSON.stringify(list.map(r => ({ sel: r.selector, cond: r.condition || null })));
    })()`);
    console.log('   · 保存的规则:', savedRule);
    check('⑨ 存下来的是"带条件"的规则', /"type":"text"/.test(savedRule) && /广告/.test(savedRule), savedRule);

    console.log('\n========== 汇总 ==========');
    const failed = checks.filter((c) => !c.ok);
    console.log(`${checks.length - failed.length}/${checks.length} 项通过`);
    failed.forEach((f) => console.log(`  ✗ ${f.n}  ${f.d}`));
    process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error('✗', e?.message ?? e); process.exitCode = 1; })
    .finally(async () => {
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
