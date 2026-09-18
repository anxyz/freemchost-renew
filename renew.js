const { chromium } = require('playwright');

const ORIGIN = 'https://freemchost.com';
const HOSTS = new Set(['freemchost.com', 'new.freemchost.com']);
const RENEW_THRESHOLD_HOURS = 46;
const NOISE = /How would you rate FreeMCHost|Your feedback|Got an idea to make FreeMCHost better|Get Free\+|Upgrade to Free\+|Join the FreeMCHost community/i;
const RENEW_DIALOG = /Keep your server online/i;
const NETWORK_ERROR = /ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT|SOCKS_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|NETWORK_CHANGED)/;

function log(message) { console.log(message); }

function canonicalServerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('服务器地址必须是 FreeMCHost 的 HTTPS 管理页。');
  }
  const match = url.pathname.match(/^\/(?:app\/servers|servers?)\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) throw new Error('服务器管理页应使用 /app/servers/服务器ID 路径。');
  url.hostname = 'freemchost.com';
  url.pathname = `/app/servers/${match[1]}`;
  url.hash = '';
  return url.href;
}

function readConfig(env = process.env) {
  const urls = (env.SERVER_PAGE_URL || '').split(/[\r\n,]+/).map(value => value.trim()).filter(Boolean);
  const config = {
    email: (env.FREE_EMAIL || '').trim(), password: env.FREE_PASSWORD || '',
    serverUrls: [...new Set(urls.map(canonicalServerUrl))],
    proxyUrl: (env.PROXY_URL || '').trim(), tgToken: (env.TG_BOT_TOKEN || '').trim(),
    tgChatId: (env.TG_CHAT_ID || '').trim(), notify: (env.SEND_TG || 'true').toLowerCase() === 'true',
  };
  if (!config.email || !config.password || !config.serverUrls.length) {
    throw new Error('请配置 FREE_EMAIL、FREE_PASSWORD 和 SERVER_PAGE_URL。');
  }
  return config;
}

function proxyOptions(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol)) {
    throw new Error('代理协议不受支持，请使用本地转发地址。');
  }
  if (url.protocol.startsWith('socks') && (url.username || url.password)) {
    throw new Error('带认证的 SOCKS 节点请通过 NODE_LINK 转为本地代理。');
  }
  return { server: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {}) };
}

function privateError(error, config) {
  let text = String(error?.message || error).split('\nCall log:')[0];
  for (const secret of [config?.email, config?.password, config?.tgToken, config?.tgChatId,
    config?.proxyUrl, ...(config?.serverUrls || [])].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(secret, '[REDACTED]');
  }
  return text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]').slice(0, 600);
}

async function navigate(page, url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (response && response.status() >= 500 && attempt < 2) {
        log('⚠️ 页面连接暂时失败，正在重试');
        await page.waitForTimeout((attempt + 1) * 1000);
        continue;
      }
      if (response && response.status() >= 400) {
        throw new Error(`服务器页面返回 HTTP ${response.status()}，请检查管理页地址或面板状态。`);
      }
      return response;
    } catch (error) {
      if (attempt === 2 || (!NETWORK_ERROR.test(error.message) && error.name !== 'TimeoutError')) throw error;
      log('⚠️ 页面连接暂时失败，正在重试');
      await page.waitForTimeout((attempt + 1) * 1000);
    }
  }
}

async function firstVisible(locator) {
  for (const item of await locator.all()) if (await item.isVisible()) return item;
  return null;
}

async function dismissOptionalDialogs(page) {
  const reject = await firstVisible(page.getByRole('button', { name: /^Reject all$/i }));
  const cookie = reject || await firstVisible(page.getByRole('button', { name: /^Accept all$/i }));
  if (cookie) await cookie.click({ timeout: 3000 });
  for (let pass = 0; pass < 3; pass++) {
    let closed = false;
    for (const dialog of (await page.getByRole('dialog').all()).reverse()) {
      if (!await dialog.isVisible()) continue;
      const text = await dialog.innerText();
      if (!NOISE.test(text) || RENEW_DIALOG.test(text)) continue;
      const close = await firstVisible(dialog.getByRole('button', {
        name: /^(?:Maybe later|Not now|No thanks|Close|Dismiss|Skip)$/i,
      }));
      if (close && await close.isEnabled()) {
        await close.click({ timeout: 3000 });
        closed = true;
        break;
      }
    }
    if (!closed) break;
    await page.waitForTimeout(150);
  }
}

