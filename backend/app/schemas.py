from datetime import datetime

from pydantic import BaseModel, Field


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    # 用 pattern 做基础邮箱格式校验，避免强依赖 email-validator 包
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    password: str = Field(min_length=6, max_length=64)


class LoginIn(BaseModel):
    username: str
    password: str


class TokenOut(BaseModel):
    token: str
    user: "UserOut"


class UserOut(BaseModel):
    id: int
    username: str
    email: str
    nickname: str
    signature: str
    avatar_base64: str | None = None
    role: str
    is_online: bool
    last_seen_at: datetime | None = None

    class Config:
        from_attributes = True


class UserUpdateIn(BaseModel):
    nickname: str | None = None
    signature: str | None = None
    avatar_base64: str | None = None


class CreateRoomIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    member_ids: list[int] = Field(default_factory=list)


class CreateGroupRoomIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    member_ids: list[int] = Field(default_factory=list)
    avatar: str | None = None


class RoomOut(BaseModel):
    id: int
    name: str
    room_type: str
    type: str | None = None
    title: str | None = None
    avatar: str | None = None
    created_by: int
    member_ids: list[int]
    member_count: int | None = None


class AddRoomMemberIn(BaseModel):
    user_id: int


class RoomMemberOut(BaseModel):
    room_id: int
    user_id: int
    username: str
    nickname: str
    role: str
    joined_at: datetime | None = None


class RoomUnreadOut(BaseModel):
    room_id: int
    unread_count: int


class MessageOut(BaseModel):
    id: int
    room_id: int
    sender_id: int
    reply_to_message_id: int | None = None
    reply_to_sender_id: int | None = None
    reply_to_content: str | None = None
    content: str
    edited_by_admin: bool
    created_at: datetime
    updated_at: datetime | None


class SendMessageIn(BaseModel):
    content: str = Field(min_length=1)
    reply_to_message_id: int | None = None


class EditMessageIn(BaseModel):
    content: str = Field(min_length=1)


class SearchUserOut(BaseModel):
    id: int
    username: str
    nickname: str
    is_online: bool
    avatar_base64: str | None = None


class CreateFriendRequestIn(BaseModel):
    to_user_id: int


class FriendRequestOut(BaseModel):
    id: int
    from_user_id: int
    to_user_id: int
    status: str
    created_at: datetime
    responded_at: datetime | None = None


class FriendRemarkIn(BaseModel):
    remark: str = Field(default="", max_length=80)


class FriendRemarkOut(BaseModel):
    friend_id: int
    remark: str


class PresenceOnlineUserOut(BaseModel):
    id: int
    username: str


class PresenceStatusOut(BaseModel):
    user_id: int
    online: bool
    last_seen_at: datetime | None


class MarkRoomReadIn(BaseModel):
    last_read_message_id: int | None = None


class WsMessageIn(BaseModel):
    action: str
    room_id: int | None = None
    content: str | None = None
    message_id: int | None = None
    reply_to_message_id: int | None = None
    call_id: str | None = None
    call_type: str | None = None
    sdp: str | None = None
    candidate: dict | None = None


class WsMessageOut(BaseModel):
    type: str
    payload: dict


TokenOut.model_rebuild()
