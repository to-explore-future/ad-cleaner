<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
    deleteRule, ensureRuleUids, exportAllRules, importRules, loadRulesFor, loadSettings,
    newRuleId, newRuleUid, normalizeRule, patternLabel, ruleDisplayName, ruleToLabel,
    saveSettings, setRuleEnabled, upsertRule,
} from '@/utils/rules';
import type { BlockRule, ElementInfo, RulePattern, Settings } from '@/utils/types';

// ───────────────────────── 状态 ─────────────────────────

const tabId = ref<number | null>(null);
const pageUrl = ref('');
const domain = ref('');
const rules = ref<BlockRule[]>([]);
/** 每条规则当前在页面上命中几个元素（0 = 已经匹配不到了） */
const counts = ref<Record<string, number>>({});
/** 命中数是否已经问回来了（没回来之前先别过滤，免得列表闪空） */
const countsReady = ref(false);

/**
 * 规则列表看哪一批：
 *   page → **默认**：只看这个网页上真正命中的规则（命中数 > 0）
 *   site → 这个网站的全部规则（包括当前页面用不到的）
 */
const ruleFilter = ref<'page' | 'site'>('page');

/** 当前该显示的规则 */
const visibleRules = computed(() => {
    if (ruleFilter.value === 'site' || !countsReady.value) return rules.value;
    // 命中数未知（-1，消息刚失败/页面还在加载）时不要藏规则；
    // 只有明确算出 0 才归到「本页没有」——不然刚保存的规则会瞬间消失。
    return rules.value.filter((r) => {
        const c = counts.value[r.id];
        return c == null || c !== 0;
    });
});

/** 本页命中了几条（给标签上的数字用） */
const pageHitCount = computed(() =>
    rules.value.filter((r) => (counts.value[r.id] ?? 0) > 0).length,
);
const settings = ref<Settings>({ showEffect: true });

/** 选择模式 */
const picking = ref(false);
const editingId = ref<string | null>(null);
/** 完整 DOM 树（扁平化后的一串节点） */
type TreeRow = { path: string; depth: number; tag: string; id: string; classes: string[]; hasChildren: boolean; expanded: boolean; current: boolean; text: string; html: string };
const tree = ref<TreeRow[]>([]);
const currentPath = ref('');
/** 树里的源码是否换行显示（不换行时一行截断） */
const wrapSource = ref(true);
/**
 * 鼠标正停在哪个"多行"的节点上。
 * 不预测量整棵树（尺寸一变就不准），而是在悬浮那一刻**当场量这一行**：
 *   行高 > 26px 才算多行 → 才显示「折叠该行」。
 * 单行的行永远不显示这个按钮。
 */
const hoverMultiPath = ref<string | null>(null);
/** 被折叠成单行的节点 */
const foldedRows = ref<Set<string>>(new Set());

/** 悬浮到某一行：当场量它是不是多行 */
async function onRowEnter(path: string): Promise<void> {
    await nextTick();
    // 已折叠的行要能再展开：它现在是单行，但按钮必须还在
    if (foldedRows.value.has(path)) {
        hoverMultiPath.value = path;
        return;
    }
    const row = treeEl.value?.querySelector(`.row[data-path="${path}"]`) as HTMLElement | null;
    const nameEl = row?.querySelector('.name') as HTMLElement | null;
    if (!nameEl) {
        hoverMultiPath.value = null;
        return;
    }
    /**
     * 数真正折了几行：用 Range 拿到文本的每一行矩形，按 top 去重。
     * 量的是整行 `.name`（源码 + 文字），不是只量 `.html` ——
     * 文字被挤到第二行时也算多行。
     */
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const tops = new Set<number>();
    for (const r of Array.from(range.getClientRects())) {
        if (r.width <= 0 || r.height <= 0) continue;
        tops.add(Math.round(r.top));
    }
    hoverMultiPath.value = tops.size > 1 ? path : null;
    range.detach?.();
}

/** 鼠标离开这一行 → 收起按钮（移到行内的按钮上不算离开） */
function onRowLeave(path: string): void {
    if (hoverMultiPath.value === path) hoverMultiPath.value = null;
}

function toggleFold(path: string): void {
    const next = new Set(foldedRows.value);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    foldedRows.value = next;
}

/** 树是否需要刷新（用户自己点展开/选节点时才置 true，用一次就清） */
const allowTreeUpdate = ref(false);
function markTreeUpdate(): void {
    allowTreeUpdate.value = true;
}

/** 组合规则里勾选的标签（路径集合） */
const checkedPaths = ref<Set<string>>(new Set());
const currentIndex = ref(-1);
const selector = ref('');
const matchCount = ref(0);

/**
 * 「加条件」：让规则更精细 —— 命中这个选择器、**并且**内部包含某个东西才拦。
 *   条件选法：点「+ 加条件」→ 去页面上点那个能区分广告的东西 → 挑一个候选
 */
/** 正在等用户去页面上点条件 */
const condPicking = ref(false);
/** 点完之后算出来的候选 */
const condCandidates = ref<{ type: 'text' | 'selector'; value: string; count: number }[]>([]);
const condTotal = ref(0);
/** 这次要用的拦截方式（隐藏 / 删除） */
const pickAction = ref<'hide' | 'remove'>('hide');

/**
 * 拦截范围：
 *   · one   → 只拦选中的这一个（精确选择器）
 *   · broad → 拦所有同类（宽选择器，通常就是"这一类卡片全干掉"）
 *
 * 默认只拦一个。但页面上**始终**把同类都虚线标出来，
 * 让用户知道"如果切到同类，会波及多少"。
 */
const pickScope = ref<'one' | 'broad'>('one');
/** 用户是否手动点过范围按钮（点过就不再自动切） */
const scopeTouched = ref(false);
/** 这次选择里是否已经自动切过一次「同类」 */
const autoScoped = ref(false);
/** 同类元素的宽选择器和数量（由内容脚本算好送过来） */
const broadSelector = ref('');
const broadCount = ref(0);
/** 是否正在「预览效果」 */
const previewing = ref(false);

/** 最终要保存的选择器 / 会命中几个 */
const finalSelector = computed(() => (pickScope.value === 'broad' ? broadSelector.value : selector.value));
const finalCount = computed(() => (pickScope.value === 'broad' ? broadCount.value : matchCount.value));

/** 当前扩展版本（从 manifest 里读，永不写死） */
const fileInput = ref<HTMLInputElement | null>(null);

const toast = ref('');
let toastTimer: number | null = null;
function showToast(msg: string): void {
    toast.value = msg;
    if (toastTimer != null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.value = ''; }, 2200);
}

const canWork = computed(() => !!domain.value && tabId.value != null);
/** 当前选中的树节点 */
const currentNode = computed(() => tree.value.find((n) => n.current) ?? null);

/** 当前选中那层的短标签，例如 `div.ad-box` */
const currentLabel = computed(() => {
    const n = currentNode.value;
    if (!n) return '';
    return n.classes.length ? `${n.tag}.${n.classes[0]}` : n.tag;
});

// ───────────────────────── 与页面通信 ─────────────────────────

async function sendToTab<T = { ok: boolean }>(msg: unknown): Promise<T | null> {
    if (tabId.value == null) return null;
    try {
        return (await chrome.tabs.sendMessage(tabId.value, msg)) as T;
    } catch {
        // 内容脚本没注入（浏览器内部页 / 页面加载早于安装扩展）
        return null;
    }
}

/**
 * 发消息；如果内容脚本不在，**手动注入一次**再发。
 *
 * 场景：用户先开着页面、后装的扩展 —— 那个页面里没有我们的脚本，
 * 直接发消息会失败，用户点了按钮看起来"毫无反应"。
 */
async function sendToTabOrInject<T = { ok: boolean }>(msg: unknown): Promise<T | null> {
    const first = await sendToTab<T>(msg);
    if (first != null) return first;
    if (tabId.value == null) return null;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId.value },
            files: ['content-scripts/picker.js'],
        });
        await new Promise((r) => setTimeout(r, 250));
        return await sendToTab<T>(msg);
    } catch {
        return null;
    }
}

function domainOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

/**
 * 找出"用户正在看的那个网页标签"。
 *
 * ⚠️ 为什么这么绕：去掉 `tabs` 权限之后，`tab.url` 在**某些情况下会拿不到**
 *    （表现为面板显示"当前页面不可用"）。所以：
 *      ① 先按 url 判断，能判断就直接用
 *      ② 判断不了就**问那个页面自己**（内容脚本回 `location.href`）
 *    另外侧边栏里 `currentWindow` 不一定靠谱，要多级兜底。
 */
async function resolveActiveTab(): Promise<chrome.tabs.Tab | undefined> {
    const forced = new URLSearchParams(location.search).get('tabId');
    if (forced) {
        const t = await chrome.tabs.get(Number(forced)).catch(() => undefined);
        if (t) return t;
    }

    const isExt = (t?: chrome.tabs.Tab) => !!t?.url?.startsWith('chrome-extension://');
    const candidates: chrome.tabs.Tab[] = [];

    for (const q of [
        { active: true, currentWindow: true },
        { active: true, lastFocusedWindow: true },
    ] as const) {
        try {
            candidates.push(...(await chrome.tabs.query(q)));
        } catch { /* 某些上下文会拒绝，忽略 */ }
    }
    try {
        candidates.push(
            ...(await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url ?? '')),
        );
    } catch { /* 忽略 */ }

    for (const t of candidates) {
        if (!t || t.id == null || isExt(t)) continue;
        if (t.url) return t;
        // url 不可见 → 直接问那个页面
        try {
            const info = await chrome.tabs.sendMessage(t.id, { type: 'adc:whoami' }) as
                { ok?: boolean; url?: string } | undefined;
            if (info?.url && /^https?:/i.test(info.url)) {
                return { ...t, url: info.url };
            }
        } catch { /* 这个标签里没有我们的脚本，换下一个 */ }
    }
    return undefined;
}

async function loadPage(): Promise<void> {
    try {
        const tab = await resolveActiveTab();
        tabId.value = tab?.id ?? null;
        pageUrl.value = tab?.url ?? '';
        domain.value = domainOf(pageUrl.value);
        settings.value = await loadSettings();
        await ensureRuleUids();
        rules.value = canWork.value ? (await loadRulesFor(domain.value)).map(normalizeRule) : [];
        await refreshCounts();
    } catch (e) {
        console.warn('[广告拦截助手] 读取当前页面失败', e);
    }
}

/** 每次查询的代号：晚返回的旧查询不许覆盖新结果 */
let countGen = 0;

