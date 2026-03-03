from datetime import datetime, timedelta, timezone
import base64
import hashlib
import hmac
import os

from itsdangerous import BadSignature, URLSafeTimedSerializer

from .config import settings


serializer = URLSafeTimedSerializer(settings.secret_key, salt="chat-app")


def hash_password(password: str) -> str:
    # 使用标准库 PBKDF2 生成可存储的密码哈希：pbkdf2_sha256$iterations$salt$hash
    iterations = 200_000
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return "pbkdf2_sha256${}${}${}".format(
        iterations,
        base64.b64encode(salt).decode("utf-8"),
        base64.b64encode(digest).decode("utf-8"),
    )


def verify_password(plain_password: str, password_hash: str) -> bool:
    try:
        algo, iter_str, salt_b64, digest_b64 = password_hash.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        iterations = int(iter_str)
        salt = base64.b64decode(salt_b64.encode("utf-8"))
        expected = base64.b64decode(digest_b64.encode("utf-8"))
        actual = hashlib.pbkdf2_hmac("sha256", plain_password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def create_access_token(user_id: int, username: str) -> str:
    payload = {
        "sub": str(user_id),
        "username": username,
        "exp": (datetime.now(timezone.utc) + timedelta(hours=settings.access_token_expire_hours)).isoformat(),
    }
    return serializer.dumps(payload)


def verify_access_token(token: str) -> dict | None:
    try:
        return serializer.loads(token, max_age=settings.access_token_expire_hours * 3600)
    except BadSignature:
        return None
