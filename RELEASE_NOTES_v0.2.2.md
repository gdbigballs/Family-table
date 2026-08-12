# 家宴点单 v0.2.2

发布日期：2026-08-12

## 本次更新

### 登录 Cookie 安全策略调整

- 登录 Cookie 的 `Secure` 标记由 v0.2.1 的“自动强制”调整为“可选开启”：设置 `COOKIE_SECURE=1` 时携带 `Secure` 标记（Cookie 仅经 HTTPS 传输）；未设置或为 `0` 时不携带。
- 修复 v0.2.1 中 Docker 部署（`NODE_ENV=production`）下局域网 HTTP 访问无法保持登录的问题——浏览器会在 HTTP 连接下丢弃带 `Secure` 属性的 Cookie，现在局域网直连可正常登录。
- `compose.yml` 新增 `COOKIE_SECURE: "0"` 默认关闭，局域网 HTTP 访问不受影响。
- README 补充公网部署提醒：建议经 HTTPS 反向代理或内网穿透（frp / Cloudflare Tunnel / ngrok）访问；若服务直接暴露公网 IP（无 HTTPS 隧道），请务必设置 `COOKIE_SECURE=1` 并自行配置 HTTPS，否则密码与登录凭证会以明文传输。

## 升级说明

本次更新不涉及数据库结构变更，升级前无需备份或迁移数据。

普通 Node.js 部署更新代码后需要重启服务：

```powershell
node server.js
```

Docker 或 NAS 部署请重新构建并启动容器：

```bash
docker compose up -d --build
```

公网环境建议经 HTTPS 反向代理或内网穿透提供服务；若直接暴露公网 IP，请设置 `COOKIE_SECURE=1` 并配置 HTTPS（compose 默认关闭，需显式修改）。
