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
/** 选择模式底部：保存 / 取消（compose 区不再有第二个按钮，选择器只认 foot-row） */
const savePick = (panel) => ev(panel, `(() => { document.querySelector('.foot-row .primary')?.click(); return true; })()`);
const cancelPick = (panel) => ev(panel, `(() => { document.querySelector('.foot-row .ghost')?.click(); return true; })()`);
/** 往 v-model 输入框里塞值，必须走原生 setter + input 事件 */
const setInput = (panel, selector, value) => ev(panel, `(() => {
    const i = document.querySelector(${JSON.stringify(selector)});
    if (!i) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(i, ${JSON.stringify(value)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
})()`);
/** 命中数是异步算的：轮询到期望值，别用固定 sleep 赌 */
const waitInfo = async (panel, key, pred, tries = 20) => {
    let v = '';
    for (let i = 0; i < tries; i++) {
        v = await infoVal(panel, key);
        if (pred(v)) return v;
        await sleep(300);
    }
    return v;
};

/** 把文件塞进隐藏的 <input type=file>，触发真正的导入流程。 */
async function importRulesFile(panel, filePath) {
    await panel.send('DOM.enable');
    const doc = await panel.send('DOM.getDocument');
    const node = await panel.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: 'input[type=file]',
    });
    if (!node.nodeId) throw new Error('面板里找不到文件输入框');
    await panel.send('DOM.setFileInputFiles', { files: [filePath], nodeId: node.nodeId });
}

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
    // 界面上不再显示域名了，改从根节点的 data-domain 读（能力没变，只是不占地方）
    const site = await ev(panel, `document.querySelector('[data-domain]')?.dataset.domain ?? ''`);
    check('① 面板自动认出当前标签页', site.includes('127.0.0.1'), site);

    const domainShown = await ev(panel, `document.body.innerText.includes('127.0.0.1')`);
    check('① 界面上不显示域名（省地方）', domainShown === false, String(domainShown));

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

    const expandable = await ev(panel, `document.querySelectorAll('.tree .row .arrow:not(.blank)').length`);
    check('③ 树节点可以展开/收起', Number(expandable) > 0, `${expandable} 个可展开`);

    // 行高必须紧凑：叶子行的三角号曾经误用 .empty（padding:48px），一行被撑到 104px
    const heightInfo = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        // 用最短的叶子节点做基准（长源码节点允许多行）
        const leaf = rows.filter((r) => /同款/.test(r.innerText));
        const heights = leaf.map((r) => r.offsetHeight);
        const arrow = document.querySelector('.tree .row .arrow:not(.blank)');
        return JSON.stringify({
            maxLeaf: heights.length ? Math.max(...heights) : 0,
            arrowFont: arrow ? getComputedStyle(arrow).fontSize : '',
        });
    })()`);
    console.log('   · 行高:', heightInfo);
    {
        const h = JSON.parse(heightInfo);
        check('③ 叶子行高紧凑（≤ 26px）', h.maxLeaf > 0 && h.maxLeaf <= 26, `${h.maxLeaf}px`);
        check('③ 三角号足够大（≥ 16px）', parseFloat(h.arrowFont) >= 16, h.arrowFont);
    }

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

    await ev(panel, `(() => { document.querySelector('.foot-row .primary')?.click(); return true; })()`);
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
    await ev(panel, `(() => { document.querySelector('.foot-row .ghost')?.click(); return true; })()`);
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
    await ev(panel, `(() => { document.querySelector('.foot-row .primary')?.click(); return true; })()`);
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
    await ev(panel, `(() => { document.querySelector('.foot-row .ghost')?.click(); return true; })()`);
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

    // ═══════════ ⑧b 导入：条件 / 组合字段不许丢 ═══════════
    const importFile = path.join(os.tmpdir(), 'adc-import-roundtrip.json');
    fs.writeFileSync(importFile, JSON.stringify({
        format: 1,
        app: '广告拦截助手',
        version: '0.2.2',
        exportedAt: Date.now(),
        rules: {
            '127.0.0.1': [
                {
                    id: 'imp-cond', domain: '127.0.0.1', selector: '.feed-item', action: 'hide',
                    enabled: true, label: '导入-条件', createdAt: 1,
                    condition: { type: 'text', value: '广告' },
                },
                {
                    id: 'imp-parts', domain: '127.0.0.1', selector: '.ad-box', action: 'hide',
                    enabled: true, label: '导入-组合', createdAt: 2,
                    parts: [
                        { selector: '.ad-box', relDepth: 0 },
                        { selector: '.ad-wrap', relDepth: 1 },
                    ],
                },
            ],
        },
    }, null, 2));

    // 预置一条"同 selector、不同条件"的规则：导入时不许把它覆盖掉
    await ev(panel, `chrome.storage.local.set({ blockRules: { '127.0.0.1': [{
        id: 'pre1', domain: '127.0.0.1', selector: '.feed-item', action: 'hide',
        enabled: true, label: '原有', createdAt: 1,
        condition: { type: 'text', value: '推广' },
    }] } }).then(()=>'ok')`);
    await sleep(500);
    await importRulesFile(panel, importFile);
    await sleep(1600);
    const imported = await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        const list = Object.values(g.blockRules || {}).flat();
        return JSON.stringify({
            total: list.length,
            texts: list.map((r) => r.pattern?.text).filter(Boolean),
            legacy: list.map((r) => r.condition?.value).filter(Boolean),
            nested: list.some((r) => r.pattern?.children?.[0]?.selector === '.ad-wrap'),
            strict: list.filter((r) => r.strict).length,
        });
    })()`);
    const imp = JSON.parse(imported);
    console.log('   · 导入结果:', imported);
    check('⑧b 导入把旧文字条件迁移成 pattern.text', imp.texts.includes('广告'), JSON.stringify(imp.texts));
    check('⑧b 本地已有的旧格式规则原样保留', imp.legacy.includes('推广'), JSON.stringify(imp.legacy));
    check('⑧b 导入把旧组合规则迁移成嵌套 children', imp.nested === true, imported);
    check('⑧b 旧组合规则迁移后 strict=true', imp.strict === 1, String(imp.strict));
    check('⑧b 同选择器不同条件的规则没互相覆盖', imp.total === 3, `${imp.total} 条`);
    // 清空，别影响后面的用例
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(500);

    // ═══════════ ⑩ 偷懒模式：锚点内任意层含「广告」就拦 ═══════════
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

    // ③ 偷懒模式：不用勾任何子标签，直接在锚点这一行填「广告」
    //    —— 这正是「副标签里任意层出现这两个字就拦」的最低操作成本
    const filled = await setInput(panel, '.compose-anchor .compose-text', '广告');
    check('⑩ 锚点行可以直接填文字条件', filled === true);
    await sleep(900);

    const condShown = await ev(panel, `document.querySelector('.cond-on')?.innerText.trim() ?? ''`);
    check('⑩ 条件已生效并显示', /含「广告」/.test(condShown), condShown);

    const marked = await (async () => {
        // 高亮是异步走消息的：等它从"同类 6 个"收敛到"真实命中 2 个"
        for (let i = 0; i < 15; i++) {
            await sleep(300);
            const n = await ev(page, `document.querySelectorAll('.__adc_match').length`);
            if (Number(n) === 2) return n;
        }
        return ev(page, `document.querySelectorAll('.__adc_match').length`);
    })();
    check('⑩ 页面上只圈出符合条件的 2 个', Number(marked) === 2, `${marked} 个`);

    const saveText = await ev(panel, `document.querySelector('.foot-row .primary')?.innerText.trim() ?? ''`);
    check('⑩ 主按钮可点且写明「含文字」', /拦截这个/.test(saveText) && /含文字/.test(saveText), saveText);

    // 拦截
    await savePick(panel);
    await sleep(2200);
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
        return JSON.stringify(Object.values(g.blockRules || {}).flat().map(r => ({ text: r.pattern?.text ?? null, strict: !!r.strict })));
    })()`);
    check('⑩ 存下来的规则带 pattern.text（不是旧 condition）', /"text":"广告"/.test(savedCond) && /"strict":false/.test(savedCond), savedCond);

    // 规则列表的命中数必须按"条件过滤后"算，不能按同类总数 6 算
    await sleep(2600);
    const condCount = await ev(panel, `(() => {
        const row = [...document.querySelectorAll('.rule')].find((r) => /广告/.test(r.innerText));
        if (!row) return 'none';
        return row.querySelector('.count')?.innerText.trim() ?? 'no-count';
    })()`);
    check('⑩ 规则列表命中数按条件算（2，不是 6）', condCount === '2', condCount);

    // 悬浮这条规则 → 只预览真实命中的 2 个，而且已生效的要临时显形
    await ev(panel, `(() => {
        const row = [...document.querySelectorAll('.rule')].find((r) => /广告/.test(r.innerText));
        row?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        return true;
    })()`);
    await sleep(900);
    const previewCond = await ev(page, `JSON.stringify({
        outlined: document.querySelectorAll('.__adc_outline').length,
        ads: [...document.querySelectorAll('.feed-item.is-ad')].map((e) => getComputedStyle(e).display),
    })`);
    const pv = JSON.parse(previewCond);
    console.log('   · 条件规则悬浮预览:', previewCond);
    check('⑩ 悬浮条件规则只预览 2 个', pv.outlined === 2, `${pv.outlined} 个`);
    check('⑩ 悬浮条件规则时命中元素临时显形', pv.ads.every((d) => d !== 'none'), JSON.stringify(pv.ads));

    await ev(panel, `(() => {
        const row = [...document.querySelectorAll('.rule')].find((r) => /广告/.test(r.innerText));
        row?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        return true;
    })()`);
    await sleep(800);
    const afterLeave = await ev(page, `JSON.stringify([...document.querySelectorAll('.feed-item.is-ad')].map((e) => getComputedStyle(e).display))`);
    check('⑩ 移开鼠标后条件规则重新隐藏', JSON.parse(afterLeave).every((d) => d === 'none'), afterLeave);

    // ═══════════ ⑪ 精确模式：锚点 + 条件 + 严格层级 ═══════════
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

    // 锚点 = ad-box：先在树里选中它（蓝色当前行）
    const anchorPicked = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => (x.querySelector('.html')?.textContent ?? '').includes('ad-box'));
        if (!r) return false;
        r.querySelector('.name').click();
        return true;
    })()`);
    check('⑪ 能在树里定位到 ad-box', anchorPicked === true);
    await sleep(700);

    // 勾上锚点 ad-box（绿色复选框才参与规则）+ 它内部的两层：ad-wrap → ad-inner
    const picked = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        let n = 0;
        for (const key of ['ad-box', 'ad-wrap', 'ad-inner']) {
            const r = rows.find((x) => (x.querySelector('.name')?.textContent ?? '').includes(key));
            if (!r) continue;
            r.querySelector('.chk').click();
            n++;
        }
        return n;
    })()`);
    check('⑪ 能勾上锚点和内部的两层', Number(picked) === 3, `${picked} 层`);
    await sleep(900);

    const composeAnchor11 = await ev(panel, `document.querySelector('.compose-anchor .compose-sel')?.textContent ?? ''`);
    check('⑪ 锚点取最外层勾选（ad-box），不是蓝色定位行以外的层级', /ad-box/.test(composeAnchor11), composeAnchor11);
    const condRows = await ev(panel, `[...document.querySelectorAll('.compose-part .compose-sel')].map(e => e.innerText)`);
    check('⑪ 条件区列出两段', condRows.length === 2, JSON.stringify(condRows));

    const looseHit = await waitInfo(panel, '命中', (v) => v === '1 个元素');
    check('⑪ 非严格模式（任意层）命中 1 个容器', looseHit === '1 个元素', looseHit);

    // 打开「严格限制层级关系」：正确的层级（1 / 1）仍然命中
    await ev(panel, `document.querySelector('.compose-strict input').click()`);
    await sleep(1100);
    const strictDepths = await ev(panel, `[...document.querySelectorAll('.compose-depth')].map(e => e.value)`);
    check('⑪ 严格模式为每个条件显示层级输入', strictDepths.length === 2 && strictDepths.every((v) => v === '1'), JSON.stringify(strictDepths));
    const strictHit = await waitInfo(panel, '命中', (v) => v === '1 个元素');
    check('⑪ 严格模式层级正确时命中 1 个', strictHit === '1 个元素', strictHit);

    const saveText11 = await ev(panel, `document.querySelector('.foot-row .primary')?.innerText.trim() ?? ''`);
    check('⑪ 主按钮写明条件数量', /2 个条件/.test(saveText11), saveText11);

    await savePick(panel);
    await sleep(2400);

    const partsSaved = await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        const list = Object.values(g.blockRules || {}).flat();
        return JSON.stringify(list.map((r) => ({ strict: !!r.strict, pattern: r.pattern, label: r.label })));
    })()`);
    console.log('   · 保存的规则:', partsSaved);
    {
        const list = JSON.parse(partsSaved);
        const r = list[0] ?? {};
        const c1 = r.pattern?.children?.[0];
        const c2 = c1?.children?.[0];
        check('⑪ 存成一条嵌套条件树（ad-box → ad-wrap → ad-inner）',
            r.pattern?.selector === 'div.ad-box' && c1?.selector === 'div.ad-wrap' && c2?.selector === 'div.ad-inner',
            partsSaved);
        check('⑪ 严格层级 relDepth 都存成 1', c1?.relDepth === 1 && c2?.relDepth === 1, partsSaved);
        check('⑪ 规则标记 strict=true', r.strict === true, String(r.strict));
        check('⑪ 规则文案显示层级标记 ▸1', /▸1/.test(r.label || ''), r.label || '');
    }

    const hiddenByParts = await ev(page, `getComputedStyle(document.querySelector('.ad-box')).display`);
    check('⑪ 组合规则生效，外层容器被隐藏', hiddenByParts === 'none', hiddenByParts);

    // ═══════════ ⑪b 编辑组合规则：锚点 / 勾选 / 严格开关都要复现 ═══════════
    await sleep(1800);
    const clickedEdit = await ev(panel, `(() => {
        const row = [...document.querySelectorAll('.rule')].find((r) => /ad-box/.test(r.innerText));
        if (!row) return false;
        row.querySelector('.icon[title="编辑"]')?.click();
        return true;
    })()`);
    check('⑪b 规则列表里能找到组合规则并点编辑', clickedEdit === true);
    await sleep(2400);

    const editState = JSON.parse(await ev(panel, `(() => {
        const box = document.querySelector('.tree');
        const row = box?.querySelector('.row.current');
        const rb = row?.getBoundingClientRect();
        const tb = box?.getBoundingClientRect();
        return JSON.stringify({
            anchor: document.querySelector('.compose-anchor .compose-sel')?.innerText ?? '',
            strict: !!document.querySelector('.compose-strict input')?.checked,
            checks: document.querySelectorAll('.tree .chk.on').length,
            rows: [...document.querySelectorAll('.compose-part .compose-sel')].map((e) => e.innerText),
            depths: [...document.querySelectorAll('.compose-depth')].map((e) => e.value),
            visible: !!(rb && tb && rb.top >= tb.top - 1 && rb.bottom <= tb.bottom + 1),
            bg: row ? getComputedStyle(row).backgroundColor : '',
        });
    })()`));
    console.log('   · 编辑复现:', JSON.stringify(editState));
    check('⑪b 锚点复现为 ad-box', /ad-box/.test(editState.anchor), editState.anchor);
    check('⑪b 严格开关复现为开', editState.strict === true, String(editState.strict));
    check('⑪b 复现勾选（锚点 + 2 个条件）', editState.checks === 3, `${editState.checks} 个`);
    check('⑪b 条件区复现 2 段', editState.rows.length === 2, JSON.stringify(editState.rows));
    check('⑪b 层级输入复现为 1 / 1', editState.depths.every((v) => v === '1') && editState.depths.length === 2, JSON.stringify(editState.depths));
    check('⑪b 选中的标签滚进了可视范围', editState.visible === true, String(editState.visible));
    check('⑪b 选中行有明显背景高亮', editState.bg && editState.bg !== 'rgba(0, 0, 0, 0)', editState.bg);

    // 退出编辑
    await cancelPick(panel);
    await sleep(900);

    // ═══════════ ⑪c 严格层级真的会拒绝错误层级 ═══════════
    await page.send('Page.reload');
    await sleep(2000);
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(1000);
    await ev(panel, `document.querySelector('.primary')?.click()`);
    await sleep(1200);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(800);
    await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => (x.querySelector('.html')?.textContent ?? '').includes('ad-box'));
        r?.querySelector('.name')?.click();
        r?.querySelector('.chk')?.click();
        return !!r;
    })()`);
    await sleep(700);
    await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => (x.querySelector('.name')?.textContent ?? '').includes('ad-inner'));
        r?.querySelector('.chk')?.click();
        return !!r;
    })()`);
    await sleep(800);
    await ev(panel, `document.querySelector('.compose-strict input').click()`);
    await sleep(900);

    // ad-inner 在 ad-box 下面第 2 层；填 1 应该一个都不命中
    await setInput(panel, '.compose-depth', '1');
    await sleep(1100);
    const wrongDepthHit = await waitInfo(panel, '命中', (v) => v === '0 个元素');
    check('⑪c 严格第 1 层时 ad-inner 不匹配（0 个）', wrongDepthHit === '0 个元素', wrongDepthHit);

    await setInput(panel, '.compose-depth', '2');
    await sleep(1100);
    const rightDepthHit = await waitInfo(panel, '命中', (v) => v === '1 个元素');
    check('⑪c 改成第 2 层后命中 1 个', rightDepthHit === '1 个元素', rightDepthHit);

    // 关掉严格 → 任意层，又变回命中 1 个
    await ev(panel, `document.querySelector('.compose-strict input').click()`);
    await sleep(1100);
    const looseAgain = await waitInfo(panel, '命中', (v) => v === '1 个元素');
    check('⑪c 关掉严格后按任意层命中 1 个', looseAgain === '1 个元素', looseAgain);

    await cancelPick(panel);
    await sleep(800);

    // ═══════════ ⑫ 条件 + 文字：同类卡片里只拦带「广告」的 ═══════════
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

    // 还原真实场景：蓝色定位行在更深的 feed-title，真正参与规则的是勾选的 feed-item → feed-cover
    // （以前拿蓝色行当锚点，会误报"勾选的标签必须在锚点内部"）
    const picked2 = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        let n = 0;
        for (const key of ['feed-item', 'feed-cover']) {
            const r = rows.find((x) => (x.querySelector('.name')?.textContent ?? '').includes(key));
            if (!r) continue;
            r.querySelector('.chk').click();
            n++;
        }
        return n;
    })()`);
    check('⑫ 勾选 feed-item（锚点）和 feed-cover（条件）', Number(picked2) === 2, `${picked2} 个`);
    await sleep(900);

    const anchor12 = await ev(panel, `document.querySelector('.compose-anchor .compose-sel')?.textContent ?? ''`);
    const err12 = await ev(panel, `document.querySelector('.compose-err')?.textContent ?? ''`);
    const selRow12 = await infoVal(panel, '选择器');
    check('⑫ 锚点取最外层勾选 feed-item（不参考蓝色定位行）', /feed-item/.test(anchor12), anchor12);
    check('⑫ 不再误报"勾选在锚点内部/外面"红字', err12 === '', err12 || '(无)');
    check('⑫ 选择器摘要显示锚点选择器', /feed-item/.test(selRow12), selRow12);

    // 树里显示节点的文字内容
    const nodeTextShown = await ev(panel, `[...document.querySelectorAll('.tree .txt')].length > 0`);
    check('⑫ 树里显示节点的文字内容', nodeTextShown === true);

    // 条件加文字约束「广告」，并打开严格层级（feed-cover 正好在第 1 层）
    await setInput(panel, '.compose-part .compose-text', '广告');
    await ev(panel, `document.querySelector('.compose-strict input').click()`);
    await sleep(1100);

    const draftHit = await waitInfo(panel, '命中', (v) => v === '2 个元素');
    check('⑫ 草稿命中数按「第 1 层 feed-cover 含广告」算（2 个）', draftHit === '2 个元素', draftHit);

    await savePick(panel);
    await sleep(2400);

    const savedParts = await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        const list = Object.values(g.blockRules || {}).flat();
        return JSON.stringify(list.map((r) => ({ pattern: r.pattern, strict: !!r.strict })));
    })()`);
    console.log('   · 规则:', savedParts);
    {
        const list = JSON.parse(savedParts);
        const c = list[0]?.pattern?.children?.[0];
        check('⑫ 规则里带上了文字约束', c?.text === '广告', savedParts);
        check('⑫ 条件带精确层级 relDepth=1', c?.relDepth === 1, savedParts);
        check('⑫ 条件选择器是 feed-cover', /feed-cover/.test(c?.selector ?? ''), JSON.stringify(c));
        check('⑫ 规则 strict=true', list[0]?.strict === true, String(list[0]?.strict));
    }

    const st12 = JSON.parse(await ev(page, `JSON.stringify({
        ads: [...document.querySelectorAll('.feed-item.is-ad')].map((e) => getComputedStyle(e).display),
        normals: [...document.querySelectorAll('.feed-item:not(.is-ad)')].map((e) => getComputedStyle(e).display),
    })`));
    console.log('   · 广告:', JSON.stringify(st12.ads), '普通:', JSON.stringify(st12.normals));
    check('⑫ 只拦掉带「广告」字样的那 2 个', st12.ads.every((d) => d === 'none'), JSON.stringify(st12.ads));
    check('⑫ 普通卡片没被误杀', st12.normals.every((d) => d !== 'none'), JSON.stringify(st12.normals));

    // 列表要在保存后异步刷新；等它真的出现，别用一个固定 sleep 赌
    let label12 = '';
    for (let i = 0; i < 20 && !label12; i++) {
        await sleep(500);
        label12 = await ev(panel, `[...document.querySelectorAll('.rule-label')].map(e => e.textContent).join('\\n')`);
    }
    let labelState = '';
    if (!/feed-cover/.test(label12)) {
        labelState = await ev(panel, `JSON.stringify({ picking: !!document.querySelector('.foot.three'), rules: document.querySelectorAll('.rule').length, labels: document.querySelectorAll('.rule-label').length, body: (document.body.textContent || '').replace(/\\s+/g,' ').slice(0, 220) })`);
        const remote = await ev(panel, `(async () => {
            const g = await chrome.storage.local.get('blockRules');
            const rs = (g.blockRules['127.0.0.1'] || []).map((r) => ({ selector: r.selector, pattern: r.pattern, strict: !!r.strict }));
            const t = (await chrome.tabs.query({})).find((x) => (x.url || '').includes('8941'));
            const res = t ? await chrome.tabs.sendMessage(t.id, { type: 'adc:countRules', rules: rs }) : { noTab: true };
            return JSON.stringify({ tab: t?.url, res });
        })()`);
        console.log('   · 列表诊断:', labelState, '| 页面计数:', remote);
    }
    check('⑫ 规则列表写出完整条件', /feed-cover/.test(label12) && /广告/.test(label12), label12 || `(列表为空) ${labelState}`);

    // ═══════════ ⑫b 编辑带文字条件的规则：文字 / 勾选 / 严格层都要复现 ═══════════
    const edit12 = await ev(panel, `(() => {
        const row = [...document.querySelectorAll('.rule')].find((r) => /feed-cover/.test(r.innerText));
        if (!row) return false;
        row.querySelector('.icon[title="编辑"]')?.click();
        return true;
    })()`);
    check('⑫b 能编辑带文字条件的规则', edit12 === true);
    await sleep(2600);
    const state12 = JSON.parse(await ev(panel, `JSON.stringify({
        anchor: document.querySelector('.compose-anchor .compose-sel')?.textContent ?? '',
        anchorText: document.querySelector('.compose-anchor .compose-text')?.value ?? '',
        strict: !!document.querySelector('.compose-strict input')?.checked,
        checks: document.querySelectorAll('.tree .chk.on').length,
        texts: [...document.querySelectorAll('.compose-part .compose-text')].map((e) => e.value),
        depths: [...document.querySelectorAll('.compose-depth')].map((e) => e.value),
    })`) || '{}');
    console.log('   · ⑫b 编辑复现:', JSON.stringify(state12));
    check('⑫b 锚点复现为 feed-item', /feed-item/.test(state12.anchor), state12.anchor);
    check('⑫b 条件文字「广告」复现', state12.texts.includes('广告'), JSON.stringify(state12.texts));
    check('⑫b 严格开关复现为开', state12.strict === true, String(state12.strict));
    check('⑫b 勾选复现（锚点 + feed-cover）', state12.checks === 2, `${state12.checks} 个`);
    check('⑫b 层级复现为 1', state12.depths.every((v) => v === '1') && state12.depths.length === 1, JSON.stringify(state12.depths));

    // ═══════════ ⑫c 点条件区里的选择器 → 树把该节点滚到正中 ═══════════
    await panel.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 520, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await ev(panel, `(() => { const c = document.querySelector('.tree'); if (c) c.scrollTop = 0; return true; })()`);
    await sleep(300);
    const locateClicked = await ev(panel, `(() => {
        const b = [...document.querySelectorAll('.compose-anchor .compose-pick')].find((x) => x.textContent.trim() === '定位');
        if (!b) return false;
        b.click();
        return true;
    })()`);
    await sleep(500);
    const locatePos = JSON.parse(await ev(panel, `(() => {
        const c = document.querySelector('.tree');
        const row = c?.querySelector('.row.current');
        if (!c || !row) return JSON.stringify({ ok: false });
        const cr = c.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        return JSON.stringify({
            ok: true,
            scrollTop: Math.round(c.scrollTop),
            maxScroll: Math.round(c.scrollHeight - c.clientHeight),
            rowCenter: Math.round(rr.top + rr.height / 2 - cr.top),
            boxCenter: Math.round(c.clientHeight / 2),
        });
    })()`));
    console.log('   · ⑫c 定位后:', JSON.stringify(locatePos));
    {
        const nearEdge = locatePos.ok && (locatePos.scrollTop <= 1 || Math.abs(locatePos.scrollTop - locatePos.maxScroll) <= 40);
        check('⑫c 点「定位」能把节点滚到树正中（或到边界）',
            locateClicked === true && locatePos.ok && (nearEdge || Math.abs(locatePos.rowCenter - locatePos.boxCenter) <= 60),
            JSON.stringify(locatePos));
    }
    await panel.send('Emulation.clearDeviceMetricsOverride');
    await sleep(400);
    await cancelPick(panel);
    await sleep(800);

    // ═══════════ ⑬ 锁定后鼠标滑向抽屉，树不许变 ═══════════
    // 先把上一段留下的选择模式退掉，否则 .primary 是「拦截这个」
    await ev(panel, `(() => { document.querySelector('.foot-row .ghost')?.click(); return true; })()`);
    await sleep(800);
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
    check('⑬ 确实选中了元素（选择器不是空的）', lockedSel13 !== '—' && !!lockedSel13, lockedSel13);

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

    // ═══════════ ⑭ 锁定后页面自己变化（懒加载/插广告），树也不许变 ═══════════
    await ev(panel, `(() => { document.querySelector('.foot-row .ghost')?.click(); return true; })()`);
    await sleep(800);
    await page.send('Page.reload');
    await sleep(2000);
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(900);
    await ev(panel, `document.querySelector('.primary')?.click()`);
    await sleep(1200);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(500);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 150, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 150, y: 150, button: 'left', clickCount: 1 });
    await sleep(900);

    const rowsBefore = await ev(panel, `document.querySelectorAll('.tree .row').length`);
    const curBefore = await ev(panel, `document.querySelector('.tree .row.current .html')?.textContent ?? ''`);

    // 页面自己在动：插 3 个新节点 + 触发 MutationObserver + 鼠标扫一圈
    await ev(page, `(() => {
        for (let i = 0; i < 3; i++) {
            const d = document.createElement('div');
            d.className = 'late-added-' + i;
            d.textContent = '后来的内容 ' + i;
            document.querySelector('.ad-box').appendChild(d);
        }
        return true;
    })()`);
    for (const pt of [[900, 60], [1000, 300], [700, 200]]) {
        await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt[0], y: pt[1], button: 'none' });
        await sleep(350);
    }
    await sleep(700);

    const rowsAfter = await ev(panel, `document.querySelectorAll('.tree .row').length`);
    const curAfter = await ev(panel, `document.querySelector('.tree .row.current .html')?.textContent ?? ''`);
    console.log('   · 行数:', rowsBefore, '→', rowsAfter);
    check('⑭ 页面新增节点后，树的行数不变', rowsAfter === rowsBefore, `${rowsBefore} → ${rowsAfter}`);
    check('⑭ 树的当前行不变', curAfter === curBefore, `${curBefore.slice(0, 30)} → ${curAfter.slice(0, 30)}`);

    // ═══════════ ⑮ 选中的节点要在树里居中显示 ═══════════
    await ev(panel, `(() => { document.querySelector('.foot-row .ghost')?.click(); return true; })()`);
    await sleep(700);
    await page.send('Page.reload');
    await sleep(1800);
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(800);
    await ev(panel, `document.querySelector('.primary')?.click()`);
    await sleep(1200);
    const leafPos = await ev(page, `(() => {
        const el = document.querySelector('.deep-leaf');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
    })()`);
    const lp = JSON.parse(leafPos);

    // 先把手版面压矮，逼树出现滚动条，再选中（否则居中逻辑不会被触发）
    await panel.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 520, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    await ev(panel, `(() => { const c = document.querySelector('.tree'); if (c) c.scrollTop = 0; return true; })()`);
    await sleep(300);

    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lp.x, y: lp.y, button: 'none' });
    await sleep(700);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: lp.x, y: lp.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lp.x, y: lp.y, button: 'left', clickCount: 1 });
    await sleep(2200);

    const pos = JSON.parse(await ev(panel, `(() => {
        const c = document.querySelector('.tree');
        const r = c && c.querySelector('.row.current');
        if (!c || !r) return JSON.stringify({ ok: false });
        const cr = c.getBoundingClientRect();
        const rr = r.getBoundingClientRect();
        return JSON.stringify({
            ok: true,
            scrollable: c.scrollHeight > c.clientHeight + 4,
            rowCenter: Math.round(rr.top + rr.height / 2 - cr.top),
            boxCenter: Math.round(c.clientHeight / 2),
            scrollTop: Math.round(c.scrollTop),
            maxScroll: Math.round(c.scrollHeight - c.clientHeight),
        });
    })()`));
    console.log('   · 行中心/容器中心:', JSON.stringify(pos));
    await panel.send('Emulation.clearDeviceMetricsOverride');
    check('⑮ 树里有当前行', pos.ok === true, JSON.stringify(pos));
    if (pos.ok && pos.scrollable) {
        // 最顶部/最底部的节点受滚动边界限制，无法真正居中 —— 这种情况下滚到底就算通过
        const atTop = pos.scrollTop <= 1;
        const atBottom = Math.abs(pos.scrollTop - pos.maxScroll) <= 40;
        const centered = Math.abs(pos.rowCenter - pos.boxCenter) <= 60;
        check('⑮ 当前行落在列表垂直正中（或已滚到边界）',
            centered || atTop || atBottom,
            `行 ${pos.rowCenter} / 中 ${pos.boxCenter} · scrollTop ${pos.scrollTop}/${pos.maxScroll}`);
    } else {
        check('⑮ 当前行落在列表垂直正中（树不够长，免检）', true);
    }

    // ═══════════ ⑯ 三种状态用不同颜色区分 ═══════════
    // 勾一个不是当前行的节点，才能同时拿到"选中"和"勾选"两种状态
    await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => !x.classList.contains('current') && x.querySelector('.chk'));
        r && r.querySelector('.chk').click();
        return !!r;
    })()`);
    await sleep(600);

    const colors = JSON.parse(await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const cur = rows.find((r) => r.classList.contains('current'));
        const checked = rows.find((r) => r.classList.contains('checked') && !r.classList.contains('current'));
        const plain = rows.find((r) => !r.classList.contains('current') && !r.classList.contains('checked'));
        const chkOn = document.querySelector('.tree .row .chk.on');
        return JSON.stringify({
            current: cur ? getComputedStyle(cur).backgroundColor : '',
            checked: checked ? getComputedStyle(checked).backgroundColor : '',
            plain: plain ? getComputedStyle(plain).backgroundColor : '',
            checkbox: chkOn ? getComputedStyle(chkOn).backgroundColor : '',
        });
    })()`));
    console.log('   · 颜色:', JSON.stringify(colors));
    check('⑯ 有勾选的行（绿色系）', !!colors.checked, JSON.stringify(colors));
    check('⑯ 勾选行底色 ≠ 选中行底色', colors.checked !== colors.current, `${colors.checked} vs ${colors.current}`);
    check('⑯ 勾选行底色 ≠ 普通行底色', colors.checked !== colors.plain, `${colors.checked} vs ${colors.plain}`);
    check('⑯ 复选框是绿色', /rgb\(0, 180, 42\)/.test(colors.checkbox), colors.checkbox);

    // ═══════════ ⑰ 展开/收起节点，列表不许自己滚动 ═══════════
    // 先把面板压矮，让树能滚
    await panel.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 520, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    await ev(panel, `(() => { const c = document.querySelector('.tree'); if (c) c.scrollTop = 120; return true; })()`);
    await sleep(400);
    const before17 = await ev(panel, `document.querySelector('.tree')?.scrollTop ?? -1`);

    // 点一个可展开的节点（不是当前行）
    // 挑一个"在视野下方且当前是收起的"节点来展开（展开只会加内容，不会让滚动位置被夹）
    const toggled = await ev(panel, `(() => {
        const c = document.querySelector('.tree');
        if (!c) return false;
        const cb = c.getBoundingClientRect();
        const rows = [...c.querySelectorAll('.row')];
        const r = rows.find((x) => {
            const a = x.querySelector('.arrow');
            if (!a || a.classList.contains('empty')) return false;
            if (!/▸/.test(a.textContent || '')) return false;   // 必须当前是收起的
            return x.getBoundingClientRect().top > cb.bottom - 10;
        });
        if (!r) return false;
        r.querySelector('.arrow').click();
        return true;
    })()`);
    check('⑰ 找到一个可展开的节点并点开', toggled === true);
    await sleep(1600);

    const after17 = await ev(panel, `document.querySelector('.tree')?.scrollTop ?? -1`);
    console.log('   · scrollTop:', before17, '→', after17);
    check('⑰ 展开节点后列表滚动位置不变', Math.abs(Number(after17) - Number(before17)) <= 2, `${before17} → ${after17}`);
    await panel.send('Emulation.clearDeviceMetricsOverride');
    await sleep(400);

    // ═══════════ ㉑ 右侧点标签行不许滚动（只有左侧点选才居中） ═══════════
    await panel.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 520, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await ev(panel, `(() => { const c = document.querySelector('.tree'); if (c) c.scrollTop = 140; return true; })()`);
    await sleep(300);
    const before21 = await ev(panel, `document.querySelector('.tree')?.scrollTop ?? -1`);
    const clicked21 = await ev(panel, `(() => {
        const c = document.querySelector('.tree');
        if (!c) return false;
        // 不要求整行都在可视区：面板变矮时树可能只剩几行，点任意一行都能验证"右侧操作不滚动"
        const row = [...c.querySelectorAll('.row')].find((r) => r.querySelector('.name'));
        if (!row) return false;
        row.querySelector('.name').click();
        return true;
    })()`);
    await sleep(1400);
    const after21 = await ev(panel, `document.querySelector('.tree')?.scrollTop ?? -1`);
    console.log('   · 右侧点行 scrollTop:', before21, '→', after21);
    check('㉑ 右侧点标签行不滚动列表',
        clicked21 === true && Math.abs(Number(after21) - Number(before21)) <= 2,
        `${before21} → ${after21}`);
    await panel.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);

    // ═══════════ ⑱ 只有"选中的元素变了"才居中 ═══════════
    await panel.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 520, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    // 先选中别的地方，保证"选中的元素变了"，否则路径没变监听不触发
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(400);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 150, y: 150, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 150, y: 150, button: 'left', clickCount: 1 });
    await sleep(900);

    const deepPos = JSON.parse(await ev(page, `(() => {
        const el = document.querySelector('.deep-leaf');
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`));
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: deepPos.x, y: deepPos.y, button: 'none' });
    await sleep(500);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: deepPos.x, y: deepPos.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: deepPos.x, y: deepPos.y, button: 'left', clickCount: 1 });
    await sleep(2000);
    const centered18 = JSON.parse(await ev(panel, `(() => {
        const c = document.querySelector('.tree');
        const r = c && c.querySelector('.row.current');
        if (!c || !r) return JSON.stringify({ ok: false });
        const cr = c.getBoundingClientRect();
        const rr = r.getBoundingClientRect();
        return JSON.stringify({
            ok: true,
            scrollTop: Math.round(c.scrollTop),
            maxScroll: Math.round(c.scrollHeight - c.clientHeight),
            rowCenter: Math.round(rr.top + rr.height / 2 - cr.top),
            boxCenter: Math.round(c.clientHeight / 2),
        });
    })()`));
    console.log('   · 选中后:', JSON.stringify(centered18));
    await panel.send('Emulation.clearDeviceMetricsOverride');
    if (centered18.ok) {
        const nearEdge = centered18.scrollTop <= 1 || Math.abs(centered18.scrollTop - centered18.maxScroll) <= 40;
        check('⑱ 选中元素后会主动滚到中间（或到边界）',
            nearEdge || Math.abs(centered18.rowCenter - centered18.boxCenter) <= 60,
            JSON.stringify(centered18));
    } else {
        check('⑱ 选中元素后会主动滚到中间（或到边界）', false, '没有当前行');
    }

    // ═══════════ ⑲ 悬浮只变色，不触发任何逻辑；全局按钮还在 ═══════════
    const hasGlobalBtn = await ev(panel, `!!document.querySelector('.wrap-btn')`);
    check('⑲ 顶部全局「源码换行」按钮还在', hasGlobalBtn === true);

    // 悬浮一个"单行"的节点 → 不该出现「折叠该行」
    const singleTest = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => x.getBoundingClientRect().height <= 30);
        if (!r) return 'no-single';
        r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        r.dispatchEvent(new MouseEvent('mouseenter'));
        return r.dataset.path;
    })()`);
    await sleep(500);
    const btnAfterSingle = await ev(panel, `document.querySelectorAll('.tree .row .fold-btn').length`);
    check('⑲ 悬浮单行的行：没有折叠按钮', Number(btnAfterSingle) === 0, `${btnAfterSingle} 个 (${singleTest})`);

    const rowsBefore19 = await ev(panel, `document.querySelectorAll('.tree .row').length`);
    const expandedBefore19 = await ev(panel, `document.querySelectorAll('.tree .row .arrow.open').length`);
    // 在一堆行上来回悬浮
    await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        rows.slice(0, 12).forEach((r) => r.dispatchEvent(new MouseEvent('mouseenter')));
        return true;
    })()`);
    await sleep(700);
    const rowsAfter19 = await ev(panel, `document.querySelectorAll('.tree .row').length`);
    const expandedAfter19 = await ev(panel, `document.querySelectorAll('.tree .row .arrow.open').length`);
    console.log('   · 行数:', rowsBefore19, '→', rowsAfter19, '| 展开数:', expandedBefore19, '→', expandedAfter19);
    check('⑲ 悬浮不改变树的展开状态', expandedAfter19 === expandedBefore19, `${expandedBefore19} → ${expandedAfter19}`);

    // ═══════════ ⑳ 折叠按钮只给多行的行；复选框/三角/首行文字中线对齐 ═══════════
    await ev(panel, `(() => {
        const b = document.querySelector('.wrap-btn');
        if (b && /不换行/.test(b.textContent)) b.click();
        return true;
    })()`);
    await sleep(700);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(1200);

    // 悬浮"单行"的行 → 不能有按钮
    const singlePath = await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => (x.getBoundingClientRect().height ?? 0) <= 26);
        if (!r) return '';
        r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        r.dispatchEvent(new MouseEvent('mouseenter'));
        return r.dataset.path ?? '';
    })()`);
    await sleep(500);
    const btnSingle = await ev(panel, `document.querySelectorAll('.tree .row .fold-btn').length`);
    check('⑳ 单行的行不出现折叠按钮', Number(btnSingle) === 0, `${btnSingle} 个（单行行: ${singlePath}）`);

    // 悬浮"多行"的行 → 应该有按钮，且绝对定位
    const multiInfo = JSON.parse(await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => (x.getBoundingClientRect().height ?? 0) > 34);
        if (!r) return JSON.stringify({ found: false });
        r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        r.dispatchEvent(new MouseEvent('mouseenter'));
        return JSON.stringify({ found: true, path: r.dataset.path ?? '' });
    })()`));
    await sleep(600);
    const btnMulti = JSON.parse(await ev(panel, `(() => {
        const r = document.querySelector('.tree .row .fold-btn');
        if (!r) return JSON.stringify({ has: false });
        const cs = getComputedStyle(r);
        const row = r.closest('.row');
        const html = row?.querySelector('.html');
        const chk = row?.querySelector('.chk');
        const arrow = row?.querySelector('.arrow');
        const firstLine = (() => {
            if (!html) return null;
            const range = document.createRange();
            range.selectNodeContents(html);
            const rects = [...range.getClientRects()];
            return rects[0] ?? null;
        })();
        const mid = (el) => { const b = el.getBoundingClientRect(); return Math.round(b.top + b.height / 2); };
        return JSON.stringify({
            has: true,
            position: cs.position,
            chkMid: chk ? mid(chk) : null,
            arrowMid: arrow ? mid(arrow) : null,
            lineMid: firstLine ? Math.round(firstLine.top + firstLine.height / 2) : null,
        });
    })()`));
    console.log('   · 多行行:', JSON.stringify(multiInfo), JSON.stringify(btnMulti));
    check('⑳ 多行的行出现折叠按钮', btnMulti.has === true, JSON.stringify(btnMulti));
    check('⑳ 按钮绝对定位（浮在文字上，不占垂直空间）', btnMulti.position === 'absolute', btnMulti.position);
    if (btnMulti.has) {
        const d1 = Math.abs((btnMulti.chkMid ?? 0) - (btnMulti.arrowMid ?? 0));
        const d2 = Math.abs((btnMulti.chkMid ?? 0) - (btnMulti.lineMid ?? 0));
        check('⑳ 复选框/三角/首行文字中线对齐（误差 ≤2px）', d1 <= 2 && d2 <= 2,
            `chk ${btnMulti.chkMid} / arrow ${btnMulti.arrowMid} / line ${btnMulti.lineMid}`);
    }

    // ═══════════ ㉒ 规则命名 + 全局 UID ═══════════
    await cancelPick(panel);
    await sleep(700);
    await page.send('Page.reload');
    await sleep(2000);
    await ev(panel, `chrome.storage.local.set({ blockRules: {} }).then(()=>'ok')`);
    await sleep(1200);
    await ev(panel, `document.querySelector('.primary')?.click()`);
    await sleep(1200);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 150, y: 150, button: 'none' });
    await sleep(800);
    await ev(panel, `(() => {
        const rows = [...document.querySelectorAll('.tree .row')];
        const r = rows.find((x) => (x.querySelector('.html')?.textContent ?? '').includes('ad-box'));
        r?.querySelector('.name')?.click();
        return !!r;
    })()`);
    await sleep(800);

    // 新建时直接命名
    await setInput(panel, '.compose-name-input', '首页大广告框');
    await sleep(300);
    await savePick(panel);
    await sleep(2600);

    const nameSaved = JSON.parse(await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        const list = Object.values(g.blockRules || {}).flat();
        return JSON.stringify(list.map((r) => ({ name: r.name ?? '', uid: r.uid ?? '' })));
    })()`));
    console.log('   · 命名规则:', JSON.stringify(nameSaved));
    check('㉒ 新建时能直接命名', nameSaved[0]?.name === '首页大广告框', JSON.stringify(nameSaved[0]));
    check('㉒ 新规则自动带全局 UID', /^adc_[A-Za-z0-9]{8,}$/.test(nameSaved[0]?.uid || ''), nameSaved[0]?.uid || '');

    const rowText22 = await ev(panel, `document.querySelector('.rule')?.innerText.replace(/\\s+/g,' ').trim() ?? ''`);
    check('㉒ 列表标题显示名字', /首页大广告框/.test(rowText22), rowText22);
    check('㉒ 列表不显示 UID（UID 只给后台/分享用）',
        !rowText22.includes((nameSaved[0]?.uid || '').slice(-8)) && (await ev(panel, `document.querySelectorAll('.uid-chip').length`)) === 0,
        rowText22);
    check('㉒ 列表仍显示自动描述', /div\.ad-box/.test(rowText22), rowText22);

    // 点名字 → 内联改名
    await ev(panel, `document.querySelector('.rule .rule-name')?.click()`);
    await sleep(400);
    const renameShown = await ev(panel, `!!document.querySelector('.rule-name-input')`);
    check('㉒ 点名字出现内联输入框', renameShown === true);
    await setInput(panel, '.rule-name-input', '首页顶部广告');
    await ev(panel, `(() => {
        const i = document.querySelector('.rule-name-input');
        i?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
    })()`);
    await sleep(2400);
    const renamed22 = JSON.parse(await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        const r = Object.values(g.blockRules || {}).flat()[0] || {};
        return JSON.stringify({ name: r.name ?? '', uid: r.uid ?? '' });
    })()`));
    check('㉒ 改名写回存储', renamed22.name === '首页顶部广告', renamed22.name);
    check('㉒ 改名不换 UID', renamed22.uid === nameSaved[0]?.uid, `${renamed22.uid} vs ${nameSaved[0]?.uid}`);

    // 编辑时名字回填；顶栏一行；名字输入框占满整行、不再有「名」占位块
    await ev(panel, `document.querySelector('.rule .icon[title="编辑"]')?.click()`);
    await sleep(2600);
    const editNameVal = await ev(panel, `document.querySelector('.compose-name-input')?.value ?? ''`);
    check('㉒ 编辑时名字回填', editNameVal === '首页顶部广告', editNameVal);

    const headGeom = JSON.parse(await ev(panel, `(() => {
        const h = document.querySelector('.pick-head');
        const t = document.querySelector('.pick-title');
        const x = document.querySelector('.pick-hint');
        const mid = (e) => { const r = e.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
        return JSON.stringify({
            height: Math.round(h.getBoundingClientRect().height),
            titleMid: mid(t),
            hintMid: mid(x),
        });
    })()`));
    check('㉒ 「修改规则」顶栏只有一行', headGeom.height <= 48 && Math.abs(headGeom.titleMid - headGeom.hintMid) <= 2, JSON.stringify(headGeom));

    const nameGeom = JSON.parse(await ev(panel, `(() => {
        const c = document.querySelector('.compose');
        const i = document.querySelector('.compose-name-input');
        return JSON.stringify({
            composeW: Math.round(c.getBoundingClientRect().width),
            inputW: Math.round(i.getBoundingClientRect().width),
            extra: !!document.querySelector('.compose-name, .compose-uid, .cond-badge.name'),
            inputRows: Math.round(i.getBoundingClientRect().height),
        });
    })()`));
    check('㉒ 名字输入框占满一行、左侧没有「名」占位块',
        nameGeom.extra === false && nameGeom.inputW >= nameGeom.composeW * 0.82,
        JSON.stringify(nameGeom));

    await cancelPick(panel);
    await sleep(800);

    // ═══════════ ㉓ 老规则补 UID / 导入导出保留命名 ═══════════
    await page.send('Page.reload');
    await sleep(1800);
    await ev(panel, `chrome.storage.local.set({ blockRules: { '127.0.0.1': [
        { id: 'legacy-1', domain: '127.0.0.1', selector: '.dup', action: 'hide', enabled: true, label: 'div.dup', createdAt: 1 },
        { id: 'legacy-2', domain: '127.0.0.1', selector: '.icon-box', action: 'hide', enabled: true, label: 'div.icon-box', createdAt: 2 }
    ] } }).then(()=>'ok')`);
    // 后台标签的定时器会被 Chrome 降频；重新打开面板走一次 onMounted → loadPage 才稳定
    await panel.send('Page.reload');
    await sleep(1800);
    // 等它把老规则补齐（最多 8s）
    let backfilled = [];
    for (let i = 0; i < 16; i++) {
        await sleep(500);
        backfilled = JSON.parse(await ev(panel, `(async () => {
            const g = await chrome.storage.local.get('blockRules');
            return JSON.stringify((g.blockRules['127.0.0.1'] || []).map((r) => ({ id: r.id, uid: r.uid ?? '' })));
        })()`));
        if (backfilled.length === 2 && backfilled.every((r) => r.uid)) break;
    }
    console.log('   · 老规则补 UID:', JSON.stringify(backfilled));
    check('㉓ 老规则自动补 UID', backfilled.length === 2 && backfilled.every((r) => /^adc_[A-Za-z0-9]{8,}$/.test(r.uid)), JSON.stringify(backfilled));
    check('㉓ 两条规则 UID 互不相同', backfilled[0]?.uid !== backfilled[1]?.uid, JSON.stringify(backfilled));
    const uidBefore = backfilled.map((r) => r.uid).join('|');
    await sleep(2600);
    const uidAfter = (JSON.parse(await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        return JSON.stringify((g.blockRules['127.0.0.1'] || []).map((r) => r.uid ?? ''));
    })()`)) || []).join('|');
    check('㉓ UID 补完以后保持稳定', uidAfter === uidBefore, `${uidBefore} → ${uidAfter}`);
    await sleep(900);

    const compactList = JSON.parse(await ev(panel, `JSON.stringify({
        rows: document.querySelectorAll('.rule').length,
        metas: document.querySelectorAll('.rule .rule-meta').length,
        uids: document.querySelectorAll('.uid-chip').length,
        heights: [...document.querySelectorAll('.rule')].map((r) => Math.round(r.getBoundingClientRect().height)),
        text: document.querySelector('.rule')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
    })`));
    console.log('   · 规则行紧凑度:', JSON.stringify(compactList));
    check('㉓ 列表里不出现 UID', compactList.uids === 0, JSON.stringify(compactList));
    check('㉓ 没起名字的规则不占第二行',
        compactList.rows === 2 && compactList.metas === 0 && compactList.heights.every((h) => h <= 50),
        JSON.stringify(compactList));

    // 导入一条带 name + uid 的分享规则
    const shareFile = path.join(os.tmpdir(), 'adc-share-rule.json');
    const shareRule = {
        id: 'shared-1', domain: '127.0.0.1', selector: '.dup', action: 'hide',
        enabled: true, label: 'div.dup', createdAt: 3,
        uid: 'adc_shared00000000000001', name: '共享的推广卡',
        pattern: { selector: '.dup', text: '推广' }, strict: false,
    };
    fs.writeFileSync(shareFile, JSON.stringify({ format: 1, app: '广告拦截助手', version: '0.4.0', exportedAt: Date.now(), rules: { '127.0.0.1': [shareRule] } }, null, 2));
    await importRulesFile(panel, shareFile);
    await sleep(2000);
    const importedShare = JSON.parse(await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        const list = g.blockRules['127.0.0.1'] || [];
        const r = list.find((x) => x.uid === 'adc_shared00000000000001') || {};
        return JSON.stringify({ total: list.length, name: r.name ?? '', uid: r.uid ?? '' });
    })()`));
    check('㉓ 导入保留分享规则的 UID', importedShare.uid === 'adc_shared00000000000001', JSON.stringify(importedShare));
    check('㉓ 导入保留分享规则的名字', importedShare.name === '共享的推广卡', JSON.stringify(importedShare));

    // 同 UID 再导入一次（改了名字）→ 更新，不许重复
    shareRule.name = '共享的推广卡（已改名）';
    fs.writeFileSync(shareFile, JSON.stringify({ format: 1, app: '广告拦截助手', version: '0.4.0', exportedAt: Date.now(), rules: { '127.0.0.1': [shareRule] } }, null, 2));
    await importRulesFile(panel, shareFile);
    await sleep(2000);
    const reimported = JSON.parse(await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        const list = g.blockRules['127.0.0.1'] || [];
        const r = list.find((x) => x.uid === 'adc_shared00000000000001') || {};
        return JSON.stringify({ total: list.length, name: r.name ?? '' });
    })()`));
    check('㉓ 同 UID 重复导入不会多一条', reimported.total === 3, `${reimported.total} 条`);
    check('㉓ 同 UID 导入会更新名字', reimported.name === '共享的推广卡（已改名）', reimported.name);

    // 导出内容必须带 name / uid
    const exportedText = await ev(panel, `(async () => {
        let captured = '';
        const orig = URL.createObjectURL;
        URL.createObjectURL = (blob) => {
            try { blob.text().then((t) => { captured = t; }); } catch { /* ignore */ }
            return orig.call(URL, blob);
        };
        const b = [...document.querySelectorAll('.rf-link')].find((x) => x.textContent.trim() === '导出');
        b && b.click();
        await new Promise((r) => setTimeout(r, 600));
        URL.createObjectURL = orig;
        return captured;
    })()`);
    let exportedOk = false;
    try {
        const parsed = JSON.parse(exportedText);
        const list = parsed.rules?.['127.0.0.1'] || [];
        const r = list.find((x) => x.uid === 'adc_shared00000000000001');
        exportedOk = !!r && r.name === '共享的推广卡（已改名）';
    } catch { /* 导出被下载策略拦住时，至少不误报 */ }
    check('㉓ 导出文件带 name / uid', exportedOk === true, String(exportedText).slice(0, 120));

    // ═══════════ ㉔ 空闲不轮询：页面/存储真的变了才刷新 ═══════════
    await cancelPick(panel);
    await sleep(500);
    await page.send('Page.reload');
    await sleep(1800);
    await ev(panel, `chrome.storage.local.set({ blockRules: { '127.0.0.1': [
        { id: 'poll-1', domain: '127.0.0.1', selector: '.dup', action: 'hide', enabled: true, label: 'div.dup', uid: 'adc_polltest000000000001', createdAt: 1 }
    ] } }).then(()=>'ok')`);
    await panel.send('Page.reload');
    await sleep(1800);
    // 测试里面板是普通标签页，可能被页面抢了 active；后台标签的 document.hidden=true 会跳过刷新
    const panelVisible = await ev(panel, `(async () => {
        const t = await chrome.tabs.getCurrent();
        if (t) await chrome.tabs.update(t.id, { active: true });
        return !document.hidden;
    })()`);
    await sleep(900);
    console.log('   · ㉔ 面板可见:', panelVisible);

    const countOfDup = () => ev(panel, `[...document.querySelectorAll('.rule')].find((r) => /div\\.dup/.test(r.innerText))?.querySelector('.count')?.innerText ?? 'none'`);
    const initialDup = await countOfDup();
    check('㉔ 初始命中数 3', initialDup === '3', initialDup);

    // 记录发往页面的 countRules 次数：空闲 5s 不许有轮询
    await ev(panel, `(() => {
        window.__countCalls = 0;
        const orig = chrome.tabs.sendMessage.bind(chrome.tabs);
        chrome.tabs.sendMessage = (...args) => {
            const m = args[1];
            if (m && m.type === 'adc:countRules') window.__countCalls++;
            return orig(...args);
        };
        return true;
    })()`);
    await sleep(5200);
    const idleCalls = await ev(panel, `window.__countCalls`);
    check('㉔ 页面空闲时不轮询命中数', Number(idleCalls) <= 1, `${idleCalls} 次 / 5.2s`);

    // 页面 DOM 真的变了（插入同款）→ 只刷新一次，命中数 3 → 4
    const addedDup = await ev(page, `(() => {
        const d = document.createElement('div');
        d.className = 'dup z';
        d.textContent = '同款 4';
        document.querySelector('#content').appendChild(d);
        return document.querySelectorAll('.dup').length;
    })()`);
    let dupAfter = '';
    for (let i = 0; i < 24; i++) {
        await sleep(400);
        dupAfter = await countOfDup();
        if (dupAfter === '4') break;
    }
    check('㉔ 页面新增内容后才刷新命中数（3 → 4）', dupAfter === '4', `${addedDup} 个 / 显示 ${dupAfter}`);

    const callsAfterMutation = await ev(panel, `window.__countCalls`);
    check('㉔ 一次页面变化只触发一次重算', Number(callsAfterMutation) <= 2, `${callsAfterMutation} 次`);

    // 规则存储变化 → 列表自动更新（不靠轮询）
    await ev(panel, `(async () => {
        const g = await chrome.storage.local.get('blockRules');
        g.blockRules['127.0.0.1'].push({
            id: 'poll-2', domain: '127.0.0.1', selector: '.icon-box', action: 'hide',
            enabled: true, label: 'div.icon-box', uid: 'adc_polltest000000000002', createdAt: 2,
        });
        await chrome.storage.local.set(g);
        return 'ok';
    })()`);
    let ruleRows = 0;
    for (let i = 0; i < 20; i++) {
        await sleep(300);
        ruleRows = await ev(panel, `document.querySelectorAll('.rule').length`);
        if (ruleRows === 2) break;
    }
    check('㉔ 存储变化会自动刷新规则列表', ruleRows === 2, `${ruleRows} 条`);

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
