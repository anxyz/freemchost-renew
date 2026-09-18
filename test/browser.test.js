const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const app = require('../renew');

const SERVER = 'https://freemchost.com/app/servers/test-node';

function panel({ hours = 48, remaining = 1, update = true, locked = false, invalidTimer = false } = {}) {
  const before = `${Math.floor(remaining / 24)}d ${remaining % 24}h 0m 0s remaining`;
  const after = `${Math.floor(hours / 24)}d ${hours % 24}h 0m 0s remaining`;
  return `<!doctype html><main id="app"><h1>Server</h1>
    <div role="tablist"><button role="tab" onclick="document.querySelector('#billing').hidden=false">Plan Billing &amp; lifecycle</button></div>
    <section id="billing" hidden>
      <div><p>Time until expiry</p><div role="timer" aria-label="${invalidTimer ? 'unknown' : before}">time</div><p>Renews on demand.</p></div>
      <button onclick="document.querySelector('#renewal').hidden=false">Renew now</button>
    </section>
    <div role="dialog" id="promo"><h2>Your feedback</h2><button onclick="this.parentElement.remove()">Maybe later</button></div>
    <div role="dialog" id="renewal" hidden><h2>Keep your server online</h2>
      <button onclick="window.paid++">60 hours $9.99 Quick top-up</button>
      <button id="free" ${locked ? 'disabled' : ''} onclick="window.submissions++;${update ? `document.querySelector('[role=timer]').setAttribute('aria-label','${after}');` : ''}this.parentElement.hidden=true">
        ${hours} hours ${hours > 48 ? 'Discord Boosted renewal' : 'Quick top-up'}
        ${locked ? 'Free renewals open 12h before expiry — come back later.' : ''}
      </button>
    </div>
  </main><script>window.submissions=0;window.paid=0;</script>`;
}

