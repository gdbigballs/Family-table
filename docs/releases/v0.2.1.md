# 家宴点单 v0.2.1

发布日期：2026-08-12

## 本次更新

### 安全加固（公网部署）

- 管理员登录增加防爆破锁定：同一 IP 与用户名连续失败 5 次后锁定 15 分钟，期间即使输入正确密码也会被拒绝，降低公网暴力破解风险。
- 全站响应统一增加安全响应头：
  - `Content-Security-Policy`：限制脚本、样式、图片与请求来源，作为 XSS 的纵深防御。
  - `X-Content-Type-Options: nosniff`：禁止浏览器对上传图片等内容进行 MIME 嗅探。
  - `X-Frame-Options: DENY`：禁止站点被嵌入第三方页面。
  - `Referrer-Policy`：限制请求携带的 Referrer 信息。
- 登录 Cookie 支持 `Secure` 标记：设置 `COOKIE_SECURE=1` 或 `NODE_ENV=production`（Docker 构建默认启用）后，`family_admin` Cookie 仅在 HTTPS 连接下传输，避免登录凭证在公网明文泄露。本地 `npm start`（HTTP 开发环境）不受影响。
- README 补充公网部署说明：建议一律经 HTTPS 反向代理或内网穿透（frp / Cloudflare Tunnel / ngrok）访问，并提示启用 `COOKIE_SECURE`。

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

公网环境请确保环境变量 `COOKIE_SECURE=1`（Docker 构建已通过 `NODE_ENV=production` 默认启用），并通过 HTTPS 反向代理或内网穿透提供服务。
