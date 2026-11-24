/** 极简静态服务器，只为测试页服务。 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, 'fixture');
const PORT = Number(process.env.FIXTURE_PORT || 8941);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
    });
}).listen(PORT, () => console.log(`fixture server: http://127.0.0.1:${PORT}/`));
