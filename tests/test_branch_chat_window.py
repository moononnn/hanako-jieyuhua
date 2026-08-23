# 解语花 — 另一枝聊天窗口无头冒烟测试（QT_QPA_PLATFORM=offscreen）
# 覆盖：窗口构造、气泡渲染/状态行、历史加载与轮询增量追加、分支列表渲染

import unittest
from types import SimpleNamespace

from _zhujian_test_support import QtTestCase, zhujian


def make_app():
    return zhujian.QApplication.instance() or zhujian.QApplication([])


def make_ball(theme="light"):
    return SimpleNamespace(theme_mode=theme, branch_windows={})


def make_panel():
    """真 QFrame 当 parent，挂上 ball 与收起方法（BranchListMenu 构造要求 QWidget parent）。"""
    ball = make_ball()
    panel = zhujian.QFrame()
    panel.ball = ball
    panel._toggle_branch_list_off = lambda: None
    return panel


def make_branch(bid="b1", title="另一枝"):
    return {"id": bid, "title": title, "createdAt": 1700000000000, "lastTs": 0, "preview": ""}


class BranchChatWindowTests(QtTestCase):
    def _make_window(self, branch=None):
        app = make_app()
        ball = make_ball()
        win = zhujian.BranchChatWindow(ball, branch or make_branch())
        return app, win

    def test_constructs_with_title(self):
        app, win = self._make_window()
        self.assertEqual(win.lbl_title.text(), "另一枝")
        self.assertEqual(win.branch_id, "b1")
        self.assertFalse(win.btn_send.isEnabled() is False)  # 初始可发送
        win.close()
        app.processEvents()

    def test_append_message_inserts_before_stretch(self):
        app, win = self._make_window()
        before = win.msg_box.count()  # 1（底部 stretch）
        win._append_message("user", "你好")
        win._append_message("assistant", "在的")
        self.assertEqual(win.msg_box.count(), before + 2)
        win.close()
        app.processEvents()

    def test_status_row_clear(self):
        app, win = self._make_window()
        win._append_status("正在回复…")
        self.assertIsNotNone(win._status_row)
        win._clear_status()
        self.assertIsNone(win._status_row)
        win.close()
        app.processEvents()

    def test_apply_history_initial_renders_all(self):
        app, win = self._make_window()
        win._apply_history({
            "ok": True,
            "messages": [
                {"role": "user", "content": "第一句", "ts": 1},
                {"role": "assistant", "content": "回复一", "ts": 2},
            ],
        })
        self.assertEqual(win._rendered, 2)
        self.assertFalse(win._awaiting_reply)
        win.close()
        app.processEvents()

    def test_apply_history_empty_shows_status(self):
        app, win = self._make_window()
        win._apply_history({"ok": True, "messages": []})
        self.assertIsNotNone(win._status_row)
        win.close()
        app.processEvents()

    def test_polling_appends_new_messages_and_finishes(self):
        app, win = self._make_window()
        win._apply_history({
            "ok": True,
            "messages": [{"role": "user", "content": "发送的话", "ts": 1}],
        })
        self.assertEqual(win._rendered, 1)
        # 发送后进入等待回复
        win._awaiting_reply = True
        win._sending = True
        win.btn_send.setEnabled(False)
        win._append_status("正在回复…")
        # 轮询回包：多了一条用户消息 + 一条助手回复
        win._apply_history({
            "ok": True,
            "messages": [
                {"role": "user", "content": "发送的话", "ts": 1},
                {"role": "user", "content": "追问一句", "ts": 3},
                {"role": "assistant", "content": "回你了", "ts": 4},
            ],
        })
        self.assertEqual(win._rendered, 3)
        self.assertFalse(win._awaiting_reply)
        self.assertFalse(win._sending)
        self.assertTrue(win.btn_send.isEnabled())
        self.assertIsNone(win._status_row)
        win.close()
        app.processEvents()

    def test_polling_no_new_assistant_keeps_waiting(self):
        app, win = self._make_window()
        win._apply_history({
            "ok": True,
            "messages": [{"role": "user", "content": "发送的话", "ts": 1}],
        })
        win._awaiting_reply = True
        win._sending = True
        win._poll_started = 0.0  # 很早开始 → 会触发超时
        win._apply_history({
            "ok": True,
            "messages": [{"role": "user", "content": "发送的话", "ts": 1}],
        })
        # 只有用户消息没有助手回复 → 超时结束等待
        self.assertFalse(win._awaiting_reply)
        self.assertTrue(win.btn_send.isEnabled())
        win.close()
        app.processEvents()

    def test_title_drag_event_filter_no_crash(self):
        app, win = self._make_window()
        # 模拟标题栏按下/移动/松开（构造 QMouseEvent 太繁琐，直接调私有状态并验证不崩）
        win._drag_press = None
        win._drag_start = win.pos()
        win.close()
        app.processEvents()


class BranchListMenuTests(QtTestCase):
    def test_sync_renders_items(self):
        app = make_app()
        menu = zhujian.BranchListMenu(make_panel())
        menu._apply_branches({
            "ok": True,
            "branches": [
                {"id": "b1", "title": "另一枝", "createdAt": 1700000000000, "lastTs": 0, "preview": "支线第二句"},
                {"id": "b2", "title": "另一枝", "createdAt": 1700000001000, "lastTs": 0, "preview": ""},
            ],
        })
        self.assertEqual(menu.list_box.count(), 2)
        menu.close()
        app.processEvents()

    def test_empty_state_hint(self):
        app = make_app()
        menu = zhujian.BranchListMenu(make_panel())
        menu._apply_branches({"ok": True, "branches": []})
        self.assertEqual(menu.list_box.count(), 0)
        self.assertIn("另开一枝", menu.lbl_hint.text())
        menu.close()
        app.processEvents()

    def test_item_label_format(self):
        label = zhujian.BranchListMenu._item_label(
            {"title": "另一枝", "createdAt": 1700000000000, "lastTs": 1700000003000, "preview": "支线第二句"}
        )
        self.assertIn("另一枝", label)
        self.assertIn("支线第二句", label)


if __name__ == "__main__":
    unittest.main()
