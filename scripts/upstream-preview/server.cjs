const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('./catalog.cjs');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.bmp': 'image/bmp' };
function within(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function createServer(config) {
  if (!config) throw new Error('Unknown upstream application');
  if (!config.entry) throw new Error(`${config.id}: ${config.limitation}`);
  const root = fs.realpathSync(config.root);
  const entry = fs.realpathSync(path.join(root, config.entry));
  if (!within(root, entry) || !fs.statSync(entry).isFile()) throw new Error('Invalid upstream entrypoint');
  return http.createServer((req, res) => {
    res.setHeader('X-Upstream-Preview', 'original-assets-only');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('Method not allowed');
    }
    let requested;
    try { requested = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch { res.writeHead(400); return res.end('Invalid URL'); }
    if (requested.includes('\0') || requested.includes('\\')) { res.writeHead(400); return res.end('Invalid path'); }
    // Redirect preserves upstream-relative script/style URLs without rewriting HTML.
    if (requested === '/') {
      res.writeHead(302, { Location: '/' + config.entry }); return res.end();
    }
    try {
      const candidate = path.resolve(root, '.' + requested);
      if (!within(root, candidate)) { res.writeHead(403); return res.end('Outside upstream root'); }
      const file = fs.realpathSync(candidate);
      if (!within(root, file)) { res.writeHead(403); return res.end('Outside upstream root'); }
      const stat = fs.statSync(file);
      if (!stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      res.writeHead(['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500);
      res.end('Upstream asset unavailable');
    }
  });
}
function start(id) {
  const config = catalog.find(app => app.id === id);
  try {
    const server = createServer(config);
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(config.port, '127.0.0.1', () => {
      console.log(`${id}: original assets at http://127.0.0.1:${config.port}/${config.entry}`);
      console.log(config.limitation);
    });
    return server;
  } catch (error) {
    console.error(`${id}: preview unavailable: ${error.message}`);
    if (config) console.error(config.limitation);
    process.exitCode = 1;
  }
}
module.exports = { createServer, start };
if (require.main === module) start(process.argv[2]);
