import { buildHideCss, isAdvancedPattern, loadRulesFor, loadSettings, normalizeRule } from '@/utils/rules';
import { ancestorChain, buildBroadSelector, buildSelector, countMatches, describeElement } from '@/utils/selector';
import type { BlockRule, ElementInfo, RuleCondition, RulePart, RulePattern, Settings } from '@/utils/types';

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
/**
 * 是否已「锁定」当前选择。
 *
 * F12 的行为是两段式：
 *   · 还没点之前，鼠标滑到哪，右侧树就跟到哪（实时预览）
 *   · 点一下之后**锁定**，再滑动鼠标只移动高亮框，树不再乱跳
 *     （否则用户想去点树里的祖先时，鼠标一动树就变了，根本点不中）
 */
let locked = false;
/**
 * 这次选中是谁触发的：
 *   page  = 用户在页面上点了一下（只有这种才让右侧树居中）
 *   panel = 用户在右侧树里点行/编辑
 *   hover = 页面上的鼠标悬停（不居中，否则树会跟着鼠标一直滚）
 */
let selectionOrigin: 'page' | 'panel' | 'hover' = 'hover';
/** 用户在页面上"点选"的次数。面板靠它判断是不是一次新的左→右选择。 */
let pageSelectionSeq = 0;
/** 鼠标当前悬停的元素（不管锁没锁定都更新）—— 面板轮询时靠它 */
let lastHovered: Element | null = null;
let chain: Element[] = [];
let currentIndex = -1;
/** 正在"点一下条件"模式：下一次点击用来选条件，而不是选外层 */
let condPicking = false;
/** 这次要给哪个选择器加条件 */
let condOuterSelector = '';

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
let draft: { selector: string; action: string; advanced?: boolean } | null = null;
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
    const draftCss = draft && draft.action === 'hide' && !draft.advanced ? `\n${draft.selector}{display:none !important}` : '';
    el.textContent =
        hide + draftCss +
        `\n.${OUTLINE_CLASS}.${OUTLINE_CLASS}{outline:2px dashed #f53f3f !important;outline-offset:-2px !important;` +
        `background:rgba(245,63,63,.10) !important;}\n` +
        /** 同类元素：淡一点的虚线，和"当前这一个"区分开 */
        // 同类元素：细虚线、不加底色 —— 只做"提示还有几个"，别糊住页面
        `.__adc_match.__adc_match{outline:1px dashed rgba(0,174,236,.55) !important;outline-offset:-1px !important;}\n` +
        `\n.${BLOCKED_CLASS}.${BLOCKED_CLASS}{display:none !important}\n`;
}

/** 元素文本（用 innerText 优先，文本条件要的是"用户看到的字"） */
function textOf(el: Element): string {
    return (el as HTMLElement).innerText ?? el.textContent ?? '';
}

/** 元素是否满足条件（保留给「+ 加条件」的候选计算）。 */
function meetsCondition(el: Element, c: RuleCondition): boolean {
    if (c.type === 'text') return textOf(el).includes(c.value);
    try {
        return !!el.querySelector(c.value);
    } catch {
        return false;
    }
}

function safeMatches(el: Element, selector: string): boolean {
    if (selector === '*') return true;
    try {
        return el.matches(selector);
    } catch {
        return false;
    }
}

/** 某个元素**正好**往下 depth 层的所有后代 */
function descendantsAtDepth(el: Element, depth: number): Element[] {
    let level: Element[] = [el];
    for (let d = 0; d < depth; d++) {
        const next: Element[] = [];
        for (const e of level) for (const c of Array.from(e.children)) next.push(c);
        if (next.length === 0) return [];
        level = next;
    }
    return level;
}

/** 某个元素的全部后代（不含自己） */
function allDescendants(el: Element): Element[] {
    const out: Element[] = [];
    const walk = (p: Element) => {
        for (const c of Array.from(p.children)) {
            out.push(c);
            walk(c);
        }
    };
    walk(el);
    return out;
}

/**
 * 统一条件树是否命中。
 *
 * strict=false：每个子条件在**锚点子树任意层**里找（偷懒模式）
 * strict=true ：按 relDepth 精确到第 N 层（精确模式）
 * children 之间是 AND；children 自己还能再套 children。
 */
