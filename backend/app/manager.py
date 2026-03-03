from collections import defaultdict

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        self.user_sockets: dict[int, list[WebSocket]] = defaultdict(list)
        self.room_subscribers: dict[int, set[int]] = defaultdict(set)

    async def connect(self, user_id: int, websocket: WebSocket, room_ids: list[int]):
        await websocket.accept()
        self.user_sockets[user_id].append(websocket)
        for rid in room_ids:
            self.room_subscribers[rid].add(user_id)

    def disconnect(self, user_id: int, websocket: WebSocket):
        if user_id in self.user_sockets and websocket in self.user_sockets[user_id]:
            self.user_sockets[user_id].remove(websocket)
        if user_id in self.user_sockets and not self.user_sockets[user_id]:
            self.user_sockets.pop(user_id, None)

    def refresh_user_rooms(self, user_id: int, room_ids: list[int]):
        for rid in list(self.room_subscribers.keys()):
            self.room_subscribers[rid].discard(user_id)
            if not self.room_subscribers[rid]:
                self.room_subscribers.pop(rid, None)
        for rid in room_ids:
            self.room_subscribers[rid].add(user_id)

    async def send_json_to_user(self, user_id: int, payload: dict):
        sockets = self.user_sockets.get(user_id, [])
        dead = []
        for ws in sockets:
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(user_id, ws)

    async def broadcast_to_room(self, room_id: int, payload: dict):
        for uid in list(self.room_subscribers.get(room_id, set())):
            await self.send_json_to_user(uid, payload)