/** 问页面：这些选择器各命中几个元素。 */
async function refreshCounts(): Promise<void> {
    const gen = ++countGen;
    countsReady.value = false;
    if (!canWork.value || rules.value.length === 0) {
        counts.value = {};
        countsReady.value = true;
        return;
    }
    /**
     * ⚠️ 用 sendToTabOrInject：换了新版本之后，**已经打开的页面里还是旧脚本**
     *    （上下文已失效），直接发消息会失败 —— 表现就是命中数全是「—」。
     *    这里发不通就自动补注入一次，用户不用手动刷新。
     *
     * ⚠️ 不能只发 selector：条件/组合规则的真实命中范围比 selector 小，
     *    只按 selector 算会把"只拦 2 个广告"显示成 6。
     */
    const res = await sendToTabOrInject<{ ok: boolean; counts: number[] }>({
        type: 'adc:countRules',
        rules: rules.value.map((r) => ({
            selector: r.selector,
            pattern: r.pattern,
            strict: !!r.strict,
        })),
    });
    // 期间规则又变了（比如刚保存一条）→ 这份结果已经过期，丢掉
    if (gen !== countGen) return;
    const out: Record<string, number> = {};
    rules.value.forEach((r, i) => {
        out[r.id] = res?.counts?.[i] ?? -1;
    });
    counts.value = out;
    countsReady.value = true;
}

// ───────────────────────── 规则操作 ─────────────────────────

async function refreshRules(): Promise<void> {
    await ensureRuleUids();
    rules.value = canWork.value ? (await loadRulesFor(domain.value)).map(normalizeRule) : [];
    // 规则变了必须重算命中数：否则新规则 id 不在 counts 里，会被"本页"过滤掉
    await refreshCounts();
}

async function onToggle(rule: BlockRule): Promise<void> {
    rule.enabled = !rule.enabled;
    await setRuleEnabled(domain.value, rule.id, rule.enabled);
    await sendToTab({ type: 'adc:reapply' });
    await refreshRules();
    showToast(rule.enabled ? '已启用' : '已停用，刷新后可见');
}

async function onDelete(rule: BlockRule): Promise<void> {
    await deleteRule(domain.value, rule.id);
    await sendToTab({ type: 'adc:reapply' });
    await refreshRules();
    showToast('已删除');
}

// ───────────────────────── 规则命名 / UID ─────────────────────────

/** 正在内联改名的规则 id（空 = 没有） */
const renamingId = ref('');
const renameDraft = ref('');

/** 点规则名 → 变成输入框；空名字保存后回到自动描述 */
function beginRename(rule: BlockRule): void {
    renamingId.value = rule.id;
    renameDraft.value = rule.name ?? '';
    void nextTick(() => {
        const el = document.querySelector<HTMLInputElement>('.rule-name-input');
        el?.focus();
        el?.select();
    });
}

function cancelRename(): void {
    renamingId.value = '';
    renameDraft.value = '';
}

async function commitRename(rule: BlockRule): Promise<void> {
    if (renamingId.value !== rule.id) return;
    const name = renameDraft.value.trim().slice(0, 40);
    renamingId.value = '';
    renameDraft.value = '';
    if (name === (rule.name ?? '')) return;
    await upsertRule({ ...rule, uid: rule.uid || newRuleUid(), name: name || undefined });
    await refreshRules();
    showToast(name ? '已改名' : '已恢复自动描述');
}

/** 悬浮规则 → 页面上标出它会影响哪些元素 */
async function onHoverRule(rule: BlockRule): Promise<void> {
    if (!settings.value.showEffect) return;
    const res = await sendToTab<{ ok: boolean; count: number }>({
        type: 'adc:preview',
        selector: rule.selector,
        action: rule.action,
        pattern: rule.pattern,
        strict: !!rule.strict,
    });
    if (res && res.count === -1) {
        showToast(rule.action === 'remove' ? '删除类规则无法预览' : '选择器已失效');
    }
}

function onLeaveRule(): void {
    void sendToTab({ type: 'adc:clearPreview' });
}

async function onToggleEffect(): Promise<void> {
    settings.value = { ...settings.value, showEffect: !settings.value.showEffect };
    await saveSettings(settings.value);
    showToast(settings.value.showEffect ? '悬浮规则可预览影响范围' : '已关闭预览');
}

/**
 * 弹出成独立窗口。
 *
 * 侧边栏太窄，组合规则这种要多行输入的活根本铺不开；
 * 弹成窗口后可以自己拖大（F12 的分离模式也是这个道理）。
 * 带上 ?tabId= 让窗口锁定在同一个页面，不然弹窗里
 * currentWindow 是它自己，找不到该操作哪个标签页。
 */
async function popOut(): Promise<void> {
    const url =
        chrome.runtime.getURL('sidepanel.html') + (tabId.value != null ? `?tabId=${tabId.value}` : '');
    await chrome.windows.create({ url, type: 'popup', width: 430, height: 780 });
    window.close();
}

/** 打开产品介绍页（关于 / 版本进度都在那里）。 */
function openHomepage(): void {
    void chrome.tabs.create({ url: 'https://tianrunye.com/adcleaner' });
}

// ───────────────────────── 「加条件」 ─────────────────────────

async function startCondPick(): Promise<void> {
    const sel = finalSelector.value;
    if (!sel) {
        showToast('先选中要拦的东西');
        return;
    }
    condCandidates.value = [];
    condTotal.value = 0;
    const res = await sendToTabOrInject<{ ok: boolean }>({ type: 'adc:startCondPick', selector: sel });
    if (!res?.ok) {
        showToast('这个页面里跑不起来，刷新一下再试');
        return;
    }
    condPicking.value = true;
}

function pickCondition(c: { type: 'text' | 'selector'; value: string }): void {
    condPicking.value = false;
    condCandidates.value = [];
    if (c.type === 'text') {
        // 文字候选 = 锚点子树里出现这段字（偷懒模式）
        anchorText.value = c.value;
    } else {
        // 元素候选 = 锚点内部要有这个元素（可再切严格层级）
        manualConditions.value = [...manualConditions.value, { selector: c.value, relDepth: 1 }];
    }
    void refreshDraftCount();
}

function clearCondition(): void {
    condPicking.value = false;
    condCandidates.value = [];
    anchorText.value = '';
    manualConditions.value = [];
    void sendToTab({ type: 'adc:clearCondition' });
    void refreshDraftCount();
}

// ───────────────────────── 导入 / 导出 ─────────────────────────

