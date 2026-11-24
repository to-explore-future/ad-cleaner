/** 拦截方式：隐藏（保留布局占位）或删除（从 DOM 移除）。 */
export type RuleAction = 'hide' | 'remove';

/**
 * 条件：光有选择器不够，还要"内部得有什么"才拦。
 *
 * 真实场景：信息流里所有卡片 class 都一样，
 * 只有广告卡片内部带一个「广告」角标。光按 class 拦会把整条信息流干掉。
 */
export interface RuleCondition {
    /** text = 内部包含这段文字；selector = 内部含有匹配这个选择器的元素 */
    type: 'text' | 'selector';
    value: string;
}

/** 一条拦截规则。 */
export interface BlockRule {
    id: string;
    /** 归属域名，例如 www.example.com（按 hostname 精确匹配） */
    domain: string;
    /** CSS 选择器 */
    selector: string;
    action: RuleAction;
    enabled: boolean;
    /** 给人看的短描述，例如 `div.ad-box` */
    label: string;
    /** 可选条件：命中选择器之后，还要满足这个条件才拦 */
    condition?: RuleCondition;
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

// ───────────────────────── 智能推断 ─────────────────────────

/** 一条候选"区分特征" */
export interface SmartCandidate {
    type: 'text' | 'selector';
    /** text 时是文字本身；selector 时是 `.className` */
    value: string;
    /** 这个特征在多少个同类元素里出现 */
    count: number;
    /** 是否命中内置广告词表（命中的排前面并标"推荐"） */
    recommended: boolean;
}

/** 「点一下广告」之后系统推断出来的结果 */
export interface SmartInference {
    /** 卡片的宽选择器，例如 div.floor-single-card */
    unitSelector: string;
    /** 同类卡片一共几个 */
    unitCount: number;
    /** 建议采用的条件（找到区分特征时才有） */
    condition: SmartCandidate | null;
    /** 所有候选特征（给「调整」用） */
    candidates: SmartCandidate[];
    /** 直接给用户看的一句话 */
    reason: string;
}
