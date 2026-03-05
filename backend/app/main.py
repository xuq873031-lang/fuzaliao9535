from datetime import datetime

from fastapi import Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import and_, delete, desc, func, insert, inspect, select, text
from sqlalchemy.orm import Session

from .config import settings
from .db import Base, SessionLocal, engine, get_db
from .manager import ConnectionManager
from .models import ChatRoom, Message, RoomRead, User, friends, room_members
from .schemas import (
    AddRoomMemberIn,
    CreateGroupRoomIn,
    CreateRoomIn,
    EditMessageIn,
    LoginIn,
    MarkRoomReadIn,
    MessageOut,
    PresenceOnlineUserOut,
    PresenceStatusOut,
    RegisterIn,
    RoomUnreadOut,
    RoomOut,
    RoomMemberOut,
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
    allow_origins=["https://xuq873031-lang.github.io"],
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


def get_room_member_ids(db: Session, room_id: int) -> list[int]:
    rows = db.execute(select(room_members.c.user_id).where(room_members.c.room_id == room_id)).all()
    return [r[0] for r in rows]


def get_room_members_with_meta(db: Session, room_id: int):
    return db.execute(
        select(room_members.c.user_id, room_members.c.role, room_members.c.joined_at).where(room_members.c.room_id == room_id)
    ).all()


def get_room_member_role(db: Session, room_id: int, user_id: int) -> str | None:
    row = db.execute(
        select(room_members.c.role).where(room_members.c.room_id == room_id, room_members.c.user_id == user_id)
    ).first()
    return row[0] if row else None


def room_effective_type(room: ChatRoom) -> str:
    value = room.type or room.room_type or "group"
    if value == "private":
        return "dm"
    return value


def room_effective_title(room: ChatRoom) -> str:
    return room.title or room.name


def get_room_latest_message_id(db: Session, room_id: int) -> int | None:
    row = db.execute(select(Message.id).where(Message.room_id == room_id).order_by(desc(Message.id)).limit(1)).first()
    return row[0] if row else None


def get_user_room_read(db: Session, user_id: int, room_id: int) -> RoomRead | None:
    return db.execute(
        select(RoomRead).where(RoomRead.user_id == user_id, RoomRead.room_id == room_id)
    ).scalars().first()


def get_unread_count_for_room(db: Session, user_id: int, room_id: int) -> int:
    rr = get_user_room_read(db, user_id, room_id)
    if rr and rr.last_read_message_id:
        row = db.execute(
            select(func.count(Message.id)).where(
                Message.room_id == room_id,
                Message.id > rr.last_read_message_id,
            )
        ).first()
        return int(row[0] if row else 0)
    row = db.execute(select(func.count(Message.id)).where(Message.room_id == room_id)).first()
    return int(row[0] if row else 0)


def mark_room_read(db: Session, user_id: int, room_id: int, last_read_message_id: int | None) -> int:
    final_last_read = last_read_message_id or get_room_latest_message_id(db, room_id)
    rr = get_user_room_read(db, user_id, room_id)
    now = datetime.utcnow()
    if rr:
        if final_last_read is not None:
            rr.last_read_message_id = final_last_read
        rr.last_read_at = now
    else:
        rr = RoomRead(
            user_id=user_id,
            room_id=room_id,
            last_read_message_id=final_last_read,
            last_read_at=now,
        )
        db.add(rr)
    db.commit()
    return get_unread_count_for_room(db, user_id, room_id)


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


def ensure_compatible_schema():
    """
    向后兼容迁移：
    - users.last_seen_at
    - chat_rooms.type/title/avatar
    - room_members.role/joined_at
    """
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())
    with engine.begin() as conn:
        if "users" in table_names:
            user_columns = {col["name"] for col in inspector.get_columns("users")}
            if "last_seen_at" not in user_columns:
                if engine.dialect.name == "sqlite":
                    conn.execute(text("ALTER TABLE users ADD COLUMN last_seen_at DATETIME"))
                else:
                    conn.execute(text("ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMP NULL"))

        if "chat_rooms" in table_names:
            room_columns = {col["name"] for col in inspector.get_columns("chat_rooms")}
            if "type" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN type VARCHAR(20)"))
            if "title" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN title VARCHAR(120)"))
            if "avatar" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN avatar TEXT"))

            # 数据回填：旧 room_type=private -> type=dm，其余保留 group
            conn.execute(text("UPDATE chat_rooms SET type='dm' WHERE type IS NULL AND room_type='private'"))
            conn.execute(text("UPDATE chat_rooms SET type='group' WHERE type IS NULL AND room_type!='private'"))
            conn.execute(text("UPDATE chat_rooms SET title=name WHERE title IS NULL"))

        if "room_members" in table_names:
            member_columns = {col["name"] for col in inspector.get_columns("room_members")}
            if "role" not in member_columns:
                conn.execute(text("ALTER TABLE room_members ADD COLUMN role VARCHAR(20)"))
            if "joined_at" not in member_columns:
                if engine.dialect.name == "sqlite":
                    conn.execute(text("ALTER TABLE room_members ADD COLUMN joined_at DATETIME"))
                else:
                    conn.execute(text("ALTER TABLE room_members ADD COLUMN joined_at TIMESTAMP NULL"))

            conn.execute(text("UPDATE room_members SET role='member' WHERE role IS NULL"))
            conn.execute(text("UPDATE room_members SET joined_at=CURRENT_TIMESTAMP WHERE joined_at IS NULL"))


