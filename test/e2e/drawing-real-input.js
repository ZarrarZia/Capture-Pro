// Drawing mode driven by REAL Windows mouse and keyboard input (SendInput), so window stacking and
// focus behave exactly as for a user. Regression test for: "after drawing, toolbar clicks draw marks
// instead of working (no undo, eraser or colour change)".
// Usage: node test/e2e/drawing-real-input.js
const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One PowerShell per action; coordinates are physical pixels (the script opts into per-monitor DPI
// awareness, otherwise Windows would rescale every coordinate on scaled displays).
const DEF = `Add-Type -Namespace W -Name U -ReferencedAssemblies System.Drawing -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);
[DllImport("user32.dll")] public static extern void keybd_event(byte k,byte s,int f,int e);
[DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(System.Drawing.Point p);
[DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr h, uint f);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr c);';
[void][W.U]::SetProcessDpiAwarenessContext([System.IntPtr](-4));`; // per-monitor DPI aware: coordinates are real physical pixels
const ps = (body) => execFileSync('powershell', ['-NoProfile', '-Command', `${DEF} ${body}`], { encoding: 'utf8' }).trim();
const click = (p) => ps(`[W.U]::SetCursorPos(${p.x},${p.y}); Start-Sleep -Milliseconds 60; [W.U]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 40; [W.U]::mouse_event(4,0,0,0,0); Start-Sleep -Milliseconds 150`);
const drag = (a, b) => ps(`[W.U]::SetCursorPos(${a.x},${a.y}); [W.U]::mouse_event(2,0,0,0,0); for($i=1;$i -le 12;$i++){ [W.U]::SetCursorPos(${a.x}+(${b.x - a.x})*$i/12, ${a.y}+(${b.y - a.y})*$i/12); Start-Sleep -Milliseconds 15 }; [W.U]::mouse_event(4,0,0,0,0); Start-Sleep -Milliseconds 200`);
const keys = (seq) => ps(seq.map(([vk, up]) => `[W.U]::keybd_event(${vk},0,${up ? 2 : 0},0)`).join('; ') + '; Start-Sleep -Milliseconds 200');
const tap = (...vks) => keys([...vks.map((v) => [v, false]), ...vks.reverse().map((v) => [v, true])]);
const hwndAt = (p) => ps(`[W.U]::GetAncestor([W.U]::WindowFromPoint((New-Object System.Drawing.Point ${p.x},${p.y})),2).ToInt64()`);

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'capturepro-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ mode: 'full', general: { outputDir: path.join(profile, 'out') } }));
  const env = { ...process.env, CAPTUREPRO_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [ROOT], env, cwd: ROOT });
  try {
    await app.evaluate(() => { global.__errs = []; process.prependListener('uncaughtException', (e) => global.__errs.push(String(e.stack))); });
    let main;
    for (let i = 0; i < 50 && !main; i++) { main = app.windows().find((w) => w.url().includes('main/index.html')); if (!main) await sleep(200); }
    await main.waitForSelector('.card');
    await main.click('#btn-draw');
    await sleep(2000);
    const live = async (part) => { for (const w of app.windows().filter((x) => x.url().includes(part)).reverse()) if (await w.evaluate(() => 1).then(() => 1, () => 0)) return w; return null; };
    const bar = await live('drawbar.html');
    const ov = await live('overlay.html');
    const shapes = () => ov.evaluate(() => drawing.shapes.length);
    const tool = () => bar.evaluate(() => document.querySelector('[data-tool].on')?.dataset.tool);
    const color = () => bar.evaluate(() => document.querySelector('.swatch.on')?.dataset.color);

    // Physical screen point of a toolbar element's centre.
    const at = async (selector) => {
      const r = await bar.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, selector);
      return app.evaluate(({ BrowserWindow, screen }, r) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('drawbar.html'));
        const b = w.getContentBounds();
        const p = screen.dipToScreenPoint({ x: b.x + r.x, y: b.y + r.y });
        return { x: Math.round(p.x), y: Math.round(p.y) };
      }, r);
    };
    const barHwnd = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('drawbar.html')).getNativeWindowHandle().readBigInt64LE().toString());
    const toolbarOnTop = async () => assert.equal(hwndAt(await at('#undo')), barHwnd, 'toolbar is on top of the drawing overlay');

    console.log('draw a stroke');
    drag({ x: 500, y: 500 }, { x: 900, y: 650 });
    assert.equal(await shapes(), 1);
    await toolbarOnTop();

    console.log('change colour and tool with real clicks');
    click(await at('.swatch[data-color="#3d8bff"]'));
    assert.equal(await color(), '#3d8bff', 'colour changed');
    click(await at('[data-tool="box"]'));
    assert.equal(await tool(), 'box', 'tool changed');
    assert.equal(await shapes(), 1, 'toolbar clicks did not draw on the screen');

    console.log('undo / redo buttons');
    click(await at('#undo'));
    assert.equal(await shapes(), 0, 'undo works');
    click(await at('#redo'));
    assert.equal(await shapes(), 1, 'redo works');

    console.log('eraser');
    click(await at('[data-tool="eraser"]'));
    assert.equal(await tool(), 'eraser');
    drag({ x: 480, y: 520 }, { x: 920, y: 630 });
    const erased = await ov.evaluate(() => drawing.shapes.at(-1).tool);
    assert.equal(erased, 'eraser', 'eraser stroke applied');
    await toolbarOnTop();

    console.log('keyboard shortcuts go to the toolbar');
    tap(0x11, 0x5a); // Ctrl+Z
    assert.equal(await shapes(), 1, 'Ctrl+Z undid the eraser stroke');
    tap(0x50); // P = pen
    assert.equal(await tool(), 'pen', 'P selects the pen');

    console.log('text tool, then toolbar again');
    click(await at('[data-tool="text"]'));
    click({ x: 700, y: 800 });
    await sleep(300);
    tap(0x10, 0x48); tap(0x49); // "Hi"
    tap(0x0d); // Enter
    await sleep(300);
    assert.equal(await ov.evaluate(() => drawing.shapes.at(-1)?.text), 'Hi', 'typed text was placed');
    await toolbarOnTop();
    click(await at('#clear'));
    assert.equal(await shapes(), 0, 'clear all works after typing text');

    console.log('Esc exits drawing mode');
    tap(0x1b);
    await sleep(800);
    const still = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().includes('overlay.html')));
    assert.equal(still, false, 'drawing mode exited');

    assert.deepEqual(await app.evaluate(() => global.__errs), [], 'no main-process errors');
    console.log('DRAWING REAL-INPUT E2E OK');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error('DRAWING REAL-INPUT E2E FAILED:', e.message); process.exit(1); });
