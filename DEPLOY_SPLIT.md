# 前后端分离部署（稳定版）

## 结论（推荐）
- 前端：GitHub Pages（静态）
- 后端：Railway（FastAPI）
- 两者独立域名，不共用公开入口域名。

为什么选这个：
1. 你当前前端已经稳定在 GitHub Pages。
2. 后端崩溃问题来自 Railway 变量配置，不是前端部署方式。
3. 最小风险：不迁移前端到 Railway，先稳定后端。

---

## 当前崩溃根因
当 `APP_ENV=production` 时，后端有生产护栏：
1. `DATABASE_URL` 不能是 SQLite
2. 默认禁止本地 uploads（除非显式放开）

若你在 Railway 里把：
- `APP_ENV=production`
- `DATABASE_URL=sqlite:///./chat_app.db`

会在启动时报错并崩溃（这是预期保护行为）。

---

## 后端 Railway 正确配置（web 服务）

### Root Directory
- `backend`

### Start Command
- `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

### 必需环境变量
- `APP_ENV=production`
- `SECRET_KEY=<长随机串，至少 32 位>`
- `DATABASE_URL=<Railway Postgres 连接串，postgresql+psycopg://...>`
- `FRONTEND_ORIGINS=https://xuq873031-lang.github.io`
- `ALLOW_LOCAL_UPLOADS_IN_PRODUCTION=true`（短期兜底；长期建议对象存储）

### 可选
- `ACCESS_TOKEN_EXPIRE_HOURS=72`
- `UPLOAD_DIR=uploads`

---

## 前端（GitHub Pages）配置

前端通过 `window.__CHAT_CONFIG.API_BASE` 指向后端域名。

在 `index.html` 与 `admin.html` 中已经配置：
- `API_BASE=https://web-production-be9f.up.railway.app`

如后端域名变化，只需改这一个值并重新发布前端。

---

## CORS 配置建议
后端环境变量 `FRONTEND_ORIGINS` 至少包含：
- `https://xuq873031-lang.github.io`

如果未来前端换新域名，追加即可（逗号分隔）。

---

## WebSocket 与 API 分离
- API 全部走 `API_BASE`
- WS 默认由 `API_BASE` 派生（https -> wss）
- 不依赖页面当前域名

---

## 验证前后端已分离
1. 打开前端：`https://xuq873031-lang.github.io/fuzaliao9535/`
2. 浏览器网络面板查看 API 请求：应指向 Railway 域名
3. WebSocket 地址应为 `wss://<railway-domain>/ws?...`
4. Railway 停机时前端页面仍可打开，但接口会失败（证明已分离）

---

## 管理后台独立 URL
- `https://xuq873031-lang.github.io/fuzaliao9535/admin.html`

仅管理员可访问（后端 role 校验）。

