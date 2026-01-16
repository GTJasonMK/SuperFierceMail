# SuperFierceMail - 超人猛邮箱

一个基于 Cloudflare Workers 和 D1 数据库的临时邮箱服务。

> **Fork 说明**：本项目 Fork 自 [idinging/freemail](https://github.com/idinging/freemail)，感谢原作者的开源贡献！

## 一键部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GTJasonMK/SuperFierceMail)

### [点击查看一键部署指南](docs/yijianbushu.md)

---

## 功能特性

### 邮箱管理
- 随机生成临时邮箱地址，支持自定义长度和域名
- 随机人名生成邮箱功能
- 邮箱单点登录支持
- 批量管理（批量放行/禁止/删除）
- 受保护邮箱（不可删除）
- 列表和卡片两种展示方式

### 邮件功能
- 实时接收邮件，支持 HTML 和纯文本
- 自动刷新（可配置间隔）
- 智能验证码提取和高亮显示
- 一键复制验证码或邮件内容
- 发件支持（通过 Resend API）

### 管理后台
- 管理员统计面板（邮箱总数、邮件总数、7天趋势等）
- 活跃邮箱排行榜
- 邮件来源 TOP10
- 域名分布统计
- 权限分布统计

### 技术特性
- 基于 Cloudflare Workers，全球加速
- D1 数据库存储
- 响应式设计，适配移动端
- 亮色/暗色主题切换

---

## 快速部署

### 1. 安装 Wrangler CLI
```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare
```bash
wrangler login
```

### 3. 创建 D1 数据库
```bash
wrangler d1 create superfierce_mail_db
```
将返回的 `database_id` 更新到 `wrangler.toml`

### 4. 初始化数据库
```bash
wrangler d1 execute TEMP_MAIL_DB --file=d1-init.sql
```

### 5. 设置环境变量
```bash
wrangler secret put ADMIN_PASSWORD    # 管理员密码
wrangler secret put JWT_TOKEN         # JWT 密钥
wrangler secret put MAIL_DOMAIN       # 邮箱域名
```

### 6. 部署
```bash
wrangler deploy
```

### 7. 配置邮件路由
在 Cloudflare Dashboard：
1. 进入域名 → **Email** → **Email Routing**
2. 启用 Email Routing
3. 添加 **Catch-all** 规则，目标选择你的 Worker

---

## 环境变量

| 变量名 | 说明 | 必需 |
|--------|------|:----:|
| `MAIL_DOMAIN` | 邮箱域名（多个用逗号分隔） | 是 |
| `ADMIN_PASSWORD` | 管理员密码 | 是 |
| `JWT_TOKEN` | JWT 签名密钥 | 是 |
| `ADMIN_NAME` | 管理员用户名（默认 `admin`） | 否 |
| `RESEND_API_KEY` | Resend 发件 API 密钥 | 否 |
| `PROTECTED_MAILBOXES` | 受保护邮箱列表（逗号分隔） | 否 |
| `FORWARD_RULES` | 邮件转发规则 | 否 |

---

## 常用命令

```bash
# 本地开发
wrangler dev

# 部署
wrangler deploy

# 查看日志
wrangler tail

# 数据库查询
wrangler d1 execute TEMP_MAIL_DB --command "SELECT * FROM mailboxes LIMIT 10"
```

---

## API 文档

完整 API 文档见 [`docs/api.md`](docs/api.md)

### 管理员令牌认证
支持三种方式：
- `Authorization: Bearer <JWT_TOKEN>`
- `X-Admin-Token: <JWT_TOKEN>`
- URL 参数：`?admin_token=<JWT_TOKEN>`

---

## 故障排除

### 邮件接收不到
- 检查 Cloudflare Email Routing 配置
- 确认域名 MX 记录设置正确
- 验证 `MAIL_DOMAIN` 环境变量

### 数据库连接错误
- 确认 D1 数据库绑定名称为 `TEMP_MAIL_DB`
- 检查 `wrangler.toml` 中的 `database_id`
- 运行 `wrangler d1 list` 确认数据库存在

### 登录问题
- 确认 `ADMIN_PASSWORD` 和 `JWT_TOKEN` 已设置
- 清除浏览器缓存和 Cookie

---

## 致谢

本项目基于 [idinging/freemail](https://github.com/idinging/freemail) 开发，感谢原作者 [@idinging](https://github.com/idinging) 的开源贡献！

---

## 许可证

Apache-2.0 License
