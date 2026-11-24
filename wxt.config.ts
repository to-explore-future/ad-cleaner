import { defineConfig } from 'wxt';

export default defineConfig({
    modules: ['@wxt-dev/module-vue'],

    manifest: {
        name: '广告拦截助手',
        description: '像 F12 一样在页面上点选不想看的内容，把它留空；还能沿着 DOM 树往外扩一层。',
        default_locale: undefined,
        // 商店里"主页"会显示这个，指向产品介绍页
        homepage_url: 'https://tianrunye.com/adcleaner',
        permissions: ['storage', 'scripting'],
        host_permissions: ['<all_urls>'],
        action: {
            default_title: '广告拦截助手',
        },
        side_panel: {
            default_path: 'sidepanel.html',
        },
    },
});
