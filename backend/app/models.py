from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Table, Text, UniqueConstraint
from sqlalchemy.orm import relationship

from .db import Base


room_members = Table(
    "room_members",
    Base.metadata,
    Column("room_id", ForeignKey("chat_rooms.id", ondelete="CASCADE"), primary_key=True),
    Column("user_id", ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("role", String(20), nullable=False, default="member"),
    Column("joined_at", DateTime, default=datetime.utcnow, nullable=False),
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
    is_online = Column(Boolean, default=False, nullable=False)
    last_seen_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

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
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

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
    content = Column(Text, nullable=False)
    edited_by_admin = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, nullable=True)

    room = relationship("ChatRoom", back_populates="messages")
    sender = relationship("User", back_populates="messages")


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
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    responded_at = Column(DateTime, nullable=True)


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
    updated_at = Column(DateTime, default=datetime.utcnow, nullable=False)
