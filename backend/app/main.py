from datetime import datetime

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import and_, delete, desc, insert, select
from sqlalchemy.orm import Session

from .config import settings
from .db import Base, SessionLocal, engine, get_db
from .manager import ConnectionManager
from .models import ChatRoom, Message, User, friends, room_members
from .schemas import (
    CreateRoomIn,
    EditMessageIn,
    LoginIn,
    MessageOut,
    RegisterIn,
    RoomOut,
    SearchUserOut,
    TokenOut,
    UserOut,
    UserUpdateIn,
    WsMessageIn,
)
from .security import create_access_token, hash_password, verify_access_token, verify_password

app = FastAPI(title=settings.app_name)
manager = ConnectionManager()

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def parse_bearer_token(authorization: str | None) -> str:
    if not authorization:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing Authorization header")
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Authorization format")
    return authorization.replace("Bearer ", "", 1).strip()


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    token = parse_bearer_token(authorization)
    payload = verify_access_token(token)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")

    uid = int(payload["sub"])
    user = db.get(User, uid)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


def get_room_ids_for_user(db: Session, user_id: int) -> list[int]:
    rows = db.execute(select(room_members.c.room_id).where(room_members.c.user_id == user_id)).all()
    return [r[0] for r in rows]


def serialize_message(m: Message) -> dict:
    return {
        "id": m.id,
        "room_id": m.room_id,
        "sender_id": m.sender_id,
        "content": m.content,
        "edited_by_admin": m.edited_by_admin,
        "created_at": m.created_at.isoformat(),
        "updated_at": m.updated_at.isoformat() if m.updated_at else None,
    }


def ensure_user_in_room(db: Session, user_id: int, room_id: int):
    exists = db.execute(
        select(room_members.c.room_id).where(
            and_(room_members.c.room_id == room_id, room_members.c.user_id == user_id)
        )
    ).first()
    if not exists:
        raise HTTPException(status_code=403, detail="You are not a member of this room")


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # 初始化一个管理员账号（仅首次创建）
        admin = db.execute(select(User).where(User.username == "admin")).scalar_one_or_none()
        if not admin:
            admin = User(
                username="admin",
                email="admin@example.com",
                password_hash=hash_password("admin123456"),
                role="admin",
                nickname="管理员",
                signature="系统管理员",
            )
            db.add(admin)
            db.commit()
    finally:
        db.close()


@app.get("/health")
def health():
    return {"status": "ok", "env": settings.app_env}


