from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Table, Text, UniqueConstraint
from sqlalchemy.orm import relationship

from .db import Base


def utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


room_members = Table(
    "room_members",
    Base.metadata,
    Column("room_id", ForeignKey("chat_rooms.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("role", String(20), nullable=False, default="member"),
    Column("can_kick", Boolean, nullable=False, default=False),
    Column("can_mute", Boolean, nullable=False, default=False),
    Column("can_recall_others", Boolean, nullable=False, default=False),
    Column("can_super_delete", Boolean, nullable=False, default=False),
    Column("joined_at", DateTime, default=utc_now_naive, nullable=False),
)


friends = Table(
    "friends",
    Base.metadata,
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("friend_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    UniqueConstraint("user_id", "friend_id", name="uq_user_friend"),
)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    email = Column(String(120), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(20), default="member", nullable=False)
    nickname = Column(String(80), default="", nullable=False)
    signature = Column(String(200), default="", nullable=False)
    avatar_base64 = Column(Text, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    is_banned = Column(Boolean, default=False, nullable=False)
    is_online = Column(Boolean, default=False, nullable=False)
    last_seen_at = Column(DateTime, nullable=True)
    can_kick_members = Column(Boolean, default=False, nullable=False)
    can_mute_members = Column(Boolean, default=False, nullable=False)
    can_recall_own_messages = Column(Boolean, default=True, nullable=False)
    can_recall_others_messages = Column(Boolean, default=False, nullable=False)
    can_super_delete_messages = Column(Boolean, default=False, nullable=False)
    can_use_edit_feature = Column(Boolean, default=False, nullable=False)
    can_use_super_delete = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=utc_now_naive, nullable=False)

    messages = relationship("Message", back_populates="sender", cascade="all, delete")


class ChatRoom(Base):
    __tablename__ = "chat_rooms"

    id = Column(Integer, primary_key=True, index=True)
    # 兼容旧字段（name/room_type）并新增语义化字段（title/type/avatar）
    name = Column(String(120), nullable=False)
    room_type = Column(String(20), nullable=False, default="group")
    type = Column(String(20), nullable=False, default="group")
    title = Column(String(120), nullable=True)
    avatar = Column(Text, nullable=True)
    description = Column(String(300), nullable=False, default="")
    notice = Column(String(300), nullable=False, default="")
    allow_member_friend_add = Column(Boolean, nullable=False, default=False)
    allow_member_invite = Column(Boolean, nullable=False, default=False)
    invite_need_approval = Column(Boolean, nullable=False, default=True)
    global_mute = Column(Boolean, nullable=False, default=False)
    rate_limit_seconds = Column(Integer, nullable=False, default=0)
    is_dissolved = Column(Boolean, nullable=False, default=False)
    dissolved_at = Column(DateTime, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=utc_now_naive, nullable=False)

    members = relationship("User", secondary=room_members)
    messages = relationship("Message", back_populates="room", cascade="all, delete")


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (
        Index("ix_messages_room_created_at", "room_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    room_id = Column(Integer, ForeignKey("chat_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    sender_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    reply_to_message_id = Column(Integer, nullable=True, index=True)
    content = Column(Text, nullable=False)
    edited_by_admin = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=utc_now_naive, nullable=False, index=True)
    updated_at = Column(DateTime, nullable=True)

    room = relationship("ChatRoom", back_populates="messages")
    sender = relationship("User", back_populates="messages")


class UserHiddenMessage(Base):
    __tablename__ = "user_hidden_messages"
    __table_args__ = (
        UniqueConstraint("user_id", "message_id", name="uq_user_hidden_message"),
        Index("ix_user_hidden_messages_user_message", "user_id", "message_id"),
        Index("ix_user_hidden_messages_user_room", "user_id", "room_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    room_id = Column(Integer, ForeignKey("chat_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    message_id = Column(Integer, ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, default=utc_now_naive, nullable=False)


class RoomRead(Base):
    __tablename__ = "room_reads"
    __table_args__ = (
        UniqueConstraint("user_id", "room_id", name="uq_room_read_user_room"),
        Index("ix_room_reads_user_room", "user_id", "room_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    room_id = Column(Integer, ForeignKey("chat_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    last_read_message_id = Column(Integer, nullable=True)
    last_read_at = Column(DateTime, nullable=True)


class FriendRequest(Base):
    __tablename__ = "friend_requests"
    __table_args__ = (
        Index("ix_friend_requests_to_status", "to_user_id", "status"),
        Index("ix_friend_requests_from_status", "from_user_id", "status"),
    )

    id = Column(Integer, primary_key=True, index=True)
    from_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    to_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    status = Column(String(20), nullable=False, default="pending")
    message = Column(String(120), nullable=False, default="")
    created_at = Column(DateTime, default=utc_now_naive, nullable=False)
    responded_at = Column(DateTime, nullable=True)

    from_user = relationship("User", foreign_keys=[from_user_id])
    to_user = relationship("User", foreign_keys=[to_user_id])


class FriendRemark(Base):
    __tablename__ = "friend_remarks"
    __table_args__ = (
        UniqueConstraint("user_id", "friend_id", name="uq_friend_remark_user_friend"),
        Index("ix_friend_remarks_user_friend", "user_id", "friend_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    friend_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    remark = Column(String(80), nullable=False, default="")
    updated_at = Column(DateTime, default=utc_now_naive, nullable=False)


class RoomMute(Base):
    __tablename__ = "room_mutes"
    __table_args__ = (
        UniqueConstraint("room_id", "user_id", name="uq_room_mute_room_user"),
        Index("ix_room_mutes_room_user", "room_id", "user_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    room_id = Column(Integer, ForeignKey("chat_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    muted_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    created_at = Column(DateTime, default=utc_now_naive, nullable=False)
