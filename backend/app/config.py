from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    app_name: str = "chat-backend"
    secret_key: str = "change-me"
    database_url: str = "sqlite:///./chat_app.db"
    frontend_origins: str = "http://localhost:5500,http://127.0.0.1:5500"
    access_token_expire_hours: int = 72
    # 生产护栏：默认禁止在 production 使用 SQLite
    enforce_non_sqlite_in_production: bool = True
    # 生产护栏：默认禁止本地 uploads（需显式放开）
    allow_local_uploads_in_production: bool = False
    # 好友申请权限（后端强校验）
    friend_request_allowed_roles: str = "admin,mentor,member"
    friend_request_allowed_usernames: str = ""
    # 上传目录（相对 backend 目录）
    upload_dir: str = "uploads"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def cors_origins(self) -> list[str]:
        # 始终包含生产前端域名，避免环境变量遗漏导致跨域失败
        required_origin = "https://xuq873031-lang.github.io"
        origins = [x.strip() for x in self.frontend_origins.split(",") if x.strip()]
        if required_origin not in origins:
            origins.append(required_origin)
        return origins

    @property
    def allowed_friend_request_roles(self) -> set[str]:
        return {x.strip().lower() for x in self.friend_request_allowed_roles.split(",") if x.strip()}

    @property
    def allowed_friend_request_usernames(self) -> set[str]:
        return {x.strip().lower() for x in self.friend_request_allowed_usernames.split(",") if x.strip()}


settings = Settings()