@app.post("/api/auth/register", response_model=TokenOut)
def register(payload: RegisterIn, db: Session = Depends(get_db)):
    exists = db.execute(
        select(User).where((User.username == payload.username) | (User.email == payload.email))
    ).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=400, detail="Username or email already exists")

    user = User(
        username=payload.username,
        email=payload.email,
        password_hash=hash_password(payload.password),
        role="member",
        nickname=payload.username,
        signature="",
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token(user.id, user.username)
    return TokenOut(token=token, user=UserOut.model_validate(user))


@app.post("/api/auth/login", response_model=TokenOut)
def login(payload: LoginIn, db: Session = Depends(get_db)):
    user = db.execute(select(User).where(User.username == payload.username)).scalar_one_or_none()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    token = create_access_token(user.id, user.username)
    return TokenOut(token=token, user=UserOut.model_validate(user))


@app.get("/api/users/me", response_model=UserOut)
def get_me(current_user: User = Depends(get_current_user)):
    return UserOut.model_validate(current_user)


@app.patch("/api/users/me", response_model=UserOut)
def update_me(payload: UserUpdateIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if payload.nickname is not None:
        current_user.nickname = payload.nickname
    if payload.signature is not None:
        current_user.signature = payload.signature
    if payload.avatar_base64 is not None:
        current_user.avatar_base64 = payload.avatar_base64
    db.commit()
    db.refresh(current_user)
    return UserOut.model_validate(current_user)


@app.get("/api/users/search", response_model=list[SearchUserOut])
def search_users(
    q: str = Query(min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = db.execute(select(User).where(User.username.ilike(f"%{q}%"), User.id != current_user.id).limit(20)).scalars().all()
    return [SearchUserOut(id=u.id, username=u.username, nickname=u.nickname, is_online=u.is_online) for u in rows]


@app.post("/api/friends/{friend_id}")
def add_friend(friend_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if friend_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot add yourself")

    friend = db.get(User, friend_id)
    if not friend:
        raise HTTPException(status_code=404, detail="User not found")

    # 双向好友关系
    for uid, fid in [(current_user.id, friend_id), (friend_id, current_user.id)]:
        exists = db.execute(
            select(friends.c.user_id).where(and_(friends.c.user_id == uid, friends.c.friend_id == fid))
        ).first()
        if not exists:
            db.execute(insert(friends).values(user_id=uid, friend_id=fid))

    # 自动创建单聊房间（如果不存在）
    my_room_ids = set(get_room_ids_for_user(db, current_user.id))
    friend_room_ids = set(get_room_ids_for_user(db, friend_id))
    shared = my_room_ids.intersection(friend_room_ids)
    private_room = None
    if shared:
        private_room = db.execute(
            select(ChatRoom).where(ChatRoom.id.in_(shared), ChatRoom.room_type == "private")
        ).scalars().first()

    if not private_room:
        room = ChatRoom(name=f"{current_user.username}-{friend.username}", room_type="private", created_by=current_user.id)
        db.add(room)
        db.commit()
        db.refresh(room)
        db.execute(insert(room_members).values(room_id=room.id, user_id=current_user.id))
        db.execute(insert(room_members).values(room_id=room.id, user_id=friend.id))

    db.commit()

    manager.refresh_user_rooms(current_user.id, get_room_ids_for_user(db, current_user.id))
    manager.refresh_user_rooms(friend_id, get_room_ids_for_user(db, friend_id))
    return {"ok": True}


@app.get("/api/friends", response_model=list[SearchUserOut])
def get_friends(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ids = db.execute(select(friends.c.friend_id).where(friends.c.user_id == current_user.id)).all()
    friend_ids = [x[0] for x in ids]
    if not friend_ids:
        return []
    users = db.execute(select(User).where(User.id.in_(friend_ids))).scalars().all()
    return [SearchUserOut(id=u.id, username=u.username, nickname=u.nickname, is_online=u.is_online) for u in users]


@app.post("/api/rooms", response_model=RoomOut)
def create_group_room(payload: CreateRoomIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    members = set(payload.member_ids)
    members.add(current_user.id)

    valid_members = db.execute(select(User.id).where(User.id.in_(members))).all()
    valid_ids = {x[0] for x in valid_members}
    if current_user.id not in valid_ids:
        raise HTTPException(status_code=400, detail="Current user invalid")

    room = ChatRoom(name=payload.name, room_type="group", created_by=current_user.id)
    db.add(room)
    db.commit()
    db.refresh(room)

    for uid in valid_ids:
        db.execute(insert(room_members).values(room_id=room.id, user_id=uid))
    db.commit()

    for uid in valid_ids:
        manager.refresh_user_rooms(uid, get_room_ids_for_user(db, uid))

    return RoomOut(id=room.id, name=room.name, room_type=room.room_type, created_by=room.created_by, member_ids=list(valid_ids))


@app.get("/api/rooms", response_model=list[RoomOut])
def list_my_rooms(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    room_ids = get_room_ids_for_user(db, current_user.id)
    if not room_ids:
        return []

    rooms = db.execute(select(ChatRoom).where(ChatRoom.id.in_(room_ids))).scalars().all()
    res: list[RoomOut] = []
    for room in rooms:
        mids = db.execute(select(room_members.c.user_id).where(room_members.c.room_id == room.id)).all()
        res.append(
            RoomOut(
                id=room.id,
                name=room.name,
                room_type=room.room_type,
                created_by=room.created_by,
                member_ids=[m[0] for m in mids],
            )
        )
    return res


@app.get("/api/rooms/{room_id}/messages", response_model=list[MessageOut])
def get_room_messages(
    room_id: int,
    limit: int = Query(default=50, ge=1, le=200),
    before: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)

    query = select(Message).where(Message.room_id == room_id)
    if before:
        query = query.where(Message.id < before)

    rows = db.execute(query.order_by(desc(Message.id)).limit(limit)).scalars().all()
    rows.reverse()
    return [
        MessageOut(
            id=m.id,
            room_id=m.room_id,
            sender_id=m.sender_id,
            content=m.content,
            edited_by_admin=m.edited_by_admin,
            created_at=m.created_at,
            updated_at=m.updated_at,
        )
        for m in rows
    ]


@app.patch("/api/messages/{message_id}", response_model=MessageOut)
async def admin_edit_message(
    message_id: int,
    payload: EditMessageIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Only admin can edit messages")

    msg = db.get(Message, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    msg.content = payload.content
    msg.edited_by_admin = True
    msg.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(msg)

    payload_ws = {"type": "message_edited", "payload": serialize_message(msg)}
    await manager.broadcast_to_room(msg.room_id, payload_ws)

    return MessageOut(
        id=msg.id,
        room_id=msg.room_id,
        sender_id=msg.sender_id,
        content=msg.content,
        edited_by_admin=msg.edited_by_admin,
        created_at=msg.created_at,
        updated_at=msg.updated_at,
    )


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(...)):
    payload = verify_access_token(token)
    if not payload:
        await websocket.close(code=1008)
        return

    user_id = int(payload["sub"])
    db = SessionLocal()
    try:
        user = db.get(User, user_id)
        if not user:
            await websocket.close(code=1008)
            return

        user.is_online = True
        db.commit()

        room_ids = get_room_ids_for_user(db, user_id)
        await manager.connect(user_id, websocket, room_ids)

        await websocket.send_json({
            "type": "connected",
            "payload": {"user_id": user_id, "room_ids": room_ids},
        })

        while True:
            raw = await websocket.receive_json()
            data = WsMessageIn(**raw)

            if data.action == "ping":
                await websocket.send_json({"type": "pong", "payload": {"time": datetime.utcnow().isoformat()}})
                continue

            if data.action == "send_message":
                if not data.content or not data.content.strip():
                    await websocket.send_json({"type": "error", "payload": {"message": "Empty content"}})
                    continue

                member = db.execute(
                    select(room_members.c.room_id).where(
                        and_(room_members.c.room_id == data.room_id, room_members.c.user_id == user_id)
                    )
                ).first()
                if not member:
                    await websocket.send_json({"type": "error", "payload": {"message": "No room access"}})
                    continue

                msg = Message(room_id=data.room_id, sender_id=user_id, content=data.content.strip())
                db.add(msg)
                db.commit()
                db.refresh(msg)

                await manager.broadcast_to_room(
                    data.room_id,
                    {"type": "new_message", "payload": serialize_message(msg)},
                )
                continue

            if data.action == "edit_message":
                if user.role != "admin":
                    await websocket.send_json({"type": "error", "payload": {"message": "Only admin can edit"}})
                    continue
                if not data.message_id or not data.content:
                    await websocket.send_json({"type": "error", "payload": {"message": "message_id/content required"}})
                    continue

                msg = db.get(Message, data.message_id)
                if not msg or msg.room_id != data.room_id:
                    await websocket.send_json({"type": "error", "payload": {"message": "Message not found"}})
                    continue

                msg.content = data.content.strip()
                msg.updated_at = datetime.utcnow()
                msg.edited_by_admin = True
                db.commit()
                db.refresh(msg)

                await manager.broadcast_to_room(
                    data.room_id,
                    {"type": "message_edited", "payload": serialize_message(msg)},
                )
                continue

            await websocket.send_json({"type": "error", "payload": {"message": "Unknown action"}})

    except WebSocketDisconnect:
        pass
    finally:
        user = db.get(User, user_id)
        if user:
            user.is_online = False
            db.commit()
        manager.disconnect(user_id, websocket)
        db.close()


@app.delete("/api/rooms/{room_id}")
def delete_room(room_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.created_by != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="No permission")

    members = db.execute(select(room_members.c.user_id).where(room_members.c.room_id == room_id)).all()
    db.execute(delete(room_members).where(room_members.c.room_id == room_id))
    db.delete(room)
    db.commit()

    for m in members:
        uid = m[0]
        manager.refresh_user_rooms(uid, get_room_ids_for_user(db, uid))

    return {"ok": True}
