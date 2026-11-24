import type { ElementInfo } from './types';

/**
 * 我们自己往元素上加的标记类（高亮/同类）。
 * ⚠️ 这些绝不能被当成"元素的类名"显示给用户，也不能写进选择器 ——
 *    否则用户会看到 `img.__adc_match`，而且规则会依赖这些临时类。
 */
function isOurMarkerClass(name: string): boolean {
    return name.startsWith('__adc_');
}

/** 看起来像构建工具生成的无意义类名（CSS-in-JS / 哈希），选它容易失效。 */
function isHashyClass(name: string): boolean {
    if (name.length < 2) return true;
    // css-1x2y3z / sc-bdVaJa / jsx-123456 / _a1b2c
    if (/^(css|sc|jsx|emotion|svelte|styled)[-_]/i.test(name)) return true;
    // 纯哈希：包含数字且长度 > 6，或者全是大小写随机混合
    if (/\d/.test(name) && name.length > 6) return true;
    return false;
}

function cssEscape(s: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/** 这个选择器现在能选中几个元素（可能是 0、1、多）。 */
export function countMatches(selector: string): number {
    if (!selector) return 0;
    try {
        return document.querySelectorAll(selector).length;
    } catch {
        return -1; // 选择器语法错误
    }
}

/**
 * 给一个元素生成**尽量短、且能唯一定位它**的 CSS 选择器。
 *
 * 策略（从短到长）：
 *   1. `#id`（且 id 看起来是人起的，不是哈希）
 *   2. `tag.class1.class2`（逐步加祖先）
 *   3. 同名兄弟多的时候补 `:nth-of-type(n)`
 *
 * ⚠️ 唯一性用 `document.querySelectorAll(...).length === 1` 实测，
 *    而不是靠推断 —— 页面上的 DOM 结构千奇百怪，只有实测才靠谱。
 */
export function buildSelector(el: Element): string {
    const doc = el.ownerDocument;

    // 1) 唯一 id
    if (el.id && !/\d{6,}/.test(el.id)) {
        const sel = `#${cssEscape(el.id)}`;
        try {
            if (doc.querySelectorAll(sel).length === 1) return sel;
        } catch { /* 忽略非法 id */ }
    }

    // 2~3) 自底向上拼路径
    const parts: string[] = [];
    let cur: Element | null = el;

    const unique = (sel: string): boolean => {
        try {
            return doc.querySelectorAll(sel).length === 1;
        } catch {
            return false;
        }
    };

    while (cur && cur.nodeType === 1 && cur !== doc.documentElement) {
        const tag = cur.tagName.toLowerCase();
        const goodClasses = Array.from(cur.classList)
            .filter((c) => !isHashyClass(c) && !isOurMarkerClass(c))
            .slice(0, 2);
        const classPart = tag + goodClasses.map((c) => `.${cssEscape(c)}`).join('');

        const parent: Element | null = cur.parentElement;

        /**
         * ⚠️ 顺序很重要：**先试不带位置的选择器**。
         *
         *    如果一上来就加 `:nth-of-type(2)`，会得到
         *    `div.ad-box:nth-of-type(2)` —— 看着也能用，但页面结构一变就失效。
         *    `div.ad-box` 才是可维护的写法（类名通常比位置稳定）。
         *    只有"同类兄弟只有一个类名信息不够用"时，才退回带位置的写法。
         */
        const byClass = [...parts, classPart].join(' > ');
        if (unique(byClass)) return byClass;

        if (parent) {
            const sameTag = Array.from(parent.children).filter(
                (c) => c.tagName === cur!.tagName,
            );
            if (sameTag.length > 1) {
                const withNth = `${classPart}:nth-of-type(${sameTag.indexOf(cur) + 1})`;
                const byPos = [...parts, withNth].join(' > ');
                if (unique(byPos)) return byPos;
                parts.unshift(withNth);
                cur = parent;
                continue;
            }
        }

        parts.unshift(classPart);
        cur = parent;
    }

    return parts.join(' > ');
}

/** 这个元素在它自己的祖先链里的深度（html 为 0）。 */
export function depthOf(el: Element): number {
    let d = 0;
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
        d++;
        cur = cur.parentElement;
    }
    return d;
}

/** 把一个元素压缩成面板要显示的一条记录。 */
export function describeElement(el: Element): ElementInfo {
    const r = el.getBoundingClientRect();
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return {
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        classes: Array.from(el.classList).filter((c) => !isOurMarkerClass(c)).slice(0, 6),
        width: Math.round(r.width),
        height: Math.round(r.height),
        text,
    };
}

/**
 * 从某个元素往上取**整条祖先链**（根 → 元素自身）。
 *
 * 面板右侧的树就是这条链。用户点哪一层，选中的就是哪一层 ——
 * 这就是"能往外扩"的实现：不必在页面上操作，直接点树里的祖先。
 */
export function ancestorChain(el: Element): Element[] {
    const chain: Element[] = [];
    let cur: Element | null = el;
    while (cur && cur.nodeType === 1) {
        chain.unshift(cur);
        cur = cur.parentElement;
    }
    return chain;
}

/**
 * 生成"这一类元素"的宽选择器（**不要求唯一**）。
 *
 * 用途：用户指着一个卡片时，页面上要把**所有长得一样的卡片**都标出来 ——
 * 这样他一眼就看见"我这一刀下去会砍掉 12 块"，而不是闷头砍一个。
 * （这是这个插件相对 Adblock Plus 的核心差异点。）
 *
 * 优先类名；元素自己没有可用类名时，退一步用"父级类名 > tag"。
 */
export function buildBroadSelector(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList)
        .filter((c) => !isHashyClass(c) && !isOurMarkerClass(c));

    /**
     * ⚠️ 关键：**先用单个 class 试**，不要一上来就拼两个。
     *
     *    之前取前两个类拼成 `div.floor-single-card.floor-card`，
     *    结果这个组合在 B 站首页只有一个元素 —— 同类数量算成 1，
     *    用户以为"没法按 class 拦"。
     *    其实只用 `div.floor-single-card` 就能命中整片卡片（几十个）。
     *
     *    顺序：从"更具体"到"更宽"都试一遍，选第一个命中数在合理区间的。
     */
    const candidates: string[] = [];
    for (const c of classes.slice(0, 3)) {
        candidates.push(`${tag}.${cssEscape(c)}`);
        candidates.push(`.${cssEscape(c)}`);
    }
    if (classes.length >= 2) {
        candidates.push(`${tag}.${cssEscape(classes[0])}.${cssEscape(classes[1])}`);
    }

    // 命中 2~300 个 → 这就是"这一类"；都没有就用第一个候选（哪怕只有一个）
    for (const sel of candidates) {
        const n = countMatches(sel);
        if (n >= 2 && n <= 300) return sel;
    }
    if (candidates.length > 0) return candidates[0];

    // 自己没有可用类名 → 退一步用"父级类名 > tag"
    const parent = el.parentElement;
    if (parent && parent !== document.documentElement) {
        const pt = parent.tagName.toLowerCase();
        const pc = Array.from(parent.classList).filter((c) => !isHashyClass(c) && !isOurMarkerClass(c)).slice(0, 2);
        if (pc.length) return `${pt}${pc.map((c) => `.${cssEscape(c)}`).join('')} > ${tag}`;
    }
    return tag;
}
