# 🎬 自动化签到与观影保活管理面板 (Auto Checkin & Media Keepalive Panel)

一套开箱即用的 Telegram 机器人自动化签到 + Emby 观影保活 Web 管理系统。支持多账号调度、按键交互、验证码解析、纯中文状态通知与全量加密备份。

---

## ✨ 核心特性

- 📱 **Telegram 机器人自动化签到**
  - 多 TG 账号统一接入、会话隔离；
  - 支持 Inline Keyboard 按钮自动回调与文本命令匹配；
  - 支持 Cloudflare 验证与多种验证码解析；
  - 智能超时与断线重试，全自动巡检。
- 🎬 **Emby 多站点观影保活**
  - 自动化播放保活，自定义观看时长与心跳间隔；
  - 定期轮询，降低被服主清退的风险。
- 🔔 **纯中文通知推送**
  - 执行结果与错误原因全部本地化；
  - 签到积分变动、保活进度一目了然。
- 📦 **全量加密备份与恢复**
  - 一键导出 AES 加密备份；
  - 支持合并恢复与全新导入，方便迁移机器。
- 🐳 **Docker Compose 一键部署**

---

## 🚀 快速上手部署

### 0. 前置条件

- 一台 Linux 服务器（1 核 1G 即可），已安装 Docker 与 Docker Compose；
- 一个 Telegram 账号，用于执行签到（建议用小号）；
- 到 <https://my.telegram.org> 申请 `api_id` / `api_hash`（登录时要用）。

### 1. 克隆本仓库

```bash
git clone https://github.com/rosc-bot/tg-media-checkin.git
cd tg-media-checkin
```

### 2. 准备环境变量

```bash
cp .env.example .env
```

编辑 `.env`，把下面四项改成自己的：

| 变量 | 说明 |
| --- | --- |
| `ADMIN_USERNAME` | 面板登录账号 |
| `ADMIN_PASSWORD` | 面板登录密码（务必改掉默认值） |
| `JWT_SECRET` | 一段随机长字符串，用于登录态签发 |
| `BEMBY_DATA_KEY` | 32 位随机字符，用于数据库敏感字段加密（**改动后旧数据无法解密**） |

生成随机串可以用：

```bash
openssl rand -hex 32
```

### 3. 启动容器

```bash
docker compose up -d
docker compose logs -f      # 看启动日志，Ctrl+C 退出查看
```

### 4. 访问面板

浏览器打开 `http://服务器IP:3100`，用 `.env` 里设置的管理员账号密码登录。

> 默认只监听 `127.0.0.1:3100`（适合放在 Nginx / Caddy 反代后面）。
> 想直接用 IP 访问，把 `docker-compose.yml` 里的 `127.0.0.1:3100:3000` 改成 `3100:3000` 再 `docker compose up -d`。

### 5. 接入 Telegram 账号

1. 面板左侧进入「账号管理」→「添加账号」；
2. 填入 `api_id`、`api_hash`、手机号（带国家码，如 `+8613800138000`）；
3. 按提示输入 Telegram 收到的验证码（开了两步验证的还要输入密码）；
4. 登录成功后，在「任务管理」里新建签到任务，选择目标机器人与触发命令即可。

---

## 🛠️ 目录结构

```
.
├── docker-compose.yml     # 容器编排
├── .env.example           # 环境变量模板（复制成 .env 使用）
├── dist/                  # 后端运行代码（Node.js）
│   ├── jobs/              # 各类任务：签到 / 观影保活 / 通知
│   ├── routes/            # Web API 路由
│   ├── tg/                # Telegram 客户端封装
│   └── scheduler.js       # 调度器
├── public/                # 前端静态资源（已构建）
├── scripts/               # 辅助脚本（如每日总日报）
└── data/                  # 运行时数据（数据库、会话、浏览器配置，不进仓库）
```

---

## 🔒 安全注意事项

1. **`.env` 切勿外泄**：里面有管理员口令与加密私钥；
2. **`data/` 切勿上传**：包含 SQLite 数据库与 Telegram Session（等于账号登录态），泄露即可被他人接管账号；
3. 仓库自带 `.gitignore`，已屏蔽 `data/`、`*.db`、`.env`、`*.session`、日志等；
4. 建议面板只监听内网/本机，通过带 HTTPS 的反向代理对外；
5. 备份文件（加密包）也要妥善保管，`BEMBY_DATA_KEY` 丢失则无法恢复。

---

## ❓ 常见问题

**Q：容器起来了但页面打不开？**
A：确认端口映射与防火墙；`curl http://127.0.0.1:3100/api/health` 应返回健康状态。

**Q：签到一直失败 / 提示验证码错误？**
A：先在面板里手动触发一次，看日志里的具体报错；机器人改版后命令可能变化，需要在任务里更新触发命令。

**Q：能多开几个账号吗？**
A：可以，账号彼此隔离；但同一账号不要在多台机器同时登录，容易被 Telegram 风控。

---

## 📄 License

仅供个人学习与自用，请遵守各站点与 Telegram 的使用条款。
