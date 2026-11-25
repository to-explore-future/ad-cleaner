import type { BlockRule, RuleCondition, RulePart, Settings } from './types';

const RULES_KEY = 'blockRules';
const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = { showEffect: true };

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
        // 带条件的规则 CSS 表达不了（CSS 没有"包含文字"），交给页面脚本处理
        // 带条件 / 组合标签的规则 CSS 表达不了，交给页面脚本处理
        .filter((r) => r.enabled && r.action === 'hide' && !r.condition && !r.parts)
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

/**
 * 合并时判断"是不是同一条规则"。
 *
 * 不能只看 selector：同一类卡片可以有一条"含广告"的条件规则和一条普通规则，
 * 只按 selector 合并会让它们互相覆盖。条件 + 组合都要算进身份。
 */
function ruleIdentity(rule: Pick<BlockRule, 'selector' | 'condition' | 'parts'>): string {
    return [
        rule.selector,
        rule.condition ? `${rule.condition.type}:${rule.condition.value}` : '',
        rule.parts ? JSON.stringify(rule.parts) : '',
    ].join('\u0000');
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
            if (!r || typeof r.selector !== 'string' || !r.selector) continue;
            const condition = sanitizeCondition(r.condition);
            const parts = sanitizeParts(r.parts);
            const rule: BlockRule = {
                id: r.id || newRuleId(),
                domain,
                selector: r.selector,
                action: r.action === 'remove' ? 'remove' : 'hide',
                enabled: r.enabled !== false,
                label: r.label || r.selector,
                createdAt: r.createdAt || Date.now(),
                ...(condition ? { condition } : {}),
                ...(parts ? { parts } : {}),
            };
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
    const base = `${rule.domain}##${rule.selector}`;
    if (!rule.condition) return base;
    return rule.condition.type === 'text'
        ? `${rule.selector}|text("${rule.condition.value}")`
        : `${rule.selector}|has(${rule.condition.value})`;
}

/** 规则的一句话描述（列表里显示）。 */
export function ruleToLabel(rule: BlockRule): string {
    if (!rule.condition) return rule.label || rule.selector;
    const what = rule.condition.type === 'text'
        ? `含「${rule.condition.value}」`
        : `含 ${rule.condition.value}`;
    return `${rule.label || rule.selector} ${what}`;
}
