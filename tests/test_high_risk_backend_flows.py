from __future__ import annotations

import time

import pytest

from backend.app import main as app_main
from backend.app.security import create_access_token, verify_access_token
from tests.conftest import auth_headers, register_user


def _create_group(client, token: str, member_ids: list[int], title: str = "Test Group") -> dict:
    res = client.post(
        "/api/rooms/group",
        headers=auth_headers(token),
        json={"title": title, "member_ids": member_ids, "avatar": None},
    )
    assert res.status_code == 200, res.text
    return res.json()


def _post_message(client, token: str, room_id: int, content: str, reply_to_message_id: int | None = None) -> dict:
    payload = {"content": content}
    if reply_to_message_id is not None:
        payload["reply_to_message_id"] = reply_to_message_id
    res = client.post(f"/api/rooms/{room_id}/messages", headers=auth_headers(token), json=payload)
    assert res.status_code == 200, res.text
    return res.json()


def _collect_types(ws, expected_types: set[str], limit: int = 8) -> list[dict]:
    events = []
    for _ in range(limit):
        evt = ws.receive_json()
        events.append(evt)
        seen = {e["type"] for e in events}
        if expected_types.issubset(seen):
            break
    return events


def _wait_for_ws_event_types(ws, expected_types: set[str], limit: int = 8) -> list[dict]:
    events = _collect_types(ws, expected_types, limit=limit)
    seen = {e.get("type") for e in events}
    if not expected_types.issubset(seen):
        pytest.fail(
            "WebSocket did not emit expected event types within "
            f"{limit} reads. expected={sorted(expected_types)} got={sorted(seen)}"
        )
    return events


def test_ws_new_message_and_unread_update_are_broadcast(client):
    owner = register_user(client, "owner_ws")
    member = register_user(client, "member_ws")
    room = _create_group(client, owner["token"], [member["user"]["id"]], "WS room")
    room_id = room["id"]

    with client.websocket_connect(f"/ws?token={member['token']}") as ws_member:
        msg = _post_message(client, owner["token"], room_id, "hello realtime")
        events = _wait_for_ws_event_types(ws_member, {"new_message", "unread_update"}, limit=10)

        assert any(e["type"] == "new_message" and e["payload"]["id"] == msg["id"] for e in events)
        assert any(e["type"] == "unread_update" and e["room_id"] == room_id for e in events)


def test_recall_cascades_to_quoted_messages_and_pushes_ws_updates(client):
    owner = register_user(client, "owner_recall")
    member = register_user(client, "member_recall")
    room = _create_group(client, owner["token"], [member["user"]["id"]], "Recall room")
    room_id = room["id"]

    msg_a = _post_message(client, owner["token"], room_id, "origin")
    msg_b = _post_message(client, owner["token"], room_id, "reply", reply_to_message_id=msg_a["id"])

    with client.websocket_connect(f"/ws?token={member['token']}") as ws_member:
        res = client.post(f"/api/messages/{msg_a['id']}/recall", headers=auth_headers(owner["token"]))
        assert res.status_code == 200, res.text

        events = _wait_for_ws_event_types(ws_member, {"message_edited"}, limit=10)
        edited_ids = {
            evt["payload"]["id"]
            for evt in events
            if evt["type"] == "message_edited"
        }
        read_limit = 10 - len(events)
        for _ in range(max(0, read_limit)):
            if edited_ids == {msg_a["id"], msg_b["id"]}:
                break
            evt = ws_member.receive_json()
            events.append(evt)
            if evt["type"] == "message_edited":
                edited_ids.add(evt["payload"]["id"])

        assert edited_ids == {msg_a["id"], msg_b["id"]}, [e["type"] for e in events]

    res = client.get(f"/api/rooms/{room_id}/messages", headers=auth_headers(owner["token"]))
    assert res.status_code == 200, res.text
    by_id = {m["id"]: m for m in res.json()}
    assert by_id[msg_a["id"]]["content"] == "[已撤回]"
    assert by_id[msg_b["id"]]["content"] == "[已撤回]"


def test_group_member_cannot_recall_others_without_permission_but_can_after_grant(client):
    owner = register_user(client, "owner_perm")
    moderator = register_user(client, "moderator_perm")
    room = _create_group(client, owner["token"], [moderator["user"]["id"]], "Perm room")
    room_id = room["id"]

    msg = _post_message(client, owner["token"], room_id, "owner message")

    denied = client.post(f"/api/messages/{msg['id']}/recall", headers=auth_headers(moderator["token"]))
    assert denied.status_code == 403

    grant = client.put(
        f"/api/rooms/{room_id}/members/{moderator['user']['id']}/permissions",
        headers=auth_headers(owner["token"]),
        json={
            "can_kick": False,
            "can_mute": False,
            "can_recall_others": True,
            "can_super_delete": False,
        },
    )
    assert grant.status_code == 200, grant.text

    allowed = client.post(f"/api/messages/{msg['id']}/recall", headers=auth_headers(moderator["token"]))
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["content"] == "[已撤回]"


def test_group_super_delete_requires_permission_and_broadcasts_delete(client):
    owner = register_user(client, "owner_delete")
    moderator = register_user(client, "moderator_delete")
    room = _create_group(client, owner["token"], [moderator["user"]["id"]], "Delete room")
    room_id = room["id"]
    msg = _post_message(client, owner["token"], room_id, "remove me")

    denied = client.delete(f"/api/messages/{msg['id']}/super-delete", headers=auth_headers(moderator["token"]))
    assert denied.status_code == 403

    grant = client.put(
        f"/api/rooms/{room_id}/members/{moderator['user']['id']}/permissions",
        headers=auth_headers(owner["token"]),
        json={
            "can_kick": False,
            "can_mute": False,
            "can_recall_others": False,
            "can_super_delete": True,
        },
    )
    assert grant.status_code == 200, grant.text

    with client.websocket_connect(f"/ws?token={owner['token']}") as ws_owner:
        deleted = client.delete(f"/api/messages/{msg['id']}/super-delete", headers=auth_headers(moderator["token"]))
        assert deleted.status_code == 200, deleted.text

        events = _wait_for_ws_event_types(ws_owner, {"message_deleted"}, limit=10)
        evt = next(e for e in events if e["type"] == "message_deleted")
        assert evt["type"] == "message_deleted"
        assert evt["payload"]["id"] == msg["id"]

    res = client.get(f"/api/rooms/{room_id}/messages", headers=auth_headers(owner["token"]))
    assert res.status_code == 200, res.text
    assert all(m["id"] != msg["id"] for m in res.json())


def test_invalid_and_expired_token_behaviour():
    assert verify_access_token("not-a-token") is None

    old_expire = app_main.settings.access_token_expire_hours
    try:
        app_main.settings.access_token_expire_hours = 0
        token = create_access_token(1, "expired_user")
        time.sleep(1)
        assert verify_access_token(token) is None
    finally:
        app_main.settings.access_token_expire_hours = old_expire
