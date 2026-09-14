## Freemhost自动续期

## 配置

在仓库 `Settings → Secrets and variables → Actions` 中添加以下 Secrets：

| Secret 名称 | 是否必填 | 说明 | 示例 |
|---|---|---|---|
| `FREE_EMAIL`         | ✅必填 | Freemhost 邮箱 |
| `FREE_PASSWORD`      | ✅必填 | Freemhost 密码 |
| `SERVER_PAGE_URL`    | ✅必填 | VPS管理地址,多个可用,或换行间隔(https://new.freemchost.com/server/xxxxxx)|
| `TG_BOT_TOKEN`  | ❌可选 | Telegram Bot Token | 
| `TG_CHAT_ID`    | ❌可选 | Telegram Chat ID |

**⚠️ 免责声明**：本脚本仅供学习交流使用，使用者需遵守 [Freemhost](https://freemchost.com) 的服务条款。因使用本脚本造成的任何问题，作者不承担任何责任。