def ensure_message_indexes():
    """
    兼容迁移：为消息历史分页创建复合索引 (room_id, created_at)。
    """
    with engine.begin() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_room_created_at ON messages (room_id, created_at)"))


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    ensure_compatible_schema()
    ensure_message_indexes()
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
            select(ChatRoom).where(ChatRoom.id.in_(shared), ChatRoom.type.in_(["dm", "private"]))
        ).scalars().first()

    if not private_room:
        title = f"{current_user.username}-{friend.username}"
        room = ChatRoom(
            name=title,
            title=title,
            room_type="private",
            type="dm",
            created_by=current_user.id,
        )
        db.add(room)
        db.commit()
        db.refresh(room)
        db.execute(insert(room_members).values(room_id=room.id, user_id=current_user.id, role="owner", joined_at=datetime.utcnow()))
        db.execute(insert(room_members).values(room_id=room.id, user_id=friend.id, role="member", joined_at=datetime.utcnow()))

    db.commit()

    manager.refresh_user_rooms(current_user.id, get_room_ids_for_user(db, current_user.id))
    manager.refresh_user_rooms(friend_id, get_room_ids_for_user(db, friend_id))
    return {"ok": True}


@app.delete("/api/friends/{friend_id}")
def remove_friend(friend_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if friend_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot remove yourself")

    friend = db.get(User, friend_id)
    if not friend:
        raise HTTPException(status_code=404, detail="User not found")

    db.execute(
        delete(friends).where(friends.c.user_id == current_user.id, friends.c.friend_id == friend_id)
    )
    db.execute(
        delete(friends).where(friends.c.user_id == friend_id, friends.c.friend_id == current_user.id)
    )
    db.commit()
    return {"ok": True}


@app.get("/api/friends", response_model=list[SearchUserOut])
def get_friends(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ids = db.execute(select(friends.c.friend_id).where(friends.c.user_id == current_user.id)).all()
    friend_ids = [x[0] for x in ids]
    if not friend_ids:
        return []
    users = db.execute(select(User).where(User.id.in_(friend_ids))).scalars().all()
    return [SearchUserOut(id=u.id, username=u.username, nickname=u.nickname, is_online=u.is_online) for u in users]


@app.get("/api/presence/online", response_model=list[PresenceOnlineUserOut])
def get_online_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    users = db.execute(select(User).where(User.is_online.is_(True))).scalars().all()
    return [PresenceOnlineUserOut(id=u.id, username=u.username) for u in users]


@app.get("/api/presence/{user_id}", response_model=PresenceStatusOut)
def get_user_presence(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return PresenceStatusOut(user_id=user.id, online=user.is_online, last_seen_at=user.last_seen_at)


def _create_group_room_impl(
    title: str,
    member_ids: list[int],
    avatar: str | None,
    db: Session,
    current_user: User,
) -> RoomOut:
    members = set(member_ids)
    members.add(current_user.id)

    valid_members = db.execute(select(User.id).where(User.id.in_(members))).all()
    valid_ids = {x[0] for x in valid_members}
    if current_user.id not in valid_ids:
        raise HTTPException(status_code=400, detail="Current user invalid")

    room = ChatRoom(
        name=title,
        title=title,
        avatar=avatar,
        room_type="group",
        type="group",
        created_by=current_user.id,
    )
    db.add(room)
    db.commit()
    db.refresh(room)

    for uid in valid_ids:
        role = "owner" if uid == current_user.id else "member"
        db.execute(
            insert(room_members).values(
                room_id=room.id,
                user_id=uid,
                role=role,
                joined_at=datetime.utcnow(),
            )
        )
    db.commit()

    for uid in valid_ids:
        manager.refresh_user_rooms(uid, get_room_ids_for_user(db, uid))

    return RoomOut(
        id=room.id,
        name=room.name,
        room_type=room.room_type,
        type=room_effective_type(room),
        title=room_effective_title(room),
        avatar=room.avatar,
        created_by=room.created_by,
        member_ids=list(valid_ids),
        member_count=len(valid_ids),
    )


@app.post("/api/rooms/group", response_model=RoomOut)
def create_group_room_v2(
    payload: CreateGroupRoomIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return _create_group_room_impl(payload.title, payload.member_ids, payload.avatar, db, current_user)


@app.post("/api/rooms", response_model=RoomOut, deprecated=True)
def create_group_room(payload: CreateRoomIn, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    # 兼容旧接口：name -> title
    return _create_group_room_impl(payload.name, payload.member_ids, None, db, current_user)


@app.get("/api/rooms", response_model=list[RoomOut])
def list_my_rooms(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    room_ids = get_room_ids_for_user(db, current_user.id)
    if not room_ids:
        return []

    rooms = db.execute(select(ChatRoom).where(ChatRoom.id.in_(room_ids))).scalars().all()
    res: list[RoomOut] = []
    for room in rooms:
        mids = db.execute(select(room_members.c.user_id).where(room_members.c.room_id == room.id)).all()
        member_ids = [m[0] for m in mids]
        res.append(
            RoomOut(
                id=room.id,
                name=room.name,
                room_type=room.room_type,
                type=room_effective_type(room),
                title=room_effective_title(room),
                avatar=room.avatar,
                created_by=room.created_by,
                member_ids=member_ids,
                member_count=len(member_ids),
            )
        )
    return res


@app.get("/api/rooms/{room_id}/members", response_model=list[RoomMemberOut])
def list_room_members(
    room_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)
    rows = get_room_members_with_meta(db, room_id)
    user_ids = [r[0] for r in rows]
    users = db.execute(select(User).where(User.id.in_(user_ids))).scalars().all() if user_ids else []
    user_map = {u.id: u for u in users}
    return [
        RoomMemberOut(
            room_id=room_id,
            user_id=uid,
            username=user_map[uid].username if uid in user_map else f"user_{uid}",
            nickname=user_map[uid].nickname if uid in user_map else "",
            role=role or "member",
            joined_at=joined_at,
        )
        for uid, role, joined_at in rows
    ]


@app.post("/api/rooms/{room_id}/members")
async def add_room_member(
    room_id: int,
    payload: AddRoomMemberIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room_effective_type(room) != "group":
        raise HTTPException(status_code=400, detail="Only group room supports member management")

    my_role = get_room_member_role(db, room_id, current_user.id)
    if my_role != "owner":
        raise HTTPException(status_code=403, detail="Only owner can add members")

    target_user = db.get(User, payload.user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="Target user not found")

    exists = db.execute(
        select(room_members.c.user_id).where(room_members.c.room_id == room_id, room_members.c.user_id == payload.user_id)
    ).first()
    if not exists:
        db.execute(
            insert(room_members).values(
                room_id=room_id,
                user_id=payload.user_id,
                role="member",
                joined_at=datetime.utcnow(),
            )
        )
        db.commit()
        manager.refresh_user_rooms(payload.user_id, get_room_ids_for_user(db, payload.user_id))

        system_msg = Message(
            room_id=room_id,
            sender_id=current_user.id,
            content=f"[system] {target_user.nickname or target_user.username} 加入了群聊",
        )
        db.add(system_msg)
        db.commit()
        db.refresh(system_msg)
        await manager.broadcast_to_room(room_id, {"type": "new_message", "payload": serialize_message(system_msg)})

    return {"ok": True}


@app.delete("/api/rooms/{room_id}/members/{user_id}")
async def remove_room_member(
    room_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room_effective_type(room) != "group":
        raise HTTPException(status_code=400, detail="Only group room supports member management")

    my_role = get_room_member_role(db, room_id, current_user.id)
    if current_user.id != user_id and my_role != "owner":
        raise HTTPException(status_code=403, detail="Only owner can remove other members")

    exists = db.execute(
        select(room_members.c.user_id).where(room_members.c.room_id == room_id, room_members.c.user_id == user_id)
    ).first()
    if not exists:
        raise HTTPException(status_code=404, detail="Member not found")

    # 不允许移除最后一个 owner，确保群可管理
    target_role = get_room_member_role(db, room_id, user_id)
    if target_role == "owner":
        owner_count_row = db.execute(
            select(func.count()).select_from(room_members).where(room_members.c.room_id == room_id, room_members.c.role == "owner")
        ).first()
        owner_count = int(owner_count_row[0] if owner_count_row else 0)
        if owner_count <= 1:
            raise HTTPException(status_code=400, detail="Cannot remove the last owner")

    db.execute(delete(room_members).where(room_members.c.room_id == room_id, room_members.c.user_id == user_id))
    db.commit()
    manager.refresh_user_rooms(user_id, get_room_ids_for_user(db, user_id))

    actor = current_user.nickname or current_user.username
    system_msg = Message(room_id=room_id, sender_id=current_user.id, content=f"[system] {actor} 移除了成员 {user_id}")
    db.add(system_msg)
    db.commit()
    db.refresh(system_msg)
    await manager.broadcast_to_room(room_id, {"type": "new_message", "payload": serialize_message(system_msg)})
    return {"ok": True}


@app.get("/api/rooms/unread", response_model=list[RoomUnreadOut])
def get_rooms_unread(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    room_ids = get_room_ids_for_user(db, current_user.id)
    return [
        RoomUnreadOut(room_id=rid, unread_count=get_unread_count_for_room(db, current_user.id, rid))
        for rid in room_ids
    ]


@app.post("/api/rooms/{room_id}/read")
async def mark_room_as_read(
    room_id: int,
    payload: MarkRoomReadIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)
    unread_count = mark_room_read(db, current_user.id, room_id, payload.last_read_message_id)

    await manager.send_json_to_user(
        current_user.id,
        {"type": "unread_update", "room_id": room_id, "unread_count": unread_count},
    )
    await manager.broadcast_to_room(
        room_id,
        {
            "type": "read_receipt",
            "room_id": room_id,
            "user_id": current_user.id,
            "last_read_message_id": payload.last_read_message_id,
        },
    )
    return {"ok": True, "room_id": room_id, "unread_count": unread_count}


@app.get("/api/rooms/{room_id}/messages", response_model=list[MessageOut])
def get_room_messages(
    room_id: int,
    limit: int = Query(default=50, ge=1, le=100),
    before_id: int | None = Query(default=None),
    before: int | None = Query(default=None, deprecated=True),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)

    query = select(Message).where(Message.room_id == room_id)
    cursor_id = before_id or before
    if cursor_id:
        anchor = db.get(Message, cursor_id)
        if anchor and anchor.room_id == room_id:
            query = query.where(
                (Message.created_at < anchor.created_at)
                | ((Message.created_at == anchor.created_at) & (Message.id < anchor.id))
            )
        else:
            query = query.where(Message.id < cursor_id)

    # 默认按时间倒序返回（最新在前）
    rows = db.execute(query.order_by(desc(Message.created_at), desc(Message.id)).limit(limit)).scalars().all()
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

        room_ids = get_room_ids_for_user(db, user_id)
        had_connection = manager.connection_count(user_id) > 0
        await manager.connect(user_id, websocket, room_ids)

        # 同一用户多连接时，仅首个连接触发 online 状态变更
        if not had_connection:
            user.is_online = True
            db.commit()
            await manager.broadcast_global(
                {
                    "type": "presence",
                    "user_id": user_id,
                    "online": True,
                }
            )

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

                # 发送者默认已读到最新消息
                mark_room_read(db, user_id, data.room_id, msg.id)

                await manager.broadcast_to_room(
                    data.room_id,
                    {"type": "new_message", "payload": serialize_message(msg)},
                )

                # 推送每个成员在该房间的最新未读数
                for uid in get_room_member_ids(db, data.room_id):
                    unread_count = get_unread_count_for_room(db, uid, data.room_id)
                    await manager.send_json_to_user(
                        uid,
                        {"type": "unread_update", "room_id": data.room_id, "unread_count": unread_count},
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
        manager.disconnect(user_id, websocket)
        remain = manager.connection_count(user_id)
        if remain == 0:
            user = db.get(User, user_id)
            if user:
                user.is_online = False
                user.last_seen_at = datetime.utcnow()
                db.commit()
                await manager.broadcast_global(
                    {
                        "type": "presence",
                        "user_id": user_id,
                        "online": False,
                        "last_seen_at": user.last_seen_at.isoformat(),
                    }
                )
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
