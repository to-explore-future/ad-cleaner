/**
 * 后台只干一件事：点工具栏图标就打开侧边栏。
 *
 * 其它工作（读规则、应用规则）都由「侧边栏」和「内容脚本」直接做 ——
 * 它们都能访问 `chrome.storage.local`，不需要绕一层后台，
 * 少一层转发就少一处可能出错的地方。
 */
export default defineBackground(() => {
    const open = () => {
        chrome.sidePanel
            .setPanelBehavior({ openPanelOnActionClick: true })
            .catch((e) => console.warn('[广告清道夫] setPanelBehavior 失败', e));
    };
    chrome.runtime.onInstalled.addListener(open);
    open();
});
