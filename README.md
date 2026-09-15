# FreeMCHost 自动续期

使用 Node.js 和 Playwright 检查 FreeMCHost 服务器，在剩余不足 46 小时且面板允许时执行免费续期。

## 配置

在 **Settings → Secrets and variables → Actions** 配置：

| Secret | 说明 |
| --- | --- |
| `FREE_EMAIL` | 登录邮箱 |
| `FREE_PASSWORD` | 登录密码，保留原始首尾空格 |
| `SERVER_PAGE_URL` | 当前管理页，例如 `https://freemchost.com/app/servers/服务器ID`；多个地址用逗号或换行分隔 |
| `TG_BOT_TOKEN` | 可选，Telegram Bot Token |
| `TG_CHAT_ID` | 可选，接收通知的聊天 ID |
| `NODE_LINK` | 可选，代理分享链接，由初始化脚本转为本地代理 |
| `PROXY_URL` | 可选，浏览器代理地址，优先于 `NODE_LINK` 生成的本地地址 |

管理页地址应从已登录的服务器详情页复制。旧的 `/server/服务器ID` 路径会规范到 `/app/servers/服务器ID`；服务器 ID 本身仍需有效。404 会作为失败报告，不再继续等待不存在的按钮。

## 执行与通知

- 每天北京时间 **08:15、20:15** 检查；同一仓库的执行会串行进行。
- 只点击续期弹窗中明确的免费选项，支持面板提供的不同小时数；不点击带价格的选项。
- 续期请求只提交一次，观察到到期时间增加后才报告成功。倒计时无法读取、选项不存在或结果未确认都会报错。
- 任意服务器失败会让 Actions 显示失败，其余配置的服务器仍会继续检查。
- 正常每次执行汇总发送一条 TG 图文通知，附运行编号、尝试次数和运行链接。图片失败时改发文字；上传超时后的备用发送可能造成重复投递。
- 图片在内存中生成，输入框内容会遮罩；不上传公开的 Actions 截图附件。
- 公开日志只保留固定执行状态，原始错误、页面内容和服务器信息只出现在配置的 TG 聊天中。
- 旧运行已公开的日志和截图附件不会因修改代码自动消失，需要在 Actions 中自行清理。

手动运行时可以关闭“发送 Telegram 图文通知”。第三方代理初始化脚本来自 `https://main.ssss.nyc.mn/setup_proxy.sh`，其原始输出和环境导出经过隔离。

## 本地检查

需要 Node.js 22+、Python 3（用于 CI 日志隔离测试）。

```sh
npm ci
npx playwright install chromium
npm run check
npm test
```

浏览器回归使用模拟页面，不需要真实账号。不要把账号、服务器实际地址、节点或 Telegram Token 写入代码。
