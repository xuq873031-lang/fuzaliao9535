# Migration Guide

## 1) Schema migration (existing SQLite)

This project now requires `users.last_seen_at`.
This project also requires message history performance index:
- `ix_messages_room_created_at` on `(room_id, created_at)`.
Unread feature requires a new table:
- `room_reads(user_id, room_id, last_read_message_id, last_read_at)`

### Automatic migration (already implemented)
On app startup, `app.main.ensure_compatible_schema()` checks whether `users.last_seen_at` exists.
If missing, it runs:

- SQLite: `ALTER TABLE users ADD COLUMN last_seen_at DATETIME`
- Postgres: `ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMP NULL`

On app startup, `app.main.ensure_message_indexes()` runs:
- `CREATE INDEX IF NOT EXISTS ix_messages_room_created_at ON messages (room_id, created_at)`

`room_reads` table is created by SQLAlchemy metadata (`Base.metadata.create_all`) on startup.

No existing API is removed.

### Manual fallback (if startup migration fails)

```sql
ALTER TABLE users ADD COLUMN last_seen_at DATETIME;
CREATE INDEX IF NOT EXISTS ix_messages_room_created_at ON messages (room_id, created_at);
CREATE TABLE IF NOT EXISTS room_reads (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  room_id INTEGER NOT NULL,
  last_read_message_id INTEGER NULL,
  last_read_at DATETIME NULL
);
```

## 2) SQLite -> Postgres migration

1. Export SQLite data and load into Postgres with `pgloader`:

```bash
pgloader sqlite:///absolute/path/to/chat_app.db postgresql://USER:PASSWORD@HOST:5432/DBNAME
```

2. Set environment variable:

```env
DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:5432/DBNAME
```

3. Install postgres driver if needed:

```bash
pip install psycopg[binary]
```

4. Restart service.

## 3) Railway note

Railway runtime already uses `$PORT` in start commands (`Procfile` / `railway.json`).
For production reliability, use Postgres instead of SQLite ephemeral disk.
