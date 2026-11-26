/** 拦截方式：隐藏（保留布局占位）或删除（从 DOM 移除）。 */
export type RuleAction = 'hide' | 'remove';

/**
 * 规则条件：光有选择器不够，还要"内部得有什么"才拦。
 *
 * 真实场景：信息流里所有卡片 class 都一样，只有广告卡片内部带一个「广告」角标。
 * 光按 class 拦会把整条信息流干掉。
 */
export interface RuleCondition {
    /** text = 内部包含这段文字；selector = 内部含有匹配这个选择器的元素 */
    type: 'text' | 'selector';
    value: string;
}

/**
 * 组合标签规则的一段：某个选择器，位于上一段的**下方几层**。
 * parts[0].relDepth 恒为 0（锚点），后面都是相对上一段的层级差。
 */
export interface RulePart {
    selector: string;
    relDepth: number;
    /** 可选：这一段元素的文字必须包含这个内容（用来区分同类里的广告） */
    text?: string;
}

/**
 * 统一规则模型：锚点 + 条件树。
 *
 * 一条规则拦「锚点」，当它的子树满足 children 里的条件。
 * children 可以递归，所以"某个子标签里还要有某个标签/某段文字"能一直套下去。
 * strict 开关在整条规则上：关 = children 在任意层找；开 = 按 relDepth 精确匹配。
 */
export interface RulePattern {
    /** 这一层要匹配的 CSS 选择器；'*' 表示任意元素 */
    selector: string;
    /** 这一层的文本必须包含这段内容（包含所有后代的文字） */
    text?: string;
    /** 相对父层：正好往下第几层。strict=false 时忽略 */
    relDepth?: number;
    /** 子条件（默认全部满足） */
    children?: RulePattern[];
}

/** 一条拦截规则。 */
export interface BlockRule {
    id: string;
    /** 归属域名，例如 www.example.com（按 hostname 精确匹配） */
    domain: string;
    /** CSS 选择器（锚点） */
    selector: string;
    action: RuleAction;
    enabled: boolean;
    /** 给人看的短描述，例如 `div.ad-box` */
    label: string;
    /**
     * 全局唯一 id（跨用户 / 跨电脑），用于分享和统计。
     * 老规则没有时，面板加载会自动补齐并写回。
     */
    uid?: string;
    /** 用户起的名字；空则显示自动描述 */
    name?: string;
    /** 统一规则模型（新规则一定有；旧规则加载时自动迁移） */
    pattern?: RulePattern;
    /** 严格层级：true = children 按 relDepth 精确匹配；false/缺省 = 任意层 */
    strict?: boolean;
    /**
     * @deprecated 旧条件模型，加载时迁移到 pattern
     */
    condition?: RuleCondition;
    /**
     * @deprecated 旧组合模型，加载时迁移到 pattern
     */
    parts?: RulePart[];
    createdAt: number;
}

/** 全局设置。 */
export interface Settings {
    /**
     * 「显示拦截效果」开关（默认开）。
     *
     * 开着的时候，鼠标悬浮某条规则 → 页面把**会被这条规则命中的元素**给你看：
     *   · 规则没生效 → 实心高亮
     *   · 规则已生效（元素已被藏起来）→ 临时把它们显形出来（虚线框）
     *
     * 关掉 = 悬浮不预览，页面保持原样。
     */
    showEffect: boolean;
}

/** 元素在祖先链里的一条记录（面板右侧的树用它渲染）。 */
export interface ElementInfo {
    tag: string;
    id: string;
    classes: string[];
    width: number;
    height: number;
    /** 文本片段，帮助用户判断这层是什么 */
    text: string;
}
