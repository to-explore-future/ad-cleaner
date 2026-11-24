import { buildHideCss, loadRulesFor, loadSettings } from '@/utils/rules';
import { ancestorChain, buildBroadSelector, buildSelector, countMatches, describeElement } from '@/utils/selector';
import type { BlockRule, ElementInfo, RuleCondition, Settings, SmartCandidate, SmartInference } from '@/utils/types';

/**
 * 页面侧的「选择器 + 规则执行器」。
 *
 * 干三件事：
 *   ① 把当前域名的规则应用到页面上（注入 CSS 隐藏 / 直接移除节点）
 *   ② 选择模式：像 F12 一样悬停高亮、点击选中，并把**祖先链**报给侧边栏
 *   ③ 预览：把某条规则会命中的元素标出来（已生效的要临时显形）
 */

/**
 * 扩展上下文是否还活着。
 *
 * ⚠️⚠️ 用户"重新加载扩展"之后，**已经打开的页面里那个旧内容脚本没有立刻消失**，
 *    它还在跑定时器、还在监听消息，但 `chrome.*` 已经不能用了 ——
 *    每次调用都会抛 "Extension context invalidated"。
 *    我有个 800ms 的定时器，于是控制台每 0.8 秒刷一条未捕获异常。
 *    所以每个定时器/监听里都要先问一句"我还活着吗"。
 */
function ctxAlive(): boolean {
    try {
        return !!chrome.runtime?.id;
    } catch {
        return false;
    }
}

const STYLE_ID = '__adc_style';
/** 条件规则命中后打的类（CSS 里 display:none） */
const BLOCKED_CLASS = '__adc_blocked';
const OUTLINE_CLASS = '__adc_outline';

let rules: BlockRule[] = [];
let settings: Settings = { showEffect: true };
let styleEl: HTMLStyleElement | null = null;

/** 选择模式状态 */
let picking = false;
/** 「点一下广告」智能模式：点中元素后自动推断规则，而不是锁定它 */
let smartMode = false;
/**
 * 是否已「锁定」当前选择。
 *
 * F12 的行为是两段式：
 *   · 还没点之前，鼠标滑到哪，右侧树就跟到哪（实时预览）
 *   · 点一下之后**锁定**，再滑动鼠标只移动高亮框，树不再乱跳
 *     （否则用户想去点树里的祖先时，鼠标一动树就变了，根本点不中）
 */
let locked = false;
/** 鼠标当前悬停的元素（不管锁没锁定都更新）—— 面板轮询时靠它 */
let lastHovered: Element | null = null;
let chain: Element[] = [];
let currentIndex = -1;
/** 预览时被排除在隐藏规则之外的选择器 */
let previewExclude: string | null = null;

/**
 * 「预览效果」：把当前选择器**真的**应用上去（隐藏或删除），让用户看到拦完之后长什么样，
 * 再点一次恢复。
 *
 * ⚠️ 说清楚它是什么：对「隐藏」来说就是临时往注入的样式表里加一条 `display:none`；
 *    对「删除」来说是真把节点从 DOM 摘掉，恢复时按记录的原位置塞回去。
 *    它不是"只画个框"，用户看到的就是最终效果。
 */
let draft: { selector: string; action: string } | null = null;
/** 预览「删除」时摘下来的节点（记父节点 + 原来的下一个兄弟，才能原位塞回） */
let removedForPreview: { node: Element; parent: Element; next: Node | null }[] = [];

// ───────────────────────── 规则应用 ─────────────────────────

function ensureStyleEl(): HTMLStyleElement | null {
    if (styleEl && styleEl.isConnected) return styleEl;
    const target = document.head ?? document.documentElement;
    if (!target) return null;
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    target.appendChild(styleEl);
    return styleEl;
}

/** 重新生成注入的 CSS（隐藏规则 + 预览描边）。 */
function rewriteStyle(): void {
    const el = ensureStyleEl();
    if (!el) return;
    const hide = buildHideCss(rules, previewExclude ?? undefined);
    const draftCss = draft && draft.action === 'hide' ? `\n${draft.selector}{display:none !important}` : '';
    el.textContent =
        hide + draftCss +
        `\n.${OUTLINE_CLASS}.${OUTLINE_CLASS}{outline:2px dashed #f53f3f !important;outline-offset:-2px !important;` +
        `background:rgba(245,63,63,.10) !important;}\n` +
        /** 同类元素：淡一点的虚线，和"当前这一个"区分开 */
        `.__adc_match.__adc_match{outline:2px dashed rgba(0,174,236,.85) !important;outline-offset:-2px !important;` +
        `background:rgba(0,174,236,.07) !important;}\n` +
        `\n.${BLOCKED_CLASS}.${BLOCKED_CLASS}{display:none !important}\n`;
}