async function safeFill(locator, value) {
  await locator.waitFor({ state: 'visible', timeout: 20000 });
  await locator.fill(value);
  if (await locator.inputValue() !== value) {
    await locator.clear();
    await locator.pressSequentially(value, { delay: 20 });
  }
  if (await locator.inputValue() !== value) throw new Error('登录字段填写未完成。');
}

async function login(page, config, timeoutMs = 45000) {
  log('🚀 正在打开登录页面');
  await navigate(page, `${ORIGIN}/login`);
  await page.waitForTimeout(2000);
  await dismissOptionalDialogs(page);
  await safeFill(page.locator('input[type="email"], input[name="email"]').first(), config.email);
  await safeFill(page.locator('input[type="password"], input[name="password"]').first(), config.password);
  const submit = page.getByRole('button', { name: /^Sign in$/i }).first();
  log('🔐 正在登录');
  await Promise.all([
    page.waitForURL(url => url.origin === ORIGIN && !/^\/(?:login|signup|forgot-password)(?:\/|$)/.test(url.pathname), { timeout: timeoutMs }),
    submit.click(),
  ]);
  log('✅ 登录成功');
}

function parseExpiry(text) {
  if (/^Expired$/i.test(text.trim())) return { totalSeconds: 0, totalHours: 0, raw: '已到期' };
  const match = text.match(/(\d+)\s*(?:days?|d)\b\s*(\d+)\s*(?:hours?|h)\b\s*(\d+)\s*(?:minutes?|mins?|m)\b(?:\s*(\d+)\s*(?:seconds?|secs?|s)\b)?/i);
  if (!match) return null;
  const [days, hours, minutes, seconds] = match.slice(1).map(value => Number(value || 0));
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const totalSeconds = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return { totalSeconds, totalHours: totalSeconds / 3600, raw: `${days}天${hours}小时${minutes}分` };
}

async function extractExpiryTime(page) {
  const label = page.getByText(/^Time until expiry$/i).filter({ visible: true }).first();
  if (!await label.count()) return null;
  const scope = label.locator('..');
  const expired = scope.getByText(/^Expired$/i);
  if (await expired.count()) return parseExpiry('Expired');
  const timer = scope.getByRole('timer', { includeHidden: true }).first();
  if (await timer.count()) {
    const result = parseExpiry(await timer.getAttribute('aria-label') || await timer.innerText());
    if (result) return result;
  }
  return parseExpiry(await scope.innerText());
}

async function openBilling(page) {
  await dismissOptionalDialogs(page);
  const tab = page.getByRole('tab', { name: /Billing/i }).filter({ visible: true }).first();
  await tab.waitFor({ state: 'visible', timeout: 20000 });
  await tab.click();
  await dismissOptionalDialogs(page);
  await page.getByText(/^Time until expiry$/i).filter({ visible: true }).first()
    .waitFor({ state: 'visible', timeout: 20000 });
}

async function findFreeOption(dialog) {
  const selectors = ['button', '[role="button"]', '[class*="cursor-pointer"]', '[class*="rounded"]'];
  for (const selector of selectors) {
    const candidates = dialog.locator(selector);
    for (const button of await candidates.all()) {
      if (!await button.isVisible()) continue;
      const text = await button.innerText();
      const hours = text.match(/\b(\d+)\s+hours?\b/i);
      if (!hours || /[$€£¥]\s*\d|\b(?:USD|EUR|GBP)\b/i.test(text)) continue;
      return { button, hours: Number(hours[1]), text };
    }
  }
  return null;
}

