// Skeptic check: if the frame pauses on window blur and the pause UI focuses its Resume button
// (ui.showPause -> _focus(resume)), does that steal focus back from the host page's text field?
import http from 'node:http';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const inner = `<!doctype html><body style="margin:0"><button id=b style="display:none">Resume</button><canvas id=c width=300 height=200 style="background:#48a"></canvas><script>
const c = document.getElementById('c'), b = document.getElementById('b');
c.addEventListener('mousedown', (e) => { e.preventDefault(); if (!document.hasFocus()) window.focus(); });
addEventListener('blur', () => { b.style.display = 'block'; b.focus({ preventScroll: true }); parent.postMessage('paused', '*'); });
addEventListener('keydown', (e) => parent.postMessage('key:' + e.code, '*'));
</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  if (u.pathname === '/inner') { res.end(inner); return; }
  res.end(`<!doctype html><body style="margin:0"><input id=chat style="position:absolute;left:10px;top:300px"><iframe id=f sandbox="${u.searchParams.get('sb')}" src="/inner" style="border:0;width:300px;height:200px"></iframe><script>window.got=[];addEventListener('message',e=>got.push(e.data))</script>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
for (const sb of ['allow-scripts', 'allow-scripts allow-same-origin']) {
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/outer?sb=${encodeURIComponent(sb)}`);
  await page.waitForTimeout(300);
  await page.mouse.click(150, 150); await page.waitForTimeout(100);
  await page.keyboard.press('KeyA');
  await page.click('#chat'); await page.waitForTimeout(200);
  await page.keyboard.press('KeyW');
  const r = await page.evaluate(() => ({ got: window.got, chat: document.getElementById('chat').value, active: document.activeElement.id || document.activeElement.tagName }));
  console.log(sb.padEnd(34), JSON.stringify(r));
  await page.close();
}
await browser.close(); server.close();
