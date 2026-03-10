#!/usr/bin/env python3
"""Chat backend load test (HTTP + WebSocket) for local/test environment.

Design goals:
- no business code changes
- repeatable, scriptable scenarios
- measurable output (json summary)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import statistics
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import aiohttp
import websockets
from dotenv import load_dotenv


@dataclass
class Metrics:
    counters: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    timings: dict[str, list[float]] = field(default_factory=lambda: defaultdict(list))
    errors: list[str] = field(default_factory=list)

    def inc(self, key: str, n: int = 1) -> None:
        self.counters[key] += n

    def add_timing(self, key: str, value_ms: float) -> None:
        self.timings[key].append(value_ms)

    def add_error(self, msg: str) -> None:
        self.inc("errors")
        if len(self.errors) < 40:
            self.errors.append(msg)


def pct(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    idx = int(round((p / 100.0) * (len(ordered) - 1)))
    return ordered[max(0, min(idx, len(ordered) - 1))]


def build_summary(metrics: Metrics, started_at: float, ended_at: float, meta: dict[str, Any]) -> dict[str, Any]:
    timing_summary: dict[str, dict[str, float | None]] = {}
    for k, vals in metrics.timings.items():
        timing_summary[k] = {
            "count": len(vals),
            "avg_ms": round(statistics.fmean(vals), 2) if vals else None,
            "p95_ms": round(pct(vals, 95), 2) if vals else None,
            "p99_ms": round(pct(vals, 99), 2) if vals else None,
            "max_ms": round(max(vals), 2) if vals else None,
        }

    def rate(ok_key: str, all_key: str) -> float | None:
        total = metrics.counters.get(all_key, 0)
        if total <= 0:
            return None
        return round((metrics.counters.get(ok_key, 0) / total) * 100.0, 2)

    return {
        "meta": meta,
        "started_at": datetime.fromtimestamp(started_at, tz=timezone.utc).isoformat(),
        "ended_at": datetime.fromtimestamp(ended_at, tz=timezone.utc).isoformat(),
        "duration_sec": round(ended_at - started_at, 2),
        "counters": dict(metrics.counters),
        "rates": {
            "login_success_rate_pct": rate("login_success", "login_attempt"),
            "ws_connect_success_rate_pct": rate("ws_connect_success", "ws_connect_attempt"),
            "http_send_success_rate_pct": rate("http_send_success", "http_send_attempt"),
            "ws_send_success_rate_pct": rate("ws_send_success", "ws_send_attempt"),
        },
        "timings": timing_summary,
        "errors_sample": metrics.errors,
    }


async def timed_request(
    session: aiohttp.ClientSession,
    method: str,
    url: str,
    metrics: Metrics,
    timing_key: str,
    **kwargs,
) -> tuple[int, Any, str]:
    t0 = time.perf_counter()
    async with session.request(method, url, **kwargs) as resp:
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        metrics.add_timing(timing_key, elapsed_ms)
        content_type = resp.headers.get("content-type", "")
        if "application/json" in content_type:
            data = await resp.json()
            return resp.status, data, ""
        text = await resp.text()
        return resp.status, None, text


async def register_user(session: aiohttp.ClientSession, base: str, username: str, password: str, metrics: Metrics) -> bool:
    email = f"{username.lower().replace(' ', '_')}@load.local"
    metrics.inc("register_attempt")
    status, data, text = await timed_request(
        session,
        "POST",
        f"{base}/api/auth/register",
        metrics,
        "register",
        json={"username": username, "email": email, "password": password},
    )
    if status == 200 and data:
        metrics.inc("register_success")
        return True
    if status == 400 and ((data and "exists" in str(data.get("detail", "")).lower()) or "exists" in text.lower()):
        metrics.inc("register_exists")
        return True
    metrics.inc("register_fail")
    metrics.add_error(f"register {username} status={status} detail={data or text}")
    return False


async def login_user(session: aiohttp.ClientSession, base: str, username: str, password: str, metrics: Metrics) -> tuple[str | None, int | None]:
    metrics.inc("login_attempt")
    status, data, text = await timed_request(
        session,
        "POST",
        f"{base}/api/auth/login",
        metrics,
        "login",
        json={"username": username, "password": password},
    )
    if status == 200 and data and data.get("token"):
        metrics.inc("login_success")
        return data["token"], int(data["user"]["id"])
    metrics.inc("login_fail")
    metrics.add_error(f"login {username} status={status} detail={data or text}")
    return None, None


async def ensure_user_token(
    session: aiohttp.ClientSession,
    base: str,
    username: str,
    password: str,
    metrics: Metrics,
) -> tuple[str | None, int | None]:
    token, user_id = await login_user(session, base, username, password, metrics)
    if token:
        return token, user_id
    ok = await register_user(session, base, username, password, metrics)
    if not ok:
        return None, None
    return await login_user(session, base, username, password, metrics)


async def get_rooms(session: aiohttp.ClientSession, base: str, token: str, metrics: Metrics) -> list[dict[str, Any]]:
    status, data, text = await timed_request(
        session,
        "GET",
        f"{base}/api/rooms",
        metrics,
        "get_rooms",
        headers={"Authorization": f"Bearer {token}"},
    )
    if status == 200 and isinstance(data, list):
        metrics.inc("get_rooms_success")
        return data
    metrics.inc("get_rooms_fail")
    metrics.add_error(f"get_rooms status={status} detail={data or text}")
    return []


async def send_message_http(
    session: aiohttp.ClientSession,
    base: str,
    token: str,
    room_id: int,
    content: str,
    metrics: Metrics,
) -> bool:
    metrics.inc("http_send_attempt")
    status, data, text = await timed_request(
        session,
        "POST",
        f"{base}/api/rooms/{room_id}/messages",
        metrics,
        "http_send",
        headers={"Authorization": f"Bearer {token}"},
        json={"content": content},
    )
    if status == 200:
        metrics.inc("http_send_success")
        return True
    metrics.inc("http_send_fail")
    metrics.add_error(f"http_send room={room_id} status={status} detail={data or text}")
    return False


async def create_shared_room(
    session: aiohttp.ClientSession,
    base: str,
    owner_token: str,
    member_ids: list[int],
    metrics: Metrics,
) -> int:
    room_name = f"load-room-{int(time.time())}"
    status, data, text = await timed_request(
        session,
        "POST",
        f"{base}/api/rooms",
        metrics,
        "create_room",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={"name": room_name, "member_ids": member_ids},
    )
    if status == 200 and data and data.get("id"):
        metrics.inc("create_room_success")
        return int(data["id"])
    metrics.inc("create_room_fail")
    raise RuntimeError(f"create room failed status={status} detail={data or text}")


async def prepare_users(
    session: aiohttp.ClientSession,
    base: str,
    prefix: str,
    password: str,
    users: int,
    metrics: Metrics,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for i in range(users):
        username = f"{prefix}_{i:04d}"
        token, user_id = await ensure_user_token(session, base, username, password, metrics)
        if token and user_id:
            result.append({"username": username, "token": token, "user_id": user_id})
    return result


async def ws_connect(uri: str, metrics: Metrics):
    metrics.inc("ws_connect_attempt")
    t0 = time.perf_counter()
    ws = await websockets.connect(uri, max_size=2**20)
    metrics.add_timing("ws_connect", (time.perf_counter() - t0) * 1000.0)
    metrics.inc("ws_connect_success")
    return ws


async def scenario_http(base: str, users_data: list[dict[str, Any]], room_id: int, loops: int, metrics: Metrics) -> None:
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
        sem = asyncio.Semaphore(20)

        async def one_user(u: dict[str, Any]) -> None:
            for n in range(loops):
                async with sem:
                    await get_rooms(session, base, u["token"], metrics)
                    content = f"[http-load] {u['username']} #{n} {random.randint(1000, 9999)}"
                    await send_message_http(session, base, u["token"], room_id, content, metrics)

        await asyncio.gather(*(one_user(u) for u in users_data))


async def scenario_ws_online(ws_base: str, users_data: list[dict[str, Any]], duration_sec: int, metrics: Metrics) -> None:
    async def hold_connection(user: dict[str, Any]) -> None:
        uri = f"{ws_base}/ws?token={quote(user['token'])}"
        try:
            ws = await ws_connect(uri, metrics)
        except Exception as e:  # noqa: BLE001
            metrics.inc("ws_connect_fail")
            metrics.add_error(f"ws_connect {user['username']} error={e}")
            return

        async def receiver() -> None:
            try:
                async for _ in ws:
                    metrics.inc("ws_received")
            except Exception:
                metrics.inc("ws_disconnect")

        recv_task = asyncio.create_task(receiver())
        try:
            t_end = time.time() + duration_sec
            while time.time() < t_end:
                # Keep-alive by holding open socket; avoid sending app-specific actions
                # that may skew metrics on different backend implementations.
                await asyncio.sleep(1)
        except Exception as e:  # noqa: BLE001
            metrics.add_error(f"ws_hold {user['username']} error={e}")
        finally:
            await ws.close()
            recv_task.cancel()

    await asyncio.gather(*(hold_connection(u) for u in users_data))


async def scenario_ws_chat(
    ws_base: str,
    users_data: list[dict[str, Any]],
    room_id: int,
    duration_sec: int,
    send_interval_sec: float,
    metrics: Metrics,
) -> None:
    async def chatter(user: dict[str, Any]) -> None:
        uri = f"{ws_base}/ws?token={quote(user['token'])}"
        try:
            ws = await ws_connect(uri, metrics)
        except Exception as e:  # noqa: BLE001
            metrics.inc("ws_connect_fail")
            metrics.add_error(f"ws_chat_connect {user['username']} error={e}")
            return

        async def receiver() -> None:
            try:
                async for _ in ws:
                    metrics.inc("ws_received")
            except Exception:
                metrics.inc("ws_disconnect")

        recv_task = asyncio.create_task(receiver())
        t_end = time.time() + duration_sec
        try:
            while time.time() < t_end:
                payload = {
                    "action": "send_message",
                    "room_id": room_id,
                    "content": f"[ws-load] {user['username']} {int(time.time()*1000)}",
                }
                t0 = time.perf_counter()
                await ws.send(json.dumps(payload))
                metrics.add_timing("ws_send", (time.perf_counter() - t0) * 1000.0)
                metrics.inc("ws_send_attempt")
                metrics.inc("ws_send_success")
                await asyncio.sleep(send_interval_sec)
        except Exception as e:  # noqa: BLE001
            metrics.inc("ws_send_fail")
            metrics.add_error(f"ws_chat_send {user['username']} error={e}")
        finally:
            await ws.close()
            recv_task.cancel()

    await asyncio.gather(*(chatter(u) for u in users_data))


def derive_ws_base(base: str, explicit_ws_base: str | None) -> str:
    if explicit_ws_base:
        return explicit_ws_base.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):]
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):]
    raise ValueError(f"Unsupported BASE URL: {base}")


async def main() -> None:
    load_dotenv()

    parser = argparse.ArgumentParser(description="Chat app load tester")
    parser.add_argument("--mode", choices=["http", "ws", "chat"], required=True)
    parser.add_argument("--base-url", default=os.getenv("LOAD_BASE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--ws-base", default=os.getenv("LOAD_WS_BASE", ""))
    parser.add_argument("--users", type=int, default=int(os.getenv("LOAD_USERS", "10")))
    parser.add_argument("--duration-sec", type=int, default=int(os.getenv("LOAD_DURATION_SEC", "60")))
    parser.add_argument("--send-interval-sec", type=float, default=float(os.getenv("LOAD_SEND_INTERVAL_SEC", "2.0")))
    parser.add_argument("--http-loops", type=int, default=5)
    parser.add_argument("--user-prefix", default=os.getenv("LOAD_USER_PREFIX", "loaduser"))
    parser.add_argument("--password", default=os.getenv("LOAD_PASSWORD", "loadpass123"))
    parser.add_argument("--room-id", type=int, default=int(os.getenv("LOAD_ROOM_ID", "0") or 0))
    parser.add_argument("--output", default="tests/load/results/latest.json")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    ws_base = derive_ws_base(base, args.ws_base)

    metrics = Metrics()
    started_at = time.time()

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
        users_data = await prepare_users(session, base, args.user_prefix, args.password, args.users, metrics)
        if len(users_data) < args.users:
            raise RuntimeError(f"Only prepared {len(users_data)}/{args.users} users")

        room_id = args.room_id
        if room_id <= 0 and args.mode in {"http", "chat"}:
            owner = users_data[0]
            member_ids = [u["user_id"] for u in users_data[1:]]
            room_id = await create_shared_room(session, base, owner["token"], member_ids, metrics)

    if args.mode == "http":
        await scenario_http(base, users_data, room_id, args.http_loops, metrics)
    elif args.mode == "ws":
        await scenario_ws_online(ws_base, users_data, args.duration_sec, metrics)
    elif args.mode == "chat":
        await scenario_ws_chat(ws_base, users_data, room_id, args.duration_sec, args.send_interval_sec, metrics)

    ended_at = time.time()
    summary = build_summary(
        metrics,
        started_at,
        ended_at,
        meta={
            "mode": args.mode,
            "base_url": base,
            "ws_base": ws_base,
            "users": args.users,
            "duration_sec": args.duration_sec,
            "send_interval_sec": args.send_interval_sec,
            "room_id": room_id,
        },
    )

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"\nSaved result: {output_path}")


if __name__ == "__main__":
    asyncio.run(main())
