# 广告拦截助手（liubai）· 项目约定

浏览器扩展：像 F12 一样在页面上点选要拦的元素，**并且能沿着 DOM 树往外扩一层再拦**。
WXT + Vue 3 + CDP 自测。MV3。

目录：`/Users/tcxt/zq/web/wxt/adBlocker`

---

## ⚠️ 版本号规则（用户明确要求，必须遵守）

**三段 `A.B.C`，每一位最大 9，满 9 进位到左边一位并从 0 开始。**

```
0.0.1 → 0.0.2 → … → 0.0.9 → 0.1.0 → … → 0.9.9 → 1.0.0 → …
```

- **唯一源头是 `package.json` 的 `version`**（WXT 会把它写进 manifest；
  不要在 `wxt.config.ts` 里再写一份，两处会打架）
- **每次改动就 +1**
- 不加 `-beta` 之类后缀

当前：`0.3.0`

---

## 产品要解决的问题

Adblock Plus / uBlock 的元素选择器有个硬伤：**浏览器的命中测试永远返回最里层的元素**。

```html
<div class="ad-box">        ← 用户真正想拦的
  <div class="ad-wrap">
    <div class="ad-inner">  ← 鼠标实际命中的
      <img>
```

拦住最里层只藏掉一张图，外层空白框还在。想往外走只能盲按快捷键，看不见结构。

**我们的解法：右侧面板给一棵 DOM 祖先链**，点哪一层就选哪一层，页面高亮同步变大。

## 核心交互（改动前先读，别破坏这套语义）

| 场景 | 行为 |
|---|---|
| 进入选择模式后**悬停**页面（未选中） | 高亮最里层元素，右侧树**实时**跟着变（F12 那种对应） |
| **点击**页面 | 选中并锁定：框变绿钉住，鼠标再滑**框/树/选择器全都不变** |
| **再点一下已选中的元素**（或它内部） | **取消选中**，回到悬浮模式（鼠标滑动重新联动） |
| 点页面**另一个**元素 | 换目标，**仍保持选中**（不恢复悬浮） |
| 点右侧树里的**祖先**行 | 选中层往外扩一层，左侧高亮框跟着变大（仍保持选中） |
| 悬停右侧树里的行 | 页面上高亮对应那一层（不改选中） |
| 悬浮**规则列表**里的某条 | 页面标出它会影响的所有元素 |

**为什么"点击后才锁定"**：不锁的话，用户想把鼠标移到右侧去点祖先时，鼠标一离开页面元素，树就变了，根本点不中。

## 锁定后"页面自己在变"的真凶：重复重画

用户反馈"选中之后标签还在变"。本地测锁定状态完全一致，最后在真页面找到原因：

**面板的轮询（60ms）里在重复发 `adc:markMatches`**，而内容脚本的 `showMatches` 每次
都"先摘掉所有 `__adc_match` 再加回去"。22 个元素 × 每秒 16 次 = **虚线框一直在闪**，
看起来就是"还在变"。

两条规矩：
1. `showMatches` 里**选择器没变就直接返回**（`lastMatchSelector` 缓存）；
2. 面板轮询**只切范围，绝不发 markMatches** —— 内容脚本在鼠标移动时本来就会自己标。

`npm run probe:lock` 在真 B 站页面上验"锁定后框/标签/树/选择器全都不变"。

## 同类高亮（核心差异点）

指着一个元素时，页面上要把**所有同款元素**用蓝色虚线一起标出来，
并在面板上写「页面上同样结构的还有 N 个」。

为什么：Adblock Plus 只告诉你"这一条选中了"，**不告诉你这一刀会砍掉多少**。
用户要的是"按下去之前就知道波及范围"。

实现要点：
- `buildBroadSelector()` 生成**不要求唯一**的宽选择器，
  和保存用的精确选择器分开；
- **宽选择器必须用「单个 class」**，不能一上来拼两个类。
  踩过：B 站卡片有 `floor-single-card / floor-card / single-card` 三个类，
  拼成 `div.floor-single-card.floor-card` 后全站只剩 1 个，用户以为"没法按 class 拦"。
  正确做法：先试 `tag.class1`（可能是几十个），命中 2~300 个就采用；
- **默认就按 class 拦**（`pickScope` 自动切到 broad），用户可手动改成"只这一个"；
- 面板给「这一个 / 同类 N」两档，默认只拦一个，但**同类始终标出来**；
- 超过 300 个就不标（避免把页面拖卡）。

⚠️ 内部标记类（`__adc_match` / `__adc_outline`）**绝不能**出现在
类名显示或选择器里 —— `utils/selector.ts` 里统一用 `isOurMarkerClass()` 过滤。

## 「显示拦截效果」开关（默认开）

规则生效后元素已被隐藏，页面上没东西可高亮 —— 所以悬浮时要把这条规则**从注入的样式里临时摘掉**，元素就自然显形了（虚线框标出），移开再塞回去。

- **不要**用 `display: revert !important` 之类的覆盖去"强行显形"：页面自己的 `display:flex` 会被一起干掉，看着不对。
  **临时改样式表文本**才是正确的做法（见 `rewriteStyle()` 的 `previewExclude`）。

