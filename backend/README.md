# FastAPI Chat Backend（可上线版）

## 1) 项目目录结构

```text
backend/
├── app/
│   ├── __init__.py
│   ├── config.py          # 环境配置（CORS、DB、密钥）
│   ├── db.py              # SQLAlchemy 引擎与 Session
│   ├── manager.py         # WebSocket ConnectionManager
│   ├── models.py          # 用户/群组/消息/好友关系模型
│   ├── schemas.py         # Pydantic 请求与响应模型
│   ├── security.py        # 密码哈希、Token 签发与校验
│   └── main.py            # FastAPI 入口（REST + WS）
├── tests/
├── .env.example
├── Procfile               # Railway/Render 启动命令
├── requirements.txt
└── README.md
```

## 2) 本地运行

1. 进入目录：
   ```bash
   cd backend
   ```
2. 创建虚拟环境并安装依赖：
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
3. 配置环境变量：
   ```bash
   cp .env.example .env
   ```
4. 启动服务：
   ```bash
   uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
   ```
5. 打开接口文档：
   - `http://127.0.0.1:8000/docs`

> 首次启动会自动创建 SQLite 数据库和管理员账号：
> - 用户名：`admin`
> - 密码：`admin123456`

## 3) Railway 部署

1. 把 `backend` 作为独立服务目录推到 GitHub。
2. Railway 新建项目 -> Deploy from GitHub。
3. Root Directory 设置为 `backend`。
4. 配置环境变量（Railway Variables）：
   - `APP_ENV=production`
   - `SECRET_KEY=<强随机字符串>`
   - `DATABASE_URL=sqlite:///./chat_app.db`（演示可用；生产建议 PostgreSQL）
   - `FRONTEND_ORIGINS=https://<你的github-pages域名>`
5. Railway 会读取 `Procfile` 自动启动：
   - `uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}`

## 4) 前端连接说明（ws -> wss）

前端根据页面协议自动切换：

```js
const API_BASE = location.hostname === 'localhost'
  ? 'http://127.0.0.1:8000'
  : 'https://your-backend.up.railway.app';

const WS_BASE = API_BASE.replace('http://', 'ws://').replace('https://', 'wss://');
const ws = new WebSocket(`${WS_BASE}/ws?token=${token}`);
```

- 本地开发：`ws://`
- 线上 HTTPS 页面（GitHub Pages）：必须 `wss://`

## 5) 关键接口

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/users/me`
- `PATCH /api/users/me`
- `GET /api/users/search?q=alice`
- `POST /api/friends/{friend_id}`
- `GET /api/friends`
- `POST /api/rooms`（创建群聊）
- `GET /api/rooms`
- `GET /api/rooms/{room_id}/messages?limit=50&before=100`
- `PATCH /api/messages/{message_id}`（仅 admin 可编辑）
- `GET /health`

## 6) WebSocket 协议

连接：`/ws?token=<登录token>`

客户端发送示例：

```json
{ "action": "send_message", "room_id": 1, "content": "hello" }
```

```json
{ "action": "edit_message", "room_id": 1, "message_id": 10, "content": "new text" }
```

```json
{ "action": "ping", "room_id": 1 }
```

服务端推送示例：

```json
{ "type": "new_message", "payload": { ... } }
```

```json
{ "type": "message_edited", "payload": { ... } }
```
