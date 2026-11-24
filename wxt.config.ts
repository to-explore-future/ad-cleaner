import { defineConfig } from 'wxt';

export default defineConfig({
    modules: ['@wxt-dev/module-vue'],

    manifest: {
        name: '广告清道夫',
        description: '像 F12 一样在页面上点选要拦的东西，还能沿着 DOM 树往外扩。',
        default_locale: undefined,
        permissions: ['storage', 'scripting'],
        host_permissions: ['<all_urls>'],
        action: {
            default_title: '广告清道夫',
        },
        side_panel: {
            default_path: 'sidepanel.html',
        },
    },
});
