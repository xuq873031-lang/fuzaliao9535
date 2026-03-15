from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_chat_split_breakpoint_keeps_desktop_and_tablet_divider():
    css = _read("style.css")
    docs_css = _read("docs/style.css")

    for content in (css, docs_css):
        assert "@media (min-width: 681px)" in content
        assert "@media (max-width: 680.98px)" in content
        assert "#chatSplitHandle" in content
        assert "cursor: col-resize" in content
        assert "flex: 0 0 var(--chat-split-width)" in content


def test_mobile_header_contract_uses_real_two_row_containers():
    html = _read("index.html")
    css = _read("style.css")

    assert 'class="mobile-topbar d-md-none' in html
    assert 'class="chat-home-topbar"' in html
    assert ".mobile-topbar" in css
    assert "#messagesView .chat-home-topbar" in css
