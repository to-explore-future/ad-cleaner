# 交接说明（给接手的人）

## 这个项目是什么

Chrome/Edge 扩展（MV3），WXT 0.20 + Vue 3.5 + Vite 8。
功能：像 F12 一样在网页上点选元素，沿 DOM 树往外/往里选，然后隐藏或删除。
面板是完整 DOM 树（可展开、可勾选组合成规则）。

## 怎么跑

```bash
npm install
npm run build          # 产物 .output/chrome-mv3
npm run dev            # 开发模式
npm run compile        # 类型检查
```

Chrome → `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `.output/chrome-mv3`

## 自测（全部无头，不弹窗口）

```bash
node scripts/server.cjs &     # 本地测试页 :8941
node scripts/verify-real.cjs  # 生产路径端到端，79 项
node scripts/verify.cjs       # 完整套件，25 项
```

## 代码结构

```
entrypoints/picker.content/index.ts   页面侧：高亮框、DOM 树、选择/锁定、规则执行
entrypoints/sidepanel/app.vue         面板 UI（单个大组件）
utils/types.ts                        规则数据结构
utils/rules.ts                        存储、CSS 生成、导入导出
scripts/verify*.cjs                   CDP 自动化测试
scripts/fixture/index.html            测试页
```

## 已完成（有测试）

- F12 式点选：悬停跟随 / 点击锁定 / 再点取消
- 完整 DOM 树：展开收起、点节点选中、悬停高亮页面
- 树里显示**开标签源码**（全部属性），可全局换行 / 单个节点折叠成单行
- 同类识别（按 class），命中数显示，可"只这一个 / 同类"
- 隐藏 / 删除两种方式
- 预览效果（真应用一次再恢复）
- 组合标签规则：勾多层 + 层级差 + 每段可加文字约束
- 规则列表：本页/本网站筛选、开关、编辑、删除、命中数、导入导出
- 面板可弹出成独立窗口（⧉）
- 104 项自动化测试（79 + 25）

## 已知问题（**未修完**）

1. 树里"当前行"标记时有时无
   相关内容脚本 `buildTree()` 的 `current` 判断（元素比对 + 路径兜底）。
   已有 ⑬ 守着"锁定后当前行不变"，但极端重排下仍可能有偏差。

> 0.2.2 已修：锁定后树跟随页面变化（⑭ 曾失败）、导入丢条件/组合字段、
> 条件/组合规则的命中数与悬浮预览按 selector 粗算。对应测试 ⑭ / ⑧b / ⑩。

## 关键约定（改之前必读）

见 `REGRESSIONS.md`：22 条改坏过的问题，每条都有对应测试。
其中第 2 条（锁定后树不许变）已经被改坏三次，改相关代码务必跑 ⑬/⑭。