describe('browser regressions', () => {
  let browser, context, page;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser.close(); });
  beforeEach(async () => {
    context = await browser.newContext(); page = await context.newPage(); page.setDefaultTimeout(2000);
  });
  afterEach(async () => { await context.close(); });

  async function fixture(html = panel(), status = 200) {
    await page.route('**/*', route => route.fulfill({ status, contentType: 'text/html', body: html }));
    await page.goto(SERVER);
  }

  it('dismisses optional dialogs without deleting the application', async () => {
    await fixture(); await app.dismissOptionalDialogs(page);
    assert.equal(await page.locator('#app').count(), 1);
    assert.equal(await page.locator('#promo').count(), 0);
    assert.equal(await page.locator('#renewal').count(), 1);
  });

  it('never removes a renewal dialog or its overlay', async () => {
    await fixture(); await app.dismissOptionalDialogs(page);
    await page.getByRole('tab').click(); await page.getByRole('button', { name: 'Renew now', exact: true }).click();
    await app.dismissOptionalDialogs(page);
    assert.equal(await page.locator('#renewal').isVisible(), true);
    assert.equal(await page.locator('html').count(), 1);
  });

  for (const hours of [48, 60, 72, 78]) {
    it(`verifies a free ${hours}-hour renewal and never selects a priced card`, async () => {
      await fixture(panel({ hours }));
      const result = await app.renewServer(page, SERVER, { timeoutMs: 1000 });
      assert.equal(result.status, 'renewed');
      assert.equal(await page.evaluate(() => window.submissions), 1);
      assert.equal(await page.evaluate(() => window.paid), 0);
      assert.equal((await app.extractExpiryTime(page)).totalHours, hours);
    });
  }

  it('does not fail while expiry remains at least 12 hours and renewal is pending', async () => {
    await fixture(panel({ remaining: 20, update: false }));
    const result = await app.renewServer(page, SERVER, { timeoutMs: 200 });
    assert.equal(result.status, 'pending');
    assert.equal(await page.evaluate(() => window.submissions), 1);
    assert.equal(app.reportsExitCode([result]), 0);
  });

  it('fails when expiry is below 12 hours and does not increase', async () => {
    await fixture(panel({ remaining: 11, update: false }));
    const result = await app.renewServer(page, SERVER, { timeoutMs: 200 });
    assert.equal(result.status, 'failed');
    assert.equal(await page.evaluate(() => window.submissions), 1);
    assert.equal(app.reportsExitCode([result]), 1);
  });

  it('respects the panel renewal window', async () => {
    await fixture(panel({ locked: true }));
    const result = await app.renewServer(page, SERVER, { timeoutMs: 200 });
    assert.equal(result.status, 'not_due');
    assert.equal(await page.evaluate(() => window.submissions), 0);
  });

  it('waits when expiry is above the configured threshold', async () => {
    await fixture(panel({ remaining: 47 }));
    assert.equal((await app.renewServer(page, SERVER)).status, 'not_due');
    assert.equal(await page.evaluate(() => window.submissions), 0);
  });

  it('unreadable timers do not become a fabricated 99-hour countdown', async () => {
    await fixture(panel({ invalidTimer: true }));
    await assert.rejects(app.renewServer(page, SERVER), /无法读取/);
    assert.equal(await page.evaluate(() => window.submissions), 0);
  });

  it('404 pages fail immediately instead of waiting for a renewal button', async () => {
    await fixture('<h1>404</h1><p>Page not found</p>', 404);
    await assert.rejects(app.renewServer(page, SERVER), /404/);
  });

  it('application console text mentioning Page not found is not a panel 404', async () => {
    await fixture(panel({ remaining: 47 }) + '<pre>Page not found</pre>');
    assert.equal((await app.renewServer(page, SERVER)).status, 'not_due');
  });

  it('a login redirect does not count as a valid server page', async () => {
    await fixture('<script>history.replaceState(null,"","/login?next=/app/servers/test-node")</script><p>Sign in</p>');
    await assert.rejects(app.renewServer(page, SERVER), /跳转/);
  });

  it('captures masked screenshots in memory', async () => {
    await fixture('<input value="private-fixture"><textarea>private-fixture</textarea>');
    const picture = await app.captureScreenshot(page);
    assert.equal(picture.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  });

  it('login preserves password spaces and waits for the application redirect', async () => {
    let submitted;
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/session') {
        submitted = JSON.parse(route.request().postData());
        return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
      }
      if (pathname === '/login') return route.fulfill({ contentType: 'text/html', body: `
        <form onsubmit="event.preventDefault();fetch('/session',{method:'POST',body:JSON.stringify({password:document.querySelector('[type=password]').value})}).then(()=>location.href='/app')">
        <input type="email"><input type="password"><button type="submit">Sign in</button></form>` });
      return route.fulfill({ contentType: 'text/html', body: '<h1>Dashboard</h1>' });
    });
    await app.login(page, { email: 'test@example.invalid', password: '  test-password  ' }, 2000);
    assert.equal(submitted.password, '  test-password  ');
    assert.equal(page.url(), 'https://freemchost.com/app');
  });

  it('server check errors are reported to Telegram without failing Actions', async t => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url, options) => {
      calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true }) };
    });
    let ownedContext;
    let closed = 0;
    const browserType = { launch: async () => ({
      newContext: async options => {
        ownedContext = await browser.newContext(options);
        await ownedContext.route('**/*', route => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === '/login') return route.fulfill({ contentType: 'text/html', body:
            '<form onsubmit="event.preventDefault();location.href=\'/app\'"><input type="email"><input type="password"><button type="submit">Sign in</button></form>' });
          if (pathname.startsWith('/app/servers/')) return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>404</h1>' });
          return route.fulfill({ contentType: 'text/html', body: '<h1>Dashboard</h1>' });
        });
        return ownedContext;
      },
      close: async () => { closed++; await ownedContext.close(); },
    }) };
    const code = await app.main({ FREE_EMAIL: 'test@example.invalid', FREE_PASSWORD: 'test-password',
      SERVER_PAGE_URL: SERVER, TG_BOT_TOKEN: '12345:fake-token', TG_CHAT_ID: '1234' }, browserType);
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(closed, 1);
    assert.match(calls[0].options.body.get('caption'), /检查异常/);
  });
});