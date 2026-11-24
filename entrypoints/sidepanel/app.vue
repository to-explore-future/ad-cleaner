<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import {
    deleteRule, exportAllRules, importRules, loadRulesFor, loadSettings,
    newRuleId, saveSettings, setRuleEnabled, upsertRule,
} from '@/utils/rules';
import { CHANGELOG, ROADMAP } from '@/utils/changelog';
import type { BlockRule, ElementInfo, Settings, SmartInference } from '@/utils/types';

// ───────────────────────── 状态 ─────────────────────────

const tabId = ref<number | null>(null);
const pageUrl = ref('');
const domain = ref('');
const rules = ref<BlockRule[]>([]);
/** 每条规则当前在页面上命中几个元素（0 = 已经匹配不到了） */
const counts = ref<Record<string, number>>({});
const settings = ref<Settings>({ showEffect: true });

/** 选择模式 */
const picking = ref(false);
const editingId = ref<string | null>(null);
const chain = ref<ElementInfo[]>([]);
const currentIndex = ref(-1);
const selector = ref('');
const matchCount = ref(0);
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
const appVersion = chrome.runtime.getManifest().version;

/**
 * 智能模式（「点一下广告，剩下的我来」）。
 *   idle     → 还没开始，显示大按钮
 *   waiting  → 等用户在页面上点广告
 *   result   → 已经推断出结果，等用户确认
 */
const smartStatus = ref<'idle' | 'waiting' | 'result'>('idle');
const smartResult = ref<SmartInference | null>(null);

/** 是否在「关于」页 */
const showAbout = ref(false);

const toast = ref('');
let toastTimer: number | null = null;
function showToast(msg: string): void {
    toast.value = msg;
    if (toastTimer != null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.value = ''; }, 2200);
}

const canWork = computed(() => !!domain.value && tabId.value != null);
const currentEl = computed(() => (currentIndex.value >= 0 ? chain.value[currentIndex.value] : null));

/** 当前选中那层的短标签，例如 `div.ad-box` */
const currentLabel = computed(() => {
    const el = currentEl.value;
    if (!el) return '';
    return el.classes.length ? `${el.tag}.${el.classes[0]}` : el.tag;
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
        rules.value = canWork.value ? await loadRulesFor(domain.value) : [];
        await refreshCounts();
    } catch (e) {
        console.warn('[广告清道夫] 读取当前页面失败', e);
    }
}

/** 问页面：这些选择器各命中几个元素。 */
async function refreshCounts(): Promise<void> {
    if (!canWork.value || rules.value.length === 0) {
        counts.value = {};
        return;
    }
    const res = await sendToTab<{ ok: boolean; counts: number[] }>({
        type: 'adc:countAll',
        selectors: rules.value.map((r) => r.selector),
    });
    const out: Record<string, number> = {};
    rules.value.forEach((r, i) => {
        out[r.id] = res?.counts?.[i] ?? -1;
    });
    counts.value = out;
}

// ───────────────────────── 规则操作 ─────────────────────────