/** 元素是否满足条件。 */
function meetsCondition(el: Element, c: RuleCondition): boolean {
    if (c.type === 'text') {
        const txt = (el as HTMLElement).innerText ?? el.textContent ?? '';
        return txt.includes(c.value);
    }
    try {
        return !!el.querySelector(c.value);
    } catch {
        return false;
    }
}

/**
 * 执行「带条件」的规则。
 *
 * ⚠️ 为什么这部分不能靠 CSS：
 *    CSS 没法表达"这个元素内部包含「广告」两个字"。
 *    所以只能 JS 逐个判断，命中的打上 `__adc_blocked` 类（样式里 display:none）。
 */
function applyConditionalRules(): void {
    const list = rules.filter((r) => r.enabled && r.condition);
    // 先清掉上一次打的标记（条件可能变了）
    document.querySelectorAll(`.${BLOCKED_CLASS}`).forEach((el) => el.classList.remove(BLOCKED_CLASS));
    if (list.length === 0) return;

    for (const r of list) {
        let targets: Element[] = [];
        try {
            targets = Array.from(document.querySelectorAll(r.selector));
        } catch {
            continue;
        }
        for (const el of targets) {
            if (!meetsCondition(el, r.condition!)) continue;
            if (r.action === 'remove') {
                el.remove();
            } else {
                el.classList.add(BLOCKED_CLASS);
            }
        }
    }
}

/** 执行「删除」类规则（这些没法用 CSS 做，只能真删）。 */
function applyRemovals(): void {
    for (const r of rules) {
        if (!r.enabled || r.action !== 'remove') continue;
        try {
            document.querySelectorAll(r.selector).forEach((n) => n.remove());
        } catch { /* 选择器非法就跳过 */ }
    }
}

/** 全部重来一遍。 */
function applyAll(): void {
    rewriteStyle();
    applyRemovals();
    applyConditionalRules();
}

/** 页面是单页应用，节点会不断重挂 —— 用观察器兜住「删除」类规则。 */
let removeObserver: MutationObserver | null = null;
let removeTimer: number | null = null;

