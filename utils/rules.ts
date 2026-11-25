import type { BlockRule, RuleCondition, RulePart, RulePattern, Settings } from './types';

const RULES_KEY = 'blockRules';
const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = { showEffect: true };

// ───────────────────────── 统一规则模型 ─────────────────────────

/** 深拷贝一份条件树，避免面板和内容脚本共享可变对象。 */
function clonePattern(p: RulePattern): RulePattern {
    return {
        selector: p.selector,
        ...(p.text ? { text: p.text } : {}),
        ...(p.relDepth != null ? { relDepth: p.relDepth } : {}),
        ...(p.children && p.children.length ? { children: p.children.map(clonePattern) } : {}),
    };
}

/**
 * 把旧规则迁移成统一模型。
 *
 * - 普通规则：pattern = { selector }
 * - 旧条件规则：文字 → 锚点 text；内部元素 → 一个任意层的子条件
 * - 旧组合规则：parts 链 → 嵌套 children，strict = true
 *
 * 迁移在**读入时**做，存储里的旧数据不动；用户下次编辑保存时才写成新格式。
 */
export function normalizeRule(rule: BlockRule): BlockRule {
    const { condition, parts, ...rest } = rule;
    if (rest.pattern) {
        return { ...rest, strict: !!rest.strict, pattern: clonePattern(rest.pattern) };
    }

    let pattern: RulePattern = { selector: rule.selector };
    let strict = false;

    if (parts && parts.length > 0) {
        let cur: RulePattern = {
            selector: parts[0].selector,
            ...(parts[0].text ? { text: parts[0].text } : {}),
        };
        pattern = cur;
        for (let i = 1; i < parts.length; i++) {
            const p = parts[i];
            const child: RulePattern = {
                selector: p.selector,
                relDepth: Math.max(1, Math.round(p.relDepth || 1)),
                ...(p.text ? { text: p.text } : {}),
            };
            cur.children = [child];
            cur = child;
        }
        strict = true;
    } else if (condition) {
        if (condition.type === 'text') {
            pattern.text = condition.value;
        } else {
            pattern.children = [{ selector: condition.value }];
        }
    }

    return { ...rest, pattern, strict };
}

/** 这条规则是否必须走 JS 匹配（CSS 表达不了文字/条件树）。 */
export function isAdvancedPattern(rule: Pick<BlockRule, 'pattern'>): boolean {
    const p = rule.pattern;
    return !!p && (!!p.text || !!(p.children && p.children.length));
}

/** 给人看的一句话规则描述。 */
export function patternLabel(p: RulePattern, strict = false): string {
    const own = p.text ? `${p.selector} 含「${p.text}」` : p.selector;
    const kids = (p.children ?? []).map((c) => {
        const depth = strict ? `▸${c.relDepth ?? 1}` : '▸任意层';
        return `${depth}${patternLabel(c, strict)}`;
    });
    return kids.length ? `${own}（${kids.join('，')}）` : own;
}

/** 读全部规则（按域名分组）。 */
export async function loadAllRules(): Promise<Record<string, BlockRule[]>> {
    try {
        const got = await chrome.storage.local.get(RULES_KEY);
        return (got?.[RULES_KEY] as Record<string, BlockRule[]>) ?? {};
    } catch {
        return {};
    }
}

/** 读某个域名的规则。 */
export async function loadRulesFor(domain: string): Promise<BlockRule[]> {
    const all = await loadAllRules();
    return all[domain] ?? [];
}

/** 写回某个域名的规则列表。 */
async function writeRulesFor(domain: string, list: BlockRule[]): Promise<void> {
    const all = await loadAllRules();
    if (list.length === 0) delete all[domain];
    else all[domain] = list;
    await chrome.storage.local.set({ [RULES_KEY]: all });
}

/** 新增或更新一条规则（按 id 覆盖）。 */
export async function upsertRule(rule: BlockRule): Promise<void> {
    const list = await loadRulesFor(rule.domain);
    const i = list.findIndex((r) => r.id === rule.id);
    if (i >= 0) list[i] = rule;
    else list.push(rule);
    await writeRulesFor(rule.domain, list);
}

/** 删除一条规则。 */
export async function deleteRule(domain: string, id: string): Promise<void> {
    const list = await loadRulesFor(domain);
    await writeRulesFor(domain, list.filter((r) => r.id !== id));
}

