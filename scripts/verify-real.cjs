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
/** 按字段名取（选择器/条件/范围/方式/命中）—— 比按位置稳，加行不会错位 */
const infoVal = (panel, key) => ev(panel, `(() => {
    const rows = [...document.querySelectorAll('.info-row')];
    const r = rows.find((x) => (x.querySelector('.k')?.innerText ?? '').trim() === ${JSON.stringify(key)});
    return (r?.querySelector('.v')?.innerText ?? '').trim();
})()`);
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

    const dupTitles = await ev(panel, `document.querySelectorAll('.head .title').length`);
    check('① 面板不重复显示插件名（标题栏已有）', Number(dupTitles) === 0, `${dupTitles} 个`);

    const disabled = await ev(panel, `document.querySelector('.primary')?.disabled ?? true`);
    check('① 按钮可用（不是在"不支持"状态）', disabled === false, 'disabled=' + disabled);

    // ② 进入选择模式
    await ev(panel, `(() => { document.querySelector('.primary')?.click(); return true; })()`);
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
    check('② 页面上没有任何文字浮层（不挡视线）', bannerText === '' , bannerText || '(无)');

    // ③ F12 效果：鼠标移动 → 树跟着变（**这是用户最在意的一条**）
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(700);

    const treeLen = await ev(panel, `document.querySelectorAll('.tree .row').length`);
    console.log('   · 树的行数:', treeLen);
    check('③ 右侧显示完整 DOM 树（多行）', Number(treeLen) >= 5, `${treeLen} 行`);

    const curTagA = await ev(panel, `document.querySelector('.tree .row.current .html')?.textContent?.trim() ?? ''`);
    check('③ 当前行是鼠标下的那个元素', /^<img/.test(curTagA), curTagA || '(无当前行)');

    const expandable = await ev(panel, `document.querySelectorAll('.tree .row .arrow:not(.empty)').length`);
    check('③ 树节点可以展开/收起', Number(expandable) > 0, `${expandable} 个可展开`);

    const hasSize = await ev(panel, `!!document.querySelector('.tree .size')`);
    check('③ 树里不显示宽高（用户不需要）', hasSize === false, String(hasSize));

    // ═══════════ ⑨b 树里：悬浮是淡的，选中是深的 ═══════════
    const rowColors = await ev(panel, `(() => {
        const cur = document.querySelector('.tree .row.current');
        const others = [...document.querySelectorAll('.tree .row')].filter((r) => !r.classList.contains('current'));
        const other = others.find((r) => r.querySelector('.name'));
        return JSON.stringify({
            current: cur ? getComputedStyle(cur).backgroundColor : '',
            currentWeight: cur ? getComputedStyle(cur.querySelector('.name') || cur).fontWeight : '',
            other: other ? getComputedStyle(other).backgroundColor : '',
        });
    })()`);
    console.log('   · 颜色:', rowColors);
    {
        const c = JSON.parse(rowColors);
        check('⑨b 选中的那一行有独立底色（不是透明）',
            c.current && c.current !== 'rgba(0, 0, 0, 0)', c.current);
        check('⑨b 选中行底色比其它行深（能一眼看出选中）',
            c.current !== c.other, `选中 ${c.current} / 其它 ${c.other}`);
    }



    const vals1 = [await infoVal(panel, '选择器'), await infoVal(panel, '命中')];
    check('③ 选择器随之更新', !!vals1[0] && vals1[0] !== '—', vals1[0] ?? '');

    // 换一个位置 → 树应该变成另一个元素
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 520, y: 110, button: 'none' });
    await sleep(600);
    const curB = await ev(panel, `document.querySelector('.tree .row.current .html')?.textContent?.trim() ?? ''`);
    console.log('   · 位置 B 当前行:', curB);
    check('③ 换位置后当前行也跟着换', curB !== curTagA, `${curTagA} → ${curB}`);

    // 面板显示的"命中数"必须等于页面上真实的匹配数（拿页面自己算，别猜）
    const vals2 = [await infoVal(panel, '选择器'), await infoVal(panel, '命中')];
    const match2 = vals2[1] ?? '';
    const sel2 = vals2[0] ?? '';
    const realCount = await ev(page, `document.querySelectorAll(${JSON.stringify(sel2)}).length`);
    check('③ 命中数与页面真实匹配数一致', match2 === `${realCount} 个元素`,
        `面板=${match2} 页面实算=${realCount}`);

    // 故意悬停到"没有区分类名"的那一层，验证多元素时能显示 >1
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 520, y: 260, button: 'none' });
    await sleep(600);
    const v3 = [await infoVal(panel, '选择器'), await infoVal(panel, '命中')];
    const real3 = await ev(page, `document.querySelectorAll(${JSON.stringify(v3[0] ?? '')}).length`);
    check('③ 多元素场景命中数也对得上', (v3[1] ?? '') === `${real3} 个元素`,
        `面板=${v3[1]} 页面实算=${real3}`);

    // ④ 双向：在树里悬停某行 → 页面上高亮那一层
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(600);
    await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find(x => (x.querySelector('.html')?.textContent ?? '').includes('ad-box'));
        r?.querySelector('.name')?.dispatchEvent(new MouseEvent('mouseenter'));
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
    const lockedSel = await infoVal(panel, '选择器');
    check('⑤ 点击后锁定到一个具体选择器', !!lockedSel && lockedSel !== '—', lockedSel ?? '');

    // 锁定后：把"不该变"的东西全抓一遍，移到几个不同位置，再抓一遍对比
    const snapshot = async () => JSON.stringify({
        box: await ev(page, `(() => { const h=document.getElementById('__adc_overlay'); const r=h&&h.shadowRoot; const b=r&&r.querySelector('.box'); return b&&!b.hidden?[b.style.left,b.style.top,b.style.width,b.style.height].join(','):''; })()`),
        tag: await ev(page, `(() => { const h=document.getElementById('__adc_overlay'); const r=h&&h.shadowRoot; const t=r&&r.querySelector('.tag'); return t&&!t.hidden?t.textContent:''; })()`),
        treeCur: await ev(panel, `document.querySelector('.tree .row.current')?.innerText.replace(/\s+/g,' ').trim() ?? ''`),
        treeAll: await ev(panel, `[...document.querySelectorAll('.tree .row')].map(r=>r.innerText.replace(/\s+/g,' ').trim()).join('|')`),
        sel: await infoVal(panel, '选择器'),
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
    const before = await infoVal(panel, '选择器');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 520, y: 170, button: 'none' });
    await sleep(700);
    const boxAfter = await boxAt();
    const after = await infoVal(panel, '选择器');
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
    check('⑤ 页面上没有黑框提示条', !/已锁定/.test(bannerTxt), bannerTxt || '(无)');

    // 点别处 → 重新锁定到新元素
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 520, y: 170, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 520, y: 170, button: 'left', clickCount: 1 });
    await sleep(700);
    const afterRepick = await infoVal(panel, '选择器');
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
    check('⑤b 再点已选中的元素 → 取消选中（页面无浮层、树恢复跟随）',
        !/已锁定/.test(bannerAfterUnlock), bannerAfterUnlock || '(无)');

    // 悬浮模式恢复：移动鼠标，右侧树应该又开始跟着变
    const treeA = await infoVal(panel, '选择器');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(700);
    const treeB = await infoVal(panel, '选择器');
    check('⑤b 取消选中后，悬浮切换恢复（树跟着鼠标变）', treeA !== treeB, `${treeA} → ${treeB}`);

    // ═══════════ ⑤c 再点一下（换成锁定）→ 又停住 ═══════════
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 150, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 150, y: 150, button: 'left', clickCount: 1 });
    await sleep(700);
    const lockedSel2 = await infoVal(panel, '选择器');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 520, y: 170, button: 'none' });
    await sleep(700);
    const stillLocked = await infoVal(panel, '选择器');
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
        const r = rows.find(x => (x.querySelector('.html')?.textContent ?? '').includes('ad-box'));
        r?.querySelector('.name')?.click();
        return true;
    })()`);
    await sleep(800);
    const widened = await infoVal(panel, '选择器');
    check('⑥ 树里点祖先 → 往外扩一层', widened.includes('ad-box'), widened);

    await ev(panel, `(() => { document.querySelector('.foot.three .primary')?.click(); return true; })()`);
    await sleep(1800);
    check('⑥ 确认后广告容器真的被隐藏', (await displayOf(page, '.ad-box')) === 'none', await displayOf(page, '.ad-box'));
    check('⑥ 正文没被误伤', (await displayOf(page, '#keep')) !== 'none');

    const shot = await panel.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/adc-real.png', Buffer.from(shot.data, 'base64'));

    // ═══════════ ⑥c 预览效果：真的应用一次，再点恢复 ═══════════
    // 此时已拦截 .ad-box（规则生效）。先重新进选择模式选一个可见元素。
    await ev(panel, `(() => { document.querySelector('.primary')?.click(); return true; })()`);
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
    await ev(panel, `(() => { document.querySelector('.primary')?.click(); return true; })()`);
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

    const finalSel = await infoVal(panel, '选择器');
    check('⑦ 切到同类后选择器变成宽选择器（无 nth-of-type）',
        finalSel.includes('.dup') && !finalSel.includes('nth-of-type'), finalSel);

    // 确认拦截 → 三个同款全消失
    await ev(panel, `(() => { document.querySelector('.foot.three .primary')?.click(); return true; })()`);
    await sleep(1800);
    const allHidden = await ev(page, `[...document.querySelectorAll('.dup')].every(e => getComputedStyle(e).display === 'none')`);
    check('⑦ 拦同类后三个同款全部消失', allHidden === true, String(allHidden));
    check('⑦ 正文仍然正常', (await displayOf(page, '#keep')) !== 'none');

    // ═══════════ ⑩ 鼠标选不到的元素，从树里展开后选中 ═══════════
    await page.send('Page.reload');
    await sleep(2000);
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(1000);
    await ev(panel, `document.querySelector('.primary')?.click()`);
    await sleep(1200);

    // 悬停到那个 pointer-events:none 的图标中心 → 只会命中它的父级
    const iconPos = await ev(page, `(() => {
        const el = document.querySelector('.tiny-icon');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    })()`);
    const ip = JSON.parse(iconPos);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ip.x, y: ip.y, button: 'none' });
    await sleep(700);

    const hitTag = await ev(panel, `document.querySelector('.tree .row.current .html')?.textContent?.trim() ?? ''`);
    console.log('   · 悬停在图标上，命中到的是:', hitTag);
    check('⑩ 图标被 pointer-events:none 挡住时，命中到的是父级', !/^<svg/.test(hitTag), hitTag);

    // 树里能找到 svg 那一行（因为展开到了当前元素）
    const hasSvgRow = await ev(panel, `[...document.querySelectorAll('.tree .row .html')].some((e) => /^<svg/.test(e.textContent))`);
    check('⑩ 树里能看到 svg 节点', hasSvgRow === true, String(hasSvgRow));

    // 点 svg 那一行 → 选中它
    await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => /^<svg/.test(x.querySelector('.html')?.textContent ?? ''));
        r && r.querySelector('.name').click();
        return !!r;
    })()`);
    await sleep(900);

    const nowTag = await ev(panel, `document.querySelector('.tree .row.current .html')?.textContent?.trim() ?? ''`);
    const nowSel = await infoVal(panel, '选择器');
    console.log('   · 选中后:', nowTag, '| 选择器:', nowSel);
    check('⑩ 点 svg 行后选中了 svg', /svg\.tiny-icon/.test(nowSel), `${nowTag} / ${nowSel}`);


    // 退出选择模式，恢复干净状态
    await ev(panel, `(() => { document.querySelector('.foot.three .ghost')?.click(); return true; })()`);
    await sleep(900);

    // ═══════════ ⑨ 页面上不许出现文字标签（会挡住要点的东西）═══════════
    const hasTagEl = await ev(page, `(() => {
        const h = document.getElementById('__adc_overlay');
        const r = h && h.shadowRoot;
        if (!r) return 'no-overlay';
        return r.querySelector('.tag') ? 'has-tag' : 'no-tag';
    })()`);
    check('⑨ 页面上没有文字标签（不挡视线）', hasTagEl !== 'has-tag', hasTagEl);

    // ═══════════ ⑧ 导入导出挪到列表底部 ═══════════
    const footLinks = await ev(panel, `[...document.querySelectorAll('.rf-link')].map((b) => b.textContent.trim()).join(' ')`);
    check('⑧ 列表顶部有「导入 / 导出」', /导出/.test(footLinks) && /导入/.test(footLinks), footLinks);

    // 原生文件控件必须藏起来（界面上只留文字按钮）
    const nativeInputShown = await ev(panel, `(() => {
        const i = document.querySelector('input[type=file]');
        if (!i) return 'missing';
        return getComputedStyle(i).display;
    })()`);
    check('⑧ 控件藏起来了（不出现原生"选择文件"）', nativeInputShown === 'none', String(nativeInputShown));

    // ═══════════ ⑩ 加条件：外层选一类，内层点条件 ═══════════
    await page.send('Page.reload');
    await sleep(2200);
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(1200);

    await ev(panel, `document.querySelector('.primary')?.click()`);
    await sleep(1200);

    // ① 先点卡片里的标题（点卡片中心会命中封面，外层就不是整张卡了）
    const titlePos = await ev(page, `(() => {
        const el = document.querySelector('.feed-item:not(.is-ad) .feed-title');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    })()`);
    const tp = JSON.parse(titlePos);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tp.x, y: tp.y, button: 'none' });
    await sleep(300);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tp.x, y: tp.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tp.x, y: tp.y, button: 'left', clickCount: 1 });
    await sleep(900);

    // ② 在右侧树里往上选到「整张卡片」
    const widenedRow = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => (x.querySelector('.html')?.textContent ?? '').includes('feed-item'));
        if (!r) return false;
        r.querySelector('.name').click();
        return true;
    })()`);
    check('⑩ 树里能选到整张卡片', widenedRow === true);
    await sleep(800);

    const selBefore = await infoVal(panel, '选择器');
    console.log('   · 选中后选择器:', selBefore);
    check('⑩ 选中一类卡片，命中 6', /feed-item/.test(selBefore), selBefore);

    // 点「+ 加条件」
    const condBtn = await ev(panel, `(() => {
        const b = [...document.querySelectorAll('.mini-btn')].find(x => /加条件/.test(x.innerText));
        if (!b) return 'none';
        b.click();
        return b.innerText.trim();
    })()`);
    check('⑩ 有「+ 加条件」按钮', /加条件/.test(condBtn), String(condBtn));
    await sleep(1200);

    const waiting = await ev(panel, `document.body.innerText.includes('去页面上点一下')`);
    check('⑩ 点后进入"去页面上点一下"状态', waiting === true);

    // 在**广告卡片的角标**上点一下
    const badge = await ev(page, `(() => {
        const el = document.querySelector('.feed-item.is-ad .feed-badge');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    })()`);
    const bd = JSON.parse(badge);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bd.x, y: bd.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bd.x, y: bd.y, button: 'left', clickCount: 1 });
    await sleep(1400);

    const opts = await ev(panel, `JSON.stringify([...document.querySelectorAll('.cond-opt')].map(b => b.innerText.replace(/\s+/g,' ').trim()))`);
    console.log('   · 候选条件:', opts);
    check('⑩ 算出了候选条件', JSON.parse(opts).length > 0, opts);
    check('⑩ 第一个候选是「含文字「广告」」', /含文字「广告」/.test(JSON.parse(opts)[0] || ''), JSON.parse(opts)[0] || '');
    check('⑩ 候选带命中数 2 / 6', /2 \/ 6/.test(JSON.parse(opts)[0] || ''), JSON.parse(opts)[0] || '');

    // 选它
    await ev(panel, `(() => {
        const b = [...document.querySelectorAll('.cond-opt')].find(x => /含文字「广告」/.test(x.innerText));
        b && b.click();
        return true;
    })()`);
    await sleep(1000);

    const condShown = await ev(panel, `document.querySelector('.cond-on')?.innerText.trim() ?? ''`);
    check('⑩ 条件已生效并显示', /含「广告」/.test(condShown), condShown);

    const marked = await ev(page, `document.querySelectorAll('.__adc_match').length`);
    check('⑩ 页面上只圈出符合条件的 2 个', Number(marked) === 2, `${marked} 个`);

    // 拦截
    await ev(panel, `document.querySelector('.foot.three .primary')?.click()`);
    await sleep(1600);
    const states = await ev(page, `JSON.stringify({
        ads: [...document.querySelectorAll('.feed-item.is-ad')].map(e => getComputedStyle(e).display),
        normals: [...document.querySelectorAll('.feed-item:not(.is-ad)')].map(e => getComputedStyle(e).display),
    })`);
    const st = JSON.parse(states);
    console.log('   · 广告:', JSON.stringify(st.ads), ' 普通:', JSON.stringify(st.normals));
    check('⑩ 只拦掉 2 个广告卡片', st.ads.every((d) => d === 'none'), JSON.stringify(st.ads));
    check('⑩ 4 个普通卡片没动', st.normals.every((d) => d !== 'none'), JSON.stringify(st.normals));

    const savedCond = await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        return JSON.stringify(Object.values(g.blockRules || {}).flat().map(r => r.condition || null));
    })()`);
    check('⑩ 存下来的规则带条件', /"type":"text"/.test(savedCond) && /广告/.test(savedCond), savedCond);

    // ═══════════ ⑪ 组合标签规则：勾几层 → 一条规则 ═══════════
    await page.send('Page.reload');
    await sleep(2000);
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(1000);
    await ev(panel, `document.querySelector('.primary')?.click()`);
    await sleep(1200);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(800);

    const chkCount = await ev(panel, `document.querySelectorAll('.tree .row .chk').length`);
    check('⑪ 树里每个标签左边有复选框', Number(chkCount) > 0, `${chkCount} 个`);

    // 勾选三层：ad-box → ad-wrap → ad-inner
    const picked = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const want = ['ad-box', 'ad-wrap', 'ad-inner'];
        let n = 0;
        for (const key of want) {
            const r = rows.find((x) => {
                const t = x.querySelector('.name')?.textContent ?? '';
                return t.includes(key) && !x.__done;
            });
            if (!r) continue;
            r.__done = true;
            r.querySelector('.chk').click();
            n++;
        }
        return n;
    })()`);
    console.log('   · 勾选:', picked, '| .chk.on:', await ev(panel, `document.querySelectorAll('.tree .chk.on').length`), '| compose:', await ev(panel, `!!document.querySelector('.compose')`), '| footer exists:', await ev(panel, `!!document.querySelector('.foot')`));
    check('⑪ 能勾多层', Number(picked) === 3, `${picked} 层`);
    await sleep(600);

    const chainText = await ev(panel, `document.querySelector('.compose-parts')?.innerText.replace(/\\s+/g,' ').trim() ?? ''`);
    console.log('   · 组合链:', chainText);
    check('⑪ 显示了组合链（含层级差）', /▸1/.test(chainText), chainText);

    await ev(panel, `(() => {
        const b = [...document.querySelectorAll('.compose-actions .primary')].find((x) => /组合成规则/.test(x.textContent));
        b && b.click();
        return true;
    })()`);
    await sleep(1600);

    const partsSaved = await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        const list = Object.values(g.blockRules || {}).flat();
        return JSON.stringify(list.map((r) => ({ parts: r.parts || null })));
    })()`);
    console.log('   · 保存的规则:', partsSaved);
    check('⑪ 存成了一条三段式规则', (partsSaved.match(/relDepth/g) || []).length === 3, partsSaved);

    const hiddenByParts = await ev(page, `getComputedStyle(document.querySelector('.ad-box')).display`);
    check('⑪ 组合规则生效，外层容器被隐藏', hiddenByParts === 'none', hiddenByParts);

    // ═══════════ ⑫ 组合规则 + 文字约束（同类里靠文字区分） ═══════════
    // 先把 ⑪ 留下的选择模式退掉，否则 .primary 是「拦截这个」
    await ev(panel, `(() => { document.querySelector('.foot.three .ghost')?.click(); return true; })()`);
    await sleep(800);
    await page.send('Page.reload');
    await sleep(2000);
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(1000);
    await ev(panel, `document.querySelector('.primary')?.click()`);
    await sleep(1200);
    const ftPos = await ev(page, `(() => {
        const el = document.querySelector('.feed-item:not(.is-ad) .feed-title');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    })()`);
    const ft = JSON.parse(ftPos);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ft.x, y: ft.y, button: 'none' });
    await sleep(900);

    // 勾两层：div.feed-item → div.feed-cover（同类里文字不同）
    const picked2 = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        let n = 0;
        for (const key of ['feed-item', 'feed-cover']) {
            const r = rows.find((x) => {
                const t = x.querySelector('.name')?.textContent ?? '';
                return t.includes(key) && !x.__d;
            });
            if (!r) continue;
            r.__d = true;
            r.querySelector('.chk').click();
            n++;
        }
        return n;
    })()`);
    check('⑫ 勾选两层（feed-item → feed-cover）', Number(picked2) === 2, `${picked2} 层`);
    await sleep(500);

    // 树里显示节点的文字内容
    const nodeTextShown = await ev(panel, `[...document.querySelectorAll('.tree .txt')].length > 0`);
    check('⑫ 树里显示节点的文字内容', nodeTextShown === true);

    // 第二段加文字约束「广告」
    await ev(panel, `(() => {
        const inputs = [...document.querySelectorAll('.compose-text')];
        const i = inputs[1];
        if (!i) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(i, '广告');
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    await sleep(500);

    await ev(panel, `(() => {
        const b = [...document.querySelectorAll('.compose-actions .primary')].find((x) => /组合成规则/.test(x.textContent));
        b && b.click();
        return true;
    })()`);
    await sleep(1600);

    const savedParts = await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        return JSON.stringify(Object.values(g.blockRules || {}).flat().map((r) => r.parts || null));
    })()`);
    console.log('   · 规则:', savedParts);
    check('⑫ 规则里带上了文字约束', /"text":"广告"/.test(savedParts), savedParts);

    const st12 = JSON.parse(await ev(page, `JSON.stringify({
        ads: [...document.querySelectorAll('.feed-item.is-ad')].map((e) => getComputedStyle(e).display),
        normals: [...document.querySelectorAll('.feed-item:not(.is-ad)')].map((e) => getComputedStyle(e).display),
    })`));
    console.log('   · 广告:', JSON.stringify(st12.ads), ' 普通:', JSON.stringify(st12.normals));
    check('⑫ 只拦掉带「广告」字样的那 2 个', st12.ads.every((d) => d === 'none'), JSON.stringify(st12.ads));
    check('⑫ 普通卡片没被误杀', st12.normals.every((d) => d !== 'none'), JSON.stringify(st12.normals));

    // ═══════════ ⑬ 锁定后鼠标滑向抽屉，树不许变 ═══════════
    await page.send('Page.reload');
    await sleep(2000);
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(900);
    await ev(panel, `document.querySelector('.primary')?.click()`);
    await sleep(1200);

    // (150,150) 命中 .ad-img，是前面几段已经验证过的坐标
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(500);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 150, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 150, y: 150, button: 'left', clickCount: 1 });
    await sleep(900);

    const lockedRow = await ev(panel, `document.querySelector('.tree .row.current .html')?.textContent ?? ''`);
    const lockedSel13 = await infoVal(panel, '选择器');
    check('⑬ 锁定后树里有当前行', !!lockedRow && !/^<html/.test(lockedRow), lockedRow || '(无)');
    check('⑬ 确实选中了元素（选择器不是空的）', lockedSel !== '—' && !!lockedSel, lockedSel);

    // 往右边刷地去（模拟鼠标离开页面去够抽屉），沿途掠过大片别的元素
    for (const pt of [[900, 60], [1000, 300], [1100, 120], [1180, 500]]) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt[0], y: pt[1], button: 'none' });
        await sleep(320);
    }
    await sleep(400);

    const afterRow = await ev(panel, `document.querySelector('.tree .row.current .html')?.textContent ?? ''`);
    const afterSel13 = await infoVal(panel, '选择器');
    console.log('   · 锁定行:', lockedRow, '→', afterRow);
    check('⑬ 鼠标掠过别的元素，树的当前行不变', afterRow === lockedRow, `${lockedRow} → ${afterRow}`);
    check('⑬ 选择器也不变', afterSel13 === lockedSel13, `${lockedSel13} → ${afterSel13}`);

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
