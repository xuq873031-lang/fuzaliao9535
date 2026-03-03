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

    class Config:
        from_attributes = True


class UserUpdateIn(BaseModel):
    nickname: str | None = None
    signature: str | None = None
    avatar_base64: str | None = None


class CreateRoomIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    member_ids: list[int] = Field(default_factory=list)


class RoomOut(BaseModel):
    id: int
    name: str
    room_type: str
    created_by: int
    member_ids: list[int]


class MessageOut(BaseModel):
    id: int
    room_id: int
    sender_id: int
    content: str
    edited_by_admin: bool
    created_at: datetime
    updated_at: datetime | None


class EditMessageIn(BaseModel):
    content: str = Field(min_length=1)


class SearchUserOut(BaseModel):
    id: int
    username: str
    nickname: str
    is_online: bool


class WsMessageIn(BaseModel):
    action: str
    room_id: int
    content: str | None = None
    message_id: int | None = None


class WsMessageOut(BaseModel):
    type: str
    payload: dict


TokenOut.model_rebuild()
