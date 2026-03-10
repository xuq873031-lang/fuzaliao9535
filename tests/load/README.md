# Chat APP 压力测试方案（本地/测试环境）

本目录提供一套**不改业务逻辑**的可重复压测方案，用于量化聊天系统并发能力与瓶颈位置。

## 1. 测试目标

- 测出系统在不同并发下的可用性与性能趋势，而不是拍脑袋估算
- 重点观察：
  - 同时登录成功率
  - 同时在线（WebSocket 建连）成功率
  - 持续发消息成功率
  - P95/P99 延迟变化
  - 断连与错误原因

## 2. 测试环境建议

- 强烈建议使用**测试环境**（不要直压线上正式流量）
- 后端：FastAPI（Railway 或本地）
- 数据库：建议单独测试库
- 前端无需参与压测，脚本直接打后端 API/WS

## 3. 覆盖链路

当前脚本覆盖：

- 注册：`POST /api/auth/register`（仅账号不存在时触发）
- 登录：`POST /api/auth/login`
- 会话列表：`GET /api/rooms`
- 发消息（HTTP）：`POST /api/rooms/{room_id}/messages`
- WebSocket 在线：`GET /ws?token=...`
- WebSocket 发消息：`action=send_message`

暂不压测：

- 图片上传（可作为第 4 阶段单独补测）
- 好友/好友申请复杂流程

## 4. 指标定义

脚本输出 JSON（`tests/load/results/*.json`）包含：

- `counters`
  - `login_attempt/success/fail`
  - `ws_connect_attempt/success/fail`
  - `http_send_attempt/success/fail`
  - `ws_send_attempt/success/fail`
  - `errors`
- `rates`
  - `login_success_rate_pct`
  - `ws_connect_success_rate_pct`
  - `http_send_success_rate_pct`
  - `ws_send_success_rate_pct`
- `timings`
  - `avg_ms`
  - `p95_ms`
  - `p99_ms`
  - `max_ms`

## 5. 安装与准备

```bash
cd /Users/fang/Desktop/fuzaliao
python3 -m venv .venv-load
source .venv-load/bin/activate
pip install -r tests/load/requirements.txt
cp tests/load/.env.example tests/load/.env
```

编辑 `tests/load/.env`：

- `LOAD_BASE_URL`：测试后端地址
- `LOAD_USER_PREFIX`：压测账号前缀（避免和正式用户冲突）
- `LOAD_PASSWORD`：压测账号密码

## 6. 三阶段执行

### 阶段 1：基础接口压测（HTTP）

```bash
python tests/load/load_test.py --mode http --users 10 --http-loops 10 --output tests/load/results/http_u10.json
python tests/load/load_test.py --mode http --users 30 --http-loops 10 --output tests/load/results/http_u30.json
python tests/load/load_test.py --mode http --users 50 --http-loops 10 --output tests/load/results/http_u50.json
```

### 阶段 2：在线连接压测（WebSocket 在线保持）

```bash
python tests/load/load_test.py --mode ws --users 10 --duration-sec 120 --output tests/load/results/ws_u10.json
python tests/load/load_test.py --mode ws --users 30 --duration-sec 120 --output tests/load/results/ws_u30.json
python tests/load/load_test.py --mode ws --users 50 --duration-sec 120 --output tests/load/results/ws_u50.json
```

### 阶段 3：真实聊天场景压测（在线 + 持续发消息）

```bash
python tests/load/load_test.py --mode chat --users 10 --duration-sec 120 --send-interval-sec 2.0 --output tests/load/results/chat_u10.json
python tests/load/load_test.py --mode chat --users 30 --duration-sec 120 --send-interval-sec 2.0 --output tests/load/results/chat_u30.json
python tests/load/load_test.py --mode chat --users 50 --duration-sec 120 --send-interval-sec 2.5 --output tests/load/results/chat_u50.json
```

> 如果 50 人稳定，可继续 80/100 人递增；如果 30 人已明显失败，改为 40 人、再回退定位瓶颈。

## 7. 一键分梯度执行（推荐）

```bash
python tests/load/run_plan.py
```

该脚本会依次执行：

- HTTP：10/30/50
- WS 在线：10/30/50
- Chat：10/30/50

并将结果写入 `tests/load/results/`。

## 8. 风险与注意事项

- 不要在生产高峰时对线上压测
- 压测会写入消息数据，请使用专用测试账号前缀
- Railway 免费/低配实例可能先被平台限流，不代表应用绝对上限
- WebSocket 成功率下降通常先于 HTTP 接口报错

## 9. 如何解读结果

建议判定阈值（可按业务调整）：

- 可接受：
  - 登录成功率 >= 99%
  - WS 建连成功率 >= 98%
  - 发消息成功率 >= 98%
  - `http_send` 或 `ws_send` 的 P95 < 800ms
- 进入瓶颈：
  - 成功率持续下降（尤其 WS）
  - P95/P99 急剧上升
  - 错误中出现大量 5xx、timeout、disconnect

## 10. 最小观测建议

压测期间至少同时观察：

- 后端日志：
  - 401/403（鉴权问题）
  - 404（路径错误）
  - 429（限流）
  - 5xx（应用异常）
  - WebSocket disconnect/exception
- Railway：
  - CPU、内存、重启次数
  - 响应时间、错误率
- 数据库：
  - 连接数
  - 慢查询
  - 锁等待

若出现下列信号，通常表示触顶：

- WS 大量断连 + 重连风暴
- 发消息接口 P99 明显抬升并伴随 5xx
- 数据库连接池耗尽/超时