## 选择器生成的三条铁律

1. **优先生成类名选择器**（`div.ad-box`），**位置选择器（`:nth-of-type`）只作兜底** ——
   位置一改就失效，类名通常更稳。
2. **唯一性必须实测**（`querySelectorAll(sel).length === 1`），不能靠推断。
3. 过滤掉构建工具生成的哈希类名（`css-1x2y3z` / `sc-xxx` / 带数字的长串）。

## 规则存储

`chrome.storage.local['blockRules']` = `Record<domain, BlockRule[]>`，按 **hostname 精确匹配**，不跨站。

`chrome.storage.local['settings']` = `{ showEffect: boolean }`。

## Git 工作流

**仓库：https://github.com/to-explore-future/ad-cleaner（public），分支 `main`。**

- 每次版本号 +1 之后**提交一次**，message 写清这版做了什么
- 不 push、不加远端（除非用户明确要求）
- 探索性的改动如果被退回，**开个 `wip/xxx` 分支留档**，别直接删：
  `git checkout -b wip/xxx` → 提交 → `git checkout master`
- `.gitignore` 里已经排除 `node_modules/ .output/ .wxt/ .dev-profile/ .chrome-profile/ *.zip`
- ⚠️ **这台机器上推 GitHub 必须走代理**（已在本仓库 local config 里配好，不影响别的仓库）：
  `git config http.proxy http://127.0.0.1:7897`，否则报
  `Failed to connect to github.com port 443` 或 `HTTP2 framing layer`

## 两条命令

```bash
npm run dev      # 开发（wxt）
npm run build    # 发布 → .output/chrome-mv3
npm run verify   # 端到端自测（21 项）
npm run compile  # 类型检查
```

---

## 自测：必须用 CDP 真的去点，而且**必须是无头**

`scripts/verify.cjs` 会：
- 起一个 **`--headless=new`** 的 Chrome 实例 —— **完全不出窗口**，不抢焦点、不在 Dock 出现
  （用户明确要求：验证时不要动用他本机的浏览器窗口，会影响他干活）
- 打开 `scripts/fixture/index.html`（本地 8941 端口，`node scripts/server.cjs`）
- **真的派发鼠标事件**（`Input.dispatchMouseEvent`）到页面上，不是纯 JS 模拟
- 断言页面元素的 computed style、面板的 DOM 文本

### 为什么不用 DSH 自带的浏览器窗格

DSH 右侧那个「浏览器」是 App 内嵌的预览视图，**不是可编程的 Chromium 用户目录**：
它不能装未打包扩展（`--load-extension`），也没有暴露给我 CDP 或任何控制接口。
浏览器扩展必须在真实 Chromium profile 里跑，所以只能用无头 Chrome。

**无头模式下依旧零窗口**（实测：跑测试期间 `CGWindowListCopyWindowInfo` 里可见的 Chrome 窗口数 = 0），
截图用 `Page.captureScreenshot` 拿，用户完全无感。

⚠️ 侧边栏当普通标签页打开时，`chrome.tabs.query({active:true})` 会拿到它自己。
所以面板支持 `?tabId=<id>` 显式指定要操作的标签页（**只给测试用，生产不受影响**）。

## 踩过的坑

- **「重新加载扩展」之后，已打开页面里的旧内容脚本会变成死上下文** ——
  `chrome.storage` 直接变成 `undefined`，任何 `chrome.*` 调用都抛异常。
  而它还在跑定时器/监听，于是**控制台每 0.8 秒刷一条红字**，直到用户刷新页面。
  实测证据（重载后立刻读页面里的 chrome）：
  `{"storage":"undefined","runtimeId":null,"getOk":false}`。
  **规矩**：定时器一律用 wxt 的 `ctx.setInterval`（上下文失效后自动停），
  所有 `chrome.*` 调用外面都要有 `ctxAlive()` 或 try/catch 兜底。
  `npm run probe:reload` 专门验这条。


- **`chrome.sidePanel` 的 manifest 权限名是 `sidePanel`**，WXT 会自动补。
- **覆盖层必须 `pointer-events: none`**，否则 `elementFromPoint` 命中的是覆盖层自己。
- **覆盖层要用 Shadow DOM**，否则页面的 CSS 会把它改得面目全非。
- **内容脚本在 `document_start` 跑**，此时 `document.head` 可能还不存在，注入样式要兜底到 `documentElement`。
- **单页应用切页面不会重载内容脚本**，要用定时器比对 `location.href` 重新应用规则。
- **`remove` 类规则没法用 CSS 做**，只能真删节点 + `MutationObserver` 盯动态内容。
- **`remove` 类规则无法预览**（节点已经不在 DOM 里了），面板要明说，不要静默。

## 还没做（下一步）

- 导入/导出规则（备份）
- 规则跨设备同步（`chrome.storage.sync`）
- 过滤规则列表订阅（网络层拦截）
- Firefox 适配（`sidePanel` 是 Chrome 独有的，FF 要用 `sidebar_action`）
