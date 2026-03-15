from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import and_, delete, desc, func, insert, inspect, or_, select, text
from sqlalchemy.orm import Session

from .config import settings
from .db import Base, SessionLocal, engine, get_db
from .manager import ConnectionManager
from .models import ChatRoom, FriendRemark, FriendRequest, Message, RoomMute, RoomRead, User, friends, room_members
try:
    from .models import UserHiddenMessage
except ImportError:
    UserHiddenMessage = None
from .schemas import (
    AdminUserStatusIn,
    AdminUserPermissionsIn,
    AdminResetPasswordIn,
    AdminUserOut,
    AddRoomMemberIn,
    CreateFriendRequestIn,
    CreateGroupRoomIn,
    CreateRoomIn,
    EditMessageIn,
    FriendRemarkIn,
    FriendRemarkOut,
    FriendRequestOut,
    LoginIn,
    MarkRoomReadIn,
    MessageOut,
    PresenceOnlineUserOut,
    PresenceStatusOut,
    RegisterIn,
    RoomUnreadOut,
    RoomOut,
    RoomMemberOut,
    RoomMemberPermissionIn,
    RoomMuteOut,
    RoomMuteMemberOut,
    RoomRateLimitIn,
    RoomUpdateIn,
    SendMessageIn,
    SearchUserOut,
    TokenOut,
    UserOut,
    UserUpdateIn,
    WsMessageIn,
)
from .security import create_access_token, hash_password, verify_access_token, verify_password

manager = ConnectionManager()
call_sessions: dict[str, dict] = {}
user_call_index: dict[int, str] = {}
group_rate_last_sent_at: dict[tuple[int, int], datetime] = {}


def utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    run_startup_tasks()
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)


def _resolve_upload_dir() -> Path:
    configured = Path(settings.upload_dir)
    if configured.is_absolute():
        return configured
    return Path(__file__).resolve().parents[1] / configured