function matchesPattern(el: Element, p: RulePattern, strict: boolean): boolean {
    if (!safeMatches(el, p.selector)) return false;
    if (p.text && !textOf(el).includes(p.text)) return false;
    for (const c of p.children ?? []) {
        const cands = strict ? descendantsAtDepth(el, Math.max(1, c.relDepth ?? 1)) : allDescendants(el);
        if (!cands.some((x) => matchesPattern(x, c, strict))) return false;
    }
    return true;
}

/** 只保留匹配需要的最小字段，面板可以整条规则发过来。 */
interface MatchableRule {
    selector: string;
    pattern?: RulePattern;
    strict?: boolean;
    /** @deprecated 旧格式兼容 */
    condition?: RuleCondition;
    /** @deprecated 旧格式兼容 */
    parts?: RulePart[];
}

/** 把最小字段补成完整规则并迁移旧格式。 */
function toNormalized(rule: MatchableRule): BlockRule {
    return normalizeRule({
        id: 'x', domain: '', selector: rule.selector, action: 'hide', enabled: true,
        label: '', createdAt: 0,
        ...(rule.pattern ? { pattern: rule.pattern } : {}),
        strict: !!rule.strict,
        ...(rule.condition ? { condition: rule.condition } : {}),
        ...(rule.parts ? { parts: rule.parts } : {}),
    });
}

/**
 * 一条规则**真正**会命中的元素。
 *
 * 统一走条件树：普通规则就是没有文字/children 的单节点。
 */
function elementsMatchingRule(rule: MatchableRule): Element[] {
    const n = toNormalized(rule);
    const p = n.pattern!;
    let anchors: Element[] = [];
    try {
        anchors = Array.from(document.querySelectorAll(p.selector));
    } catch {
        return [];
    }
    return anchors.filter((el) => matchesPattern(el, p, !!n.strict));
}

function countRuleMatches(rule: MatchableRule): number {
    return elementsMatchingRule(rule).length;
}

/**
 * 找回一条规则每个节点对应的树路径（按条件树的先序）。
 *
 * 用途：编辑规则时把当初勾选的标签重新勾上。
 * strict 时按 relDepth 找，否则在子树里找第一个匹配的。
 */
function collectPatternPaths(
    el: Element,
    p: RulePattern,
    strict: boolean,
    out: { path: string; text: string }[],
): boolean {
    const path = elementPath(el);
    if (!path) return false;
    out.push({ path: keyOfPath(path), text: p.text ?? '' });
    for (const c of p.children ?? []) {
        const cands = strict ? descendantsAtDepth(el, Math.max(1, c.relDepth ?? 1)) : allDescendants(el);
        const next = cands.find((x) => matchesPattern(x, c, strict));
        if (!next) return false;
        if (!collectPatternPaths(next, c, strict, out)) return false;
    }
    return true;
}

function patternPaths(rule: MatchableRule): { path: string; text: string }[] {
    const n = toNormalized(rule);
    const p = n.pattern!;
    let anchors: Element[] = [];
    try {
        anchors = Array.from(document.querySelectorAll(p.selector));
    } catch {
        return [];
    }
    for (const el of anchors) {
        if (!matchesPattern(el, p, !!n.strict)) continue;
        const out: { path: string; text: string }[] = [];
        if (collectPatternPaths(el, p, !!n.strict, out)) return out;
    }
    return [];
}

/**
 * 统一执行所有"CSS 表达不了"的规则（文字条件 / 条件树）。
 * 命中后打 __adc_blocked（CSS 里 display:none）或真删。
 */
function applyPatternRules(): void {
    document.querySelectorAll(`.${BLOCKED_CLASS}`).forEach((el) => el.classList.remove(BLOCKED_CLASS));
    for (const r of rules) {
        if (!r.enabled || !isAdvancedPattern(r)) continue;
        for (const el of elementsMatchingRule(r)) {
            // 悬浮预览时这些元素要临时显形，别被 MutationObserver 又藏回去
            if (previewAdvanced && previewed.includes(el)) continue;
            if (r.action === 'remove') el.remove();
            else el.classList.add(BLOCKED_CLASS);
        }
    }
}

/** 执行「删除」类规则（这些没法用 CSS 做，只能真删）。 */
function applyRemovals(): void {
    for (const r of rules) {
        // 条件树的删除由 applyPatternRules 处理，别在这里按裸 selector 全删
        if (!r.enabled || r.action !== 'remove' || isAdvancedPattern(r)) continue;
        try {
            document.querySelectorAll(r.selector).forEach((n) => n.remove());
        } catch { /* 选择器非法就跳过 */ }
    }
}