async function waitForRenewal(page, before, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  do {
    await dismissOptionalDialogs(page);
    const current = await extractExpiryTime(page);
    if (current && current.totalSeconds > before.totalSeconds + 60) return current;
    await page.waitForTimeout(500);
  } while (Date.now() < deadline);
  return null;
}

async function renewServer(page, url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
  log('🗂️ 正在打开服务器管理页');
  await navigate(page, url);
  const current = new URL(page.url());
  if (current.origin !== ORIGIN || current.pathname.replace(/\/$/, '') !== new URL(url).pathname) {
    throw new Error('服务器页面跳转到了其他位置，请检查地址和登录状态。');
  }
  const errorHeading = page.getByRole('heading', { name: /^(?:404|Page not found)$/i }).filter({ visible: true });
  if (await errorHeading.count() && !await page.getByRole('tab', { name: /Billing/i }).count()) {
    throw new Error('服务器页面不存在（404），请检查管理页地址。');
  }
  await openBilling(page);
  const before = await extractExpiryTime(page);
  if (!before) throw new Error('无法读取有效的到期倒计时，本次未提交续期。');
  if (before.totalHours >= RENEW_THRESHOLD_HOURS) {
    log('⏳ 当前无需续期');
    return { status: 'not_due', before: before.raw };
  }
  log('🔄 正在打开免费续期选项');
  const renew = page.getByRole('button', { name: /^Renew now$/i }).filter({ visible: true }).first();
  await renew.click();
  await dismissOptionalDialogs(page);
  const dialog = page.getByRole('dialog').filter({ hasText: RENEW_DIALOG }).last();
  await dialog.waitFor({ state: 'visible', timeout: timeoutMs });
  let option;
  const deadline = Date.now() + timeoutMs;
  do {
    option = await findFreeOption(dialog);
    if (option && await option.button.isEnabled()) break;
    if (option && /Free renewals open .*before expiry/i.test(option.text)) {
      log('⏳ 面板尚未开放免费续期');
      return { status: 'not_due', before: before.raw, reason: '面板尚未开放免费续期窗口。' };
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  if (!option || !await option.button.isEnabled()) throw new Error('未找到可用的免费续期选项。');
  let clickError;
  log('🔄 正在提交免费续期');
  try { await option.button.click(); } catch (error) { clickError = error; }
  const after = await waitForRenewal(page, before, timeoutMs);
  if (!after) {
    if (before.totalHours >= 12) {
      log('⏳ 续期请求待确认');
      return { status: 'pending', before: before.raw,
        reason: clickError?.message || '已提交续期，观察窗口内到期时间尚未增加。' };
    }
    log('❌ 续期失败');
    return { status: 'failed', before: before.raw,
      reason: clickError?.message || '观察窗口内到期时间未增加，且剩余时间不足 12 小时。' };
  }
  log('✅ 续期已确认');
  return { status: 'renewed', before: before.raw, after: after.raw };
}

function reportsExitCode(reports) {
  return reports.length && !reports.some(report => report.status === 'failed') ? 0 : 1;
}

function buildSummary(reports, env = process.env) {
  const lines = ['🤖 FreeMCHost 巡检报告', ''];
  for (const [index, report] of reports.entries()) {
    const label = report.index ? `服务器 ${report.index}` : `检查 ${index + 1}`;
    const states = { renewed: '✅ 续期成功', not_due: '⏳ 暂无需续期', pending: '⏳ 续期待确认', failed: '❌ 续期失败', error: '⚠️ 检查异常', uncertain: '⚠️ 续期结果待确认' };
    lines.push(`${label}：${states[report.status] || states.failed}`);
    if (report.before) lines.push(`剩余时间：${report.before}${report.after ? ` → ${report.after}` : ''}`);
    if (report.reason) lines.push(`详情：${report.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

function limitText(text, length) {
  if (text.length <= length) return text;
  return text.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

async function captureScreenshot(page) {
  try {
    return await page.screenshot({ type: 'png', fullPage: true, timeout: 10000,
      mask: [page.locator('input, textarea')] });
  } catch {
    log('⚠️ 页面截图失败');
    return null;
  }
}

async function telegramPost(config, method, fields, photo) {
  const url = `https://api.telegram.org/bot${config.tgToken}/${method}`;
  try {
    let body;
    let headers;
    if (photo) {
      body = new FormData();
      for (const [name, value] of Object.entries(fields)) body.set(name, value);
      body.set('photo', new Blob([photo], { type: 'image/png' }), 'freemchost-status.png');
    } else {
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify(fields);
    }
    const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(25000) });
    const result = await response.json().catch(() => null);
    if (response.ok && result?.ok === true) return true;
    log('⚠️ Telegram 接口请求失败');
  } catch { log('⚠️ Telegram 网络请求失败'); }
  return false;
}

async function sendReport(config, reports, photo, photoIndex) {
  if (!config.notify || !config.tgToken || !config.tgChatId) {
    log('ℹ️ 本次未发送 Telegram 通知');
    return null;
  }
  const text = buildSummary(reports);
  const caption = photoIndex ? `📸 截图：服务器 ${photoIndex}\n\n${text}` : text;
  if (photo && await telegramPost(config, 'sendPhoto', { chat_id: config.tgChatId, caption: limitText(caption, 1024) }, photo)) {
    log('📸 Telegram 截图通知发送成功');
    return true;
  }
  if (photo) log('ℹ️ 图片未发送成功，改发文字通知');
  const sent = await telegramPost(config, 'sendMessage', { chat_id: config.tgChatId, text: limitText(text, 4096) });
  log(sent ? '📩 Telegram 文字通知发送成功' : '❌ Telegram 通知发送失败');
  return sent;
}

async function main(env = process.env, browserType = chromium) {
  let config = { tgToken: (env.TG_BOT_TOKEN || '').trim(), tgChatId: (env.TG_CHAT_ID || '').trim(), notify: (env.SEND_TG || 'true').toLowerCase() === 'true' };
  let browser;
  let page;
  let photo;
  let photoIndex;
  let photoIsFailure = false;
  const reports = [];
  let notified = null;
  log('📋 开始 FreeMCHost 巡检');
  try {
    config = readConfig(env);
    browser = await browserType.launch({ headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1920,1080'],
      proxy: proxyOptions(config.proxyUrl) });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', locale: 'en-US' });
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    page = await context.newPage();
    await login(page, config);
    for (const [index, url] of config.serverUrls.entries()) {
      let report;
      try {
        report = await renewServer(page, url);
        if (report.reason) report.reason = privateError(report.reason, config);
      } catch (error) {
        log('❌ 服务器检查失败');
        report = { status: 'error', reason: privateError(error, config) };
      }
      reports.push({ ...report, index: index + 1 });
      const failure = report.status === 'failed';
      if (config.notify && config.tgToken && config.tgChatId && (!photoIsFailure || failure)) {
        const captured = await captureScreenshot(page);
        if (captured) {
          photo = captured;
          photoIndex = index + 1;
          photoIsFailure = failure;
        }
      }
    }
  } catch (error) {
    log('❌ 巡检未完成');
    reports.push({ status: 'error', reason: privateError(error, config) });
    if (page && config.notify && config.tgToken && config.tgChatId) photo = await captureScreenshot(page);
  } finally {
    try { notified = await sendReport(config, reports, photo, photoIndex); }
    catch { log('❌ Telegram 通知发送失败'); notified = false; }
    if (browser) {
      try { await browser.close(); } catch { log('⚠️ 浏览器清理未完成'); }
    }
    log('🏁 巡检结束');
  }
  return notified === false ? 1 : reportsExitCode(reports);
}

module.exports = { canonicalServerUrl, readConfig, proxyOptions, privateError, navigate,
  dismissOptionalDialogs, safeFill, login, parseExpiry, extractExpiryTime, openBilling,
  findFreeOption, waitForRenewal, renewServer, reportsExitCode, buildSummary, limitText,
  captureScreenshot, telegramPost, sendReport, main };

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(() => {
    log('❌ 未处理的运行错误');
    process.exitCode = 1;
  });
}
