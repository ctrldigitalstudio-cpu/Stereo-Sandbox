// Skeptic check: in an opaque-origin sandboxed iframe (sandbox="allow-scripts", like a hosted artifact),
// does mousedown preventDefault block frame focus, and does window.focus()/canvas.focus() in mousedown fix it?
import http from 'node:http';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const inner = (mode) => `<!doctype html><body style="margin:0"><canvas id=c width=300 height=200 ${mode === 'tabindex' ? 'tabindex="-1"' : ''} style="background:#48a;outline:none"></canvas><script>
const c = document.getElementById('c');
c.addEventListener('mousedown', (e) => {
  e.preventDefault();
  if ('${mode}' === 'winfocus' && !document.hasFocus()) window.focus();
  if ('${mode}' === 'tabindex') c.focus({ preventScroll: true });
});
addEventListener('keydown', (e) => parent.postMessage('key:' + e.code, '*'));
</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/inner') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(inner(u.searchParams.get('mode'))); return; }
  const mode = u.searchParams.get('mode');
  const host = u.searchParams.get('xo') ? `http://localhost:${server.address().port}` : '';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><body style="margin:0"><input id=chat style="position:absolute;left:10px;top:300px"><iframe id=f sandbox="${u.searchParams.get('sb') || 'allow-scripts'}" src="${host}/inner?mode=${mode}" style="border:0;width:300px;height:200px"></iframe><script>window.got=[];addEventListener('message',e=>got.push(e.data))</script>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch();
for (const [mode, sb] of [['none', 'allow-scripts'], ['winfocus', 'allow-scripts'], ['tabindex', 'allow-scripts'], ['none', 'allow-scripts allow-same-origin'], ['winfocus', 'allow-scripts allow-same-origin']]) {
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  await page.goto(`http://127.0.0.1:${port}/outer?mode=${mode}&sb=${encodeURIComponent(sb)}`);
  await page.waitForTimeout(300);
  await page.mouse.click(150, 100); await page.waitForTimeout(100);
  await page.keyboard.press('KeyA');
  await page.click('#chat');
  await page.mouse.click(150, 100); await page.waitForTimeout(100);
  await page.keyboard.press('KeyW');
  const r = await page.evaluate(() => ({ got: window.got, chat: document.getElementById('chat').value, active: document.activeElement.id || document.activeElement.tagName }));
  console.log(mode.padEnd(9), sb.padEnd(34), JSON.stringify(r));
  await page.close();
}
await browser.close(); server.close();
