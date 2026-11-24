/**
 * 版本进度与未来计划 —— 直接显示在扩展的「关于」页里。
 *
 * 为什么写在代码里而不是外部文档：用户装了扩展之后，
 * 想知道"这玩意儿更新到哪了""以后会有什么"，不该去翻 GitHub。
 */

export interface VersionEntry {
    version: string;
    date: string;
    items: string[];
    /** 还没发布 → 界面上标「计划中」 */
    planned?: boolean;
}

/** 已发布 + 正在开发中的版本（从新到旧） */
export const CHANGELOG: VersionEntry[] = [
    {
        version: '0.0.1',
        date: '首个版本',
        items: [
            '像 F12 一样在页面上点选元素，点一下锁定，再点一下取消',
            '右侧显示 DOM 祖先链，点上级可以把选中范围往外扩一层',
            '同类元素一起标出来，默认按 class 拦截（知道这一刀砍几块）',
            '隐藏 / 删除两种拦截方式',
            '预览效果：按下去之前先看拦完长什么样',
            '规则按域名保存，可开关、编辑、删除',
            '悬浮规则可预览它影响的所有元素（已生效的会临时显形）',
            '规则可导出成文件 / 从文件导入',
        ],
    },
];

/** 未来计划（还没做） */
export const ROADMAP: VersionEntry[] = [
    {
        version: '0.1.0',
        date: '计划中',
        planned: true,
        items: [
            '规则分享：把自己调好的规则一键分享给别人',
            '规则导入：扫别人的分享码，直接套用',
        ],
    },
    {
        version: '0.2.0',
        date: '计划中',
        planned: true,
        items: [
            '规则热度：这条规则被多少人用过、有多少人还在用',
            '按站点看热门规则，不用自己一个个点',
        ],
    },
    {
        version: '1.0.0',
        date: '计划中',
        planned: true,
        items: [
            '适配 Edge / Firefox',
            '支持 iframe 里的广告',
            '拦截统计：这个站点一共帮你挡掉多少东西',
        ],
    },
];