function watchRemovals(): void {
    if (removeObserver) return;
    const hasRemoveRule = () =>
        rules.some((r) => r.enabled && (r.action === 'remove' || !!r.condition));
    removeObserver = new MutationObserver(() => {
        if (!hasRemoveRule()) return;
        if (removeTimer != null) return;
        removeTimer = window.setTimeout(() => {
            removeTimer = null;
            applyRemovals();
            applyConditionalRules();
        }, 200);
    });
    const start = () => {
        removeObserver?.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
}

// ───────────────────────── 覆盖层（高亮框） ─────────────────────────

let host: HTMLElement | null = null;
let box: HTMLElement | null = null;
let tag: HTMLElement | null = null;
let banner: HTMLElement | null = null;

function ensureOverlay(): void {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = '__adc_overlay';
    host.style.cssText =
        'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
        <style>
            :host { all: initial; }
            .box {
                position: fixed; pointer-events: none; box-sizing: border-box;
                border: 2px solid #00aeec; background: rgba(0, 174, 236, .14);
                border-radius: 2px; transition: none;
            }
            .banner {
                position: fixed; left: 50%; top: 12px; transform: translateX(-50%);
                pointer-events: none; box-sizing: border-box;
                font: 12.5px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
                background: rgba(0, 0, 0, .82); color: #fff; padding: 8px 16px;
                border-radius: 18px; white-space: nowrap; max-width: 90vw;
                overflow: hidden; text-overflow: ellipsis;
                box-shadow: 0 4px 16px rgba(0, 0, 0, .25);
            }
            .tag {
                position: fixed; pointer-events: none; box-sizing: border-box;
                font: 11px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                background: #00aeec; color: #fff; padding: 2px 6px; border-radius: 3px;
                white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis;
            }
        </style>
        <div class="banner" hidden></div>
        <div class="box" hidden></div>
        <div class="tag" hidden></div>
    `;
    box = root.querySelector('.box');
    tag = root.querySelector('.tag');
    banner = root.querySelector('.banner');
    document.documentElement.appendChild(host);
}

function hideOverlay(): void {
    if (box) box.hidden = true;
    if (tag) tag.hidden = true;
}

function paint(el: Element | null): void {
    if (!el) return hideOverlay();
    ensureOverlay();
    const r = el.getBoundingClientRect();
    if (box) {
        box.hidden = false;
        // 锁定后换成实心深色边框，和"悬停预览"区分开
        box.style.borderColor = locked ? '#00a870' : '#00aeec';
        box.style.background = locked ? 'rgba(0,168,112,.16)' : 'rgba(0,174,236,.14)';
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        box.style.width = Math.max(r.width, 2) + 'px';
        box.style.height = Math.max(r.height, 2) + 'px';
    }
    if (tag) {
        const name = el.tagName.toLowerCase();
        const cls = Array.from(el.classList)
            .filter((c) => !c.startsWith('__adc_'))
            .slice(0, 2)
            .join('.');
        const label = (cls ? `${name}.${cls}` : name) +
            `  ${Math.round(r.width)}×${Math.round(r.height)}`;
        tag.hidden = false;
        tag.textContent = label;
        const top = r.top > 22 ? r.top - 20 : r.top + 2;
        tag.style.left = Math.max(r.left, 0) + 'px';
        tag.style.top = top + 'px';
    }
}

/** 当前被标成"同类"的元素 */
let matchedEls: Element[] = [];

/**
 * 把**这一类元素**全标出来。
 *
 * 这是用户最看重的一条：指着一个卡片时，页面上要同时提示
 * "同样长这样的还有 N 个"——让他知道这条规则的真实影响范围。
 * 数量过多（>300）就不标了，避免把页面拖卡。
 */
/**
 * 上一次标过的选择器。
 * ⚠️ 鼠标每动一次都会调用 showMatches，如果选择器没变还去"先全部摘掉再全部加回"，
 *    几十个元素 × 每秒几十次 = 页面上一直闪（用户会以为"选中之后还在变"）。
 *    所以选择器没变就直接跳过。
 */
let lastMatchSelector = '';

function showMatches(selector: string): number {
    if (selector && selector === lastMatchSelector && matchedEls.length > 0) {
        return matchedEls.length;
    }
    for (const e of matchedEls) e.classList.remove('__adc_match');
    matchedEls = [];
    lastMatchSelector = selector;
    if (!selector) return 0;
    let list: Element[] = [];
    try {
        list = Array.from(document.querySelectorAll(selector));
    } catch {
        return 0;
    }
    if (list.length > 300) return list.length;
    for (const el of list) {
        el.classList.add('__adc_match');
        matchedEls.push(el);
    }
    return list.length;
}

function clearMatches(): void {
    for (const e of matchedEls) e.classList.remove('__adc_match');
    matchedEls = [];
    lastMatchSelector = '';
}

// ───────────────────────── 选择逻辑 ─────────────────────────

function chainInfo(): ElementInfo[] {
    return chain.map((el) => describeElement(el));
}

function currentEl(): Element | null {
    return currentIndex >= 0 ? chain[currentIndex] ?? null : null;
}

/**
 * 面板要看到的全部状态。
 *
 * ⚠️ 面板会**主动轮询**这个（见 `adc:state`），而不是只依赖内容脚本推送 ——
 *    推送依赖 `chrome.runtime.sendMessage` 从内容脚本到达侧边栏，
 *    这条链路在某些情况下会断（侧边栏刚打开、扩展刚重载）。
 *    轮询是"面板发请求、内容脚本应答"，只要面板能发消息就一定有回应。
 */
function currentState() {
    // 还没锁定 → 报"鼠标下的元素"（F12 那种实时对应）
    const el = locked ? currentEl() : (lastHovered ?? currentEl());
    const effectiveChain = locked || !lastHovered ? chain : ancestorChain(lastHovered);
    const effectiveIndex = locked ? currentIndex : effectiveChain.length - 1;
    const sel = el ? buildSelector(el) : '';
    const broad = el ? buildBroadSelector(el) : '';
    return {
        picking,
        locked,
        chain: effectiveChain.map((x) => describeElement(x)),
        currentIndex: effectiveIndex,
        selector: sel,
        matchCount: sel ? countMatches(sel) : 0,
        /** 这一类元素的宽选择器（不保证唯一） */
        broadSelector: broad,
        /** 同类元素有几个 */
        broadCount: broad ? countMatches(broad) : 0,
    };
}

/** 把选中项同步给侧边栏（含选择器和命中数）。 */
function notifyPanel(): void {
    const st = currentState();
    chrome.runtime.sendMessage({ type: 'adc:pickerChanged', ...st }).catch(() => { /* 面板没开就算了 */ });
    updateFollowBox();
}

/** 选择模式里，跟着选中元素走的一个常驻提示框 */
let followBox: HTMLElement | null = null;

function updateFollowBox(): void {
    const el = currentEl();
    if (!el || !picking) {
        followBox?.remove();
        followBox = null;
        return;
    }
    if (!followBox) {
        followBox = document.createElement('div');
        followBox.id = '__adc_follow';
        followBox.style.cssText =
            'position:fixed;inset:0;pointer-events:none;z-index:2147483646;' +
            'box-shadow:0 0 0 3px rgba(0,174,236,.55) inset;';
        document.documentElement.appendChild(followBox);
    }
    paint(el);
}

function setSelected(el: Element, opts: { repaint?: boolean } = {}): void {
    if (isPreviewing()) revertPreview();
    locked = true;
    updateBanner();
    showMatches(buildBroadSelector(el));
    chain = ancestorChain(el);
    currentIndex = chain.length - 1;
    if (opts.repaint !== false) paint(el);
    notifyPanel();
}

/** 面板点了树里的某一层 → 切到那一层。 */
function selectAncestor(index: number): void {
    if (index < 0 || index >= chain.length) return;
    if (isPreviewing()) revertPreview();
    currentIndex = index;
    const el = currentEl();
    paint(el);
    if (el) showMatches(buildBroadSelector(el));
    updateBanner();
    notifyPanel();
}

function startSmart(): void {
    startPicker();
    smartMode = true;
    if (banner) {
        banner.hidden = false;
        banner.textContent = '点一下那个广告（图片、标题、角标都行）';
    }
}

function startPicker(): void {
    if (picking) return;
    picking = true;
    locked = false;
    chain = [];
    currentIndex = -1;
    ensureOverlay();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize, true);
    ensureOverlay();
    updateBanner();
    notifyPanel();
}

/** 提示条文案随"锁定"状态变化，让用户一眼知道现在是什么阶段 */
function updateBanner(): void {
    if (!banner) return;
    banner.hidden = !picking;
    if (!picking) return;
    if (isPreviewing()) {
        banner.textContent = '预览中 · 这就是拦掉之后的样子 · 再点「退出预览」恢复';
        return;
    }
    banner.textContent = locked
        ? '已锁定 · 点页面别处可换目标 · 在右侧树里点上级可往外套 · Esc 退出'
        : '选择模式 · 移动鼠标定位 · 点一下锁定 · Esc 退出';
}

function stopPicker(): void {
    if (!picking) return;
    picking = false;
    smartMode = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScrollResize, true);
    window.removeEventListener('resize', onScrollResize, true);
    revertPreview();
    hideOverlay();
    clearMatches();
    if (banner) banner.hidden = true;
    followBox?.remove();
    followBox = null;
    chrome.runtime.sendMessage({ type: 'adc:pickerEnded' }).catch(() => {});
}

function hitTest(x: number, y: number): Element | null {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    if (el === host || el.closest?.('#__adc_overlay, #__adc_follow')) return null;
    return el;
}

function onMove(e: MouseEvent): void {
    const el = hitTest(e.clientX, e.clientY);
    if (!el) return;
    lastHovered = el;

    /**
     * ⚠️⚠️ 锁定之后**绝对不能再画鼠标下的元素**。
     *
     *    之前这里无条件 `paint(el)`，结果点完之后蓝框继续跟着鼠标跑，
     *    用户看到的就是"根本没定住"（被明确骂过）。
     *    现在：锁定后高亮框钉在被选中的那一层，鼠标怎么动都不改变；
     *    想换一个目标，再点一下页面就行（onClick 会重新锁定）。
     */
    if (locked) return;

    paint(el);
    // 智能模式：只画框，不标同类（用户还没点，标了反而乱）
    if (!smartMode) showMatches(buildBroadSelector(el));

    // 还没锁定 → 右侧树跟着鼠标走（F12 的实时对应）
    chain = ancestorChain(el);
    currentIndex = chain.length - 1;
    notifyPanel();
}

function onDown(e: MouseEvent): void {
    // 阻止页面拿到这次按下（避免触发拖拽、聚焦、选中文字）
    e.preventDefault();
    e.stopImmediatePropagation();
}

/**
 * 取消选中，回到「悬浮模式」。
 *
 * 用户的需求原文：
 *   「你点一下你就选中了一个标签，你再点一下这个标签，你就取消了选中这个标签」
 *   「取消之后，鼠标再来回滑，左右两侧就又相互通知了」
 */
function unlockSelection(): void {
    if (isPreviewing()) revertPreview();
    locked = false;

    // 回到悬浮模式：高亮框重新跟到鼠标下的元素
    const el = lastHovered;
    if (el) {
        chain = ancestorChain(el);
        currentIndex = chain.length - 1;
        paint(el);
        showMatches(buildBroadSelector(el));
    }
    updateBanner();
    notifyPanel();
}

function onClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = hitTest(e.clientX, e.clientY);
    if (!el) return;

    // 智能模式：点中哪个都行，系统自己推断规则
    if (smartMode) {
        lastHovered = el;
        const inference = inferFromElement(el);
        if (inference?.condition) {
            // 只在找到"广告标记"时才圈出来；没找到就什么都别圈（免得吓人）
            markConditional(inference.unitSelector, {
                type: inference.condition.type,
                value: inference.condition.value,
            });
        } else {
            clearMatches();
        }
        chrome.runtime
            .sendMessage({ type: 'adc:smartResult', inference })
            .catch(() => { /* 面板没开就算了 */ });
        hideOverlay();
        return;
    }

    /**
     * 已经选中了某个元素，而这次点的**还是它（或它内部）** → 取消选中。
     * 点的是别的元素 → 换目标，但仍然保持"选中"状态。
     */
    const cur = currentEl();
    if (locked && cur && (el === cur || cur.contains(el))) {
        unlockSelection();
        return;
    }

    setSelected(el);
}

function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
        e.preventDefault();
        stopPicker();
    }
}

function onScrollResize(): void {
    const el = currentEl();
    if (el) paint(el);
}

// ───────────────────────── 预览 ─────────────────────────

/** 高亮某个选择器会命中的元素（已生效的规则要先临时显形）。 */
function previewSelector(selector: string, action: string): number {
    clearPreviewClasses();
    if (!selector) return 0;

    if (action === 'remove') {
        // 删除类规则的元素已经不在 DOM 里了，没法预览
        return -1;
    }

    // 关键：把这条规则从隐藏样式里**临时摘掉**，元素就自然显形了
    previewExclude = selector;
    rewriteStyle();

    let n = 0;
    try {
        document.querySelectorAll(selector).forEach((el) => {
            el.classList.add(OUTLINE_CLASS);
            n++;
        });
    } catch {
        n = -1;
    }
    return n;
}

let previewed: Element[] = [];

function clearPreviewClasses(): void {
    for (const el of previewed) el.classList.remove(OUTLINE_CLASS);
    previewed = [];
    document.querySelectorAll('.' + OUTLINE_CLASS).forEach((el) => {
        el.classList.remove(OUTLINE_CLASS);
    });
}

function clearPreview(): void {
    clearPreviewClasses();
    if (previewExclude !== null) {
        previewExclude = null;
        rewriteStyle();
    }
}

/** 真的把这条规则应用上去（预览效果）。返回影响到的元素数。 */
function applyPreview(selector: string, action: string): number {
    revertPreview();
    if (!selector) return 0;
    draft = { selector, action };
    // 预览时把"圈出来"的标记全撤掉 —— 用户要看的是真实效果，不是示意图
    clearMatches();
    hideOverlay();
    updateBanner();

    if (action === 'remove') {
        // 删除模式：真摘掉，并记住原位
        let n = 0;
        try {
            document.querySelectorAll(selector).forEach((el) => {
                const parent = el.parentElement;
                if (!parent) return;
                removedForPreview.push({ node: el, parent, next: el.nextSibling });
                el.remove();
                n++;
            });
        } catch {
            return -1;
        }
        rewriteStyle();
        return n;
    }

    // 隐藏模式：往注入的样式里加一条
    rewriteStyle();
    return countMatches(selector);
}

/** 撤销预览，页面恢复原样。 */
function revertPreview(): void {
    if (!draft && removedForPreview.length === 0) return;
    draft = null;
    // 逆序塞回，保证顺序正确
    for (let i = removedForPreview.length - 1; i >= 0; i--) {
        const r = removedForPreview[i];
        try {
            if (r.next && r.next.parentNode === r.parent) {
                r.parent.insertBefore(r.node, r.next);
            } else {
                r.parent.appendChild(r.node);
            }
        } catch { /* 页面可能已经重排，忽略 */ }
    }
    removedForPreview = [];
    rewriteStyle();
    // 预览结束后把高亮框恢复回来
    const el = currentEl();
    if (el) paint(el);
    updateBanner();
}

function isPreviewing(): boolean {
    return draft != null || removedForPreview.length > 0;
}

/** 只把"符合条件的那几个"标出来（智能模式的预览）。 */
function markConditional(selector: string, cond: RuleCondition | null): number {
    clearMatches();
    let list: Element[] = [];
    try {
        list = Array.from(document.querySelectorAll(selector));
    } catch {
        return 0;
    }
    let n = 0;
    for (const el of list) {
        if (cond && !meetsCondition(el, cond)) continue;
        el.classList.add('__adc_match');
        matchedEls.push(el);
        n++;
    }
    lastMatchSelector = '';
    return n;
}

// ───────────────────────── 智能推断（点一下广告） ─────────────────────────

/** 内置广告词表：命中这些词的候选排在前面 */
const AD_WORDS = ['广告', '推广', '赞助', '赞助商', '广告位', '推广位', 'AD', 'ADV', 'ad', 'sponsor'];

/** 类名里的"广告词元"（按 - _ 拆开逐段比，避免 shadow/loading 里的 ad 误伤） */
const AD_CLASS_TOKENS = new Set(['ad', 'ads', 'adv', 'advert', 'adverts', 'sponsor', 'sponsored', 'promo', 'promotion', 'badge', 'guanggao']);

function classLooksAd(className: string): boolean {
    return className
        .toLowerCase()
        .split(/[-_\s]+/)
        .some((t) => AD_CLASS_TOKENS.has(t));
}

/**
 * 覆盖率上限：一个候选特征最多能命中多少比例的同类元素。
 *
 * ⚠️ 超过这个比例就不算"区分特征"了 —— 拦它等于拦全部。
 *    踩过的坑：B 站搜索页 42 个卡片里 41 个都有「稍后再看」的角落，
 *    它就被误判成广告特征了。
 */
const COVERAGE_MAX = 0.7;

/**
 * 两个元素算不算"同款"。
 *
 * ⚠️ 不能比**全部** class：广告卡片往往比普通卡片多一个标记类
 *    （例：`.feed-item` vs `.feed-item.is-ad`），
 *    按全部 class 比就会得出"它们不是同类"，整个推断直接失败。
 *    正确做法：同 tag，且**至少共享一个类**（都没类时按 tag 算）。
 */
function isSameKind(a: Element, b: Element): boolean {
    if (a.tagName !== b.tagName) return false;
    const ca = Array.from(a.classList).filter((c) => !c.startsWith('__adc_'));
    const cb = Array.from(b.classList).filter((c) => !c.startsWith('__adc_'));
    if (ca.length === 0 && cb.length === 0) return true;
    return ca.some((c) => cb.includes(c));
}

/**
 * 从点中的元素往上找「重复单元」——也就是"一张卡片"。
 *
 * 判断标准：这一层在它父节点下，有 ≥3 个长得一模一样的兄弟。
 * 取**最外层**满足条件的那一层（越外层越接近"整张卡片"，而不是卡片里的小块）。
 * 但有个上限：如果那一层已经比视口还高，说明爬过头了（抓到整个信息流了），不要。
 */
function findRepeatedUnit(clicked: Element): Element | null {
    let best: Element | null = null;
    const vh = window.innerHeight;
    let el: Element | null = clicked;
    while (el && el !== document.body && el.parentElement) {
        const cur = el;
        const siblings = Array.from(cur.parentElement!.children).filter((c) => isSameKind(c, cur));
        const h = el.getBoundingClientRect().height;
        if (siblings.length >= 3 && h <= vh * 0.9) best = el;
        el = el.parentElement;
    }
    return best;
}

/** 收集元素内部的短文本（可能是广告角标） */
function collectShortTexts(root: Element): string[] {
    const out = new Set<string>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let guard = 0;
    while ((n = walker.nextNode()) && guard++ < 500) {
        const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 8) continue;
        // 纯数字/符号/时长之类没意义
        if (/^[\d\s.,:：%+\-×xX/()（）·]+$/.test(t)) continue;
        out.add(t);
        if (out.size >= 40) break;
    }
    return [...out];
}

/** 收集元素内部所有类名 */
function collectClasses(root: Element): string[] {
    const out = new Set<string>();
    root.querySelectorAll('*').forEach((el) => {
        el.classList.forEach((c) => {
            if (!c.startsWith('__adc_')) out.add(c);
        });
    });
    return [...out].slice(0, 40);
}

/**
 * 核心：点一个广告，反推出一条规则。
 *
 *   ① 往上找到"卡片"那一层
 *   ② 数出同类卡片有几个
 *   ③ 找"能把这个卡片和其他卡片区分开"的特征（短文字 / 稀有 class）
 *   ④ 挑一个最像广告的作为建议条件
 */
function inferFromElement(clicked: Element): SmartInference | null {
    const unit = findRepeatedUnit(clicked);
    if (!unit) return null;

    const unitSelector = buildBroadSelector(unit);
    const all: Element[] = Array.from(document.querySelectorAll(unitSelector));
    if (all.length < 2) return null;

    // 预先算一次文字，避免下面反复触发 layout
    const texts = all.map((el) => ((el as HTMLElement).innerText ?? el.textContent ?? '').toLowerCase());

    const candidates: SmartCandidate[] = [];
    /** 必须至少排除掉 30% 的同类元素，才算"能区分" */
    const maxCount = Math.max(1, Math.floor(all.length * COVERAGE_MAX));

    // 文字特征
    for (const t of collectShortTexts(unit)) {
        const low = t.toLowerCase();
        const count = texts.filter((x) => x.includes(low)).length;
        if (count >= 1 && count <= maxCount) {
            candidates.push({
                type: 'text',
                value: t,
                count,
                recommended: AD_WORDS.some((w) => low.includes(w.toLowerCase())),
            });
        }
    }

    // 元素特征
    for (const c of collectClasses(unit)) {
        let count = 0;
        for (const el of all) {
            try {
                if (el.querySelector(`.${CSS.escape(c)}`)) count++;
            } catch { /* 忽略非法类名 */ }
        }
        if (count >= 1 && count <= maxCount) {
            candidates.push({
                type: 'selector',
                value: `.${c}`,
                count,
                recommended: classLooksAd(c),
            });
        }
    }

    /**
     * 排序规则（踩过坑后的修正版）：
     *   ① 命中广告词表的优先
     *   ② **出现 ≥2 次的优先** —— 只出现 1 次的多半是"内容"（比如某张封面上独有的字），
     *      而不是"标签"。之前把封面文字「广告 3」当成了特征，就是栽在这里。
     *   ③ 文字短的优先（「广告」比「广告 3」更像标签）
     *   ④ 命中数少的优先
     */
    const rank = (c: SmartCandidate): number[] => [
        c.recommended ? 0 : 1,
        c.count >= 2 ? 0 : 1,
        c.type === 'text' ? c.value.length : c.value.length + 4,
        c.count,
    ];
    candidates.sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        for (let i = 0; i < ra.length; i++) {
            if (ra[i] !== rb[i]) return ra[i] - rb[i];
        }
        return 0;
    });

    // 只保留前 6 个给「调整」用
    const top = candidates.slice(0, 6);

    /**
     * 只建议**真正像广告标记**的特征。
     *
     * ⚠️ 踩过的坑：一开始改成"挑最罕见的文字"，结果在 B 站搜索页挑中了
     *    「撤销」这种页面按钮文字 —— 它确实罕见，但跟广告毫无关系。
     *    宁可说"没找到"，也不能瞎猜：猜错会把正文干掉，比不做还糟。
     */
    const best = top.find((c) => c.recommended) ?? null;

    const reason = best
        ? `这类卡片一共 ${all.length} 个，其中 ${best.count} 个${best.type === 'text' ? `带「${best.value}」` : `含 ${best.value}`}。`
        : `这类卡片一共有 ${all.length} 个，但没找到明显的广告标记（比如「广告」「推广」这类字样）。`;

    return {
        unitSelector,
        unitCount: all.length,
        condition: best,
        candidates: top,
        reason,
    };
}

// ───────────────────────── 启动 / 消息 ─────────────────────────

function domainOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

async function reloadRules(): Promise<void> {
    if (!ctxAlive()) return;
    try {
        const d = domainOf(location.href);
        rules = d ? await loadRulesFor(d) : [];
        settings = await loadSettings();
        applyAll();
    } catch (e) {
        // 上下文失效 / 存储暂时不可用：静默，不要每 800ms 刷一条红字
        console.debug('[广告清道夫] 读取规则失败（扩展可能已重载）', e);
    }
}

async function boot(ctx: { setInterval: (fn: () => void, ms: number) => unknown }): Promise<void> {
    await reloadRules();
    watchRemovals();

    // 规则/设置在本页被改动（面板里操作）→ 立刻生效
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !ctxAlive()) return;
        if ('blockRules' in changes || 'settings' in changes) void reloadRules();
    });

    // 单页应用切页面 → 重新按新域名应用
    let lastUrl = location.href;
    const tick = () => {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        void reloadRules();
    };
    // 用 wxt 提供的 ctx.setInterval：上下文失效后它会自己停，不会再抛
    ctx.setInterval(tick, 800);

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        switch (msg?.type) {
            case 'adc:whoami':
                sendResponse({ ok: true, url: location.href, host: location.hostname });
                return false;
            case 'adc:ping':
                sendResponse({ ok: true, picking });
                return false;
            case 'adc:previewApply': {
                const n = applyPreview(String(msg.selector ?? ''), String(msg.action ?? 'hide'));
                sendResponse({ ok: true, count: n, previewing: isPreviewing() });
                return false;
            }
            case 'adc:previewRevert':
                revertPreview();
                sendResponse({ ok: true, previewing: false });
                return false;
            case 'adc:previewState':
                sendResponse({ ok: true, previewing: isPreviewing() });
                return false;
            case 'adc:markMatches': {
                const n = showMatches(String(msg.selector ?? ''));
                sendResponse({ ok: true, count: n });
                return false;
            }
            case 'adc:clearMatches':
                clearMatches();
                sendResponse({ ok: true });
                return false;
            case 'adc:state':
                sendResponse({ ok: true, ...currentState() });
                return false;
            case 'adc:startSmart':
                startSmart();
                sendResponse({ ok: true });
                return false;
            case 'adc:startPicker':
                startPicker();
                sendResponse({ ok: true });
                return false;
            case 'adc:stopPicker':
                stopPicker();
                sendResponse({ ok: true });
                return false;
            case 'adc:selectAncestor':
                selectAncestor(Number(msg.index));
                sendResponse({ ok: true });
                return false;
            case 'adc:preview': {
                const n = previewSelector(String(msg.selector ?? ''), String(msg.action ?? 'hide'));
                sendResponse({ ok: true, count: n });
                return false;
            }
            case 'adc:clearPreview':
                clearPreview();
                sendResponse({ ok: true });
                return false;
            case 'adc:reapply':
                void reloadRules().then(() => sendResponse({ ok: true }));
                return true;
            case 'adc:highlightIndex': {
                const el = chain[Number(msg.index)];
                if (el) paint(el);
                sendResponse({ ok: !!el });
                return false;
            }
            case 'adc:selectBySelector': {
                // 编辑已有规则：把它的目标元素重新选出来
                try {
                    const el = document.querySelector(String(msg.selector ?? ''));
                    if (el) {
                        if (!picking) startPicker();
                        setSelected(el);
                        sendResponse({ ok: true });
                    } else {
                        sendResponse({ ok: false, reason: 'not-found' });
                    }
                } catch {
                    sendResponse({ ok: false, reason: 'bad-selector' });
                }
                return false;
            }
            case 'adc:countAll': {
                const sels: string[] = Array.isArray(msg.selectors) ? msg.selectors : [];
                const counts = sels.map((x) => countMatches(x));
                sendResponse({ ok: true, counts });
                return false;
            }
            case 'adc:countMatches': {
                const n = countMatches(String(msg.selector ?? ''));
                sendResponse({ ok: true, count: n });
                return false;
            }
            default:
                return false;
        }
    });
}

export default defineContentScript({
    matches: ['<all_urls>'],
    runAt: 'document_start',
    allFrames: false,
    main(ctx) {
        /**
         * 防重复注入 —— 但**只挡住"还活着"的旧实例**。
         *
         * 面板在检测不到内容脚本时会用 `chrome.scripting.executeScript` 手动注入一次，
         * 重复注入会导致监听器注册两遍（消息收到两份）。
         * 但用户"重新加载扩展"之后，旧实例的上下文已经失效（`isValid === false`，
         * 因为 chrome.runtime.id 没了），这时候新实例必须**接管**，
         * 否则页面里永久没有可用的脚本，只能靠刷新 —— 那太蠢了。
         */
        const w = window as unknown as { __adc_ctx?: { isValid?: boolean } };
        if (w.__adc_ctx && w.__adc_ctx.isValid) return;
        w.__adc_ctx = ctx as unknown as { isValid?: boolean };
        void boot(ctx as unknown as { setInterval: (fn: () => void, ms: number) => unknown });
    },
});