/** 导出所有规则成 .json 文件 */
async function onExport(): Promise<void> {
    try {
        const text = await exportAllRules(chrome.runtime.getManifest().version);
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `广告拦截助手-规则-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast('已导出');
    } catch (e) {
        showToast('导出失败：' + (e instanceof Error ? e.message : String(e)));
    }
}

/** 触发隐藏的文件选择器 */
function triggerImport(): void {
    fileInput.value?.click();
}

/** 从文件导入规则 */
async function onImport(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
        const text = await file.text();
        const r = await importRules(text);
        await refreshRules();
        await sendToTab({ type: 'adc:reapply' });
        showToast(`导入完成：新增 ${r.added} 条，更新 ${r.updated} 条`);
    } catch (e) {
        showToast('导入失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
        input.value = '';
    }
}

// ───────────────────────── 选择模式 ─────────────────────────

async function startPick(): Promise<void> {
    const res = await sendToTabOrInject<{ ok: boolean }>({ type: 'adc:startPicker' });
    if (!res?.ok) {
        showToast('这个页面里跑不起来，刷新一下页面再试（浏览器内部页面无法操作）');
        return;
    }
    editingId.value = null;
    pickAction.value = 'hide';
    condPicking.value = false;
    condCandidates.value = [];
    pickScope.value = 'one';
    previewing.value = false;
    scopeTouched.value = false;
    autoScoped.value = false;
    broadSelector.value = '';
    broadCount.value = 0;
    picking.value = true;
    startPolling();
    tree.value = [];
    currentPath.value = '';
    allowTreeUpdate.value = false;
    selector.value = '';
    matchCount.value = 0;
    clearComposition();
    editRootSelector.value = '';
    editAnchorPath.value = '';
    nameText.value = '';
    // 新一次选择：重新记基线，别把上一次的页面点选当成新的
    centerToken++;
}

async function startEdit(rule: BlockRule): Promise<void> {
    editingId.value = rule.id;
    pickAction.value = rule.action;
    previewing.value = false;
    pickScope.value = 'one';
    scopeTouched.value = false;
    autoScoped.value = false;
    broadSelector.value = '';
    broadCount.value = 0;
    picking.value = true;
    startPolling();
    tree.value = [];
    currentPath.value = '';
    allowTreeUpdate.value = false;
    selector.value = '';
    matchCount.value = 0;
    // 重新编辑时先清空上一次的条件；编辑是右侧操作，不居中
    clearComposition();
    editRootSelector.value = rule.selector;
    editAnchorPath.value = '';
    nameText.value = rule.name ?? '';
    centerToken++;

    const res = await sendToTabOrInject<{ ok: boolean; path?: string }>({
        type: 'adc:selectBySelector',
        selector: rule.selector,
        pattern: rule.pattern,
        strict: !!rule.strict,
    });
    if (!res?.ok) {
        showToast('页面上已找不到这条规则的目标，请重新选一个');
        return;
    }
    editAnchorPath.value = res.path ?? '';

    const pattern = rule.pattern;
    if (!pattern || (!pattern.text && !(pattern.children && pattern.children.length))) return;

    /** 恢复严格开关 / 锚点文字 / 每个条件的勾选和文字 */
    strictMode.value = !!rule.strict;
    anchorText.value = pattern.text ?? '';
    markTreeUpdate();
    const pp = await sendToTab<{ ok: boolean; entries: { path: string; text: string }[] }>({
        type: 'adc:patternPaths',
        selector: rule.selector,
        pattern,
        strict: !!rule.strict,
    });
    if (!pp?.ok || !pp.entries?.length) {
        showToast('这条规则在页面上已经对不上了，请重新勾选');
        return;
    }

    const children = patternChildren(pattern);
    // ⚠️ 根节点也要勾上：锚点 = 勾选里最外层那一行；不勾根的话编辑时会被当成"没有锚点"
    editAnchorPath.value = pp.entries[0].path;
    checkedPaths.value = new Set(pp.entries.map((e) => e.path));
    const entries = pp.entries.slice(1);
    const texts: Record<string, string> = {};
    const depths: Record<string, number> = {};
    entries.forEach((e, i) => {
        texts[e.path] = e.text ?? '';
        depths[e.path] = Math.max(1, children[i]?.relDepth ?? 1);
    });
    textByPath.value = texts;
    relDepthByPath.value = depths;
    markTreeUpdate();
}

/** 条件树的先序（不含锚点本身），和 adc:patternPaths 的 entries 顺序一致 */
function patternChildren(p: RulePattern): { relDepth?: number }[] {
    const out: { relDepth?: number }[] = [];
    const walk = (node: RulePattern) => {
        for (const c of node.children ?? []) {
            out.push({ relDepth: c.relDepth });
            walk(c);
        }
    };
    walk(p);
    return out;
}

/** 切换「拦这一个 / 拦同类」时，让页面标出对应范围 */
async function setScope(scope: 'one' | 'broad'): Promise<void> {
    await stopPreview();
    scopeTouched.value = true;
    pickScope.value = scope;
    const sel = scope === 'broad' ? broadSelector.value : selector.value;
    if (sel) await sendToTab({ type: 'adc:markMatches', selector: sel });
}

/** 勾选 / 取消勾选某个树节点（条件节点） */
function toggleCheck(path: string): void {
    const next = new Set(checkedPaths.value);
    if (next.has(path)) {
        next.delete(path);
        const t = { ...textByPath.value };
        delete t[path];
        textByPath.value = t;
        const d = { ...relDepthByPath.value };
        delete d[path];
        relDepthByPath.value = d;
    } else {
        next.add(path);
        if (textByPath.value[path] == null) {
            textByPath.value = { ...textByPath.value, [path]: '' };
        }
    }
    checkedPaths.value = next;
}

/** 每个条件节点的文字约束（按树路径存，不再依赖勾选顺序） */
const textByPath = ref<Record<string, string>>({});
/** 严格模式下每个条件的层级（按树路径存；松模式只作切严格时的默认值） */
const relDepthByPath = ref<Record<string, number>>({});

/** 勾选出来的节点（按树的先后顺序，外层在前） */
const checkedNodes = computed(() =>
    tree.value.filter((n) => checkedPaths.value.has(n.path)),
);

/** 选中节点的简写选择器：#id 优先，否则 tag.第一个类，最后退化成 tag */
function shortSelector(n: { tag: string; id: string; classes: string[] }): string {
    if (n.id) return `#${CSS.escape(n.id)}`;
    const cls = n.classes.find((c) => !/^(is|has|js)-/.test(c)) ?? n.classes[0];
    return cls ? `${n.tag}.${CSS.escape(cls)}` : n.tag;
}

// ───────────────────────── 统一规则：锚点 + 条件树 ─────────────────────────

/** 页面/面板当前定位到的行（蓝色）。⚠️ 它只是"导航位置"，不等于规则锚点 */
const currentRow = computed<TreeRow | null>(() => tree.value.find((n) => n.current) ?? null);

/**
 * 规则锚点：**勾选（绿色复选框）里最外层的那一行**。
 *
 * 用户明确要求：蓝色只是"UI 定位到附近"，绿色才是真正参与规则的标签。
 * 之前拿蓝色行当锚点，用户勾了 feed-card 作为锚点、只是在树里定位到更深的 wrap，
 * 就被判成"勾选在锚点外面"并报红字。
 *
 * 一个都没勾 → 退回当前定位行，保留"直接在锚点行填文字"的懒人模式。
 */
const anchorNode = computed<TreeRow | null>(() => {
    const checked = checkedNodes.value;
    if (checked.length) {
        let best = checked[0];
        for (const n of checked) if (n.depth < best.depth) best = n;
        return best;
    }
    return currentRow.value;
});
const anchorPath = computed(() => anchorNode.value?.path ?? '');
/** 锚点是不是当前蓝色定位行（决定根选择器要不要复用页面实测的 finalSelector） */
const anchorIsCurrent = computed(() => !!anchorNode.value && anchorNode.value.path === (currentRow.value?.path ?? ''));

/** 这个路径是不是在锚点内部 */
function insideAnchor(path: string): boolean {
    const a = anchorPath.value;
    if (!a) return path !== '';
    return path.startsWith(a + '/');
}

/** 真正的条件：勾选的、位于锚点内部、且不是锚点自己 */
const conditionNodes = computed(() =>
    checkedNodes.value.filter((n) => n.path !== anchorPath.value && insideAnchor(n.path)),
);

/** 勾到锚点外面的节点（用来提示，不参与规则） */
const outsideChecks = computed(() =>
    checkedNodes.value.filter((n) => n.path !== anchorPath.value && !insideAnchor(n.path)),
);

/** 严格层级开关：整条规则一个开关 */
const strictMode = ref(false);
/** 锚点自己的文字约束（偷懒模式：副标签里任意层出现这段字就拦） */
const anchorText = ref('');
/** 用户给这条规则起的名字（新建/编辑时填写） */
const nameText = ref('');
/** 「+ 加条件」里选的、没有对应树节点的条件（按选择器） */
const manualConditions = ref<{ selector: string; text?: string; relDepth: number }[]>([]);

/** 某个条件节点的父节点（锚点或另一个条件节点） */
function parentOf(path: string): TreeRow | null {
    const a = anchorNode.value;
    if (!a) return null;
    let best: TreeRow = a;
    for (const n of conditionNodes.value) {
        if (n.path === path) continue;
        if (path.startsWith(n.path + '/') && n.depth > best.depth) best = n;
    }
    return best;
}

interface CondRow {
    path: string;
    node: TreeRow;
    selector: string;
    text: string;
    relDepth: number;
    defaultDepth: number;
    manual: boolean;
}

/** 树里勾出来的条件（按先序） */
const conditionRows = computed<CondRow[]>(() =>
    conditionNodes.value.map((n) => {
        const parent = parentOf(n.path);
        const defaultDepth = Math.max(1, n.depth - (parent?.depth ?? 0));
        return {
            path: n.path,
            node: n,
            selector: shortSelector(n),
            text: textByPath.value[n.path] ?? '',
            relDepth: relDepthByPath.value[n.path] ?? defaultDepth,
            defaultDepth,
            manual: false,
        };
    }),
);

/** 手动加的条件（+ 加条件 里选的元素） */
const manualRows = computed<CondRow[]>(() =>
    manualConditions.value.map((m, i) => ({
        path: `manual:${i}`,
        node: { path: `manual:${i}`, depth: 0, tag: '', id: '', classes: [], hasChildren: false, expanded: false, current: false, text: '', html: '' },
        selector: m.selector,
        text: m.text ?? '',
        relDepth: m.relDepth,
        defaultDepth: 1,
        manual: true,
    })),
);

/** 有没有可保存的条件内容 */
const hasComposition = computed(() =>
    !!anchorText.value.trim()
    || conditionRows.value.length > 0
    || manualRows.value.length > 0,
);

/** 规则编辑区顶部的一句人话摘要 */
const compositionSummary = computed(() => {
    const parts: string[] = [];
    if (anchorText.value.trim()) parts.push(`含「${anchorText.value.trim()}」`);
    const n = conditionRows.value.length + manualRows.value.length;
    if (n > 0) parts.push(`${n} 个条件`);
    return parts.join(' · ');
});

/** 校验：锚点必须有；条件必须在锚点内部；严格模式下层级必须合法 */
const composeError = computed(() => {
    if (!anchorNode.value) return '先勾选要拦的那一层，或在页面上点选一个元素';
    if (outsideChecks.value.length > 0) return '有勾选的标签不在锚点内部；请检查是否勾了别的分支';
    if (strictMode.value) {
        for (const r of conditionRows.value) {
            if (!Number.isInteger(r.relDepth) || r.relDepth < 1) return '严格模式下每个条件都要填层级（≥1）';
        }
        for (const r of manualRows.value) {
            if (!Number.isInteger(r.relDepth) || r.relDepth < 1) return '严格模式下每个条件都要填层级（≥1）';
        }
    }
    return '';
});

/** 当前草稿会命中几个元素（保存前就能看到影响范围） */
const draftCount = ref(-1);
let draftTimer: number | null = null;

/** 上一次是否有条件草稿（用来判断"条件被清空"这个瞬间，恢复同类高亮） */
let hadComposition = false;

async function refreshDraftCount(): Promise<void> {
    if (!canWork.value) {
        draftCount.value = -1;
        return;
    }
    if (!hasComposition.value) {
        draftCount.value = -1;
        // 只在"刚把条件删光"时恢复同类高亮；平时不要插手内容脚本自己的选中高亮
        if (hadComposition && picking.value) {
            const sel = broadSelector.value || finalSelector.value;
            if (sel) void sendToTab({ type: 'adc:markMatches', selector: sel });
        }
        hadComposition = false;
        return;
    }
    hadComposition = true;
    const p = buildPattern();
    if (!p) {
        draftCount.value = -1;
        return;
    }
    const res = await sendToTab<{ ok: boolean; counts: number[] }>({
        type: 'adc:countRules',
        rules: [{ selector: p.selector, pattern: p, strict: strictMode.value }],
    });
    draftCount.value = res?.counts?.[0] ?? -1;
    // 让页面只圈出真正会命中的那几个：改一个字就从"同类 6 个"缩到"广告 2 个"
    void sendToTab({
        type: 'adc:markPattern',
        selector: p.selector,
        pattern: p,
        strict: strictMode.value,
    });
}

watch(
    [hasComposition, strictMode, anchorText, checkedPaths, textByPath, relDepthByPath, manualConditions, anchorPath, selector],
    () => {
        if (draftTimer != null) window.clearTimeout(draftTimer);
        draftTimer = window.setTimeout(() => { void refreshDraftCount(); }, 250);
    },
);

/** 把当前锚点 + 条件拼成统一的条件树 */
function buildPattern(): RulePattern | null {
    const a = anchorNode.value;
    if (!a) return null;
    const rootSelector = draftRootSelector.value || shortSelector(a);
    const root: RulePattern = {
        selector: rootSelector,
        ...(anchorText.value.trim() ? { text: anchorText.value.trim() } : {}),
    };
    const map = new Map<string, RulePattern>([[a.path, root]]);

    for (const row of conditionRows.value) {
        const parent = parentOf(row.path);
        const parentPattern = parent ? map.get(parent.path) : undefined;
        if (!parentPattern) continue;
        const child: RulePattern = {
            selector: row.selector,
            relDepth: Math.max(1, strictMode.value ? row.relDepth : row.defaultDepth),
            ...(row.text.trim() ? { text: row.text.trim() } : {}),
        };
        (parentPattern.children ??= []).push(child);
        map.set(row.path, child);
    }

    for (const m of manualConditions.value) {
        (root.children ??= []).push({
            selector: m.selector,
            relDepth: Math.max(1, m.relDepth),
            ...(m.text ? { text: m.text } : {}),
        });
    }

    return root;
}

/** 编辑已有规则时，原始锚点选择器（避免保存时被重新生成的位置选择器改写） */
const editRootSelector = ref('');
/** 编辑的规则原来锚点对应的树路径（用来判断用户有没有把锚点换掉） */
const editAnchorPath = ref('');

/** 草稿的根选择器：编辑保留原选择器；勾选的锚点用简写；懒人模式用页面实测的选择器 */
const draftRootSelector = computed(() => {
    const a = anchorNode.value;
    if (!a) return '';
    const keepEditedRoot = !!editingId.value && !!editRootSelector.value && !scopeTouched.value
        && a.path === editAnchorPath.value;
    if (keepEditedRoot) return editRootSelector.value;
    return anchorIsCurrent.value ? (finalSelector.value || shortSelector(a)) : shortSelector(a);
});

function clearComposition(): void {
    checkedPaths.value = new Set();
    textByPath.value = {};
    relDepthByPath.value = {};
    anchorText.value = '';
    manualConditions.value = [];
    strictMode.value = false;
}

/** 把用户在这一段内容里划选的文字，填成这一段的文字约束 */
function useSelection(path: string): void {
    const sel = window.getSelection()?.toString().trim() ?? '';
    if (!sel) {
        showToast('先在下面那段内容里划几个字');
        return;
    }
    textByPath.value = { ...textByPath.value, [path]: sel.slice(0, 40) };
}

function useAnchorSelection(): void {
    const sel = window.getSelection()?.toString().trim() ?? '';
    if (!sel) {
        showToast('先在页面上选几个字（或者直接在输入框里打）');
        return;
    }
    anchorText.value = sel.slice(0, 40);
}

/** 严格模式下改某个条件的层级 */
function setDepth(path: string, ev: Event): void {
    const n = Math.max(1, Math.round(Number((ev.target as HTMLInputElement).value) || 1));
    relDepthByPath.value = { ...relDepthByPath.value, [path]: n };
}

function setManualText(i: number, value: string): void {
    const next = manualConditions.value.slice();
    next[i] = { ...next[i], text: value };
    manualConditions.value = next;
}

function setManualDepth(i: number, value: number): void {
    const next = manualConditions.value.slice();
    next[i] = { ...next[i], relDepth: Math.max(1, Math.round(Number(value) || 1)) };
    manualConditions.value = next;
}

function onManualText(i: number, ev: Event): void {
    setManualText(i, (ev.target as HTMLInputElement).value);
}

function onManualDepth(i: number, ev: Event): void {
    setManualDepth(i, Number((ev.target as HTMLInputElement).value));
}

function removeManual(i: number): void {
    manualConditions.value = manualConditions.value.filter((_, k) => k !== i);
}

/** 主按钮文案：把当前草稿的条件数直接写在按钮上，别让用户猜 */
const draftPartCount = computed(() => conditionRows.value.length + manualRows.value.length);
const saveLabel = computed(() => {
    const base = editingId.value ? '保存修改' : '拦截这个';
    if (!hasComposition.value) return base;
    const n = draftPartCount.value;
    return n > 0 ? `${base}（${n} 个条件）` : `${base}（含文字）`;
});

/** 展开 / 收起树节点 */
function togglePath(path: string): void {
    /**
     * 记住滚动位置，展开/收起后原样恢复，列表不许跳。
     * 用定时器补几次：树的更新是异步消息驱动的，一次 nextTick 往往还没到位。
     */
    const y = treeEl.value?.scrollTop ?? 0;
    preserveScroll.value = y;
    preserveUntil = Date.now() + 1200;
    for (const d of [40, 120, 260, 500]) {
        window.setTimeout(() => {
            if (treeEl.value && Math.abs(treeEl.value.scrollTop - y) > 1) treeEl.value.scrollTop = y;
        }, d);
    }
    markTreeUpdate();
    void sendToTab({ type: 'adc:togglePath', path });
}

/** 选中树节点 */
function selectPath(path: string): void {
    void stopPreview();
    markTreeUpdate();
    currentPath.value = path;
    void sendToTab({ type: 'adc:selectPath', path });
}

/** 悬停树节点 → 页面上高亮 */
function hoverPath(path: string): void {
    void sendToTab({ type: 'adc:highlightPath', path });
}

function selectAncestor(i: number): void {
    void stopPreview();
    currentIndex.value = i;
    void sendToTab({ type: 'adc:selectAncestor', index: i });
}

function hoverAncestor(i: number): void {
    void sendToTab({ type: 'adc:highlightIndex', index: i });
}

/**
 * 预览效果：把当前选择器**真的**应用上去（隐藏/删除），
 * 让用户看到拦完之后的样子；再点一次恢复。
 */
async function togglePreview(): Promise<void> {
    if (previewing.value) {
        await sendToTab({ type: 'adc:previewRevert' });
        previewing.value = false;
        return;
    }
    if (!finalSelector.value) {
        showToast('先选中要拦的东西');
        return;
    }
    if (hasComposition.value && composeError.value) {
        showToast(composeError.value);
        return;
    }
    const pattern = hasComposition.value ? buildPattern() : null;
    const res = await sendToTab<{ ok: boolean; count: number }>({
        type: 'adc:previewApply',
        selector: pattern?.selector ?? finalSelector.value,
        action: pickAction.value,
        pattern: pattern ?? undefined,
        strict: strictMode.value,
    });
    if (res?.ok) {
        previewing.value = true;
        if (res.count > 50) showToast(`预览中：影响了 ${res.count} 个元素`);
    }
}

/** 退出预览（切换选择/范围/方式前都要调） */
async function stopPreview(): Promise<void> {
    if (!previewing.value) return;
    await sendToTab({ type: 'adc:previewRevert' });
    previewing.value = false;
}

async function cancelPick(): Promise<void> {
    stopPolling();
    previewing.value = false;
    await sendToTab({ type: 'adc:stopPicker' });
    picking.value = false;
    editingId.value = null;
    tree.value = [];
    currentPath.value = '';
}

async function confirmPick(): Promise<void> {
    if (!finalSelector.value || !currentNode.value) {
        showToast('先在页面上点一下要拦的东西');
        return;
    }
    if (hasComposition.value && composeError.value) {
        showToast(composeError.value);
        return;
    }
    const old = editingId.value ? rules.value.find((r) => r.id === editingId.value) : null;
    const pattern = hasComposition.value ? buildPattern() : null;
    const selector = pattern?.selector ?? finalSelector.value;
    const label = pattern ? patternLabel(pattern, strictMode.value) : (currentLabel.value || selector);

    const rule: BlockRule = {
        id: editingId.value ?? newRuleId(),
        domain: domain.value,
        selector,
        action: pickAction.value,
        enabled: true,
        label,
        uid: old?.uid ?? newRuleUid(),
        ...(nameText.value.trim() ? { name: nameText.value.trim().slice(0, 40) } : {}),
        createdAt: old?.createdAt ?? Date.now(),
        pattern: pattern ?? { selector },
        strict: pattern ? strictMode.value : false,
    };

    previewing.value = false;
    await upsertRule(rule);
    clearComposition();
    stopPolling();
    await sendToTab({ type: 'adc:stopPicker' });
    await sendToTab({ type: 'adc:reapply' });

    picking.value = false;
    editingId.value = null;
    await refreshRules();
    showToast(old ? '已更新' : '已拦截');
}

// ───────────────────────── 生命周期 ─────────────────────────

const treeEl = ref<HTMLElement | null>(null);

/**
 * 选择模式下**主动轮询**内容脚本的状态。
 *
 * ⚠️ 为什么不只靠内容脚本推送：
 *    推送是 `chrome.runtime.sendMessage`（内容脚本 → 侧边栏），
 *    这条链路在某些情况下会断（侧边栏刚打开、扩展刚重载过），
 *    断了以后用户"移动鼠标毫无反应"，看起来就是功能没做。
 *    轮询是"面板发问、页面回答"，只要消息通道通就一定有效。
 */
let pickPollTimer: number | null = null;
let pollBusy = false;
/** 轮询连续失败次数（>5 次就认定"和页面连不上"） */
const pollFailures = ref(0);
const pageConnected = computed(() => pollFailures.value < 5);

async function pollPickerState(): Promise<void> {
    if (pollBusy) return;
    pollBusy = true;
    try {
        const st = await sendToTab<{
            ok: boolean; picking: boolean; locked: boolean;
            origin?: string; pageSeq?: number;
            chain: ElementInfo[]; currentIndex: number; selector: string; matchCount: number;
            broadSelector: string; broadCount: number;
            tree: typeof tree.value; currentPath: string;
        }>({ type: 'adc:state' });
        if (st?.ok) {
            pollFailures.value = 0;
            /**
             * ⚠️ 轮询**不许覆盖树和当前行**。
             *
             * 踩过：锁定之后把鼠标往抽屉这边滑，路上会掠过别的元素，
             * 内容脚本虽然早就 return 了，但面板每 100ms 用轮询结果
             * 重刷一次树，用户看到的就是"右侧标签树跟着鼠标变"。
             * 树只在内容脚本主动推送（adc:pickerChanged）时更新。
             */
            /**
             * ⚠️ 只有"选中的目标变了"才允许刷新树。
             *    锁定之后鼠标往抽屉这边滑，路上会掠过别的元素；
             *    只要选择器没变，树就**一个字都不许动**。
             *    （这条被改坏过两次，REGRESSIONS 第 2 条）
             */
            const nextSel = st.selector ?? '';
            /**
             * ⚠️ 铁律：**只有这三种情况**才允许刷新树
             *  ① 选中的目标变了（换了一个元素）
             *  ② 树还是空的（第一次进选择模式）
             *  ③ 用户自己点了展开/收起或树里的节点（allowTreeUpdate）
             *
             * 之前写成 `|| !currentPath.value`，而 currentPath 经常是空的，
             * 等于闸门常开 —— 于是锁定后鼠标往抽屉滑，树跟着页面变。
             * 这条被改坏过三次（REGRESSIONS 第 2 条）。
             */
            if (nextSel !== selector.value || !tree.value.length || allowTreeUpdate.value) {
                tree.value = st.tree ?? [];
                currentPath.value = st.currentPath ?? '';
                allowTreeUpdate.value = false;
            }
            selector.value = nextSel;
            matchCount.value = st.matchCount;
            broadSelector.value = st.broadSelector ?? '';
            broadCount.value = st.broadCount ?? 0;
            // 只有页面点选（origin=page 且 locked）才会在这里触发居中
            /**
             * ⚠️ 这里**不许**再无条件 `tree.value = st.tree`。
             *    上面闸门之外再刷一次，等于闸门没写 —— 锁定后页面自己插几个节点，
             *    树的行数就会变（REGRESSIONS 第 2 条 / 测试 ⑭）。
             *    树的更新只能走闸门内的那三行。
             */
            /**
             * 默认按 **class** 拦（用户明确要求）。
             * 只要页面上真的存在"同类"，第一次拿到数量就自动切过去；
             * 用户手动点过之后就不再自动干预。
             */
            /**
             * ⚠️ 这里**只切范围，不要发 markMatches**。
             *    内容脚本在鼠标移动时本来就会自己标同类；
             *    面板每 60ms 再发一次会把"摘掉→加回"重复几十遍，页面上一直在闪。
             */
            if (!scopeTouched.value && !autoScoped.value && broadCount.value > 1) {
                autoScoped.value = true;
                pickScope.value = 'broad';
            }
        } else {
            pollFailures.value++;
        }
    } catch {
        pollFailures.value++;
    } finally {
        pollBusy = false;
    }
}

function startPolling(): void {
    stopPolling();
    pollFailures.value = 0;
    void pollPickerState();
    // 100ms ≈ 10fps，跟手够用；60ms 在 B 站这种大页面上有点浪费（每个 tick 都要算选择器 + 匹配数）
    pickPollTimer = window.setInterval(() => { void pollPickerState(); }, 100);
}

function stopPolling(): void {
    if (pickPollTimer != null) {
        window.clearInterval(pickPollTimer);
        pickPollTimer = null;
    }
}

/** 把某一行滚到列表的**正中**（不是只让它露出来） */
function centerRowInTree(row: HTMLElement): void {
    const c = treeEl.value;
    if (!c) return;
    const cr = c.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    // 目标：行中心 == 容器中心
    const delta = rr.top - cr.top - (c.clientHeight - rr.height) / 2;
    if (Math.abs(delta) < 4) return;
    // 用即时滚动：smooth 在 CDP 的 deviceMetrics 模拟下经常不生效
    c.scrollTop = c.scrollTop + delta;
}

/** 把当前行滚到列表的**正中** */
function centerCurrentRow(): void {
    const c = treeEl.value;
    if (!c) return;
    const row = c.querySelector('.row.current') as HTMLElement | null;
    if (!row) return;
    centerRowInTree(row);
}

/**
 * 点条件区里的选择器 → 把对应节点滚到树的正中。
 *
 * 标签太多时用户翻上翻下容易迷路；这里只滚动，不改变选中/勾选。
 * 手动加的条件没有树节点（path 以 manual: 开头），忽略。
 */
function locateInTree(path: string): void {
    if (!path || path.startsWith('manual:')) return;
    const c = treeEl.value;
    if (!c) return;
    const row = [...c.querySelectorAll<HTMLElement>('.row')].find((r) => r.dataset.path === path);
    if (!row) {
        showToast('这个标签在树里被折叠了，先展开它的上级');
        return;
    }
    centerRowInTree(row);
}

/**
 * 只有「左侧页面点选」才有资格让右侧树居中。
 *
 * 内容脚本在页面点击选中后会单独发 `adc:pageSelected`；
 * 面板里点行、展开/收起、勾选、编辑、轮询、悬停都不会发这条消息，
 * 所以它们一个像素都不会滚。
 */
let centerToken = 0;

function centerForPageSelection(): void {
    const token = ++centerToken;
    const run = () => {
        if (token !== centerToken) return; // 后面又有新的点选，交给最新的那次
        centerCurrentRow();
    };
    void nextTick(run);
    // 树是异步消息驱动的，可能晚一拍到；补两次，确保滚到位
    window.setTimeout(run, 150);
    window.setTimeout(run, 400);
}

/**
 * ⚠️ 树变化**不自动滚动**。
 *    展开/收起节点也会让树变化，之前这里跟了居中逻辑，结果一点展开列表就跳。
 *    规则：只有"页面点选"才居中；展开/收起保持用户当前滚动位置。
 */
const preserveScroll = ref<number | null>(null);
/** 在这个时间点之前，每次树更新都把滚动位置摆回去（一次不够，消息可能分几次到） */
let preserveUntil = 0;

watch(tree, async () => {
    hoverMultiPath.value = null;
    if (preserveScroll.value == null || Date.now() > preserveUntil) return;
    await nextTick();
    if (treeEl.value) treeEl.value.scrollTop = preserveScroll.value;
});

function onRuntimeMessage(msg: unknown): void {
    const m = msg as {
        type?: string;
        selector?: string; matchCount?: number; broadSelector?: string; broadCount?: number;
        locked?: boolean; origin?: string; pageSeq?: number;
        tree?: typeof tree.value; currentPath?: string;
    };
    if (m?.type === 'adc:pickerChanged') {
        const nextSel = m.selector ?? '';
        if (nextSel !== selector.value || !tree.value.length || allowTreeUpdate.value) {
            tree.value = m.tree ?? [];
            currentPath.value = m.currentPath ?? '';
            allowTreeUpdate.value = false;
        }
        selector.value = nextSel;
        matchCount.value = m.matchCount ?? 0;
        broadSelector.value = m.broadSelector ?? '';
        broadCount.value = m.broadCount ?? 0;
        // 树只在上面闸门内更新；这里再刷一次会让锁定后的树跟着页面变（⑭）。
    } else if (m?.type === 'adc:pageSelected') {
        // 只有页面点选会发这条 → 右侧树居中；面板自己的操作不发
        centerForPageSelection();
    } else if (m?.type === 'adc:condPicked') {
        const r = msg as { total?: number; candidates?: typeof condCandidates.value };
        condTotal.value = r.total ?? 0;
        condCandidates.value = r.candidates ?? [];
        condPicking.value = false;
        if (condCandidates.value.length === 0) {
            showToast('这个位置没找到能区分的东西，换个地方点（比如广告角标上的字）');
        }
    } else if (m?.type === 'adc:pickerEnded') {
        picking.value = false;
        editingId.value = null;
        tree.value = [];
        currentPath.value = '';
    }
}

function onTabChanged(): void {
    void loadPage();
}

let pollTimer: number | null = null;

onMounted(() => {
    void loadPage();
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.tabs.onActivated.addListener(onTabChanged);
    chrome.tabs.onUpdated.addListener(onTabChanged);
    // 侧边栏在切换标签页时不一定收到事件，兜一个低频轮询
    pollTimer = window.setInterval(() => { void loadPage(); }, 2000);
});

onUnmounted(() => {
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    chrome.tabs.onActivated.removeListener(onTabChanged);
    chrome.tabs.onUpdated.removeListener(onTabChanged);
    if (pollTimer != null) window.clearInterval(pollTimer);
    stopPolling();
    if (toastTimer != null) window.clearTimeout(toastTimer);
});
</script>

<template>
    <div class="panel" :data-domain="domain">
        <!-- ═══════════ 规则列表 ═══════════ -->
        <template v-if="!picking">
            <div class="switch-row">
                <div class="switch-text">
                    <div class="switch-label">显示拦截效果</div>
                    <div class="switch-hint">悬浮规则时，标出它会影响哪些元素</div>
                </div>
                <button
                    class="switch"
                    :class="{ on: settings.showEffect }"
                    role="switch"
                    :aria-checked="settings.showEffect"
                    @click="onToggleEffect"
                >
                    <span class="knob" />
                </button>
            </div>

            <div class="list">
                <div v-if="!canWork" class="empty">
                    打开一个普通网页后再用（浏览器内部页面无法拦截）
                </div>

                <!-- 顶部工具条：本页/本网站切换 + 导入导出（一直可见，没规则时也能导入） -->
                <template v-else>
                <div class="rule-filter">
                    <template v-if="rules.length > 0">
                        <button
                            class="rf-btn"
                            :class="{ on: ruleFilter === 'page' }"
                            @click="ruleFilter = 'page'"
                        >本页 {{ pageHitCount }}</button>
                        <button
                            class="rf-btn"
                            :class="{ on: ruleFilter === 'site' }"
                            @click="ruleFilter = 'site'"
                        >本网站 {{ rules.length }}</button>
                    </template>
                    <span class="rf-spacer"></span>
                    <button class="rf-link" @click="triggerImport">导入</button>
                    <button class="rf-link" @click="onExport">导出</button>
                    <button class="head-btn sm" title="弹出成独立窗口" @click="popOut">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8">
                            <path d="M14 4h6v6M20 4l-8 8" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
                        </svg>
                    </button>
                    <button class="head-btn sm" title="产品介绍 / 版本进度" @click="openHomepage">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8">
                            <circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 8h.01" />
                        </svg>
                    </button>
                </div>
                <div v-if="rules.length > 0 && visibleRules.length === 0 && ruleFilter === 'page'" class="empty">
                    这个页面上没有需要拦的东西<br />
                    <button class="link-btn" @click="ruleFilter = 'site'">
                        看本网站全部 {{ rules.length }} 条规则
                    </button>
                </div>
                <div v-else-if="rules.length === 0" class="empty guide">
                    <div class="guide-title">这个站点还没有拦截规则</div>
                    <ol class="guide-steps">
                        <li>点下面的「选中要拦的东西」</li>
                        <li>在页面上点一下要拦的广告（鼠标滑到哪，右侧树就显示到哪）</li>
                        <li>要拦一整片同款，就点「同类」；只要一个就点「只这一个」</li>
                    </ol>
                    <div class="guide-hint">嫌麻烦？可以先点「预览效果」看看拦完的样子</div>
                </div>

                <div
                    v-for="r in visibleRules"
                    :key="r.id"
                    class="rule"
                    :class="{ off: !r.enabled }"
                    @mouseenter="onHoverRule(r)"
                    @mouseleave="onLeaveRule"
                >
                    <button
                        class="check"
                        :class="{ on: r.enabled }"
                        :title="r.enabled ? '点击停用' : '点击启用'"
                        @click.stop="onToggle(r)"
                    >{{ r.enabled ? '✓' : '' }}</button>

                    <div class="rule-main">
                        <div class="rule-label">
                            <template v-if="renamingId === r.id">
                                <input
                                    v-model="renameDraft"
                                    class="rule-name-input"
                                    maxlength="40"
                                    :placeholder="ruleToLabel(r)"
                                    @click.stop
                                    @keydown.enter.prevent="commitRename(r)"
                                    @keydown.esc.prevent="cancelRename()"
                                    @blur="commitRename(r)"
                                />
                            </template>
                            <template v-else>
                                <button
                                    type="button"
                                    class="rule-name"
                                    :class="{ auto: !r.name }"
                                    :title="r.name ? '点一下改名' : '给这条规则起个名字（当前为自动描述）'"
                                    @click.stop="beginRename(r)"
                                >{{ ruleDisplayName(r) }}</button>
                                <span v-if="r.strict" class="cond-tag">严格层级</span>
                                <span v-else-if="r.pattern && r.pattern.children && r.pattern.children.length" class="cond-tag">
                                    {{ r.pattern.children.length }} 个条件
                                </span>
                                <span v-if="!r.enabled" class="off-tag">已停用</span>
                            </template>
                        </div>
                        <div v-if="r.name" class="rule-meta">
                            <span class="rule-sel">{{ ruleToLabel(r) }}</span>
                        </div>
                    </div>

                    <span
                        class="count"
                        :class="{ zero: counts[r.id] === 0, multi: counts[r.id] > 1 }"
                        :title="counts[r.id] === 0 ? '这条规则现在匹配不到元素了' : '会命中几个元素'"
                    >{{ counts[r.id] < 0 ? '—' : counts[r.id] }}</span>

                    <button class="icon" title="编辑" @click.stop="startEdit(r)">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8">
                            <path d="M4 20h4l10-10-4-4L4 16z" /><path d="M13.5 6.5l4 4" />
                        </svg>
                    </button>
                    <button class="icon danger" title="删除" @click.stop="onDelete(r)">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8">
                            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                        </svg>
                    </button>
                </div>
                </template>
            </div>

            <footer class="foot">
                <button class="primary" :disabled="!canWork" @click="startPick">＋ 选中要拦的东西</button>
            </footer>
        </template>

        <!-- ═══════════ 选择模式 ═══════════ -->
        <template v-else>
            <div class="pick-head">
                <div class="pick-title">{{ editingId ? '修改规则' : '选择模式' }}</div>
                <div class="pick-hint">
                    <button
                        class="wrap-btn"
                        :class="{ on: wrapSource }"
                        @click="wrapSource = !wrapSource"
                    >{{ wrapSource ? '源码换行中' : '源码不换行' }}</button>
                    <button class="head-btn sm" title="弹出成独立窗口" @click="popOut">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8">
                            <path d="M14 4h6v6M20 4l-8 8" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
                        </svg>
                    </button>
                    <button class="head-btn sm" title="产品介绍 / 版本进度" @click="openHomepage">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8">
                            <circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 8h.01" />
                        </svg>
                    </button>
                </div>
            </div>

            <div v-if="previewing" class="preview-bar">
                预览中 —— 这就是拦掉之后的样子。
                <button class="preview-back" @click="togglePreview">退出预览</button>
            </div>

            <!-- 连不上页面时，把原因说清楚，别让用户对着空列表猜 -->
            <div v-if="!pageConnected" class="warn-bar">
                和页面连不上 —— 刷新一下这个页面，再点「选中要拦的东西」
            </div>

            <div class="tree-wrap">
            <div ref="treeEl" class="tree" :class="{ 'wrap-src': wrapSource }">
                <div
                    v-for="n in tree"
                    :key="n.path"
                    class="row"
                    :class="{ current: n.current, checked: checkedPaths.has(n.path), folded: foldedRows.has(n.path) }"
                    :data-path="n.path"
                    @mouseenter="onRowEnter(n.path)"
                    @mouseleave="onRowLeave(n.path)"
                    :style="{ paddingLeft: 2 + n.depth * 7 + 'px' }"
                >
                    <!-- 勾选：用来组合成规则 -->
                    <span
                        class="chk"
                        :class="{ on: checkedPaths.has(n.path) }"
                        @click.stop="toggleCheck(n.path)"
                    ></span>

                    <!-- 展开/收起 -->
                    <span
                        v-if="n.hasChildren"
                        class="arrow"
                        :class="{ open: n.expanded }"
                        @click.stop="togglePath(n.path)"
                    >{{ n.expanded ? '▾' : '▸' }}</span>
                    <span v-else class="arrow blank"></span>

                    <!-- 点这一行 = 选中这个元素 -->
                    <span
                        class="name"
                        @click="selectPath(n.path)"
                        @mouseenter="hoverPath(n.path)"
                    >
                        <span class="html">{{ n.html }}</span>
                        <span v-if="n.text && !n.hasChildren" class="txt">"{{ n.text.slice(0, 40) }}"</span>
                    </span>

                    <!-- 只有内容超过一行的标签才在行尾/右上角浮出折叠按钮 -->
                    <button
                        v-if="hoverMultiPath === n.path"
                        class="fold-btn"
                        :title="foldedRows.has(n.path) ? '展开成多行' : '折叠成单行'"
                        @click.stop="toggleFold(n.path)"
                    >{{ foldedRows.has(n.path) ? '展开' : '折叠该行' }}</button>
                </div>
                <div v-if="tree.length === 0" class="tree-empty">
                    把鼠标移到页面上
                </div>
            </div>
            </div>

            <div class="pick-info">
                <div class="info-row">
                    <span class="k">选择器</span>
                    <span class="v">{{ (hasComposition ? draftRootSelector : finalSelector) || '—' }}</span>
                </div>
                <!-- 条件摘要：锚点文字 / 勾选的条件 / 手动加的条件 -->
                <div class="info-row">
                    <span class="k">条件</span>
                    <span v-if="hasComposition" class="v cond-on">{{ compositionSummary }}</span>
                    <span v-else class="v muted">{{ condPicking ? '去页面上点一下…' : '不限' }}</span>
                    <button v-if="hasComposition" class="mini-btn" @click="clearCondition">清除</button>
                    <button v-else class="mini-btn" :disabled="condPicking" @click="startCondPick">
                        {{ condPicking ? '等待点选' : '+ 加条件' }}
                    </button>
                </div>

                <!-- 点完条件后的候选列表 -->
                <div v-if="condCandidates.length > 0" class="cond-list">
                    <div class="cond-tip">挑一个当条件（命中数越少越精确）：</div>
                    <button
                        v-for="c in condCandidates"
                        :key="c.type + c.value"
                        class="cond-opt"
                        @click="pickCondition(c)"
                    >
                        <span class="cond-what">
                            {{ c.type === 'text' ? `含文字「${c.value}」` : `含 ${c.value}` }}
                        </span>
                        <span class="cond-num">{{ c.count }} / {{ condTotal }}</span>
                    </button>
                </div>

                <div class="info-row">
                    <span class="k">范围</span>
                    <span class="seg">
                        <button
                            class="seg-btn"
                            :class="{ on: pickScope === 'broad' }"
                            :disabled="broadCount <= 1"
                            :title="broadCount > 1 ? '按 class 拦掉页面上所有同款' : '页面上只有一个同款'"
                            @click="setScope('broad')"
                        >同类 {{ broadCount > 1 ? broadCount : '' }}</button>
                        <button
                            class="seg-btn"
                            :class="{ on: pickScope === 'one' }"
                            @click="setScope('one')"
                            title="只拦选中的这一个"
                        >只这一个</button>
                    </span>
                </div>
                <div class="info-row">
                    <span class="k">方式</span>
                    <span class="seg">
                        <button
                            class="seg-btn"
                            :class="{ on: pickAction === 'hide' }"
                            @click="pickAction = 'hide'; stopPreview()"
                            title="保留布局占位，不会搞垮页面脚本"
                        >隐藏</button>
                        <button
                            class="seg-btn"
                            :class="{ on: pickAction === 'remove' }"
                            @click="pickAction = 'remove'; stopPreview()"
                            title="从页面里彻底删掉；有些站会因此报错"
                        >删除</button>
                    </span>
                </div>
                <!-- 让用户一眼看到"这一刀下去会波及多少" -->
                <div v-if="broadCount > 1 && !hasComposition" class="broad-hint">
                    按 <code>{{ broadSelector }}</code> 拦 → 页面上有 <b>{{ broadCount }}</b> 个同款（已用蓝色虚线标出）
                </div>

                <!-- 选择器太长 / 依赖位置结构时提醒一句：这种规则站点改版就容易失效 -->
                <div v-if="pickScope === 'one' && (selector.includes('nth-of-type') || selector.length > 60)" class="sel-warn">
                    这条选择器依赖页面结构，站点改版后可能失效 —— 建议在树里往上一层选个带类名的容器
                </div>
                <div class="info-row">
                    <span class="k">命中</span>
                    <span class="v" :class="{ warn: (hasComposition ? draftCount : finalCount) > 1 }">
                        {{ hasComposition
                            ? (draftCount < 0 ? '计算中…' : draftCount + ' 个元素')
                            : (finalCount < 0 ? '选择器无效' : finalCount + ' 个元素') }}
                    </span>
                </div>
            </div>

            <footer class="foot three">
                <!-- 组合标签规则：勾几层 → 一条规则 -->
                <!-- 统一规则编辑：锚点 + 条件树 + 严格层级开关 -->
                <div v-if="picking" class="compose">
                    <input
                        v-model="nameText"
                        class="compose-name-input"
                        maxlength="40"
                        placeholder="给这条规则起个名字（可不填）"
                    />
                    <div class="compose-anchor">
                        <div class="compose-head">
                            <span class="cond-badge anchor">锚</span>
                            <button
                                type="button"
                                class="compose-sel"
                                title="在树里定位这个标签"
                                @click="locateInTree(anchorPath)"
                            >{{ draftRootSelector || (anchorNode ? shortSelector(anchorNode) : '—') }}</button>
                            <button class="compose-pick" title="在树里定位这个标签" @click="locateInTree(anchorPath)">定位</button>
                            <button class="compose-pick" @click="useAnchorSelection">选中的字</button>
                        </div>
                        <input
                            v-model="anchorText"
                            class="compose-text"
                            placeholder="任意层包含这段文字就拦（可不填）"
                        />
                    </div>

                    <label class="compose-strict">
                        <input type="checkbox" v-model="strictMode" />
                        <span>严格限制层级关系</span>
                        <span class="strict-hint">{{ strictMode ? '条件必须正好在第 N 层' : '条件在锚点子树里任意层找' }}</span>
                    </label>

                    <div v-if="conditionRows.length || manualRows.length" class="compose-parts">
                        <div
                            v-for="row in conditionRows"
                            :key="row.path"
                            class="compose-part"
                            :style="{ paddingLeft: Math.min(48, Math.max(0, row.node.depth - (anchorNode?.depth ?? 0) - 1) * 10) + 'px' }"
                        >
                            <div class="compose-head">
                                <span class="cond-badge">条件</span>
                                <button
                                    type="button"
                                    class="compose-sel"
                                    title="在树里定位这个标签"
                                    @click="locateInTree(row.path)"
                                >{{ row.selector }}</button>
                                <button class="compose-pick" title="在树里定位这个标签" @click="locateInTree(row.path)">定位</button>
                                <button class="compose-pick" @click="useSelection(row.path)">选中的字</button>
                            </div>
                            <div class="compose-sub">
                                <input
                                    v-model="textByPath[row.path]"
                                    class="compose-text"
                                    placeholder="文字含…（可不填）"
                                />
                                <template v-if="strictMode">
                                    <span class="compose-gap">第</span>
                                    <input
                                        type="number"
                                        min="1"
                                        class="compose-depth"
                                        :value="relDepthByPath[row.path] ?? row.defaultDepth"
                                        @input="setDepth(row.path, $event)"
                                    />
                                    <span class="compose-gap">层</span>
                                </template>
                            </div>
                        </div>

                        <div v-for="(row, i) in manualRows" :key="row.path" class="compose-part">
                            <div class="compose-head">
                                <span class="cond-badge">条件</span>
                                <span class="compose-sel static">{{ row.selector }}</span>
                                <button class="compose-pick" @click="removeManual(i)">删除</button>
                            </div>
                            <div class="compose-sub">
                                <input
                                    class="compose-text"
                                    :value="row.text"
                                    placeholder="文字含…（可不填）"
                                    @input="onManualText(i, $event)"
                                />
                                <template v-if="strictMode">
                                    <span class="compose-gap">第</span>
                                    <input
                                        type="number"
                                        min="1"
                                        class="compose-depth"
                                        :value="row.relDepth"
                                        @input="onManualDepth(i, $event)"
                                    />
                                    <span class="compose-gap">层</span>
                                </template>
                            </div>
                        </div>
                    </div>

                    <div v-if="!hasComposition" class="compose-hint">
                        勾选要拦的那一层（最外层勾选 = 锚点），再勾它内部的标签 = 条件；也可以不勾，直接在锚点这一行填文字。
                    </div>

                    <div v-if="composeError" class="compose-err">{{ composeError }}</div>
                    <div class="compose-actions">
                        <button class="ghost sm" @click="clearComposition">清空条件</button>
                        <span class="compose-save-hint">底部按钮会按这里的条件生成规则</span>
                    </div>
                </div>

                <div class="foot-row">
                    <button class="ghost" @click="cancelPick">取消</button>
                    <button
                        class="ghost preview"
                        :class="{ on: previewing }"
                        :title="previewing ? '恢复页面原样' : '真的应用一次，看看拦完长什么样'"
                        @click="togglePreview"
                    >
                        {{ previewing ? '退出预览' : '👁 预览效果' }}
                    </button>
                    <button class="primary" @click="confirmPick">
                        {{ saveLabel }}
                    </button>
                </div>
            </footer>
        </template>

        <!-- 隐藏的文件选择器：靠 JS 触发，界面上不出现原生控件 -->
        <input
            ref="fileInput"
            type="file"
            accept="application/json,.json"
            style="display: none"
            @change="onImport"
        />

        <div v-if="toast" class="toast">{{ toast }}</div>
    </div>
</template>

<style scoped>
.panel {
    height: 100vh;
    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
    font-size: 13px;
    color: #1f2329;
    background: #f5f6f7;
    box-sizing: border-box;
    overflow: hidden;
}

/* ── 头部 ── */
.head {
    flex: none;
    padding: 12px 14px 10px;
    background: #fff;
    border-bottom: 1px solid #e5e6eb;
}
.site.big {
    font-size: 15px;
    font-weight: 600;
    color: #1f2329;
        font-family: ui-monospace, Menlo, monospace;
}

.title { font-size: 15px; font-weight: 600; }
.site { margin-top: 3px; font-size: 12px; color: #86909c; }

.head { display: flex; align-items: center; gap: 10px; }
.head-main { flex: 1; min-width: 0; }

.head-btn.sm { width: 26px; height: 26px; padding: 0; }

.head-btn {
    flex: none;
    min-width: 30px;
    height: 28px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #e5e6eb;
    border-radius: 8px;
    background: #fff;
    color: #86909c;
    cursor: pointer;
    font-size: 12px;
}
.head-btn:hover, .head-btn.on { border-color: #00aeec; color: #00aeec; }
.head-back { font-size: 12px; }

/* ── 关于页 ── */
.about {
    flex: 1;
    overflow-y: auto;
    padding: 14px;
    background: #fff;
}
.about-head { display: flex; align-items: baseline; gap: 8px; }
.about-name { font-size: 16px; font-weight: 600; }
.about-ver { font-size: 12px; color: #00aeec; }
.about-slogan { margin: 6px 0 10px; font-size: 12.5px; color: #4e5969; line-height: 1.6; }
.about-note {
    padding: 8px 10px;
    background: #f7f8fa;
    border-radius: 8px;
    font-size: 11.5px;
    color: #4e5969;
    line-height: 1.6;
}
.about-section {
    margin: 16px 0 8px;
    font-size: 12px;
    font-weight: 600;
    color: #86909c;
}
.ver { margin-bottom: 12px; }
.ver-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.ver-no { font-size: 13px; font-weight: 600; color: #1f2329; }
.ver-date { font-size: 11px; color: #86909c; }
.ver-tag {
    font-size: 10.5px;
    color: #ff7d00;
    background: #fff7e8;
    border-radius: 4px;
    padding: 1px 6px;
}
.ver-items { margin: 0; padding-left: 18px; }
.ver-items li { font-size: 12px; color: #4e5969; line-height: 1.85; }
.ver.planned .ver-items li { color: #86909c; }

.about-actions { display: flex; gap: 10px; }
.about-actions .ghost {
    flex: 1;
    height: 34px;
    border: 1px solid #d9d9d9;
    border-radius: 17px;
    background: #fff;
    color: #4e5969;
    font-size: 12.5px;
    cursor: pointer;
}
.about-actions .ghost:hover { border-color: #00aeec; color: #00aeec; }
.file-label {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
}
.file-label input { display: none; }
.about-hint { margin-top: 8px; font-size: 11.5px; color: #86909c; }

/* ── 空状态引导 ── */
.empty.guide { text-align: left; padding: 28px 18px; }
.guide-title { font-size: 13px; color: #1f2329; font-weight: 600; margin-bottom: 10px; text-align: center; }
.guide-steps { margin: 0; padding-left: 20px; }
.guide-steps li { font-size: 12.5px; color: #4e5969; line-height: 1.9; }
.guide-hint { margin-top: 12px; font-size: 11.5px; color: #86909c; text-align: center; }

/* ── 开关行 ── */
.switch-row {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: #fff;
    border-bottom: 1px solid #f2f3f5;
}
.switch-text { flex: 1; min-width: 0; }
.switch-label { font-size: 13px; }
.switch-hint { margin-top: 2px; font-size: 11.5px; color: #86909c; }

.switch {
    flex: none;
    width: 40px;
    height: 22px;
    border-radius: 11px;
    border: none;
    background: #d9d9d9;
    position: relative;
    cursor: pointer;
    padding: 0;
    transition: background .15s;
}
.switch.on { background: #00aeec; }
.knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    transition: transform .15s;
}
.switch.on .knob { transform: translateX(18px); }

/* 本页/本网站 切换 */
.rule-filter {
    display: flex;
    gap: 8px;
    padding: 0 2px 10px;
}
.rf-btn {
    flex: none;
    padding: 5px 12px;
    border: 1px solid #e5e6eb;
    border-radius: 14px;
    background: #fff;
    color: #86909c;
    font-size: 12px;
    cursor: pointer;
}
.rf-spacer { flex: 1; }

.rf-link {
    flex: none;
    border: none;
    background: transparent;
    color: #86909c;
    font-size: 12px;
    cursor: pointer;
    padding: 0 2px;
}
.rf-link:hover { color: #00aeec; text-decoration: underline; }

.rf-btn.on {
    border-color: #00aeec;
    color: #00aeec;
    background: #f0fbff;
}

.link-btn {
    margin-top: 8px;
    border: none;
    background: transparent;
    color: #00aeec;
    font-size: 12.5px;
    text-decoration: underline;
    cursor: pointer;
}

/* ── 规则列表 ── */
.list { flex: 1; overflow-y: auto; padding: 10px; }

.empty {
    padding: 48px 20px;
    text-align: center;
    color: #86909c;
    font-size: 12.5px;
    line-height: 1.9;
}

.rule {
    position: relative;
    display: flex;
    align-items: center;
    gap: 9px;
    background: #fff;
    border: 1px solid #f0f1f3;
    border-radius: 12px;
    padding: 10px 12px;
    margin-bottom: 7px;
    box-shadow: 0 1px 2px rgba(15, 25, 40, .03), 0 4px 12px rgba(15, 25, 40, .03);
    transition: border-color .16s ease, box-shadow .16s ease;
    cursor: default;
}
.rule:hover {
    border-color: #cdeafb;
    box-shadow: 0 2px 6px rgba(0, 174, 236, .08), 0 8px 20px rgba(15, 25, 40, .04);
}
.rule.off { opacity: .62; }
.rule.off:hover { opacity: .82; }

.check {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 6px;
    border: 1.5px solid #c9cdd4;
    background: #fff;
    color: #fff;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
    transition: background .16s ease, border-color .16s ease, box-shadow .16s ease;
}
.check.on {
    background: linear-gradient(180deg, #22bdf2, #00aeec);
    border-color: #00aeec;
    box-shadow: 0 2px 5px rgba(0, 174, 236, .28);
}

.rule-main { flex: 1; min-width: 0; }
.rule-label {
    display: flex;
    align-items: center;
    min-width: 0;
    font-size: 13px;
}
.rule-name {
    min-width: 0;
    border: 0;
    background: none;
    padding: 0;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.35;
    color: #1d2129;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: text;
    border-bottom: 1px dashed transparent;
}
.rule-name:hover { border-bottom-color: #c9cdd4; }
.rule-name.auto { font-weight: 500; color: #2b3340; }
.rule-name-input {
    flex: 1;
    min-width: 0;
    width: 100%;
    height: 25px;
    padding: 0 6px;
    border: 1px solid #00aeec;
    border-radius: 6px;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    color: #1d2129;
    background: #fff;
}
.rule-name-input:focus { outline: none; box-shadow: 0 0 0 2px rgba(0, 174, 236, .14); }

.rule-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 3px;
    min-width: 0;
}
.rule-sel {
    flex: 1;
    min-width: 0;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 10.5px;
    color: #8a93a3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.cond-tag {
    flex: none;
    margin-left: 5px;
    padding: 1px 6px;
    border-radius: 5px;
    border: 1px solid #d3eefb;
    background: #eaf7fe;
    color: #0b6ea8;
    font-size: 10px;
    font-weight: 400;
}

.off-tag {
    flex: none;
    margin-left: 5px;
    padding: 1px 6px;
    border-radius: 5px;
    border: 1px solid #e5e6eb;
    background: #f7f8fa;
    color: #86909c;
    font-size: 10px;
    font-weight: 400;
}

.count {
    flex: none;
    min-width: 26px;
    height: 22px;
    padding: 0 7px;
    border-radius: 999px;
    background: #f4f5f7;
    color: #86909c;
    font-size: 11px;
    font-weight: 600;
    line-height: 22px;
    text-align: center;
}
.count.multi { background: #fff4e6; color: #d25f00; }
.count.zero { background: #ffece8; color: #d93026; }

.icon {
    flex: none;
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 8px;
    background: #f7f8fa;
    color: #5c6573;
    cursor: pointer;
    padding: 0;
    transition: background .16s ease, color .16s ease, border-color .16s ease;
}
.icon:hover { background: #e8f7fe; border-color: #b9e7fb; color: #00a3dd; }
.icon.danger:hover { background: #fff0ed; border-color: #ffd2c9; color: #e5482f; }

/* ── 底部按钮 ── */
.foot {
    flex: none;
    padding: 10px 12px;
    background: #fff;
    border-top: 1px solid #e5e6eb;
}
.foot.two { display: flex; gap: 10px; }
.foot.three {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.foot.three > .compose { width: 100%; }
.foot.three > .foot-row { display: flex; gap: 8px; width: 100%; }
.foot.three .ghost { width: auto; flex: none; min-width: 64px; padding: 0 12px; }
.foot.three .primary { flex: 1; width: auto; }
.foot .preview.on {
    border-color: #00aeec;
    color: #00aeec;
    background: #f0fbff;
}

.preview-bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 14px;
    background: #e6f7ff;
    border-bottom: 1px solid #b3e4fb;
    color: #0b6ea8;
    font-size: 12px;
    line-height: 1.5;
}

.preview-back {
    margin-left: auto;
    flex: none;
    border: 1px solid #00aeec;
    background: #fff;
    color: #00aeec;
    border-radius: 12px;
    font-size: 11.5px;
    padding: 3px 10px;
    cursor: pointer;
}

.primary {
    width: 100%;
    height: 36px;
    border: none;
    border-radius: 18px;
    background: #00aeec;
    color: #fff;
    font-size: 13.5px;
    cursor: pointer;
}
.primary:disabled { background: #c9cdd4; cursor: not-allowed; }

.ghost {
    flex: none;
    width: 88px;
    height: 36px;
    border: 1px solid #d9d9d9;
    border-radius: 18px;
    background: #fff;
    color: #4e5969;
    font-size: 13.5px;
    cursor: pointer;
}
.foot.two .primary { flex: 1; width: auto; }

/* ── 选择模式 ── */
.pick-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: #fff;
    border-bottom: 1px solid #f2f3f5;
}
.pick-title {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 600;
    white-space: nowrap;
}
.pick-hint {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
}

.pick-hint2 { margin-top: 3px; font-size: 11.5px; color: #86909c; line-height: 1.6; }

.warn-bar {
    flex: none;
    padding: 8px 14px;
    background: #fff1f0;
    color: #f53f3f;
    font-size: 12px;
    line-height: 1.6;
    border-bottom: 1px solid #ffccc7;
}

.tree {
    flex: 1;
    overflow-y: auto;
    background: #fff;
    padding: 6px 0;
}
.kids-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px 4px;
    margin-top: 6px;
    border-top: 1px dashed #e5e6eb;
    font-size: 11.5px;
    color: #86909c;
}
.kids-tip { font-size: 10.5px; color: #c9cdd4; }

.row.kid { padding-left: 12px; }

.tree-empty { padding: 30px 14px; color: #86909c; font-size: 12px; text-align: center; }

.row {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 22px;
    padding-right: 8px;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
}

/* 展开箭头 */
.chk {
    flex: none;
    width: 11px;
    height: 11px;
    margin-top: 3px;
    margin: 0 3px 0 0;
    border: 1px solid #c9cdd4;
    border-radius: 3px;
    background: #fff;
    cursor: pointer;
    position: relative;
}
.chk.on { background: #00B42A; border-color: #00B42A; }
.chk.on::after {
    content: '';
    position: absolute;
    left: 3px; top: 0.5px;
    width: 3px; height: 6px;
    border: solid #fff;
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
}

.compose {
    padding: 8px 10px;
    margin-bottom: 6px;
    background: #f7f8fa;
    border-radius: 8px;
}
.compose-name-input {
    display: block;
    width: 100%;
    box-sizing: border-box;
    height: 27px;
    margin-bottom: 6px;
    padding: 0 8px;
    border: 1px solid #e5e6eb;
    border-radius: 6px;
    font-family: inherit;
    font-size: 11.5px;
    color: #1f2329;
    background: #fff;
}
.compose-name-input:focus {
    outline: none;
    border-color: #00aeec;
    box-shadow: 0 0 0 2px rgba(0, 174, 236, .12);
}
.compose-anchor {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 6px;
}
.cond-badge {
    flex: none;
    font-size: 10px;
    line-height: 16px;
    padding: 0 5px;
    border-radius: 4px;
    background: #e8f0ff;
    color: #1677ff;
    font-weight: 600;
}
.cond-badge.anchor { background: #1677ff; color: #fff; }
.compose-strict {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px 6px;
    margin-bottom: 6px;
    font-size: 11.5px;
    color: #4e5969;
    cursor: pointer;
}
.compose-strict input { accent-color: #1677ff; }
.strict-hint { color: #86909c; font-size: 10.5px; }
.compose-depth {
    flex: none;
    width: 40px;
    height: 24px;
    padding: 0 4px;
    border: 1px solid #e5e6eb;
    border-radius: 5px;
    font-size: 11px;
    color: #1f2329;
}
.compose-hint {
    margin: 4px 0;
    font-size: 11px;
    line-height: 1.6;
    color: #86909c;
}
.compose-parts { display: flex; flex-direction: column; gap: 4px; }
.compose-part { display: flex; flex-direction: column; gap: 3px; margin-bottom: 6px; }
.compose-head { display: flex; align-items: center; gap: 4px; width: 100%; }
.compose-sub { display: flex; align-items: center; gap: 4px; width: 100%; }
.compose-gap { color: #00aeec; font-size: 10.5px; flex: none; }
.compose-sel {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    padding: 0;
    text-align: left;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px;
    color: #1f2329;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    border-radius: 3px;
}
.compose-sel:hover { color: #00aeec; text-decoration: underline; }
.compose-sel:focus-visible { outline: 1px solid #00aeec; outline-offset: 1px; }
.compose-sel.static { cursor: default; }
.compose-sel.static:hover { color: #1f2329; text-decoration: none; }
.compose-text {
    flex: 1;
    width: 100%;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid #e5e6eb;
    border-radius: 5px;
    font-size: 11px;
    color: #1f2329;
}
.compose-text:focus { outline: none; border-color: #00aeec; }
.compose-pick {
    flex: none;
    margin-left: auto;
    border: 1px solid #d9d9d9;
    background: #fff;
    color: #4e5969;
    border-radius: 5px;
    font-size: 10.5px;
    padding: 3px 6px;
    cursor: pointer;
}
.compose-pick:hover { border-color: #00aeec; color: #00aeec; }
.compose-content {
    margin: 2px 0 6px 12px;
    padding: 4px 6px;
    background: #fff;
    border: 1px dashed #e5e6eb;
    border-radius: 5px;
    font-size: 11px;
    line-height: 1.6;
    color: #4e5969;
    max-height: 54px;
    overflow-y: auto;
    user-select: text;
    cursor: text;
}
.compose-err { margin-top: 4px; color: #f53f3f; font-size: 11px; }
.compose-actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.compose-actions .sm { flex: none; height: 28px; padding: 0 12px; font-size: 11.5px; border-radius: 14px; }
.compose-save-hint {
    flex: 1;
    text-align: right;
    color: #86909c;
    font-size: 10.5px;
    line-height: 1.4;
}

.arrow {
    flex: none;
    width: 20px;
    text-align: center;
    color: #86909c;
    font-size: 17px;
    line-height: 20px;
    cursor: pointer;
    user-select: none;
}
.arrow:hover { color: #00aeec; }
/* ⚠️ 不能用 .empty：面板空状态有 .empty { padding:48px }，会把整行撑高 */
.arrow.blank { cursor: default; }

/* 节点名（点了就选中） */
.name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    padding: 1px 4px;
    border-radius: 3px;
}
/* 悬浮：很淡的一层 */
.name:hover { background: #f0f6fa; }
.txt { color: #6b7280; margin-left: 4px; font-size: 10.5px; }
.html {
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px;
    color: #7a5af8;
    white-space: nowrap;
}
/* 换行模式：整行放开，高度自适应 */
.tree.wrap-src .row {
    height: auto;
    min-height: 22px;
    align-items: flex-start;
    padding-top: 1px;
    padding-bottom: 1px;
}
/* 换行时复选框和三角号贴在首行文字上，不要飘到顶上 */
/* 复选框、三角号、首行文字三者中线对齐（首行行高 17px） */
.tree.wrap-src .chk { margin-top: 3px; }
.tree.wrap-src .arrow { height: 17px; line-height: 17px; margin-top: 0; }
.tree.wrap-src .name { white-space: normal; word-break: break-all; line-height: 1.5; }
.tree.wrap-src .html { white-space: normal; word-break: break-all; }

/* 单行折叠：这一行强制一行显示 */

.wrap-btn {
    margin-left: auto;
    flex: none;
    border: 1px solid #e5e6eb;
    background: #fff;
    color: #86909c;
    font-size: 10.5px;
    padding: 2px 8px;
    border-radius: 10px;
    cursor: pointer;
}
.wrap-btn.on { border-color: #00aeec; color: #00aeec; background: #f0fbff; }
/* 悬浮 = 中性灰 */
.row:hover { background: #F2F4F7; }

/* 勾选（组合用）= 淡绿底 + 绿色复选框 */
/* 行内「折叠该行」：绝对定位在右上角，不参与布局、不挤内容 */
.row { position: relative; }
.tree-wrap { position: relative; flex: 1; min-height: 0; display: flex; }

/**
 * 「折叠该行」：浮在**当前这一行**的右上角，不参与布局、不挤内容。
 * 只有内容真的超过一行的行才会渲染它（见 onRowEnter 的 Range 测量）。
 */
.fold-btn {
    position: absolute;
    top: 1px;
    right: 4px;
    z-index: 20;
    border: 1px solid #1677ff;
    background: rgba(255, 255, 255, .97);
    color: #1677ff;
    font-size: 10.5px;
    line-height: 16px;
    padding: 1px 6px;
    border-radius: 5px;
    cursor: pointer;
    box-shadow: 0 1px 4px rgba(22, 119, 255, .18);
}
.fold-btn:hover { background: #1677ff; color: #fff; }

/* 折叠后：这一行强制单行 */
.row.folded .name { white-space: nowrap; }
.row.folded .html {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
}

.row.checked { background: #EAF9EE; }

/* 选中（锁定）= 淡蓝底 + 左侧 3px 蓝条 + 加粗
   选中和勾选同时存在时：底色取蓝（选中优先），绿勾保留 */
.row.current {
    background: #E6F0FF;
    box-shadow: inset 3px 0 0 #1677FF;
}
.row.current .name { font-weight: 600; }
.row.current .html { color: #1c4fd8; }

.tag { color: #7a5af8; }
.id { color: #f53f3f; }
.cls { color: #00aeec; }
.size { margin-left: auto; color: #c9cdd4; font-size: 11px; }

.pick-info {
    flex: none;
    padding: 8px 14px;
    background: #fafbfc;
    border-top: 1px solid #f2f3f5;
}
.info-row { display: flex; gap: 8px; font-size: 12px; line-height: 1.7; }
.info-row .k { flex: none; color: #86909c; width: 48px; }
.info-row .v {
    flex: 1;
    min-width: 0;
    /* 选择器可能很长，允许换行让人看全（之前只能看到开头） */
    word-break: break-all;
    font-family: ui-monospace, Menlo, monospace;
    color: #1f2329;
    line-height: 1.5;
}
.info-row .v.warn { color: #ff7d00; }

.broad-hint {
    margin: 2px 0 6px;
    padding: 6px 8px;
    background: #e8f4fd;
    border-radius: 6px;
    color: #0b6ea8;
    font-size: 11.5px;
    line-height: 1.6;
}

.broad-hint code {
    font-family: ui-monospace, Menlo, monospace;
    background: rgba(0,0,0,.06);
    padding: 0 4px;
    border-radius: 3px;
    font-size: 11px;
}

.seg-btn:disabled {
    color: #c9cdd4;
    cursor: not-allowed;
}

.sel-warn {
    margin: 2px 0 6px;
    padding: 6px 8px;
    background: #fff7e8;
    border-radius: 6px;
    color: #d25f00;
    font-size: 11.5px;
    line-height: 1.6;
}

.mini-btn {
    flex: none;
    border: 1px solid #d9d9d9;
    background: #fff;
    color: #4e5969;
    border-radius: 11px;
    font-size: 11.5px;
    padding: 2px 10px;
    cursor: pointer;
}
.mini-btn:hover:not(:disabled) { border-color: #00aeec; color: #00aeec; }
.mini-btn:disabled { color: #c9cdd4; cursor: default; }

.v.muted { color: #c9cdd4; }
.v.cond-on { color: #00aeec; }

.cond-list {
    margin: 6px 0 8px;
    padding: 8px 10px;
    background: #f7f8fa;
    border-radius: 8px;
}
.cond-tip { font-size: 11.5px; color: #86909c; margin-bottom: 6px; }
.cond-opt {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 8px;
    padding: 6px 8px;
    margin-top: 4px;
    border: 1px solid #e5e6eb;
    border-radius: 6px;
    background: #fff;
    font-size: 12px;
    color: #1f2329;
    cursor: pointer;
    text-align: left;
}
.cond-opt:hover { border-color: #00aeec; color: #00aeec; }
.cond-what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cond-num { flex: none; color: #86909c; font-size: 11px; }

.seg {
    display: inline-flex;
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    overflow: hidden;
}
.seg-btn {
    border: none;
    background: #fff;
    color: #4e5969;
    font-size: 12px;
    padding: 2px 12px;
    cursor: pointer;
}
.seg-btn + .seg-btn { border-left: 1px solid #e5e6eb; }
.seg-btn.on { background: #00aeec; color: #fff; }

/* ── 提示 ── */
.toast {
    position: fixed;
    left: 50%;
    bottom: 70px;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, .82);
    color: #fff;
    font-size: 12.5px;
    padding: 8px 14px;
    border-radius: 16px;
    max-width: 80%;
    text-align: center;
    pointer-events: none;
}
</style>