/** 全部重来一遍。 */
function applyAll(): void {
    rewriteStyle();
    applyRemovals();
    applyPatternRules();
}

/** 页面是单页应用，节点会不断重挂 —— 用观察器兜住「删除」和条件树。 */
let removeObserver: MutationObserver | null = null;
let removeTimer: number | null = null;

function watchRemovals(): void {
    if (removeObserver) return;
    const hasWork = () =>
        rules.some((r) => r.enabled && (r.action === 'remove' || isAdvancedPattern(r)));
    removeObserver = new MutationObserver(() => {
        if (!hasWork()) return;
        if (removeTimer != null) return;
        removeTimer = window.setTimeout(() => {
            removeTimer = null;
            applyRemovals();
            applyPatternRules();
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
/** 跟随鼠标的浅色框（锁定后也显示，但不改变选中） */
let hoverBox: HTMLElement | null = null;

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
            .hover {
                position: fixed; pointer-events: none; box-sizing: border-box;
                border: 1px dashed rgba(0, 174, 236, .8); border-radius: 2px;
            }
            .box {
                position: fixed; pointer-events: none; box-sizing: border-box;
                border: 2px solid #00aeec; background: rgba(0, 174, 236, .14);
                border-radius: 2px; transition: none;
            }
        </style>
        <div class="hover" hidden></div>
        <div class="hover" hidden></div>
        <div class="box" hidden></div>
    `;
    box = root.querySelector('.box');
    hoverBox = root.querySelector('.hover');
    hoverBox = root.querySelector('.hover');
    document.documentElement.appendChild(host);
}

function hideOverlay(): void {
    if (box) box.hidden = true;
    if (hoverBox) hoverBox.hidden = true;
    if (hoverBox) hoverBox.hidden = true;
}

/** 画跟随鼠标的浅色框 */
function paintHover(el: Element | null): void {
    if (!hoverBox) return;
    if (!el) {
        hoverBox.hidden = true;
        return;
    }
    const r = el.getBoundingClientRect();
    hoverBox.hidden = false;
    hoverBox.style.left = r.left + 'px';
    hoverBox.style.top = r.top + 'px';
    hoverBox.style.width = r.width + 'px';
    hoverBox.style.height = r.height + 'px';
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
    /**
     * 页面上**不再显示那个文字标签**（`span.trigger-text 42×22` 之类）。
     * 用户反馈：它正好盖在要点的东西上，挡着选。
     * 这些信息面板里都有（DOM 树 + 选择器），页面上只需要一个框。
     */
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

/**
 * 把「当前草稿规则」真正会命中的元素标出来。
 *
 * 和 showMatches（整类同款）不同：条件/文字会把范围收窄，用户改一个字
 * 就应该马上看到被拦的从 6 个变成 2 个 —— 这是保存前唯一的"真实影响范围"。
 */
function markByPattern(selector: string, pattern: RulePattern | undefined, strict: boolean): number {
    clearMatches();
    if (!pattern) return 0;
    const list = elementsMatchingRule({ selector, pattern, strict });
    if (list.length > 300) return list.length;
    for (const el of list) {
        el.classList.add('__adc_match');
        matchedEls.push(el);
    }
    return list.length;
}

// ───────────────────────── DOM 树（F12 那种） ─────────────────────────

/** 已展开的节点（按路径字符串，如 "1/3/0"） */
const expandedPaths = new Set<string>();
/** 当前选中元素的路径 */
let currentPathKey = '';

/** 元素在整棵树里的路径（每层是它在父元素 children 里的下标） */
function elementPath(el: Element): number[] | null {
    const path: number[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
        const parent: Element | null = cur.parentElement;
        if (!parent) return null;
        path.unshift(Array.prototype.indexOf.call(parent.children, cur));
        cur = parent;
    }
    return cur === document.documentElement ? path : null;
}

const keyOfPath = (p: number[]): string => p.join('/');
const pathOfKey = (k: string): number[] => (k === '' ? [] : k.split('/').map(Number));

function elementAtPath(p: number[]): Element | null {
    let cur: Element = document.documentElement;
    for (const idx of p) {
        const next = cur.children[idx];
        if (!next) return null;
        cur = next;
    }
    return cur;
}

/** 展开到某个元素（所有祖先都展开），这样它在树里能露出来 */
function expandTo(path: number[]): void {
    for (let i = 0; i <= path.length; i++) expandedPaths.add(keyOfPath(path.slice(0, i)));
}

/** 树上的一个节点（扁平化之后的） */
export interface TreeNodeInfo {
    path: string;
    depth: number;
    tag: string;
    id: string;
    classes: string[];
    hasChildren: boolean;
    expanded: boolean;
    current: boolean;
    /** 开标签的源码，如 `<div class="ad-box" id="x">`（像 DevTools 那样展示） */
    html: string;
    /** 节点自己的文字内容（截断），让用户知道这段里写的是什么 */
    text: string;
}

/** 这些节点的 textContent 不是"页面上的文字"，不要展示 */
const NO_TEXT_TAGS = new Set(['html', 'head', 'style', 'script', 'meta', 'link', 'title', 'noscript']);

/** 这些属性没用，展示时跳过 */
const SKIP_ATTR = new Set(['data-v-', 'onload', 'onerror', 'onclick']);

/** 拼出开标签源码：<tag attr="v" ...> —— 就是 DevTools 左边那一行 */
function openTagSource(el: Element): string {
    const tag = el.tagName.toLowerCase();
    let out = `<${tag}`;
    for (const a of Array.from(el.attributes)) {
        if (SKIP_ATTR.has(a.name) || a.name.startsWith('data-v-')) continue;
        let v = a.value.replace(/\s+/g, ' ');
        // 去掉我们临时打的标记类，别让用户看到 __adc_match 这种东西
        if (a.name === 'class') v = v.split(' ').filter((c) => c && !c.startsWith('__adc_')).join(' ');
        /**
         * 图片的 data URI 是压缩过的整张图，展示出来就是七八行乱码，
         * 真正有用的 tag/class 全被挤没了。这里只做**显示**截断，不改 DOM。
         */
        if ((a.name === 'src' || a.name === 'srcset' || a.name === 'data-src') && v.startsWith('data:')) {
            v = `${v.slice(0, 32)}…（${a.value.length} 字符）`;
        }
        // 换行模式下要能看全，所以放宽到 400/1200；不换行时靠 CSS 截断
        if (v.length > 400) v = v.slice(0, 400) + '…';
        out += ` ${a.name}="${v}"`;
        if (out.length > 1200) { out += ' …'; break; }
    }
    return out + '>';
}

/** 最多序列化多少节点（大页面别把面板撑爆） */
const MAX_TREE_NODES = 400;

/** 按当前展开状态，把 DOM 拍平成一串节点 */
function buildTree(): TreeNodeInfo[] {
    const out: TreeNodeInfo[] = [];
    /**
     * 当前行直接拿"元素本身"比，不用路径字符串。
     * 之前用 currentPathKey 比，一旦它没设上（setSelected 漏了），
     * 树就会把 <html> 标成当前行 —— 反复出过好几次。
     */
    const cur = locked ? currentEl() : lastHovered;
    const walk = (el: Element, path: number[]) => {
        if (out.length >= MAX_TREE_NODES) return;
        // 跳过我们自己插进去的浮层（它挂在 documentElement 下，不该出现在用户的页面树里）
        if (el.id.startsWith('__adc_')) return;
        const key = keyOfPath(path);
        const isOpen = expandedPaths.has(key);
        out.push({
            path: key,
            depth: path.length,
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            classes: Array.from(el.classList)
                .filter((c) => !c.startsWith('__adc_'))
                .slice(0, 3),
            hasChildren: el.children.length > 0,
            expanded: isOpen,
            // 优先按元素本身比；万一拿不到当前元素，退回按路径比
            current: cur ? el === cur : key === currentPathKey,
            html: openTagSource(el),
            // 用 textContent（不触发排版）；innerText 对 html/body 这种大节点太贵，
            // 整棵树每 100ms 算一次会把面板拖慢
            // 只取"用户看得见的文字"：html/head/style/script 的 textContent
            // 会把 <style> 里的 CSS 源码也算进去（会污染预览）
            text: NO_TEXT_TAGS.has(el.tagName.toLowerCase())
                ? ''
                : (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        });
        if (!isOpen) return;
        Array.from(el.children).forEach((child, i) => walk(child, [...path, i]));
    };
    walk(document.documentElement, []);
    return out;
}

/**
 * 锁定后的树快照。
 *
 * ⚠️ 为什么必须缓存：面板每 100ms 轮询一次 `adc:state`，
 *    以前每次都全量 `buildTree()`（最多 400 节点、拼所有属性）。
 *    更糟的是页面自己懒加载/插节点时，重建出来的行数会变 ——
 *    用户看到的就是"选中之后树还在变"（测试 ⑭）。
 *    锁定期间只认用户操作（展开/选节点/换目标）产生的快照。
 */
let cachedTree: TreeNodeInfo[] | null = null;

function invalidateTree(): void {
    cachedTree = null;
}

/** 未锁定时实时算（F12 那种跟随）；锁定时用快照。 */
function treeSnapshot(): TreeNodeInfo[] {
    if (!locked) return buildTree();
    if (!cachedTree) cachedTree = buildTree();
    return cachedTree;
}

/** 展开 / 收起某个节点 */
function togglePath(key: string): void {
    if (expandedPaths.has(key)) expandedPaths.delete(key);
    else expandedPaths.add(key);
    invalidateTree();
    notifyPanel();
}

/** 选中树里的某个节点 */
function selectPath(key: string): void {
    const el = elementAtPath(pathOfKey(key));
    if (el) {
        selectionOrigin = 'panel';
        setSelected(el);
    }
}

/** 悬停树里的某个节点 → 页面上高亮它 */
function highlightPath(key: string): void {
    const el = elementAtPath(pathOfKey(key));
    if (el) paint(el);
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
        /** 这次选中来自哪里（page / panel / hover），面板据此决定要不要居中 */
        origin: selectionOrigin,
        /** 页面上第几次点选（面板去重用） */
        pageSeq: pageSelectionSeq,
        chain: effectiveChain.map((x) => describeElement(x)),
        currentIndex: effectiveIndex,
        selector: sel,
        matchCount: sel ? countMatches(sel) : 0,
        /** 这一类元素的宽选择器（不保证唯一） */
        broadSelector: broad,
        /** 同类元素有几个 */
        broadCount: broad ? countMatches(broad) : 0,
        tree: treeSnapshot(),
        currentPath: currentPathKey,
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
    invalidateTree();
    locked = true;
    // 记下它在整棵树里的位置，并展开到它 —— 否则树的"当前行"会停在 html
    const p = elementPath(el);
    if (p) {
        currentPathKey = keyOfPath(p);
        expandTo(p);
    }
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
    selectionOrigin = 'panel';
    invalidateTree();
    currentIndex = index;
    const el = currentEl();
    paint(el);
    if (el) showMatches(buildBroadSelector(el));
    notifyPanel();
}

function startPicker(): void {
    if (picking) return;
    picking = true;
    locked = false;
    // 每次进入选择模式重新计数：面板以 0 为基线，页面点一下就是 1
    pageSelectionSeq = 0;
    selectionOrigin = 'hover';
    chain = [];
    currentIndex = -1;
    invalidateTree();
    ensureOverlay();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize, true);
    ensureOverlay();
    notifyPanel();
}

function stopPicker(): void {
    if (!picking) return;
    picking = false;
    condPicking = false;
    invalidateTree();
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScrollResize, true);
    window.removeEventListener('resize', onScrollResize, true);
    revertPreview();
    hideOverlay();
    clearMatches();
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
    // 悬停不等于"选中"：只更新树，不让面板把行滚到中间
    if (!locked) selectionOrigin = 'hover';

    /**
     * ⚠️⚠️ 锁定之后**绝对不能再画鼠标下的元素**。
     *
     *    之前这里无条件 `paint(el)`，结果点完之后蓝框继续跟着鼠标跑，
     *    用户看到的就是"根本没定住"（被明确骂过）。
     *    现在：锁定后高亮框钉在被选中的那一层，鼠标怎么动都不改变；
     *    想换一个目标，再点一下页面就行（onClick 会重新锁定）。
     */
    // 鼠标落在页面空白/根节点上 → 不要动树（否则整行会跳到 html）
    if (el === document.documentElement) {
        paintHover(null);
        return;
    }

    // 锁定之后：选中框/树/选择器都冻住，但鼠标下仍给一个浅色框，
    // 让用户看清"下次点会点到哪"
    if (locked) {
        paintHover(el);
        return;
    }

    paintHover(el);
    paint(el);
    showMatches(buildBroadSelector(el));

    // 还没锁定 → 右侧树跟着鼠标走（F12 的实时对应）
    // 要**自动展开到鼠标下这个元素**，否则它藏在折叠节点里看不见
    chain = ancestorChain(el);
    currentIndex = chain.length - 1;
    const p = elementPath(el);
    if (p) {
        currentPathKey = keyOfPath(p);
        expandTo(p);
    }
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
    invalidateTree();

    // 回到悬浮模式：高亮框重新跟到鼠标下的元素
    const el = lastHovered;
    if (el) {
        chain = ancestorChain(el);
        currentIndex = chain.length - 1;
        paint(el);
        showMatches(buildBroadSelector(el));
    }
    notifyPanel();
}

function onClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = hitTest(e.clientX, e.clientY);
    if (!el) return;

    /**
     * 「加条件」模式：这次点击是在选"能区分广告的东西"，
     * 不是选外层，所以不能走下面的锁定逻辑。
     */
    if (condPicking) {
        condPicking = false;
        const result = computeCondCandidates(el, condOuterSelector);
        chrome.runtime
            .sendMessage({ type: 'adc:condPicked', ...result })
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
        selectionOrigin = 'page';
        unlockSelection();
        return;
    }

    // 页面点选：这是唯一会让右侧树"滚到中间"的来源
    selectionOrigin = 'page';
    pageSelectionSeq++;
    setSelected(el);
    // 单独发一条"页面选中"通知：面板收到才居中，轮询/悬停都不会触发
    chrome.runtime.sendMessage({ type: 'adc:pageSelected' }).catch(() => { /* 面板没开就算了 */ });
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

/** 悬浮预览时，是否临时把"条件/组合规则"藏起来的元素显形了 */
let previewAdvanced = false;

/** 高亮某条规则会命中的元素（已生效的规则要先临时显形）。 */
function previewSelector(
    selector: string,
    action: string,
    opts: { pattern?: RulePattern; strict?: boolean; condition?: RuleCondition; parts?: RulePart[] } = {},
): number {
    clearPreviewClasses();
    if (!selector) return 0;

    if (action === 'remove') {
        // 删除类规则的元素已经不在 DOM 里了，没法预览
        return -1;
    }

    // 关键：把这条规则从隐藏样式里**临时摘掉**，元素就自然显形了
    previewExclude = selector;
    rewriteStyle();

    let list: Element[] = [];
    try {
        // ⚠️ 不能只按 selector 标：文字/条件树的真实命中范围更小。
        list = elementsMatchingRule({
            selector,
            pattern: opts.pattern,
            strict: opts.strict,
            condition: opts.condition,
            parts: opts.parts,
        });
    } catch {
        return -1;
    }

    previewAdvanced = !!(opts.condition || (opts.parts && opts.parts.length > 1) ||
        (opts.pattern && (opts.pattern.text || (opts.pattern.children && opts.pattern.children.length))));
    for (const el of list) {
        // 条件/组合规则是靠 __adc_blocked 藏的，预览时要临时摘掉才看得见
        if (previewAdvanced) el.classList.remove(BLOCKED_CLASS);
        el.classList.add(OUTLINE_CLASS);
        previewed.push(el);
    }
    return list.length;
}

let previewed: Element[] = [];

function clearPreviewClasses(): void {
    for (const el of previewed) el.classList.remove(OUTLINE_CLASS);
    previewed = [];
    document.querySelectorAll('.' + OUTLINE_CLASS).forEach((el) => {
        el.classList.remove(OUTLINE_CLASS);
    });
    // 高级规则预览时摘掉的隐藏类要补回去，否则移开鼠标后广告不会重新藏起来
    if (previewAdvanced) {
        previewAdvanced = false;
        applyPatternRules();
    }
}

function clearPreview(): void {
    clearPreviewClasses();
    if (previewExclude !== null) {
        previewExclude = null;
        rewriteStyle();
    }
}

/** 真的把这条规则应用上去（预览效果）。返回影响到的元素数。 */
function applyPreview(
    selector: string,
    action: string,
    pattern?: RulePattern,
    strict = false,
): number {
    revertPreview();
    if (!selector) return 0;
    const advanced = !!(pattern && (pattern.text || (pattern.children && pattern.children.length)));
    draft = { selector, action, advanced };
    // 预览时把"圈出来"的标记全撤掉 —— 用户要看的是真实效果，不是示意图
    clearMatches();
    hideOverlay();

    if (advanced) {
        const list = elementsMatchingRule({ selector, pattern, strict });
        if (action === 'remove') {
            for (const el of list) {
                const parent = el.parentElement;
                if (!parent) continue;
                removedForPreview.push({ node: el, parent, next: el.nextSibling });
                el.remove();
            }
        } else {
            for (const el of list) el.classList.add(BLOCKED_CLASS);
        }
        rewriteStyle();
        return list.length;
    }

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
    const wasAdvanced = !!draft?.advanced;
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
    if (wasAdvanced) applyPatternRules();
    rewriteStyle();
    // 预览结束后把高亮框恢复回来
    const el = currentEl();
    if (el) paint(el);
}

function isPreviewing(): boolean {
    return draft != null || removedForPreview.length > 0;
}

// ───────────────────────── 「加条件」 ─────────────────────────

/** 一条候选条件 */
interface CondCandidate {
    type: 'text' | 'selector';
    value: string;
    count: number;
}

/**
 * 用户点了内层那个"能区分的东西"之后，算出可以当条件的候选。
 *
 * 只保留"命中数 < 同类总数"的 —— 全都有的东西没有区分能力。
 */
function computeCondCandidates(inner: Element, outerSelector: string): {
    total: number; candidates: CondCandidate[];
} {
    let all: Element[] = [];
    try {
        all = Array.from(document.querySelectorAll(outerSelector));
    } catch {
        return { total: 0, candidates: [] };
    }
    const total = all.length;
    if (total === 0) return { total: 0, candidates: [] };

    // 找到 inner 对应的那个外层（用于限定搜索范围）
    let outer: Element | null = null;
    for (let e: Element | null = inner; e; e = e.parentElement) {
        try {
            if (e.matches(outerSelector)) { outer = e; break; }
        } catch { /* 忽略非法选择器 */ }
    }
    const scope = outer ?? inner.parentElement ?? inner;

    // ── 文字候选：点中元素的文本，以及它内部所有短文本 ──
    const texts = new Set<string>();
    const pushText = (raw: string | null | undefined) => {
        const t = (raw ?? '').replace(/\s+/g, ' ').trim();
        if (t && t.length <= 12 && !/^[\d\s.,:：%+\-×xX/()（）·]+$/.test(t)) texts.add(t);
    };
    pushText((inner as HTMLElement).innerText);
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    let guard = 0;
    while ((n = walker.nextNode()) && guard++ < 200) pushText(n.textContent);

    // ── class 候选：点的元素 → 往上到外层为止 ──
    const classes = new Set<string>();
    for (let e: Element | null = inner; e; e = e.parentElement) {
        e.classList.forEach((c) => { if (!c.startsWith('__adc_')) classes.add(c); });
        if (e === scope) break;
    }

    const textCache = all.map((el) => (el as HTMLElement).innerText ?? el.textContent ?? '');
    const candidates: CondCandidate[] = [];

    for (const t of texts) {
        const count = textCache.filter((x) => x.includes(t)).length;
        if (count >= 1 && count < total) candidates.push({ type: 'text', value: t, count });
    }
    for (const c of classes) {
        const sel = `.${CSS.escape(c)}`;
        let count = 0;
        for (const el of all) {
            try { if (el.querySelector(sel)) count++; } catch { /* 忽略 */ }
        }
        if (count >= 1 && count < total) candidates.push({ type: 'selector', value: sel, count });
    }

    // 排序：文字优先（短的优先）→ class 按命中少的优先
    candidates.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'text' ? -1 : 1;
        if (a.type === 'text' && a.value.length !== b.value.length) return a.value.length - b.value.length;
        return a.count - b.count;
    });

    return { total, candidates: candidates.slice(0, 8) };
}

/** 按条件标出"会被拦的那几个"。 */
function markByCondition(selector: string, cond: RuleCondition): number {
    clearMatches();
    let list: Element[] = [];
    try {
        list = Array.from(document.querySelectorAll(selector));
    } catch {
        return 0;
    }
    let n = 0;
    for (const el of list) {
        if (!meetsCondition(el, cond)) continue;
        el.classList.add('__adc_match');
        matchedEls.push(el);
        n++;
    }
    lastMatchSelector = '';
    return n;
}

function startCondPick(selector: string): void {
    if (!picking) startPicker();
    condPicking = true;
    condOuterSelector = selector;
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
        rules = d ? (await loadRulesFor(d)).map(normalizeRule) : [];
        settings = await loadSettings();
        applyAll();
    } catch (e) {
        // 上下文失效 / 存储暂时不可用：静默，不要每 800ms 刷一条红字
        console.debug('[广告拦截助手] 读取规则失败（扩展可能已重载）', e);
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
                const n = applyPreview(
                    String(msg.selector ?? ''),
                    String(msg.action ?? 'hide'),
                    msg.pattern as RulePattern | undefined,
                    !!msg.strict,
                );
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
            case 'adc:startCondPick':
                startCondPick(String(msg.selector ?? ''));
                sendResponse({ ok: true });
                return false;
            case 'adc:markPattern': {
                const n = markByPattern(
                    String(msg.selector ?? ''),
                    msg.pattern as RulePattern | undefined,
                    !!msg.strict,
                );
                sendResponse({ ok: true, count: n });
                return false;
            }
            case 'adc:markCondition': {
                const n = markByCondition(
                    String(msg.selector ?? ''),
                    msg.condition as RuleCondition,
                );
                sendResponse({ ok: true, count: n });
                return false;
            }
            case 'adc:clearCondition':
                clearMatches();
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
            case 'adc:togglePath':
                togglePath(String(msg.path ?? ''));
                sendResponse({ ok: true });
                return false;
            case 'adc:selectPath':
                selectPath(String(msg.path ?? ''));
                sendResponse({ ok: true });
                return false;
            case 'adc:highlightPath':
                highlightPath(String(msg.path ?? ''));
                sendResponse({ ok: true });
                return false;
            case 'adc:selectAncestor':
                selectAncestor(Number(msg.index));
                sendResponse({ ok: true });
                return false;
            case 'adc:preview': {
                const n = previewSelector(
                    String(msg.selector ?? ''),
                    String(msg.action ?? 'hide'),
                    {
                        pattern: msg.pattern as RulePattern | undefined,
                        strict: !!msg.strict,
                        condition: msg.condition as RuleCondition | undefined,
                        parts: msg.parts as RulePart[] | undefined,
                    },
                );
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
                // 编辑已有规则：把它的目标元素重新选出来。
                // ⚠️ 条件规则不能只按 selector 选第一个 —— 第一个同类往往**不满足条件**
                //    （信息流前几张是普通卡片），锚点会选错，编辑区一个条件都复现不出来。
                const selStr = String(msg.selector ?? '');
                const pat = msg.pattern as RulePattern | undefined;
                try {
                    let el: Element | null = null;
                    if (pat) {
                        el = elementsMatchingRule({ selector: selStr, pattern: pat, strict: !!msg.strict })[0] ?? null;
                    }
                    if (!el) el = document.querySelector(selStr);
                    if (el) {
                        if (!picking) startPicker();
                        selectionOrigin = 'panel';
                        setSelected(el);
                        sendResponse({ ok: true, path: currentPathKey });
                    } else {
                        sendResponse({ ok: false, reason: 'not-found' });
                    }
                } catch {
                    sendResponse({ ok: false, reason: 'bad-selector' });
                }
                return false;
            }
            case 'adc:patternPaths': {
                // 编辑规则：把条件树每个节点对应的树路径找回来，并展开到它们
                const selector = String(msg.selector ?? '');
                const entries = patternPaths({
                    selector,
                    pattern: msg.pattern as RulePattern | undefined,
                    strict: !!msg.strict,
                });
                for (const e of entries) expandTo(pathOfKey(e.path));
                invalidateTree();
                sendResponse({ ok: true, entries, paths: entries.map((e) => e.path) });
                if (entries.length) notifyPanel();
                return false;
            }
            case 'adc:partPaths': {
                // 旧消息兼容：parts → 条件树
                const parts = Array.isArray(msg.parts) ? (msg.parts as RulePart[]) : [];
                const entries = patternPaths({ selector: parts[0]?.selector ?? '', parts });
                for (const e of entries) expandTo(pathOfKey(e.path));
                invalidateTree();
                sendResponse({ ok: true, entries, paths: entries.map((e) => e.path) });
                if (entries.length) notifyPanel();
                return false;
            }
            case 'adc:countAll': {
                const sels: string[] = Array.isArray(msg.selectors) ? msg.selectors : [];
                const counts = sels.map((x) => countMatches(x));
                sendResponse({ ok: true, counts });
                return false;
            }
            case 'adc:countRules': {
                // 条件/组合规则不能只按 selector 算，必须走真实匹配
                const list: MatchableRule[] = Array.isArray(msg.rules) ? msg.rules : [];
                const counts = list.map((r) =>
                    r && typeof r.selector === 'string' ? countRuleMatches(r) : -1,
                );
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