async function refreshRules(): Promise<void> {
    rules.value = canWork.value ? await loadRulesFor(domain.value) : [];
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

/** 悬浮规则 → 页面上标出它会影响哪些元素 */
async function onHoverRule(rule: BlockRule): Promise<void> {
    if (!settings.value.showEffect) return;
    const res = await sendToTab<{ ok: boolean; count: number }>({
        type: 'adc:preview', selector: rule.selector, action: rule.action,
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

// ───────────────────────── 导入 / 导出 ─────────────────────────

/** 导出所有规则成 .json 文件 */
async function onExport(): Promise<void> {
    try {
        const text = await exportAllRules(appVersion);
        const blob = new Blob([text], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `广告清道夫-规则-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast('已导出');
    } catch (e) {
        showToast('导出失败：' + (e instanceof Error ? e.message : String(e)));
    }
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

// ───────────────────────── 智能模式 ─────────────────────────

async function startSmart(): Promise<void> {
    const res = await sendToTabOrInject<{ ok: boolean }>({ type: 'adc:startSmart' });
    if (!res?.ok) {
        showToast('这个页面里跑不起来，刷新一下页面再试');
        return;
    }
    smartStatus.value = 'waiting';
    smartResult.value = null;
    showAbout.value = false;
}

async function cancelSmart(): Promise<void> {
    await sendToTab({ type: 'adc:stopPicker' });
    smartStatus.value = 'idle';
    smartResult.value = null;
}

/** 确认：把推断出来的规则存下来并生效 */
async function confirmSmart(mode: 'suggested' | 'all'): Promise<void> {
    const inf = smartResult.value;
    if (!inf) return;

    const cond = mode === 'all' ? null : inf.condition;
    const rule: BlockRule = {
        id: newRuleId(),
        domain: domain.value,
        selector: inf.unitSelector,
        action: 'hide',
        enabled: true,
        label: inf.unitSelector,
        createdAt: Date.now(),
        ...(cond ? { condition: { type: cond.type, value: cond.value } } : {}),
    };

    await upsertRule(rule);
    await sendToTab({ type: 'adc:stopPicker' });
    await sendToTab({ type: 'adc:reapply' });
    smartStatus.value = 'idle';
    smartResult.value = null;
    await refreshRules();
    showToast(mode === 'all' ? '已拦掉这一类全部' : '已拦掉');
}

/** 「调整」：带着推断结果进高级模式 */
async function tuneSmart(): Promise<void> {
    const inf = smartResult.value;
    if (!inf) return;
    smartStatus.value = 'idle';
    smartResult.value = null;
    await startPick();
    // 把推断出的那一类选出来，让用户接着调
    await sendToTab({ type: 'adc:selectBySelector', selector: inf.unitSelector });
}

async function startPick(): Promise<void> {
    const res = await sendToTabOrInject<{ ok: boolean }>({ type: 'adc:startPicker' });
    if (!res?.ok) {
        showToast('这个页面里跑不起来，刷新一下页面再试（浏览器内部页面无法操作）');
        return;
    }
    editingId.value = null;
    pickAction.value = 'hide';
    pickScope.value = 'one';
    previewing.value = false;
    scopeTouched.value = false;
    autoScoped.value = false;
    broadSelector.value = '';
    broadCount.value = 0;
    picking.value = true;
    startPolling();
    chain.value = [];
    currentIndex.value = -1;
    selector.value = '';
    matchCount.value = 0;
}

async function startEdit(rule: BlockRule): Promise<void> {
    editingId.value = rule.id;
    pickAction.value = rule.action;
    previewing.value = false;
    pickScope.value = 'one';
    previewing.value = false;
    scopeTouched.value = false;
    autoScoped.value = false;
    broadSelector.value = '';
    broadCount.value = 0;
    picking.value = true;
    startPolling();
    chain.value = [];
    currentIndex.value = -1;
    selector.value = '';
    matchCount.value = 0;

    const res = await sendToTabOrInject<{ ok: boolean }>({
        type: 'adc:selectBySelector', selector: rule.selector,
    });
    if (!res?.ok) {
        showToast('页面上已找不到这条规则的目标，请重新选一个');
    }
}

/** 切换「拦这一个 / 拦同类」时，让页面标出对应范围 */
async function setScope(scope: 'one' | 'broad'): Promise<void> {
    await stopPreview();
    scopeTouched.value = true;
    pickScope.value = scope;
    const sel = scope === 'broad' ? broadSelector.value : selector.value;
    if (sel) await sendToTab({ type: 'adc:markMatches', selector: sel });
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
    const res = await sendToTab<{ ok: boolean; count: number }>({
        type: 'adc:previewApply', selector: finalSelector.value, action: pickAction.value,
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
    chain.value = [];
    currentIndex.value = -1;
}

async function confirmPick(): Promise<void> {
    if (!finalSelector.value || currentIndex.value < 0) {
        showToast('先在页面上点一下要拦的东西');
        return;
    }
    const el = currentEl.value;
    const label = el ? (el.classes.length ? `${el.tag}.${el.classes[0]}` : el.tag) : selector.value;
    const old = editingId.value ? rules.value.find((r) => r.id === editingId.value) : null;

    const rule: BlockRule = {
        id: editingId.value ?? newRuleId(),
        domain: domain.value,
        selector: finalSelector.value,
        action: pickAction.value,
        enabled: true,
        label,
        createdAt: old?.createdAt ?? Date.now(),
    };

    previewing.value = false;
    await upsertRule(rule);
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
            chain: ElementInfo[]; currentIndex: number; selector: string; matchCount: number;
            broadSelector: string; broadCount: number;
        }>({ type: 'adc:state' });
        if (st?.ok) {
            pollFailures.value = 0;
            chain.value = st.chain;
            currentIndex.value = st.currentIndex;
            selector.value = st.selector;
            matchCount.value = st.matchCount;
            broadSelector.value = st.broadSelector ?? '';
            broadCount.value = st.broadCount ?? 0;
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

// 选中层变化时，把树里的当前行滚进视野
watch(currentIndex, async () => {
    await nextTick();
    const row = treeEl.value?.querySelector('.row.current') as HTMLElement | null;
    row?.scrollIntoView({ block: 'nearest' });
});

function onRuntimeMessage(msg: unknown): void {
    const m = msg as {
        type?: string; chain?: ElementInfo[]; currentIndex?: number;
        selector?: string; matchCount?: number; broadSelector?: string; broadCount?: number;
    };
    if (m?.type === 'adc:pickerChanged') {
        chain.value = m.chain ?? [];
        currentIndex.value = m.currentIndex ?? -1;
        selector.value = m.selector ?? '';
        matchCount.value = m.matchCount ?? 0;
        broadSelector.value = m.broadSelector ?? '';
        broadCount.value = m.broadCount ?? 0;
    } else if (m?.type === 'adc:smartResult') {
        const r = (msg as { inference?: SmartInference | null }).inference;
        if (r) {
            smartResult.value = r;
            smartStatus.value = 'result';
        } else {
            showToast('没看懂这个位置，换一个地方点（点广告的图片或标题试试）');
        }
    } else if (m?.type === 'adc:pickerEnded') {
        picking.value = false;
        editingId.value = null;
        chain.value = [];
        currentIndex.value = -1;
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
    <div class="panel">
        <header class="head">
            <div class="head-main">
                <div class="title">广告清道夫</div>
                <div class="site">{{ domain || '当前页面不可用' }}</div>
            </div>
            <button
                class="head-btn"
                :class="{ on: showAbout }"
                :title="showAbout ? '返回' : '关于 / 版本进度'"
                @click="showAbout = !showAbout"
            >
                <svg v-if="!showAbout" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8">
                    <circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 8h.01" />
                </svg>
                <span v-else class="head-back">返回</span>
            </button>
        </header>

        <!-- ═══════════ 关于 / 版本进度 ═══════════ -->
        <div v-if="showAbout" class="about">
            <div class="about-head">
                <div class="about-name">广告清道夫</div>
                <div class="about-ver">版本 {{ appVersion }}</div>
            </div>
            <p class="about-slogan">像 F12 一样点选要拦的东西，还能沿着 DOM 树往外扩。</p>

            <div class="about-note">
                所有规则只存在你这台电脑的浏览器里，<b>不会上传到任何服务器</b>。
            </div>

            <div class="about-section">这个版本做了什么</div>
            <div v-for="v in CHANGELOG" :key="v.version" class="ver">
                <div class="ver-head">
                    <span class="ver-no">v{{ v.version }}</span>
                    <span class="ver-date">{{ v.date }}</span>
                </div>
                <ul class="ver-items">
                    <li v-for="(it, i) in v.items" :key="i">{{ it }}</li>
                </ul>
            </div>

            <div class="about-section">后面计划做什么</div>
            <div v-for="v in ROADMAP" :key="v.version" class="ver planned">
                <div class="ver-head">
                    <span class="ver-no">v{{ v.version }}</span>
                    <span class="ver-tag">计划中</span>
                </div>
                <ul class="ver-items">
                    <li v-for="(it, i) in v.items" :key="i">{{ it }}</li>
                </ul>
            </div>

            <div class="about-section">规则备份</div>
            <div class="about-actions">
                <button class="ghost" @click="onExport">导出所有规则</button>
                <label class="ghost file-label">
                    导入规则
                    <input type="file" accept="application/json,.json" @change="onImport" />
                </label>
            </div>
            <div class="about-hint">换电脑、重装浏览器之前先导出一份。</div>
        </div>

        <!-- ═══════════ 智能模式：等待点选 ═══════════ -->
        <div v-else-if="smartStatus === 'waiting'" class="smart-wait">
            <div class="smart-icon">🪄</div>
            <div class="smart-title">在页面上点一下那个广告</div>
            <div class="smart-sub">点图片、标题、角标都行，不用管选到哪一层</div>
            <button class="ghost smart-cancel" @click="cancelSmart">取消</button>
        </div>

        <!-- ═══════════ 智能模式：推断结果 ═══════════ -->
        <div v-else-if="smartStatus === 'result' && smartResult" class="smart-result">
            <div class="smart-icon">✅</div>
            <div class="smart-title">看懂了</div>
            <div class="smart-reason">{{ smartResult.reason }}</div>

            <!-- 找到区分特征 → 只拦那几个 -->
            <template v-if="smartResult.condition">
                <div class="smart-proposal">
                    我拦这 <b>{{ smartResult.condition.count }}</b> 个，可以吗？
                </div>
                <div class="smart-syntax">{{ smartResult.unitSelector }} 含「{{ smartResult.condition.value }}」</div>
                <div class="smart-actions">
                    <button class="primary" @click="confirmSmart('suggested')">就这么拦</button>
                    <button class="ghost" @click="tuneSmart">调整</button>
                </div>
                <button class="smart-alt" @click="confirmSmart('all')">
                    不对，把这一类的 {{ smartResult.unitCount }} 个全拦掉
                </button>
            </template>

            <!-- 没找到区分特征 → 只能全拦，必须先警告 -->
            <template v-else>
                <div class="smart-warn">
                    {{ smartResult.reason }}直接拦会把整片内容都干掉，所以先不动。
                </div>
                <div class="smart-actions">
                    <button class="ghost" @click="cancelSmart">算了</button>
                    <button class="ghost danger" @click="tuneSmart">我自己挑</button>
                </div>
            </template>

            <button class="smart-rerun" @click="startSmart">重新点一次</button>
        </div>

        <!-- ═══════════ 规则列表 ═══════════ -->
        <template v-else-if="!picking">
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
                    v-for="r in rules"
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
                            {{ r.label || r.selector }}
                            <span v-if="!r.enabled" class="off-tag">已停用</span>
                        </div>
                        <div v-if="r.selector !== r.label" class="rule-sel">{{ r.selector }}</div>
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
            </div>

            <footer class="foot">
                <button class="primary smart-main" :disabled="!canWork" @click="startSmart">
                    🪄 点一下广告，剩下的我来
                </button>
                <button class="ghost smart-manual" :disabled="!canWork" @click="startPick">
                    手动选（像 F12 一样）
                </button>
            </footer>
        </template>

        <!-- ═══════════ 选择模式 ═══════════ -->
        <template v-else>
            <div class="pick-head">
                <div class="pick-title">{{ editingId ? '修改规则' : '选择模式' }}</div>
                <div class="pick-hint">
                    鼠标在页面上移动，点一下选中；要往外扩一层，就在下边点它的上级
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

            <div ref="treeEl" class="tree">
                <div
                    v-for="(el, i) in chain"
                    :key="i"
                    class="row"
                    :class="{ current: i === currentIndex }"
                    :style="{ paddingLeft: 8 + i * 10 + 'px' }"
                    @click="selectAncestor(i)"
                    @mouseenter="hoverAncestor(i)"
                >
                    <span class="tag">{{ el.tag }}</span>
                    <span v-if="el.id" class="id">#{{ el.id }}</span>
                    <span v-for="c in el.classes.slice(0, 2)" :key="c" class="cls">.{{ c }}</span>
                    <span class="size">{{ el.width }}×{{ el.height }}</span>
                </div>
                <div v-if="chain.length === 0" class="tree-empty">
                    把鼠标移到页面上
                </div>
            </div>

            <div class="pick-info">
                <div class="info-row">
                    <span class="k">选择器</span>
                    <span class="v">{{ finalSelector || '—' }}</span>
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
                <div v-if="broadCount > 1" class="broad-hint">
                    按 <code>{{ broadSelector }}</code> 拦 → 页面上有 <b>{{ broadCount }}</b> 个同款（已用蓝色虚线标出）
                </div>

                <!-- 选择器太长 / 依赖位置结构时提醒一句：这种规则站点改版就容易失效 -->
                <div v-if="pickScope === 'one' && (selector.includes('nth-of-type') || selector.length > 60)" class="sel-warn">
                    这条选择器依赖页面结构，站点改版后可能失效 —— 建议在树里往上一层选个带类名的容器
                </div>
                <div class="info-row">
                    <span class="k">命中</span>
                    <span class="v" :class="{ warn: finalCount > 1 }">
                        {{ finalCount < 0 ? '选择器无效' : finalCount + ' 个元素' }}
                    </span>
                </div>
            </div>

            <footer class="foot three">
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
                    {{ editingId ? '保存修改' : '拦截这个' }}
                </button>
            </footer>
        </template>

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
.title { font-size: 15px; font-weight: 600; }
.site { margin-top: 3px; font-size: 12px; color: #86909c; }

.head { display: flex; align-items: center; gap: 10px; }
.head-main { flex: 1; min-width: 0; }

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
    display: flex;
    align-items: center;
    gap: 8px;
    background: #fff;
    border-radius: 9px;
    padding: 10px;
    margin-bottom: 8px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
    cursor: default;
}
.rule.off { opacity: .72; }

.check {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: 5px;
    border: 1.5px solid #c9cdd4;
    background: #fff;
    color: #fff;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
}
.check.on { background: #00aeec; border-color: #00aeec; }

.rule-main { flex: 1; min-width: 0; }
.rule-label {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.rule-sel {
    margin-top: 2px;
    font-size: 11.5px;
    color: #86909c;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.off-tag {
    margin-left: 6px;
    padding: 1px 5px;
    border-radius: 4px;
    background: #f2f3f5;
    color: #86909c;
    font-size: 10.5px;
    font-weight: 400;
}

.count {
    flex: none;
    min-width: 22px;
    height: 20px;
    padding: 0 6px;
    border-radius: 10px;
    background: #f2f3f5;
    color: #86909c;
    font-size: 11px;
    line-height: 20px;
    text-align: center;
}
.count.multi { background: #fff7e8; color: #ff7d00; }
.count.zero { background: #ffece8; color: #f53f3f; }

.icon {
    flex: none;
    width: 28px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #e5e6eb;
    border-radius: 7px;
    background: #fff;
    color: #4e5969;
    cursor: pointer;
    padding: 0;
}
.icon:hover { border-color: #00aeec; color: #00aeec; }
.icon.danger:hover { border-color: #f53f3f; color: #f53f3f; }

/* ── 智能模式 ── */
.smart-wait, .smart-result {
    flex: 1;
    overflow-y: auto;
    padding: 36px 20px 20px;
    background: #fff;
    text-align: center;
}
.smart-icon { font-size: 34px; line-height: 1.2; }
.smart-title { margin-top: 10px; font-size: 15px; font-weight: 600; }
.smart-sub { margin-top: 6px; font-size: 12.5px; color: #86909c; line-height: 1.7; }
.smart-cancel {
    margin-top: 22px;
    width: auto;
    padding: 0 22px;
    height: 34px;
    border: 1px solid #d9d9d9;
    border-radius: 17px;
    background: #fff;
    color: #4e5969;
    font-size: 13px;
    cursor: pointer;
}

.smart-reason {
    margin-top: 8px;
    font-size: 13px;
    color: #1f2329;
    line-height: 1.8;
}
.smart-proposal { margin-top: 16px; font-size: 14px; }

.smart-syntax {
    margin-top: 8px;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11.5px;
    color: #86909c;
    word-break: break-all;
}
.smart-actions {
    display: flex;
    gap: 10px;
    margin-top: 18px;
    justify-content: center;
}
.smart-actions .primary {
    flex: 1;
    height: 38px;
    border: none;
    border-radius: 19px;
    background: #00aeec;
    color: #fff;
    font-size: 13.5px;
    cursor: pointer;
}
.smart-actions .ghost {
    flex: none;
    min-width: 84px;
    height: 38px;
    border: 1px solid #d9d9d9;
    border-radius: 19px;
    background: #fff;
    color: #4e5969;
    font-size: 13px;
    cursor: pointer;
}
.smart-actions .ghost.danger { color: #f53f3f; border-color: #ffccc7; }

.smart-alt, .smart-rerun {
    margin-top: 16px;
    border: none;
    background: transparent;
    color: #86909c;
    font-size: 12px;
    text-decoration: underline;
    cursor: pointer;
    display: block;
    width: 100%;
}
.smart-warn {
    margin-top: 14px;
    padding: 10px 12px;
    background: #fff7e8;
    border-radius: 8px;
    color: #d25f00;
    font-size: 12px;
    line-height: 1.7;
    text-align: left;
}

.foot { display: flex; flex-direction: column; gap: 8px; }
.smart-main {
    width: 100%;
    height: 40px;
    border: none;
    border-radius: 20px;
    background: #00aeec;
    color: #fff;
    font-size: 14px;
    cursor: pointer;
}
.smart-main:disabled { background: #c9cdd4; cursor: not-allowed; }
.smart-manual {
    width: 100%;
    height: 32px;
    border: 1px solid #e5e6eb;
    border-radius: 16px;
    background: #fff;
    color: #86909c;
    font-size: 12px;
    cursor: pointer;
}

/* ── 底部按钮 ── */
.foot {
    flex: none;
    padding: 10px 12px;
    background: #fff;
    border-top: 1px solid #e5e6eb;
}
.foot.two { display: flex; gap: 10px; }
.foot.three { display: flex; gap: 8px; }
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
    padding: 10px 14px;
    background: #fff;
    border-bottom: 1px solid #f2f3f5;
}
.pick-title { font-size: 13.5px; font-weight: 600; }
.pick-hint { margin-top: 3px; font-size: 11.5px; color: #86909c; line-height: 1.6; }

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
.tree-empty { padding: 30px 14px; color: #86909c; font-size: 12px; text-align: center; }

.row {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding-right: 10px;
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
}
.row:hover { background: #f2f9fd; }
.row.current { background: #e6f7ff; box-shadow: inset 2px 0 0 #00aeec; }

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
