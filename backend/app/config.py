from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_env: str = "development"
    app_name: str = "chat-backend"
    secret_key: str = "change-me"
    database_url: str = "sqlite:///./chat_app.db"
    frontend_origins: str = "http://localhost:5500,http://127.0.0.1:5500"
    access_token_expire_hours: int = 72

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    @property
    def cors_origins(self) -> list[str]:
        # 始终包含生产前端域名，避免环境变量遗漏导致跨域失败
        required_origin = "https://xuq873031-lang.github.io"
        origins = [x.strip() for x in self.frontend_origins.split(",") if x.strip()]
        if required_origin not in origins:
            origins.append(required_origin)
        return origins


settings = Settings()