UPLOAD_DIR = _resolve_upload_dir()
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=r"https://.*\.github\.io",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def validate_production_guardrails():
    is_prod = settings.app_env.strip().lower() == "production"
    if not is_prod:
        return

    db_url = settings.database_url.strip().lower()
    if settings.enforce_non_sqlite_in_production and db_url.startswith("sqlite"):
        raise RuntimeError(
            "P0 guardrail: production 禁止使用 SQLite。"
            "请配置 DATABASE_URL 为 PostgreSQL（postgresql+psycopg://...）"
        )

    if not settings.allow_local_uploads_in_production:
        raise RuntimeError(
            "P0 guardrail: production 默认禁止本地 uploads。"
            "若短期无法接对象存储，请显式设置 ALLOW_LOCAL_UPLOADS_IN_PRODUCTION=true 后再部署（知晓数据丢失风险）。"
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
    if not bool(user.is_active):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账号已注销")
    if bool(user.is_banned):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账号已封禁")
    return user


def get_room_ids_for_user(db: Session, user_id: int) -> list[int]:
    rows = db.execute(
        select(room_members.c.room_id)
        .join(ChatRoom, ChatRoom.id == room_members.c.room_id)
        .where(
            and_(
                room_members.c.user_id == user_id,
                ChatRoom.is_dissolved.is_(False),
            )
        )
    ).all()
    return [r[0] for r in rows]


def get_room_member_ids(db: Session, room_id: int) -> list[int]:
    rows = db.execute(select(room_members.c.user_id).where(room_members.c.room_id == room_id)).all()
    return [r[0] for r in rows]


def get_room_members_with_meta(db: Session, room_id: int):
    return db.execute(
        select(
            room_members.c.user_id,
            room_members.c.role,
            room_members.c.can_kick,
            room_members.c.can_mute,
            room_members.c.can_recall_others,
            room_members.c.can_super_delete,
            room_members.c.joined_at,
        ).where(room_members.c.room_id == room_id)
    ).all()


def get_direct_call_peer_id(db: Session, room_id: int, user_id: int) -> int:
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room_effective_type(room) != "dm":
        raise HTTPException(status_code=400, detail="Only 1-to-1 call is supported")

    member_ids = get_room_member_ids(db, room_id)
    if user_id not in member_ids:
        raise HTTPException(status_code=403, detail="No room access")
    if len(member_ids) != 2:
        raise HTTPException(status_code=400, detail="Only 1-to-1 call is supported")
    return member_ids[0] if member_ids[1] == user_id else member_ids[1]


def get_call_peer_id(call: dict, user_id: int) -> int | None:
    if not call:
        return None
    caller = int(call["caller_id"])
    callee = int(call["callee_id"])
    if user_id == caller:
        return callee
    if user_id == callee:
        return caller
    return None


def clear_call_state(call_id: str | None) -> dict | None:
    if not call_id:
        return None
    call = call_sessions.pop(call_id, None)
    if not call:
        return None
    user_call_index.pop(int(call["caller_id"]), None)
    user_call_index.pop(int(call["callee_id"]), None)
    return call


def get_room_member_role(db: Session, room_id: int, user_id: int) -> str | None:
    row = db.execute(
        select(room_members.c.role).where(room_members.c.room_id == room_id, room_members.c.user_id == user_id)
    ).first()
    return row[0] if row else None


def get_room_member_permissions(db: Session, room_id: int, user_id: int) -> tuple[bool, bool, bool, bool]:
    row = db.execute(
        select(
            room_members.c.can_kick,
            room_members.c.can_mute,
            room_members.c.can_recall_others,
            room_members.c.can_super_delete,
        ).where(
            room_members.c.room_id == room_id,
            room_members.c.user_id == user_id,
        )
    ).first()
    if not row:
        return False, False, False, False
    return bool(row[0]), bool(row[1]), bool(row[2]), bool(row[3])


def get_room_member_permission_meta(db: Session, room_id: int, user_id: int) -> dict:
    role = get_room_member_role(db, room_id, user_id)
    can_kick, can_mute, can_recall_others, can_super_delete = get_room_member_permissions(db, room_id, user_id)
    return {
        "role": role or "member",
        "can_kick": can_kick,
        "can_mute": can_mute,
        "can_recall_others": can_recall_others,
        "can_super_delete": can_super_delete,
    }


def can_actor_manage_member(db: Session, room_id: int, actor_id: int, target_id: int, action: str) -> bool:
    actor_role = get_room_member_role(db, room_id, actor_id)
    target_role = get_room_member_role(db, room_id, target_id)
    if not actor_role or not target_role:
        return False
    actor_user = db.get(User, actor_id)
    if not actor_user:
        return False
    if action == "kick" and not has_permission(actor_user, "can_kick_members"):
        return False
    if action == "mute" and not has_permission(actor_user, "can_mute_members"):
        return False
    if actor_role == "owner":
        return target_role != "owner" and actor_id != target_id
    can_kick, can_mute, _, _ = get_room_member_permissions(db, room_id, actor_id)
    target_can_kick, target_can_mute, _, _ = get_room_member_permissions(db, room_id, target_id)
    target_is_delegated_admin = target_can_kick or target_can_mute
    if action == "kick":
        return can_kick and target_role != "owner" and actor_id != target_id and not target_is_delegated_admin
    if action == "mute":
        return can_mute and target_role != "owner" and actor_id != target_id and not target_is_delegated_admin
    return False


def can_bypass_group_global_mute(db: Session, room_id: int, user_id: int) -> bool:
    role = get_room_member_role(db, room_id, user_id)
    if role == "owner":
        return True
    can_kick, can_mute, _, _ = get_room_member_permissions(db, room_id, user_id)
    return bool(can_kick or can_mute)


def should_bypass_group_rate_limit(db: Session, room_id: int, user_id: int) -> bool:
    role = get_room_member_role(db, room_id, user_id)
    if role == "owner":
        return True
    can_kick, can_mute, _, _ = get_room_member_permissions(db, room_id, user_id)
    return bool(can_kick or can_mute)


def can_recall_message_in_room(db: Session, current_user: User, msg: Message) -> bool:
    if not current_user or not msg:
        return False
    if msg.sender_id == current_user.id:
        return bool(current_user.role == "admin" or has_permission(current_user, "can_recall_own_messages"))
    room = db.get(ChatRoom, msg.room_id)
    if not room:
        return False
    if current_user.role == "admin" or has_permission(current_user, "can_recall_others_messages"):
        return True
    if room_effective_type(room) != "group":
        return False
    meta = get_room_member_permission_meta(db, msg.room_id, current_user.id)
    return meta["role"] == "owner" or bool(meta["can_recall_others"])


def can_super_delete_message_in_room(db: Session, current_user: User, msg: Message) -> bool:
    if not current_user or not msg:
        return False
    room = db.get(ChatRoom, msg.room_id)
    if not room:
        return False
    if current_user.role == "admin" or has_permission(current_user, "can_super_delete_messages"):
        return True
    if room_effective_type(room) != "group":
        return False
    meta = get_room_member_permission_meta(db, msg.room_id, current_user.id)
    return meta["role"] == "owner" or bool(meta["can_super_delete"])


def check_group_rate_limit_or_raise(db: Session, room: ChatRoom, user_id: int):
    if room_effective_type(room) != "group":
        return
    seconds = int(room.rate_limit_seconds or 0)
    if seconds <= 0:
        return
    if should_bypass_group_rate_limit(db, room.id, user_id):
        return
    now = utc_now_naive()
    key = (room.id, user_id)
    last = group_rate_last_sent_at.get(key)
    if last:
        passed = (now - last).total_seconds()
        if passed < seconds:
            wait_s = max(1, int(seconds - passed))
            raise HTTPException(status_code=429, detail=f"发言过快，请在 {wait_s} 秒后重试")
    group_rate_last_sent_at[key] = now


def users_share_group_room(db: Session, user_a: int, user_b: int) -> bool:
    room_ids_a = set(get_room_ids_for_user(db, user_a))
    room_ids_b = set(get_room_ids_for_user(db, user_b))
    shared = room_ids_a.intersection(room_ids_b)
    if not shared:
        return False
    row = db.execute(
        select(ChatRoom.id).where(ChatRoom.id.in_(shared), ChatRoom.type == "group").limit(1)
    ).first()
    return row is not None


def is_user_muted_in_room(db: Session, room_id: int, user_id: int) -> bool:
    row = db.execute(
        select(RoomMute.id).where(RoomMute.room_id == room_id, RoomMute.user_id == user_id)
    ).first()
    return bool(row)


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
    now = utc_now_naive()
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


def get_reply_preview(db: Session, reply_to_message_id: int | None) -> tuple[int | None, str | None]:
    if not reply_to_message_id:
        return None, None
    target = db.get(Message, reply_to_message_id)
    if not target:
        return None, None
    return target.sender_id, target.content


def build_message_out(db: Session, m: Message) -> MessageOut:
    reply_sender_id, reply_content = get_reply_preview(db, m.reply_to_message_id)
    return MessageOut(
        id=m.id,
        room_id=m.room_id,
        sender_id=m.sender_id,
        reply_to_message_id=m.reply_to_message_id,
        reply_to_sender_id=reply_sender_id,
        reply_to_content=reply_content,
        content=m.content,
        edited_by_admin=m.edited_by_admin,
        created_at=m.created_at,
        updated_at=m.updated_at,
    )


def cascade_recall_messages(
    db: Session,
    root_message: Message,
    edited_by_admin: bool,
) -> list[Message]:
    recalled: list[Message] = []
    queue: list[Message] = [root_message]
    seen: set[int] = set()
    now = utc_now_naive()

    while queue:
        current = queue.pop(0)
        if not current or current.id in seen:
            continue
        seen.add(current.id)

        if current.content != "[已撤回]":
            current.content = "[已撤回]"
        current.updated_at = now
        current.edited_by_admin = edited_by_admin
        recalled.append(current)

        children = db.query(Message).filter(Message.reply_to_message_id == current.id).all()
        for child in children:
            if child.id not in seen:
                queue.append(child)

    db.commit()
    for msg in recalled:
        db.refresh(msg)
    return recalled


def serialize_message(db: Session, m: Message) -> dict:
    out = build_message_out(db, m)
    return {
        "id": out.id,
        "room_id": out.room_id,
        "sender_id": out.sender_id,
        "reply_to_message_id": out.reply_to_message_id,
        "reply_to_sender_id": out.reply_to_sender_id,
        "reply_to_content": out.reply_to_content,
        "content": out.content,
        "edited_by_admin": out.edited_by_admin,
        "created_at": out.created_at.isoformat(),
        "updated_at": out.updated_at.isoformat() if out.updated_at else None,
    }


def ensure_user_in_room(db: Session, user_id: int, room_id: int):
    exists = db.execute(
        select(room_members.c.room_id).where(
            and_(room_members.c.room_id == room_id, room_members.c.user_id == user_id)
        )
    ).first()
    if not exists:
        raise HTTPException(status_code=403, detail="You are not a member of this room")
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if bool(room.is_dissolved):
        raise HTTPException(status_code=410, detail="该群已解散")


def ensure_admin_user(current_user: User):
    if (current_user.role or "").lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin only")


def has_permission(user: User, field_name: str) -> bool:
    return bool(getattr(user, field_name, False))


def ensure_permission(user: User, field_name: str, detail: str):
    if not has_permission(user, field_name):
        raise HTTPException(status_code=403, detail=detail)


def ensure_compatible_schema():
    """
    向后兼容迁移：
    - users.last_seen_at
    - chat_rooms.type/title/avatar/is_dissolved
    - room_members.role/joined_at
    - messages.reply_to_message_id/edited_by_admin/updated_at
    - friend_requests.message/responded_at
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
            if "can_kick_members" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN can_kick_members BOOLEAN"))
            if "can_mute_members" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN can_mute_members BOOLEAN"))
            if "can_use_edit_feature" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN can_use_edit_feature BOOLEAN"))
            if "can_use_super_delete" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN can_use_super_delete BOOLEAN"))
            if "can_recall_own_messages" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN can_recall_own_messages BOOLEAN"))
            if "can_recall_others_messages" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN can_recall_others_messages BOOLEAN"))
            if "can_super_delete_messages" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN can_super_delete_messages BOOLEAN"))
            if "is_active" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN is_active BOOLEAN"))
            if "is_banned" not in user_columns:
                conn.execute(text("ALTER TABLE users ADD COLUMN is_banned BOOLEAN"))
            conn.execute(text("UPDATE users SET can_kick_members=false WHERE can_kick_members IS NULL"))
            conn.execute(text("UPDATE users SET can_mute_members=false WHERE can_mute_members IS NULL"))
            conn.execute(text("UPDATE users SET can_use_edit_feature=false WHERE can_use_edit_feature IS NULL"))
            conn.execute(text("UPDATE users SET can_use_super_delete=false WHERE can_use_super_delete IS NULL"))
            conn.execute(text("UPDATE users SET can_recall_own_messages=true WHERE can_recall_own_messages IS NULL"))
            conn.execute(text("UPDATE users SET can_recall_others_messages=false WHERE can_recall_others_messages IS NULL"))
            conn.execute(text("UPDATE users SET can_super_delete_messages=false WHERE can_super_delete_messages IS NULL"))
            conn.execute(text("UPDATE users SET is_active=true WHERE is_active IS NULL"))
            conn.execute(text("UPDATE users SET is_banned=false WHERE is_banned IS NULL"))
            # 管理员账号默认具备三项全局能力，便于后台初始化后立即可用
            conn.execute(
                text(
                    "UPDATE users SET can_kick_members=true, can_mute_members=true, "
                    "can_recall_own_messages=true, can_recall_others_messages=true, "
                    "can_super_delete_messages=true, can_use_edit_feature=true, "
                    "can_use_super_delete=true WHERE role='admin'"
                )
            )

        if "chat_rooms" in table_names:
            room_columns = {col["name"] for col in inspector.get_columns("chat_rooms")}
            if "type" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN type VARCHAR(20)"))
            if "title" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN title VARCHAR(120)"))
            if "avatar" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN avatar TEXT"))
            if "rate_limit_seconds" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN rate_limit_seconds INTEGER"))
            if "description" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN description VARCHAR(300)"))
            if "notice" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN notice VARCHAR(300)"))
            if "allow_member_friend_add" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN allow_member_friend_add BOOLEAN"))
            if "allow_member_invite" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN allow_member_invite BOOLEAN"))
            if "invite_need_approval" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN invite_need_approval BOOLEAN"))
            if "global_mute" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN global_mute BOOLEAN"))
            if "is_dissolved" not in room_columns:
                conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN is_dissolved BOOLEAN"))
            if "dissolved_at" not in room_columns:
                if engine.dialect.name == "sqlite":
                    conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN dissolved_at DATETIME"))
                else:
                    conn.execute(text("ALTER TABLE chat_rooms ADD COLUMN dissolved_at TIMESTAMP NULL"))

            # 数据回填：旧 room_type=private -> type=dm，其余保留 group
            conn.execute(text("UPDATE chat_rooms SET type='dm' WHERE type IS NULL AND room_type='private'"))
            conn.execute(text("UPDATE chat_rooms SET type='group' WHERE type IS NULL AND room_type!='private'"))
            conn.execute(text("UPDATE chat_rooms SET title=name WHERE title IS NULL"))
            conn.execute(text("UPDATE chat_rooms SET rate_limit_seconds=0 WHERE rate_limit_seconds IS NULL"))
            conn.execute(text("UPDATE chat_rooms SET description='' WHERE description IS NULL"))
            conn.execute(text("UPDATE chat_rooms SET notice='' WHERE notice IS NULL"))
            # PostgreSQL 布尔列必须使用 true/false，不能写 0/1
            conn.execute(text("UPDATE chat_rooms SET allow_member_friend_add=false WHERE allow_member_friend_add IS NULL"))
            conn.execute(text("UPDATE chat_rooms SET allow_member_invite=false WHERE allow_member_invite IS NULL"))
            conn.execute(text("UPDATE chat_rooms SET invite_need_approval=true WHERE invite_need_approval IS NULL"))
            conn.execute(text("UPDATE chat_rooms SET global_mute=false WHERE global_mute IS NULL"))
            conn.execute(text("UPDATE chat_rooms SET is_dissolved=false WHERE is_dissolved IS NULL"))

        if "room_members" in table_names:
            member_columns = {col["name"] for col in inspector.get_columns("room_members")}
            if "role" not in member_columns:
                conn.execute(text("ALTER TABLE room_members ADD COLUMN role VARCHAR(20)"))
            if "can_kick" not in member_columns:
                conn.execute(text("ALTER TABLE room_members ADD COLUMN can_kick BOOLEAN"))
            if "can_mute" not in member_columns:
                conn.execute(text("ALTER TABLE room_members ADD COLUMN can_mute BOOLEAN"))
            if "can_recall_others" not in member_columns:
                conn.execute(text("ALTER TABLE room_members ADD COLUMN can_recall_others BOOLEAN"))
            if "can_super_delete" not in member_columns:
                conn.execute(text("ALTER TABLE room_members ADD COLUMN can_super_delete BOOLEAN"))
            if "joined_at" not in member_columns:
                if engine.dialect.name == "sqlite":
                    conn.execute(text("ALTER TABLE room_members ADD COLUMN joined_at DATETIME"))
                else:
                    conn.execute(text("ALTER TABLE room_members ADD COLUMN joined_at TIMESTAMP NULL"))

            conn.execute(text("UPDATE room_members SET role='member' WHERE role IS NULL"))
            conn.execute(text("UPDATE room_members SET can_kick=false WHERE can_kick IS NULL"))
            conn.execute(text("UPDATE room_members SET can_mute=false WHERE can_mute IS NULL"))
            conn.execute(text("UPDATE room_members SET can_recall_others=false WHERE can_recall_others IS NULL"))
            conn.execute(text("UPDATE room_members SET can_super_delete=false WHERE can_super_delete IS NULL"))
            conn.execute(text("UPDATE room_members SET joined_at=CURRENT_TIMESTAMP WHERE joined_at IS NULL"))

        if "messages" in table_names:
            message_columns = {col["name"] for col in inspector.get_columns("messages")}
            if "reply_to_message_id" not in message_columns:
                conn.execute(text("ALTER TABLE messages ADD COLUMN reply_to_message_id INTEGER"))
            if "edited_by_admin" not in message_columns:
                conn.execute(text("ALTER TABLE messages ADD COLUMN edited_by_admin BOOLEAN"))
            if "updated_at" not in message_columns:
                if engine.dialect.name == "sqlite":
                    conn.execute(text("ALTER TABLE messages ADD COLUMN updated_at DATETIME"))
                else:
                    conn.execute(text("ALTER TABLE messages ADD COLUMN updated_at TIMESTAMP NULL"))
            conn.execute(text("UPDATE messages SET edited_by_admin=false WHERE edited_by_admin IS NULL"))

        if "friend_requests" in table_names:
            req_columns = {col["name"] for col in inspector.get_columns("friend_requests")}
            if "message" not in req_columns:
                conn.execute(text("ALTER TABLE friend_requests ADD COLUMN message VARCHAR(120)"))
            if "responded_at" not in req_columns:
                if engine.dialect.name == "sqlite":
                    conn.execute(text("ALTER TABLE friend_requests ADD COLUMN responded_at DATETIME"))
                else:
                    conn.execute(text("ALTER TABLE friend_requests ADD COLUMN responded_at TIMESTAMP NULL"))
            conn.execute(text("UPDATE friend_requests SET message='' WHERE message IS NULL"))


def ensure_message_indexes():
    """
    兼容迁移：为消息历史分页创建复合索引 (room_id, created_at)。
    """
    with engine.begin() as conn:
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_messages_room_created_at ON messages (room_id, created_at)"))


def run_startup_tasks():
    validate_production_guardrails()
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
                is_active=True,
                is_banned=False,
                can_kick_members=True,
                can_mute_members=True,
                can_recall_own_messages=True,
                can_recall_others_messages=True,
                can_super_delete_messages=True,
                can_use_edit_feature=True,
                can_use_super_delete=True,
            )
            db.add(admin)
            db.commit()
        else:
            admin.is_active = True
            admin.is_banned = False
            admin.can_kick_members = True
            admin.can_mute_members = True
            admin.can_recall_own_messages = True
            admin.can_recall_others_messages = True
            admin.can_super_delete_messages = True
            admin.can_use_edit_feature = True
            admin.can_use_super_delete = True
            db.commit()
    finally:
        db.close()


@app.get("/health")
def health():
    return {"status": "ok", "env": settings.app_env}


@app.post("/api/uploads/images")
async def upload_image(
    request: Request,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    _ = current_user
    content_type = (file.content_type or "").lower()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image file is allowed")

    ext = Path(file.filename or "").suffix.lower()
    if not ext:
        ext = ".png"
    filename = f"{uuid4().hex}{ext}"
    target = UPLOAD_DIR / filename

    data = await file.read()
    if len(data) > 8 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image too large (max 8MB)")

    target.write_bytes(data)
    base = str(request.base_url).rstrip("/")
    return {"url": f"{base}/uploads/{filename}"}


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
    if not bool(user.is_active):
        raise HTTPException(status_code=403, detail="账号已注销，无法登录")
    if bool(user.is_banned):
        raise HTTPException(status_code=403, detail="账号已封禁，无法登录")

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


@app.get("/api/admin/users", response_model=list[AdminUserOut])
def list_admin_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_admin_user(current_user)
    rows = db.execute(select(User).order_by(desc(User.created_at))).scalars().all()
    return [
        AdminUserOut(
            id=u.id,
            username=u.username,
            nickname=u.nickname,
            role=u.role,
            is_active=bool(u.is_active),
            is_banned=bool(u.is_banned),
            is_online=bool(u.is_online),
            created_at=u.created_at,
            last_seen_at=u.last_seen_at,
            can_kick_members=bool(u.can_kick_members),
            can_mute_members=bool(u.can_mute_members),
            can_recall_own_messages=bool(u.can_recall_own_messages),
            can_recall_others_messages=bool(u.can_recall_others_messages),
            can_super_delete_messages=bool(u.can_super_delete_messages),
            can_use_edit_feature=bool(u.can_use_edit_feature),
            can_use_super_delete=bool(u.can_use_super_delete),
        )
        for u in rows
    ]


@app.post("/api/admin/users/{user_id}/reset-password")
async def admin_reset_user_password(
    user_id: int,
    payload: AdminResetPasswordIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_admin_user(current_user)
    if payload.new_password != payload.confirm_password:
        raise HTTPException(status_code=422, detail="两次密码不一致")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.password_hash = hash_password(payload.new_password)
    user.is_online = False
    db.commit()
    await manager.force_disconnect_user(
        user.id,
        payload={
            "type": "force_logout",
            "reason": "密码已被管理员重置，请重新登录",
        },
        code=4003,
    )
    await manager.broadcast_global(
        {
            "type": "presence",
            "user_id": user.id,
            "online": False,
        }
    )
    return {"ok": True, "user_id": user_id}


def _admin_update_user_permissions(
    user_id: int,
    payload: AdminUserPermissionsIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_admin_user(current_user)
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.can_kick_members = bool(payload.can_kick_members)
    user.can_mute_members = bool(payload.can_mute_members)
    user.can_recall_own_messages = bool(payload.can_recall_own_messages)
    user.can_recall_others_messages = bool(payload.can_recall_others_messages)
    user.can_super_delete_messages = bool(payload.can_super_delete_messages)
    user.can_use_edit_feature = bool(payload.can_use_edit_feature)
    user.can_use_super_delete = bool(payload.can_use_super_delete)
    db.commit()
    return {"ok": True, "user_id": user_id}


@app.put("/api/admin/users/{user_id}/permissions")
def admin_update_user_permissions(
    user_id: int,
    payload: AdminUserPermissionsIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return _admin_update_user_permissions(user_id=user_id, payload=payload, db=db, current_user=current_user)


@app.post("/api/admin/users/{user_id}/permissions", include_in_schema=False)
def admin_update_user_permissions_compat(
    user_id: int,
    payload: AdminUserPermissionsIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return _admin_update_user_permissions(user_id=user_id, payload=payload, db=db, current_user=current_user)


async def _admin_update_user_status(
    user_id: int,
    payload: AdminUserStatusIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_admin_user(current_user)
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="不能修改当前登录管理员账号状态")

    if payload.is_active is not None:
        user.is_active = bool(payload.is_active)
    if payload.is_banned is not None:
        user.is_banned = bool(payload.is_banned)

    # 账号被注销时默认离线，避免后台展示异常
    if not bool(user.is_active):
        user.is_online = False

    db.commit()

    # 后台禁用/封禁后，实时踢下线（所有设备）
    if (payload.is_active is not None and not bool(user.is_active)) or (payload.is_banned is not None and bool(user.is_banned)):
        await manager.force_disconnect_user(
            user.id,
            payload={
                "type": "force_logout",
                "reason": "账号已被管理员禁用，无法继续使用",
            },
            code=4003,
        )
        await manager.broadcast_global(
            {
                "type": "presence",
                "user_id": user.id,
                "online": False,
            }
        )

    return {
        "ok": True,
        "user_id": user_id,
        "is_active": bool(user.is_active),
        "is_banned": bool(user.is_banned),
    }


@app.put("/api/admin/users/{user_id}/status")
async def admin_update_user_status(
    user_id: int,
    payload: AdminUserStatusIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await _admin_update_user_status(user_id=user_id, payload=payload, db=db, current_user=current_user)


@app.post("/api/admin/users/{user_id}/status", include_in_schema=False)
async def admin_update_user_status_compat(
    user_id: int,
    payload: AdminUserStatusIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await _admin_update_user_status(user_id=user_id, payload=payload, db=db, current_user=current_user)


@app.delete("/api/admin/users/{user_id}")
async def admin_delete_cancelled_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_admin_user(current_user)
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="不能删除当前登录管理员账号")
    if bool(user.is_active):
        raise HTTPException(status_code=400, detail="仅可删除已注销账号")

    # 先踢下线，避免残留会话
    await manager.force_disconnect_user(
        user.id,
        payload={
            "type": "force_logout",
            "reason": "账号已被管理员删除",
        },
        code=4003,
    )

    # 清理关联数据（兼容 SQLite 外键未开启场景）
    db.execute(delete(room_members).where(room_members.c.user_id == user_id))
    db.execute(delete(friends).where((friends.c.user_id == user_id) | (friends.c.friend_id == user_id)))
    db.execute(delete(FriendRequest).where((FriendRequest.from_user_id == user_id) | (FriendRequest.to_user_id == user_id)))
    db.execute(delete(FriendRemark).where((FriendRemark.user_id == user_id) | (FriendRemark.friend_id == user_id)))
    db.execute(delete(RoomRead).where(RoomRead.user_id == user_id))
    if UserHiddenMessage is not None:
        db.execute(delete(UserHiddenMessage).where(UserHiddenMessage.user_id == user_id))
    db.execute(delete(RoomMute).where(RoomMute.user_id == user_id))
    db.execute(text("UPDATE room_mutes SET muted_by=NULL WHERE muted_by=:uid"), {"uid": user_id})
    db.execute(delete(Message).where(Message.sender_id == user_id))
    db.execute(text("UPDATE chat_rooms SET created_by=:admin_id WHERE created_by=:uid"), {"admin_id": current_user.id, "uid": user_id})
    db.delete(user)
    db.commit()
    manager.refresh_user_rooms(user_id, [])
    await manager.broadcast_global(
        {
            "type": "presence",
            "user_id": user_id,
            "online": False,
        }
    )
    return {"ok": True, "user_id": user_id, "deleted": True}


@app.get("/api/users/search", response_model=list[SearchUserOut])
def search_users(
    q: str = Query(min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    keyword = (q or "").strip()
    conds = [User.username.ilike(f"%{keyword}%"), User.nickname.ilike(f"%{keyword}%")]
    if keyword.isdigit():
        conds.append(User.id == int(keyword))
    rows = db.execute(
        select(User).where(and_(User.id != current_user.id, or_(*conds))).limit(20)
    ).scalars().all()
    return [
        SearchUserOut(
            id=u.id,
            username=u.username,
            nickname=u.nickname,
            is_online=u.is_online,
            avatar_base64=u.avatar_base64,
        )
        for u in rows
    ]


def _is_friend(db: Session, user_id: int, friend_id: int) -> bool:
    row = db.execute(
        select(friends.c.user_id).where(friends.c.user_id == user_id, friends.c.friend_id == friend_id)
    ).first()
    return row is not None


def ensure_dm_friendship_or_raise(db: Session, room_id: int, sender_id: int):
    """Direct message requires active mutual friendship."""
    room = db.get(ChatRoom, room_id)
    if not room or room_effective_type(room) != "dm":
        return

    member_ids = get_room_member_ids(db, room_id)
    if sender_id not in member_ids:
        raise HTTPException(status_code=403, detail="No room access")
    if len(member_ids) != 2:
        raise HTTPException(status_code=400, detail="Invalid direct chat members")

    peer_id = member_ids[0] if member_ids[1] == sender_id else member_ids[1]
    if not (_is_friend(db, sender_id, peer_id) and _is_friend(db, peer_id, sender_id)):
        raise HTTPException(status_code=403, detail="不是好友")


def can_user_send_friend_request(user: User) -> bool:
    username = (user.username or "").strip().lower()
    role = (user.role or "").strip().lower()
    if username in settings.allowed_friend_request_usernames:
        return True
    if role in settings.allowed_friend_request_roles:
        return True
    return False


def _serialize_friend_request(req: FriendRequest) -> FriendRequestOut:
    from_user = req.from_user
    to_user = req.to_user
    return FriendRequestOut(
        id=req.id,
        from_user_id=req.from_user_id,
        to_user_id=req.to_user_id,
        status=req.status,
        message=req.message or "",
        from_nickname=from_user.nickname if from_user else None,
        from_username=from_user.username if from_user else None,
        from_avatar_base64=from_user.avatar_base64 if from_user else None,
        to_nickname=to_user.nickname if to_user else None,
        to_username=to_user.username if to_user else None,
        to_avatar_base64=to_user.avatar_base64 if to_user else None,
        created_at=req.created_at,
        responded_at=req.responded_at,
    )


def _ensure_friendship_and_dm(db: Session, user_id: int, friend_id: int):
    user = db.get(User, user_id)
    friend = db.get(User, friend_id)
    if not user or not friend:
        raise HTTPException(status_code=404, detail="User not found")

    for uid, fid in [(user_id, friend_id), (friend_id, user_id)]:
        exists = db.execute(
            select(friends.c.user_id).where(and_(friends.c.user_id == uid, friends.c.friend_id == fid))
        ).first()
        if not exists:
            db.execute(insert(friends).values(user_id=uid, friend_id=fid))

    my_room_ids = set(get_room_ids_for_user(db, user_id))
    friend_room_ids = set(get_room_ids_for_user(db, friend_id))
    shared = my_room_ids.intersection(friend_room_ids)
    private_room = None
    if shared:
        private_room = db.execute(
            select(ChatRoom).where(ChatRoom.id.in_(shared), ChatRoom.type.in_(["dm", "private"]))
        ).scalars().first()

    if not private_room:
        title = f"{user.username}-{friend.username}"
        room = ChatRoom(name=title, title=title, room_type="private", type="dm", created_by=user_id)
        db.add(room)
        db.commit()
        db.refresh(room)
        db.execute(
            insert(room_members).values(
                room_id=room.id,
                user_id=user_id,
                role="owner",
                can_kick=False,
                can_mute=False,
                joined_at=utc_now_naive(),
            )
        )
        db.execute(
            insert(room_members).values(
                room_id=room.id,
                user_id=friend_id,
                role="member",
                can_kick=False,
                can_mute=False,
                joined_at=utc_now_naive(),
            )
        )

    db.commit()
    manager.refresh_user_rooms(user_id, get_room_ids_for_user(db, user_id))
    manager.refresh_user_rooms(friend_id, get_room_ids_for_user(db, friend_id))


def _create_friend_request(db: Session, from_user_id: int, to_user_id: int, message: str = "") -> FriendRequest:
    if from_user_id == to_user_id:
        raise HTTPException(status_code=400, detail="Cannot send request to yourself")
    to_user = db.get(User, to_user_id)
    if not to_user:
        raise HTTPException(status_code=404, detail="User not found")
    if _is_friend(db, from_user_id, to_user_id):
        raise HTTPException(status_code=400, detail="Already friends")
    existing = db.execute(
        select(FriendRequest).where(
            FriendRequest.from_user_id == from_user_id,
            FriendRequest.to_user_id == to_user_id,
            FriendRequest.status == "pending",
        )
    ).scalar_one_or_none()
    if existing:
        return existing

    req = FriendRequest(
        from_user_id=from_user_id,
        to_user_id=to_user_id,
        status="pending",
        message=(message or "").strip()[:120],
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return req


@app.post("/api/friend-requests", response_model=FriendRequestOut)
def create_friend_request(
    payload: CreateFriendRequestIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    req = _create_friend_request(db, current_user.id, payload.to_user_id, payload.message or "")
    return _serialize_friend_request(req)


@app.get("/api/friend-requests/incoming", response_model=list[FriendRequestOut])
def incoming_friend_requests(
    status_filter: str = Query(default="pending", alias="status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = db.execute(
        select(FriendRequest).where(
            FriendRequest.to_user_id == current_user.id,
            FriendRequest.status == status_filter,
        ).order_by(desc(FriendRequest.created_at))
    ).scalars().all()
    return [_serialize_friend_request(r) for r in rows]


@app.get("/api/friend-requests/outgoing", response_model=list[FriendRequestOut])
def outgoing_friend_requests(
    status_filter: str = Query(default="pending", alias="status"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = db.execute(
        select(FriendRequest).where(
            FriendRequest.from_user_id == current_user.id,
            FriendRequest.status == status_filter,
        ).order_by(desc(FriendRequest.created_at))
    ).scalars().all()
    return [_serialize_friend_request(r) for r in rows]


@app.post("/api/friend-requests/{request_id}/accept", response_model=FriendRequestOut)
def accept_friend_request(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    req = db.get(FriendRequest, request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Friend request not found")
    if req.to_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="No permission")
    if req.status != "pending":
        return _serialize_friend_request(req)

    req.status = "accepted"
    req.responded_at = utc_now_naive()
    db.commit()
    _ensure_friendship_and_dm(db, req.from_user_id, req.to_user_id)
    db.refresh(req)
    return _serialize_friend_request(req)


@app.post("/api/friend-requests/{request_id}/reject", response_model=FriendRequestOut)
def reject_friend_request(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    req = db.get(FriendRequest, request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Friend request not found")
    if req.to_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="No permission")
    if req.status != "pending":
        return _serialize_friend_request(req)

    req.status = "rejected"
    req.responded_at = utc_now_naive()
    db.commit()
    db.refresh(req)
    return _serialize_friend_request(req)


@app.post("/api/friends/{friend_id}")
def add_friend(friend_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    req = _create_friend_request(db, current_user.id, friend_id, "")
    return {"ok": True, "status": req.status, "request_id": req.id}


@app.delete("/api/friends/{friend_id}")
def remove_friend(
    friend_id: int,
    delete_peer_messages: bool = Query(default=False, description="是否同时删除对方发给我的私聊消息（仅我视角）"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
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
    db.execute(
        delete(FriendRemark).where(
            (FriendRemark.user_id == current_user.id) & (FriendRemark.friend_id == friend_id)
        )
    )
    db.execute(
        delete(FriendRemark).where(
            (FriendRemark.user_id == friend_id) & (FriendRemark.friend_id == current_user.id)
        )
    )

    # 高级权限：仅允许被后台授权的账号执行“同时删除对方消息”
    if delete_peer_messages:
        ensure_permission(current_user, "can_use_super_delete", "无权使用“同时删除对方消息”")

        dm_room_candidates = (
            select(room_members.c.room_id)
            .where(room_members.c.user_id.in_([current_user.id, friend_id]))
            .group_by(room_members.c.room_id)
            .having(func.count(func.distinct(room_members.c.user_id)) == 2)
        )
        dm_room_ids = db.execute(
            select(ChatRoom.id).where(
                ChatRoom.id.in_(dm_room_candidates),
                or_(ChatRoom.type == "dm", ChatRoom.room_type == "private"),
            )
        ).scalars().all()

        if dm_room_ids:
            peer_rows = db.execute(
                select(Message.id, Message.room_id).where(
                    Message.room_id.in_(dm_room_ids),
                    Message.sender_id == friend_id,
                )
            ).all()
            peer_message_ids = [row[0] for row in peer_rows]
            if peer_rows and UserHiddenMessage is not None:
                existed = set(
                    db.execute(
                        select(UserHiddenMessage.message_id).where(
                            UserHiddenMessage.user_id == current_user.id,
                            UserHiddenMessage.message_id.in_(peer_message_ids),
                        )
                    ).scalars().all()
                )
                for mid, rid in peer_rows:
                    if mid in existed:
                        continue
                    db.add(
                        UserHiddenMessage(
                            user_id=current_user.id,
                            room_id=rid,
                            message_id=mid,
                        )
                    )
    db.commit()
    return {"ok": True, "delete_peer_messages_applied": bool(delete_peer_messages)}


@app.get("/api/friends", response_model=list[SearchUserOut])
def get_friends(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    ids = db.execute(select(friends.c.friend_id).where(friends.c.user_id == current_user.id)).all()
    friend_ids = [x[0] for x in ids]
    if not friend_ids:
        return []
    users = db.execute(select(User).where(User.id.in_(friend_ids))).scalars().all()
    return [
        SearchUserOut(
            id=u.id,
            username=u.username,
            nickname=u.nickname,
            is_online=u.is_online,
            avatar_base64=u.avatar_base64,
        )
        for u in users
    ]


@app.get("/api/friends/remarks", response_model=list[FriendRemarkOut])
def get_friend_remarks(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    rows = db.execute(select(FriendRemark).where(FriendRemark.user_id == current_user.id)).scalars().all()
    return [FriendRemarkOut(friend_id=r.friend_id, remark=r.remark) for r in rows]


@app.put("/api/friends/{friend_id}/remark", response_model=FriendRemarkOut)
def set_friend_remark(
    friend_id: int,
    payload: FriendRemarkIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if friend_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot set remark for yourself")
    if not _is_friend(db, current_user.id, friend_id):
        raise HTTPException(status_code=400, detail="Not your friend")

    row = db.execute(
        select(FriendRemark).where(FriendRemark.user_id == current_user.id, FriendRemark.friend_id == friend_id)
    ).scalar_one_or_none()
    remark = (payload.remark or "").strip()
    if row:
        row.remark = remark
        row.updated_at = utc_now_naive()
    else:
        row = FriendRemark(
            user_id=current_user.id,
            friend_id=friend_id,
            remark=remark,
            updated_at=utc_now_naive(),
        )
        db.add(row)
    db.commit()
    return FriendRemarkOut(friend_id=friend_id, remark=remark)


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
        rate_limit_seconds=0,
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
                can_kick=False,
                can_mute=False,
                joined_at=utc_now_naive(),
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
        description=room.description or "",
        notice=room.notice or "",
        allow_member_friend_add=bool(room.allow_member_friend_add),
        allow_member_invite=bool(room.allow_member_invite),
        invite_need_approval=(bool(room.invite_need_approval) if room.invite_need_approval is not None else True),
        global_mute=bool(room.global_mute),
        rate_limit_seconds=int(room.rate_limit_seconds or 0),
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

    rooms = db.execute(
        select(ChatRoom).where(
            and_(
                ChatRoom.id.in_(room_ids),
                ChatRoom.is_dissolved.is_(False),
            )
        )
    ).scalars().all()
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
                description=room.description or "",
                notice=room.notice or "",
                allow_member_friend_add=bool(room.allow_member_friend_add),
                allow_member_invite=bool(room.allow_member_invite),
                invite_need_approval=(bool(room.invite_need_approval) if room.invite_need_approval is not None else True),
                global_mute=bool(room.global_mute),
                rate_limit_seconds=int(room.rate_limit_seconds or 0),
                created_by=room.created_by,
                member_ids=member_ids,
                member_count=len(member_ids),
            )
        )
    return res


@app.patch("/api/rooms/{room_id}", response_model=RoomOut)
def update_group_room(
    room_id: int,
    payload: RoomUpdateIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room_effective_type(room) != "group":
        raise HTTPException(status_code=400, detail="Only group room can be updated")
    my_role = get_room_member_role(db, room_id, current_user.id)
    is_admin = (current_user.role or "").lower() == "admin"
    if my_role != "owner" and not is_admin:
        raise HTTPException(status_code=403, detail="Only owner or admin can update group profile")

    if payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=422, detail="Group title cannot be empty")
        room.title = title
        room.name = title
    if payload.avatar is not None:
        room.avatar = payload.avatar
    if payload.description is not None:
        room.description = (payload.description or "").strip()
    if payload.notice is not None:
        room.notice = (payload.notice or "").strip()
    if payload.allow_member_friend_add is not None:
        room.allow_member_friend_add = bool(payload.allow_member_friend_add)
    if payload.allow_member_invite is not None:
        room.allow_member_invite = bool(payload.allow_member_invite)
    if payload.invite_need_approval is not None:
        room.invite_need_approval = bool(payload.invite_need_approval)
    if payload.global_mute is not None:
        room.global_mute = bool(payload.global_mute)
    db.commit()
    db.refresh(room)

    mids = db.execute(select(room_members.c.user_id).where(room_members.c.room_id == room_id)).all()
    member_ids = [m[0] for m in mids]
    for uid in member_ids:
        manager.refresh_user_rooms(uid, get_room_ids_for_user(db, uid))
    return RoomOut(
        id=room.id,
        name=room.name,
        room_type=room.room_type,
        type=room_effective_type(room),
        title=room_effective_title(room),
        avatar=room.avatar,
        description=room.description or "",
        notice=room.notice or "",
        allow_member_friend_add=bool(room.allow_member_friend_add),
        allow_member_invite=bool(room.allow_member_invite),
        invite_need_approval=(bool(room.invite_need_approval) if room.invite_need_approval is not None else True),
        global_mute=bool(room.global_mute),
        rate_limit_seconds=int(room.rate_limit_seconds or 0),
        created_by=room.created_by,
        member_ids=member_ids,
        member_count=len(member_ids),
    )


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
    muted_rows = db.execute(select(RoomMute.user_id).where(RoomMute.room_id == room_id)).all()
    muted_set = {m[0] for m in muted_rows}
    return [
        RoomMemberOut(
            room_id=room_id,
            user_id=uid,
            username=user_map[uid].username if uid in user_map else f"user_{uid}",
            nickname=user_map[uid].nickname if uid in user_map else "",
            role=role or "member",
            can_kick=bool(can_kick),
            can_mute=bool(can_mute),
            can_recall_others=bool(can_recall_others),
            can_super_delete=bool(can_super_delete),
            muted=uid in muted_set,
            joined_at=joined_at,
        )
        for uid, role, can_kick, can_mute, can_recall_others, can_super_delete, joined_at in rows
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

    if payload.user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot add yourself")

    target_user = db.get(User, payload.user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    exists = db.execute(
        select(room_members.c.user_id).where(room_members.c.room_id == room_id, room_members.c.user_id == payload.user_id)
    ).first()
    if exists:
        raise HTTPException(status_code=400, detail="User already in room")

    db.execute(
        insert(room_members).values(
            room_id=room_id,
            user_id=payload.user_id,
            role="member",
            can_kick=False,
            can_mute=False,
            can_recall_others=False,
            can_super_delete=False,
            joined_at=utc_now_naive(),
        )
    )
    db.commit()
    manager.refresh_user_rooms(payload.user_id, get_room_ids_for_user(db, payload.user_id))

    actor = current_user.nickname or current_user.username
    system_msg = Message(
        room_id=room_id,
        sender_id=current_user.id,
        content=f"[system] {actor} 邀请了成员 {target_user.nickname or target_user.username}",
    )
    db.add(system_msg)
    db.commit()
    db.refresh(system_msg)
    await manager.broadcast_to_room(room_id, {"type": "new_message", "payload": serialize_message(db, system_msg)})
    return {"ok": True}


@app.put("/api/rooms/{room_id}/rate-limit")
async def update_group_rate_limit(
    room_id: int,
    payload: RoomRateLimitIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room_effective_type(room) != "group":
        raise HTTPException(status_code=400, detail="Only group room supports rate limit")
    if get_room_member_role(db, room_id, current_user.id) != "owner":
        raise HTTPException(status_code=403, detail="Only owner can update rate limit")

    room.rate_limit_seconds = int(payload.seconds or 0)
    db.commit()

    actor = current_user.nickname or current_user.username
    system_msg = Message(
        room_id=room_id,
        sender_id=current_user.id,
        content=f"[system] {actor} 设置了群发言频率：{room.rate_limit_seconds} 秒/条",
    )
    db.add(system_msg)
    db.commit()
    db.refresh(system_msg)
    await manager.broadcast_to_room(room_id, {"type": "new_message", "payload": serialize_message(db, system_msg)})
    return {"ok": True, "room_id": room_id, "rate_limit_seconds": room.rate_limit_seconds}


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

    if current_user.id != user_id:
        ensure_permission(current_user, "can_kick_members", "后台未授予踢人权限")
    if current_user.id != user_id and not can_actor_manage_member(db, room_id, current_user.id, user_id, "kick"):
        raise HTTPException(status_code=403, detail="No permission to remove this member")

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

    # 强规则：成员被踢出后，其在该群历史发言对所有群成员不可见
    # 仅删除“该群 + 该成员”消息，不影响其他群与私聊
    db.execute(delete(Message).where(Message.room_id == room_id, Message.sender_id == user_id))
    db.execute(delete(room_members).where(room_members.c.room_id == room_id, room_members.c.user_id == user_id))
    db.execute(delete(RoomMute).where(RoomMute.room_id == room_id, RoomMute.user_id == user_id))
    db.commit()
    manager.refresh_user_rooms(user_id, get_room_ids_for_user(db, user_id))
    await manager.send_json_to_user(user_id, {"type": "room_removed", "room_id": room_id})

    # 前端已实现该事件处理：收到后立即从当前群消息列表移除目标成员发言
    await manager.broadcast_to_room(
        room_id,
        {"type": "member_messages_deleted", "room_id": room_id, "user_id": user_id},
    )

    actor = current_user.nickname or current_user.username
    system_msg = Message(room_id=room_id, sender_id=current_user.id, content=f"[system] {actor} 移除了成员 {user_id}")
    db.add(system_msg)
    db.commit()
    db.refresh(system_msg)
    await manager.broadcast_to_room(room_id, {"type": "new_message", "payload": serialize_message(db, system_msg)})
    return {"ok": True}


@app.put("/api/rooms/{room_id}/members/{user_id}/permissions")
async def update_room_member_permissions(
    room_id: int,
    user_id: int,
    payload: RoomMemberPermissionIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room_effective_type(room) != "group":
        raise HTTPException(status_code=400, detail="Only group room supports permission management")
    if get_room_member_role(db, room_id, current_user.id) != "owner":
        raise HTTPException(status_code=403, detail="Only owner can grant member permissions")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Owner permission cannot be changed")

    target_role = get_room_member_role(db, room_id, user_id)
    if not target_role:
        raise HTTPException(status_code=404, detail="Member not found")
    if target_role == "owner":
        raise HTTPException(status_code=400, detail="Cannot change owner permissions")

    db.execute(
        text(
            "UPDATE room_members SET can_kick=:can_kick, can_mute=:can_mute, "
            "can_recall_others=:can_recall_others, can_super_delete=:can_super_delete "
            "WHERE room_id=:room_id AND user_id=:user_id"
        ),
        {
            "can_kick": bool(payload.can_kick),
            "can_mute": bool(payload.can_mute),
            "can_recall_others": bool(payload.can_recall_others),
            "can_super_delete": bool(payload.can_super_delete),
            "room_id": room_id,
            "user_id": user_id,
        },
    )
    db.commit()

    actor = current_user.nickname or current_user.username
    target_user = db.get(User, user_id)
    target_name = target_user.nickname or target_user.username if target_user else str(user_id)
    grant_text = (
        f"踢人:{'开' if payload.can_kick else '关'} / "
        f"禁言:{'开' if payload.can_mute else '关'} / "
        f"撤回他人:{'开' if payload.can_recall_others else '关'} / "
        f"超级删除:{'开' if payload.can_super_delete else '关'}"
    )
    system_msg = Message(room_id=room_id, sender_id=current_user.id, content=f"[system] {actor} 调整了 {target_name} 的管理权限（{grant_text}）")
    db.add(system_msg)
    db.commit()
    db.refresh(system_msg)
    await manager.broadcast_to_room(room_id, {"type": "new_message", "payload": serialize_message(db, system_msg)})
    return {
        "ok": True,
        "room_id": room_id,
        "user_id": user_id,
        "can_kick": bool(payload.can_kick),
        "can_mute": bool(payload.can_mute),
        "can_recall_others": bool(payload.can_recall_others),
        "can_super_delete": bool(payload.can_super_delete),
    }


@app.post("/api/rooms/{room_id}/members/{user_id}/mute", response_model=RoomMuteOut)
async def mute_room_member(
    room_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_permission(current_user, "can_mute_members", "后台未授予禁言权限")
    ensure_user_in_room(db, current_user.id, room_id)
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room_effective_type(room) != "group":
        raise HTTPException(status_code=400, detail="Only group room supports mute")
    if not can_actor_manage_member(db, room_id, current_user.id, user_id, "mute"):
        raise HTTPException(status_code=403, detail="No permission to mute this member")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Owner cannot mute self")

    target_role = get_room_member_role(db, room_id, user_id)
    if not target_role:
        raise HTTPException(status_code=404, detail="Member not found")
    if target_role == "owner":
        raise HTTPException(status_code=400, detail="Cannot mute owner")

    row = db.execute(select(RoomMute).where(RoomMute.room_id == room_id, RoomMute.user_id == user_id)).scalar_one_or_none()
    if not row:
        db.add(RoomMute(room_id=room_id, user_id=user_id, muted_by=current_user.id))
        db.commit()

    actor = current_user.nickname or current_user.username
    system_msg = Message(room_id=room_id, sender_id=current_user.id, content=f"[system] {actor} 禁言了成员 {user_id}")
    db.add(system_msg)
    db.commit()
    db.refresh(system_msg)
    await manager.broadcast_to_room(room_id, {"type": "new_message", "payload": serialize_message(db, system_msg)})
    return RoomMuteOut(room_id=room_id, user_id=user_id, muted=True)


@app.delete("/api/rooms/{room_id}/members/{user_id}/mute", response_model=RoomMuteOut)
async def unmute_room_member(
    room_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_permission(current_user, "can_mute_members", "后台未授予禁言权限")
    ensure_user_in_room(db, current_user.id, room_id)
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room_effective_type(room) != "group":
        raise HTTPException(status_code=400, detail="Only group room supports mute")
    if not can_actor_manage_member(db, room_id, current_user.id, user_id, "mute"):
        raise HTTPException(status_code=403, detail="No permission to unmute this member")

    db.execute(delete(RoomMute).where(RoomMute.room_id == room_id, RoomMute.user_id == user_id))
    db.commit()

    actor = current_user.nickname or current_user.username
    system_msg = Message(room_id=room_id, sender_id=current_user.id, content=f"[system] {actor} 取消了成员 {user_id} 的禁言")
    db.add(system_msg)
    db.commit()
    db.refresh(system_msg)
    await manager.broadcast_to_room(room_id, {"type": "new_message", "payload": serialize_message(db, system_msg)})
    return RoomMuteOut(room_id=room_id, user_id=user_id, muted=False)


@app.delete("/api/rooms/{room_id}/members/{user_id}/messages")
async def delete_member_messages_in_room(
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
        raise HTTPException(status_code=400, detail="Only group room supports this action")

    if not can_actor_manage_member(db, room_id, current_user.id, user_id, "kick"):
        raise HTTPException(status_code=403, detail="No permission to delete this member messages")

    member_exists = db.execute(
        select(room_members.c.user_id).where(room_members.c.room_id == room_id, room_members.c.user_id == user_id)
    ).first()
    if not member_exists:
        raise HTTPException(status_code=404, detail="Member not found")

    result = db.execute(delete(Message).where(Message.room_id == room_id, Message.sender_id == user_id))
    deleted_count = int(result.rowcount or 0)
    db.commit()

    actor = current_user.nickname or current_user.username
    system_msg = Message(
        room_id=room_id,
        sender_id=current_user.id,
        content=f"[system] {actor} 删除了成员 {user_id} 的历史发言（{deleted_count}条）",
    )
    db.add(system_msg)
    db.commit()
    db.refresh(system_msg)

    await manager.broadcast_to_room(room_id, {"type": "new_message", "payload": serialize_message(db, system_msg)})
    await manager.broadcast_to_room(
        room_id,
        {"type": "member_messages_deleted", "room_id": room_id, "user_id": user_id},
    )

    return {"ok": True, "room_id": room_id, "user_id": user_id, "deleted_count": deleted_count}


@app.get("/api/rooms/{room_id}/mute-list", response_model=list[RoomMuteMemberOut])
def get_room_mute_list(
    room_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room_effective_type(room) != "group":
        raise HTTPException(status_code=400, detail="Only group room supports mute list")
    if not can_bypass_group_global_mute(db, room_id, current_user.id):
        raise HTTPException(status_code=403, detail="No permission to view mute list")

    rows = db.execute(select(RoomMute).where(RoomMute.room_id == room_id).order_by(desc(RoomMute.created_at))).scalars().all()
    if not rows:
        return []
    user_ids = [r.user_id for r in rows]
    users = db.execute(select(User).where(User.id.in_(user_ids))).scalars().all()
    user_map = {u.id: u for u in users}
    return [
        RoomMuteMemberOut(
            user_id=r.user_id,
            nickname=(user_map[r.user_id].nickname if r.user_id in user_map else f"用户{r.user_id}"),
            avatar_base64=(user_map[r.user_id].avatar_base64 if r.user_id in user_map else None),
            muted=True,
        )
        for r in rows
    ]


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
    if UserHiddenMessage is not None:
        hidden_subquery = select(UserHiddenMessage.message_id).where(UserHiddenMessage.user_id == current_user.id)
        query = query.where(~Message.id.in_(hidden_subquery))
    else:
        hidden_ids = db.execute(
            text("SELECT message_id FROM user_hidden_messages WHERE user_id=:uid"),
            {"uid": current_user.id},
        ).scalars().all()
        if hidden_ids:
            query = query.where(~Message.id.in_(hidden_ids))
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
    return [build_message_out(db, m) for m in rows]


@app.post("/api/rooms/{room_id}/messages", response_model=MessageOut)
async def post_room_message(
    room_id: int,
    payload: SendMessageIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    ensure_user_in_room(db, current_user.id, room_id)
    ensure_dm_friendship_or_raise(db, room_id, current_user.id)
    room = db.get(ChatRoom, room_id)
    if room and bool(room.is_dissolved):
        raise HTTPException(status_code=410, detail="该群已解散")
    if room and room_effective_type(room) == "group" and bool(room.global_mute) and not can_bypass_group_global_mute(db, room_id, current_user.id):
        raise HTTPException(status_code=403, detail="该群已开启全员禁言")
    if room and room_effective_type(room) == "group" and is_user_muted_in_room(db, room_id, current_user.id):
        raise HTTPException(status_code=403, detail="You are muted in this group")
    if room:
        check_group_rate_limit_or_raise(db, room, current_user.id)
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="Empty content")
    reply_to_message_id = payload.reply_to_message_id
    if reply_to_message_id:
        target = db.get(Message, reply_to_message_id)
        if not target or target.room_id != room_id:
            raise HTTPException(status_code=400, detail="Invalid reply target")

    msg = Message(
        room_id=room_id,
        sender_id=current_user.id,
        content=content,
        reply_to_message_id=reply_to_message_id,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    # 发送者默认已读到最新消息
    mark_room_read(db, current_user.id, room_id, msg.id)

    await manager.broadcast_to_room(
        room_id,
        {"type": "new_message", "payload": serialize_message(db, msg)},
    )

    # 推送每个成员在该房间的最新未读数
    for uid in get_room_member_ids(db, room_id):
        unread_count = get_unread_count_for_room(db, uid, room_id)
        await manager.send_json_to_user(
            uid,
            {"type": "unread_update", "room_id": room_id, "unread_count": unread_count},
        )

    return build_message_out(db, msg)


@app.patch("/api/messages/{message_id}", response_model=MessageOut)
async def edit_message(
    message_id: int,
    payload: EditMessageIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    msg = db.get(Message, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    is_admin = current_user.role == "admin"
    is_owner = msg.sender_id == current_user.id

    new_content = payload.content.strip()
    if not new_content:
        raise HTTPException(status_code=422, detail="Empty content")
    is_recall = new_content == "[已撤回]"

    if not is_recall and not is_admin and not is_owner:
        raise HTTPException(status_code=403, detail="No permission")

    if not is_recall:
        ensure_permission(current_user, "can_use_edit_feature", "后台未授予编辑权限")
    elif not can_recall_message_in_room(db, current_user, msg):
        raise HTTPException(status_code=403, detail="你没有权限撤回该消息")

    # 文本编辑限制：普通用户只能编辑自己的文本消息且在时间窗内
    if is_owner and not is_admin:
        if msg.content.startswith("![img]("):
            raise HTTPException(status_code=400, detail="Image message cannot be edited")
        if new_content.startswith("![img]("):
            raise HTTPException(status_code=400, detail="Image message cannot be edited")

    if is_recall and msg.content == "[已撤回]":
        return build_message_out(db, msg)

    if is_recall:
        recalled_messages = cascade_recall_messages(db, msg, bool(is_admin))
        for recalled in recalled_messages:
            payload_ws = {"type": "message_edited", "payload": serialize_message(db, recalled)}
            await manager.broadcast_to_room(recalled.room_id, payload_ws)
        return build_message_out(db, msg)

    msg.content = new_content
    msg.edited_by_admin = bool(is_admin)
    msg.updated_at = utc_now_naive()
    db.commit()
    db.refresh(msg)

    payload_ws = {"type": "message_edited", "payload": serialize_message(db, msg)}
    await manager.broadcast_to_room(msg.room_id, payload_ws)

    return build_message_out(db, msg)


@app.post("/api/messages/{message_id}/recall", response_model=MessageOut)
async def recall_message(
    message_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    msg = db.get(Message, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    ensure_user_in_room(db, current_user.id, msg.room_id)

    is_sender = msg.sender_id == current_user.id
    if not can_recall_message_in_room(db, current_user, msg):
        raise HTTPException(status_code=403, detail="你没有权限撤回该消息")

    if msg.content == "[已撤回]":
        return build_message_out(db, msg)

    recalled_messages = cascade_recall_messages(db, msg, bool(not is_sender))
    for recalled in recalled_messages:
        await manager.broadcast_to_room(
            recalled.room_id,
            {"type": "message_edited", "payload": serialize_message(db, recalled)},
        )
    return build_message_out(db, msg)


@app.delete("/api/messages/{message_id}")
async def delete_message_for_self(
    message_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    msg = db.get(Message, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    ensure_user_in_room(db, current_user.id, msg.room_id)
    if msg.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="仅可删除自己发送的消息")

    if UserHiddenMessage is None:
        existed = db.execute(
            text(
                "SELECT id FROM user_hidden_messages "
                "WHERE user_id=:uid AND message_id=:mid LIMIT 1"
            ),
            {"uid": current_user.id, "mid": message_id},
        ).first()
        if not existed:
            db.execute(
                text(
                    "INSERT INTO user_hidden_messages (user_id, room_id, message_id, created_at) "
                    "VALUES (:uid, :rid, :mid, CURRENT_TIMESTAMP)"
                ),
                {"uid": current_user.id, "rid": msg.room_id, "mid": message_id},
            )
            db.commit()
    else:
        existed = db.execute(
            select(UserHiddenMessage.id).where(
                UserHiddenMessage.user_id == current_user.id,
                UserHiddenMessage.message_id == message_id,
            )
        ).first()
        if not existed:
            db.add(
                UserHiddenMessage(
                    user_id=current_user.id,
                    room_id=msg.room_id,
                    message_id=message_id,
                )
            )
            db.commit()

    await manager.send_json_to_user(
        current_user.id,
        {"type": "message_deleted", "payload": {"id": message_id, "room_id": msg.room_id}},
    )
    return {"ok": True, "message_id": message_id, "room_id": msg.room_id, "scope": "self"}


@app.delete("/api/messages/{message_id}/super-delete")
async def super_delete_message(
    message_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    msg = db.get(Message, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    ensure_user_in_room(db, current_user.id, msg.room_id)

    if not can_super_delete_message_in_room(db, current_user, msg):
        raise HTTPException(status_code=403, detail="你没有权限执行超级删除")

    room_id = msg.room_id
    db.delete(msg)
    db.commit()

    await manager.broadcast_to_room(
        room_id,
        {"type": "message_deleted", "payload": {"id": message_id, "room_id": room_id}},
    )
    return {"ok": True, "message_id": message_id, "room_id": room_id}


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
                await websocket.send_json({"type": "pong", "payload": {"time": utc_now_naive().isoformat()}})
                continue

            if data.action == "send_message":
                if not data.room_id:
                    await websocket.send_json({"type": "error", "payload": {"message": "room_id required"}})
                    continue
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
                try:
                    ensure_dm_friendship_or_raise(db, data.room_id, user_id)
                except HTTPException as e:
                    await websocket.send_json({"type": "error", "payload": {"message": str(e.detail)}})
                    continue

                room = db.get(ChatRoom, data.room_id)
                if room and bool(room.is_dissolved):
                    await websocket.send_json({"type": "error", "payload": {"message": "该群已解散"}})
                    continue
                if room and room_effective_type(room) == "group" and bool(room.global_mute) and not can_bypass_group_global_mute(db, data.room_id, user_id):
                    await websocket.send_json({"type": "error", "payload": {"message": "该群已开启全员禁言"}})
                    continue
                if room and room_effective_type(room) == "group" and is_user_muted_in_room(db, data.room_id, user_id):
                    await websocket.send_json({"type": "error", "payload": {"message": "You are muted in this group"}})
                    continue
                if room:
                    try:
                        check_group_rate_limit_or_raise(db, room, user_id)
                    except HTTPException as e:
                        await websocket.send_json({"type": "error", "payload": {"message": e.detail}})
                        continue

                reply_to_message_id = data.reply_to_message_id
                if reply_to_message_id:
                    target = db.get(Message, reply_to_message_id)
                    if not target or target.room_id != data.room_id:
                        await websocket.send_json({"type": "error", "payload": {"message": "Invalid reply target"}})
                        continue

                msg = Message(
                    room_id=data.room_id,
                    sender_id=user_id,
                    content=data.content.strip(),
                    reply_to_message_id=reply_to_message_id,
                )
                db.add(msg)
                db.commit()
                db.refresh(msg)

                # 发送者默认已读到最新消息
                mark_room_read(db, user_id, data.room_id, msg.id)

                await manager.broadcast_to_room(
                    data.room_id,
                    {"type": "new_message", "payload": serialize_message(db, msg)},
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
                if not data.room_id:
                    await websocket.send_json({"type": "error", "payload": {"message": "room_id required"}})
                    continue
                if not data.message_id or not data.content:
                    await websocket.send_json({"type": "error", "payload": {"message": "message_id/content required"}})
                    continue

                db.refresh(user)
                if not has_permission(user, "can_use_edit_feature"):
                    await websocket.send_json({"type": "error", "payload": {"message": "后台未授予编辑权限"}})
                    continue
                msg = db.get(Message, data.message_id)
                if not msg or msg.room_id != data.room_id:
                    await websocket.send_json({"type": "error", "payload": {"message": "Message not found"}})
                    continue

                is_admin = user.role == "admin"
                is_owner = msg.sender_id == user_id
                if not is_admin and not is_owner:
                    await websocket.send_json({"type": "error", "payload": {"message": "No permission"}})
                    continue
                if is_owner and not is_admin:
                    if msg.content.startswith("![img]("):
                        await websocket.send_json({"type": "error", "payload": {"message": "Image message cannot be edited"}})
                        continue
                    if data.content.strip().startswith("![img]("):
                        await websocket.send_json({"type": "error", "payload": {"message": "Image message cannot be edited"}})
                        continue

                msg.content = data.content.strip()
                msg.updated_at = utc_now_naive()
                msg.edited_by_admin = bool(is_admin)
                db.commit()
                db.refresh(msg)

                await manager.broadcast_to_room(
                    data.room_id,
                    {"type": "message_edited", "payload": serialize_message(db, msg)},
                )
                continue

            if data.action == "call_invite":
                if not data.room_id:
                    await websocket.send_json({"type": "error", "payload": {"message": "room_id required"}})
                    continue
                if data.call_type not in {"audio", "video"}:
                    await websocket.send_json({"type": "error", "payload": {"message": "Invalid call_type"}})
                    continue

                try:
                    peer_id = get_direct_call_peer_id(db, data.room_id, user_id)
                except HTTPException as e:
                    await websocket.send_json({"type": "error", "payload": {"message": e.detail}})
                    continue

                if user_call_index.get(user_id):
                    await websocket.send_json(
                        {"type": "call_busy", "payload": {"room_id": data.room_id, "reason": "caller_busy"}}
                    )
                    continue
                if user_call_index.get(peer_id):
                    await websocket.send_json(
                        {
                            "type": "call_busy",
                            "payload": {"room_id": data.room_id, "peer_user_id": peer_id, "reason": "peer_busy"},
                        }
                    )
                    continue
                if manager.connection_count(peer_id) == 0:
                    await websocket.send_json(
                        {
                            "type": "call_reject",
                            "payload": {"room_id": data.room_id, "peer_user_id": peer_id, "reason": "peer_offline"},
                        }
                    )
                    continue

                call_id = str(uuid4())
                call = {
                    "call_id": call_id,
                    "caller_id": user_id,
                    "callee_id": peer_id,
                    "room_id": data.room_id,
                    "call_type": data.call_type,
                    "status": "ringing",
                    "created_at": utc_now_naive().isoformat(),
                }
                call_sessions[call_id] = call
                user_call_index[user_id] = call_id
                user_call_index[peer_id] = call_id

                await manager.send_json_to_user(
                    peer_id,
                    {
                        "type": "call_invite",
                        "payload": {
                            "call_id": call_id,
                            "room_id": data.room_id,
                            "from_user_id": user_id,
                            "call_type": data.call_type,
                        },
                    },
                )
                await websocket.send_json(
                    {
                        "type": "call_ringing",
                        "payload": {
                            "call_id": call_id,
                            "room_id": data.room_id,
                            "to_user_id": peer_id,
                            "call_type": data.call_type,
                        },
                    }
                )
                continue

            if data.action == "call_accept":
                call_id = data.call_id or user_call_index.get(user_id)
                call = call_sessions.get(call_id) if call_id else None
                if not call:
                    await websocket.send_json({"type": "error", "payload": {"message": "Call not found"}})
                    continue
                if int(call["callee_id"]) != user_id:
                    await websocket.send_json({"type": "error", "payload": {"message": "No permission"}})
                    continue
                call["status"] = "active"
                call["accepted_at"] = utc_now_naive().isoformat()
                await manager.send_json_to_user(
                    int(call["caller_id"]),
                    {
                        "type": "call_accept",
                        "payload": {
                            "call_id": call_id,
                            "room_id": call["room_id"],
                            "from_user_id": user_id,
                            "call_type": call["call_type"],
                        },
                    },
                )
                continue

            if data.action == "call_reject":
                call_id = data.call_id or user_call_index.get(user_id)
                call = call_sessions.get(call_id) if call_id else None
                if not call:
                    await websocket.send_json({"type": "error", "payload": {"message": "Call not found"}})
                    continue
                if user_id not in {int(call["caller_id"]), int(call["callee_id"])}:
                    await websocket.send_json({"type": "error", "payload": {"message": "No permission"}})
                    continue
                peer_id = get_call_peer_id(call, user_id)
                clear_call_state(call_id)
                if peer_id:
                    await manager.send_json_to_user(
                        peer_id,
                        {
                            "type": "call_reject",
                            "payload": {
                                "call_id": call_id,
                                "room_id": call["room_id"],
                                "from_user_id": user_id,
                                "reason": "rejected",
                            },
                        },
                    )
                continue

            if data.action == "call_hangup":
                call_id = data.call_id or user_call_index.get(user_id)
                call = call_sessions.get(call_id) if call_id else None
                if not call:
                    continue
                if user_id not in {int(call["caller_id"]), int(call["callee_id"])}:
                    await websocket.send_json({"type": "error", "payload": {"message": "No permission"}})
                    continue
                peer_id = get_call_peer_id(call, user_id)
                clear_call_state(call_id)
                if peer_id:
                    await manager.send_json_to_user(
                        peer_id,
                        {
                            "type": "call_hangup",
                            "payload": {
                                "call_id": call_id,
                                "room_id": call["room_id"],
                                "from_user_id": user_id,
                                "reason": "hangup",
                            },
                        },
                    )
                continue

            if data.action in {"call_offer", "call_answer", "call_ice_candidate"}:
                call_id = data.call_id or user_call_index.get(user_id)
                call = call_sessions.get(call_id) if call_id else None
                if not call:
                    await websocket.send_json({"type": "error", "payload": {"message": "Call not found"}})
                    continue
                if user_id not in {int(call["caller_id"]), int(call["callee_id"])}:
                    await websocket.send_json({"type": "error", "payload": {"message": "No permission"}})
                    continue
                peer_id = get_call_peer_id(call, user_id)
                if not peer_id:
                    continue
                payload_forward = {
                    "call_id": call_id,
                    "room_id": call["room_id"],
                    "from_user_id": user_id,
                    "call_type": call["call_type"],
                }
                if data.sdp:
                    payload_forward["sdp"] = data.sdp
                if data.candidate:
                    payload_forward["candidate"] = data.candidate
                await manager.send_json_to_user(peer_id, {"type": data.action, "payload": payload_forward})
                continue

            await websocket.send_json({"type": "error", "payload": {"message": "Unknown action"}})

    except WebSocketDisconnect:
        pass
    finally:
        active_call_id = user_call_index.get(user_id)
        active_call = call_sessions.get(active_call_id) if active_call_id else None
        if active_call:
            peer_id = get_call_peer_id(active_call, user_id)
            call_room_id = active_call.get("room_id")
            clear_call_state(active_call_id)
            if peer_id:
                await manager.send_json_to_user(
                    peer_id,
                    {
                        "type": "call_hangup",
                        "payload": {
                            "call_id": active_call_id,
                            "room_id": call_room_id,
                            "from_user_id": user_id,
                            "reason": "peer_disconnected",
                        },
                    },
                )

        manager.disconnect(user_id, websocket)
        remain = manager.connection_count(user_id)
        if remain == 0:
            user = db.get(User, user_id)
            if user:
                user.is_online = False
                user.last_seen_at = utc_now_naive()
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
async def delete_room(room_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    room = db.get(ChatRoom, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    member_rows = db.execute(select(room_members.c.user_id).where(room_members.c.room_id == room_id)).all()
    member_ids = [m[0] for m in member_rows]

    # 群聊：仅群主可解散，采用软解散
    if room_effective_type(room) == "group":
        if get_room_member_role(db, room_id, current_user.id) != "owner":
            raise HTTPException(status_code=403, detail="Only owner can dissolve group")
        if not bool(room.is_dissolved):
            room.is_dissolved = True
            room.dissolved_at = utc_now_naive()
            db.commit()

        await manager.broadcast_to_room(
            room_id,
            {
                "type": "room_dissolved",
                "room_id": room_id,
                "by_user_id": current_user.id,
            },
        )
        for uid in member_ids:
            manager.refresh_user_rooms(uid, get_room_ids_for_user(db, uid))
            await manager.send_json_to_user(uid, {"type": "room_removed", "room_id": room_id})
        return {"ok": True, "room_id": room_id, "dissolved": True}

    # 非群聊：保持旧行为（兼容）
    if room.created_by != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="No permission")
    db.execute(delete(room_members).where(room_members.c.room_id == room_id))
    db.delete(room)
    db.commit()

    for uid in member_ids:
        manager.refresh_user_rooms(uid, get_room_ids_for_user(db, uid))
        await manager.send_json_to_user(uid, {"type": "room_removed", "room_id": room_id})

    return {"ok": True}
