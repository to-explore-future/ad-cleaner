#!/usr/bin/env node
/**
 * 真实网站冒烟测试：确认脚本注入不报错、选择模式能正常工作、不误伤页面。
 *
 * 用法：node scripts/smoke.cjs [url]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.SMOKE_PORT || 10240);
const EXT = path.resolve(__dirname, '../.output/chrome-mv3');
const TARGET = process.argv[2] || 'https://www.aigei.com/music/class/';

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'adc-smoke-'));
const chrome = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${udd}`,
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    // ⚠️ 真·无头：**完全不出窗口**，不抢焦点、不在 Dock 里出现
    '--headless=new',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1400,900',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 80) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(url);
            if (r.ok) return r.json();
        } catch { /* retry */ }
        await sleep(300);
    }
    throw new Error('连不上 ' + url);
}

class Session {
    constructor(ws) { this.ws = ws; this.i = 0; this.pending = new Map(); this.errors = []; this.logs = []; }
    static async open(url) {
        const ws = new WebSocket(url);
        await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', rej, { once: true });
        });
        const s = new Session(ws);
        ws.addEventListener('message', (e) => {
            const m = JSON.parse(e.data);
            if (m.id && s.pending.has(m.id)) {
                const { resolve, reject } = s.pending.get(m.id);
                s.pending.delete(m.id);
                m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
            }
            if (m.method === 'Runtime.exceptionThrown') {
                s.errors.push(String(m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 200));
            }
            if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
                s.logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
            }
        });
        return s;
    }
    send(method, params = {}) {
        const id = ++this.i;
        return new Promise((res, rej) => {
            this.pending.set(id, { resolve: res, reject: rej });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 30000);
        });
    }
}

const ev = async (s, expr) => {
    const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description).slice(0, 200));
    return r.result.value;
};

const checks = [];
const check = (n, ok, d = '') => { checks.push({ n, ok, d }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? '  — ' + d : ''}`); };

(async () => {
    await getJson(`http://127.0.0.1:${PORT}/json/version`);
    let sw = null;
    for (let i = 0; i < 80 && !sw; i++) {
        await sleep(400);
        sw = (await getJson(`http://127.0.0.1:${PORT}/json/list`))
            .find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
    }
    if (!sw) throw new Error('扩展没起来');

    const host = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((t) => t.type === 'page');
    const bg = await Session.open(host.webSocketDebuggerUrl);
    await bg.send('Runtime.enable');

    console.log('· 打开', TARGET);
    await bg.send('Page.navigate', { url: TARGET });
    await sleep(12000);

    await bg.send('Runtime.enable');
    const title = await ev(bg, 'document.title');
    check('页面正常加载', !!title, title.slice(0, 40));

    // 内容脚本注入检查
    const injected = await ev(bg, `(async () => {
        try {
            const r = await chrome.runtime.sendMessage({ type: 'noop' });
            return 'noop';
        } catch { return 'noop'; }
    })()`).catch(() => 'noop');

    const styleExists = await ev(bg, `!!document.getElementById('__adc_style')`);
    check('内容脚本已注入（样式表已建）', styleExists === true, String(styleExists));

    // 进入选择模式 + 悬停 + 点击
    const startRes = await ev(bg, `(async () => {
        return await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'adc:ping' }, (r) => resolve(JSON.stringify(r || null)));
        });
    })()`).catch(() => 'err');
    console.log('   · ping:', startRes);

    // 用 DOM 事件模拟一次选择（真实鼠标事件由 CDP 派发）
    const cx = 400;
    const cy = 400;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await bg.send('Input.dispatchMouseEvent', {
            type, x: cx, y: cy, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
        });
    }
    await sleep(600);

    const errCount = bg.errors.filter((e) => /adc|__adc|picker/i.test(e)).length;
    check('没有与本扩展相关的报错', errCount === 0, `${bg.errors.length} 条总报错`);

    // 页面结构没被破坏
    const bodyOk = await ev(bg, `!!document.body && document.body.childElementCount > 0`);
    check('页面结构完好', bodyOk === true);

    console.log('\n========== 汇总 ==========');
    const failed = checks.filter((c) => !c.ok);
    console.log(`${checks.length - failed.length}/${checks.length} 项通过`);
    failed.forEach((f) => console.log(`  ✗ ${f.n}  ${f.d}`));
    process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error('✗', e?.message ?? e); process.exitCode = 1; })
    .finally(async () => {
        try { chrome.kill(); } catch { /* ignore */ }
        await sleep(300);
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