/** 开关某条规则。 */
export async function setRuleEnabled(domain: string, id: string, enabled: boolean): Promise<void> {
    const list = await loadRulesFor(domain);
    const r = list.find((x) => x.id === id);
    if (!r) return;
    r.enabled = enabled;
    await writeRulesFor(domain, list);
}

/** 读设置。 */
export async function loadSettings(): Promise<Settings> {
    try {
        const got = await chrome.storage.local.get(SETTINGS_KEY);
        return { ...DEFAULT_SETTINGS, ...((got?.[SETTINGS_KEY] as Settings) ?? {}) };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

/** 写设置。 */
export async function saveSettings(s: Settings): Promise<void> {
    await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

/**
 * 把「隐藏类」规则拼成一段 CSS。
 *
 * ⚠️ 为什么用注入 `<style>` 而不是逐个 `style.display = 'none'`：
 *    1. 页面重新渲染（React/Vue 重挂载）后，改过 inline style 的节点会丢，注入的样式表不会；
 *    2. 一条选择器命中多个元素时，CSS 天然全管住；
 *    3. 预览时要**临时撤掉某一条**，改样式表文本比记住每个节点的原样式简单得多。
 */
export function buildHideCss(rules: BlockRule[], excludeSelector?: string): string {
    const sels = rules
        // 带文字/条件树的规则 CSS 表达不了，交给页面脚本处理
        .filter((r) => r.enabled && r.action === 'hide' && !isAdvancedPattern(r))
        .map((r) => r.selector)
        .filter((s) => s && s !== excludeSelector);
    if (sels.length === 0) return '';
    return sels.map((s) => `${s}{display:none !important}`).join('\n');
}

/** 生成一个不重复的规则 id。 */
export function newRuleId(): string {
    return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ───────────────────────── 导入 / 导出 ─────────────────────────

/** 导出文件的格式版本（以后字段变了靠它做兼容） */
export const EXPORT_FORMAT = 1;

export interface RulesExport {
    format: number;
    app: string;
    version: string;
    exportedAt: number;
    rules: Record<string, BlockRule[]>;
}

/** 打包所有规则，返回一个可以直接下载的 JSON 字符串。 */
export async function exportAllRules(appVersion: string): Promise<string> {
    const all = await loadAllRules();
    const payload: RulesExport = {
        format: EXPORT_FORMAT,
        app: '广告拦截助手',
        version: appVersion,
        exportedAt: Date.now(),
        rules: all,
    };
    return JSON.stringify(payload, null, 2);
}

/**
 * 校验导入文件里的条件。
 *
 * ⚠️ 这里以前直接丢掉 condition —— 导出的条件规则再导入就退化成
 *    "按 class 全拦"，会误伤整条信息流。宁可拒绝一条坏数据，也不能静默改语义。
 */
function sanitizeCondition(raw: unknown): RuleCondition | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const c = raw as Partial<RuleCondition>;
    if (c.type !== 'text' && c.type !== 'selector') return undefined;
    if (typeof c.value !== 'string' || !c.value) return undefined;
    return { type: c.type, value: c.value };
}

/** 校验组合规则的分段；任何一段不合法就整条不认（避免半条规则误拦）。 */
function sanitizeParts(raw: unknown): RulePart[] | undefined {
    if (!Array.isArray(raw) || raw.length < 2) return undefined;
    const out: RulePart[] = [];
    for (let i = 0; i < raw.length; i++) {
        const p = raw[i] as Partial<RulePart> | null;
        if (!p || typeof p.selector !== 'string' || !p.selector) return undefined;
        const relDepth = i === 0 ? 0 : Number(p.relDepth);
        if (!Number.isInteger(relDepth) || relDepth < 0) return undefined;
        out.push({
            selector: p.selector,
            relDepth,
            ...(typeof p.text === 'string' && p.text ? { text: p.text } : {}),
        });
    }
    return out;
}

/** 校验统一条件树；任何一层不合法就整条不认（避免半条规则误拦）。 */
function sanitizePattern(raw: unknown, depth = 0): RulePattern | undefined {
    if (!raw || typeof raw !== 'object' || depth > 12) return undefined;
    const p = raw as Partial<RulePattern>;
    if (typeof p.selector !== 'string' || !p.selector) return undefined;

    const text = typeof p.text === 'string' && p.text ? p.text.slice(0, 80) : undefined;

    let relDepth: number | undefined;
    if (p.relDepth != null) {
        const n = Number(p.relDepth);
        if (!Number.isInteger(n) || n < 1) return undefined;
        relDepth = n;
    }

    let children: RulePattern[] | undefined;
    if (Array.isArray(p.children) && p.children.length > 0) {
        if (p.children.length > 20) return undefined;
        children = [];
        for (const c of p.children) {
            const s = sanitizePattern(c, depth + 1);
            if (!s) return undefined;
            children.push(s);
        }
    }

    return {
        selector: p.selector,
        ...(text ? { text } : {}),
        ...(relDepth != null ? { relDepth } : {}),
        ...(children ? { children } : {}),
    };
}

/**
 * 合并时判断"是不是同一条规则"。
 *
 * 不能只看 selector：同一类卡片可以有一条"含广告"的条件规则和一条普通规则，
 * 只按 selector 合并会让它们互相覆盖。迁移后的完整条件树才是身份。
 */
function ruleIdentity(rule: BlockRule): string {
    const n = normalizeRule(rule);
    return JSON.stringify({ p: n.pattern, s: !!n.strict });
}

/**
 * 导入规则。
 *
 * 合并策略：**条件、选择器、组合结构都相同**的视为同一条，以导入的为准；
 * 其余全部追加。不覆盖、不清空本地已有的东西 —— 用户最怕"导个文件把原来的弄没了"。
 */
export async function importRules(text: string): Promise<{ added: number; updated: number; domains: number }> {
    const parsed = JSON.parse(text) as Partial<RulesExport>;
    if (!parsed || typeof parsed !== 'object' || !parsed.rules || typeof parsed.rules !== 'object') {
        throw new Error('文件格式不对：不是广告拦截助手的规则文件');
    }
    if (parsed.format != null && parsed.format > EXPORT_FORMAT) {
        throw new Error('这个文件来自更新版本的扩展，请先升级');
    }

    const all = await loadAllRules();
    let added = 0;
    let updated = 0;

    for (const [domain, list] of Object.entries(parsed.rules)) {
        if (!Array.isArray(list)) continue;
        const existing = all[domain] ?? [];
        for (const r of list) {
            const pattern = sanitizePattern(r.pattern);
            const selector = typeof r.selector === 'string' && r.selector
                ? r.selector
                : pattern?.selector ?? '';
            if (!selector) continue;
            const condition = sanitizeCondition(r.condition);
            const parts = sanitizeParts(r.parts);
            const base: BlockRule = {
                id: r.id || newRuleId(),
                domain,
                selector,
                action: r.action === 'remove' ? 'remove' : 'hide',
                enabled: r.enabled !== false,
                label: r.label || selector,
                createdAt: r.createdAt || Date.now(),
                ...(condition ? { condition } : {}),
                ...(parts ? { parts } : {}),
                ...(pattern ? { pattern } : {}),
                strict: !!r.strict,
            };
            // 旧格式（condition/parts）在这里统一迁移成 pattern
            const rule = normalizeRule(base);
            const key = ruleIdentity(rule);
            const i = existing.findIndex((x) => ruleIdentity(x) === key);
            if (i >= 0) {
                existing[i] = rule;
                updated++;
            } else {
                existing.push(rule);
                added++;
            }
        }
        if (existing.length) all[domain] = existing;
    }

    await chrome.storage.local.set({ [RULES_KEY]: all });
    return { added, updated, domains: Object.keys(parsed.rules).length };
}

/** 规则的语法写法（给用户看，以后分享也用这个格式）。 */
export function ruleToSyntax(rule: BlockRule): string {
    const n = normalizeRule(rule);
    if (!n.pattern) return `${n.domain}##${n.selector}`;
    return `${n.domain}##${patternLabel(n.pattern, !!n.strict)}`;
}

/** 规则的一句话描述（列表里显示）。 */
export function ruleToLabel(rule: BlockRule): string {
    const n = normalizeRule(rule);
    if (n.pattern && (n.pattern.text || (n.pattern.children && n.pattern.children.length))) {
        return patternLabel(n.pattern, !!n.strict);
    }
    return n.label || n.selector;
}
