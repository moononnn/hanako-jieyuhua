import unittest
from unittest.mock import patch

from PyQt6.QtCore import QEventLoop, Qt

from _zhujian_test_support import QtTestCase, zhujian


class ResumeCardTests(QtTestCase):
    """断联续接卡片：显示/收起/继续按钮/自动开关/提问优先（离屏）"""

    def _make_panel(self):
        app = zhujian.QApplication.instance() or zhujian.QApplication([])
        ball = zhujian.ZhujianBall()
        panel = zhujian.ZhujianMenu(ball)
        panel._sync_target_state = lambda: None
        panel.show()
        app.processEvents()
        return app, ball, panel

    def _resume_entry(self, **overrides):
        entry = {
            "resumeId": "resume_test1",
            "agentId": "hanako",
            "sessionId": "s1",
            "sessionPath": "C:\\agents\\hanako\\sessions\\s1.jsonl",
            "sessionTitle": "插件闲聊",
            "agentName": "小花",
            "reason": "网络连接断了",
            "ts": 1,
        }
        entry.update(overrides)
        return entry

    def test_resume_card_temporarily_drops_always_on_top_and_restores(self):
        app, ball, panel = self._make_panel()
        flag = Qt.WindowType.WindowStaysOnTopHint
        try:
            self.assertTrue(bool(panel.windowFlags() & flag))
            position = panel.pos()
            panel.show_resume(self._resume_entry())
            app.processEvents()
            self.assertFalse(bool(panel.windowFlags() & flag))
            self.assertTrue(panel.isVisible())
            self.assertEqual(panel.pos(), position)
            panel.finish_resume_and_collapse()
            app.processEvents()
            self.assertTrue(bool(panel.windowFlags() & flag))
            panel.show_resume(self._resume_entry(resumeId="resume_test_again"))
            self.assertFalse(bool(panel.windowFlags() & flag))
            panel.prepare_for_show()
            app.processEvents()
            self.assertTrue(bool(panel.windowFlags() & flag))
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_same_resume_poll_does_not_raise_panel_again(self):
        app, ball, panel = self._make_panel()
        ball.menu = panel
        entry = self._resume_entry()
        panel.hide()
        try:
            with patch.object(panel, "raise_", wraps=panel.raise_) as raise_call:
                ball._apply_ask_payload({"ok": True, "resume": [entry]})
                app.processEvents()
                first_count = raise_call.call_count
                self.assertGreater(first_count, 0)
                ball._apply_ask_payload({"ok": True, "resume": [entry]})
                app.processEvents()
                self.assertEqual(raise_call.call_count, first_count)
                ball._apply_ask_payload({
                    "ok": True,
                    "resume": [self._resume_entry(resumeId="resume_test2")],
                })
                app.processEvents()
                self.assertEqual(raise_call.call_count, first_count + 1)
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_ask_restores_topmost_after_resume_mode(self):
        app, ball, panel = self._make_panel()
        flag = Qt.WindowType.WindowStaysOnTopHint
        try:
            panel.show_resume(self._resume_entry())
            self.assertFalse(bool(panel.windowFlags() & flag))
            panel.show_ask({
                "askId": "ask-after-resume",
                "question": "继续吗？",
                "options": [{"label": "继续"}],
                "ts": 2,
            })
            app.processEvents()
            self.assertTrue(bool(panel.windowFlags() & flag))
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_show_resume_renders_card_and_head(self):
        app, ball, panel = self._make_panel()
        try:
            panel.show_resume(self._resume_entry())
            self.assertTrue(panel.is_resume_open())
            self.assertFalse(panel.resume_body.isHidden())
            self.assertIn("窗口断联了", panel.lbl_head.text())
            self.assertIn("插件闲聊", panel.lbl_resume_from.text())
            self.assertIn("小花", panel.lbl_resume_from.text())
            self.assertEqual(panel.lbl_resume_reason.text(), "网络连接断了")
            self.assertTrue(panel.btn_resume_continue.isEnabled())
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_no_title_falls_back_to_agent(self):
        app, ball, panel = self._make_panel()
        try:
            panel.show_resume(self._resume_entry(sessionTitle="", agentName="备用助手"))
            self.assertIn("备用助手", panel.lbl_resume_from.text())
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_set_resume_auto_state_syncs_button(self):
        app, ball, panel = self._make_panel()
        try:
            panel.set_resume_auto_state(True)
            self.assertTrue(panel.btn_resume_auto.isChecked())
            self.assertIn("开", panel.btn_resume_auto.text())
            panel.set_resume_auto_state(False)
            self.assertFalse(panel.btn_resume_auto.isChecked())
            self.assertIn("关", panel.btn_resume_auto.text())
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_continue_success_finishes_card(self):
        app, ball, panel = self._make_panel()
        try:
            panel.show_resume(self._resume_entry())
            panel._apply_resume_continue_result({"ok": True})
            self.assertTrue(panel._resume_finished)
            # 650ms 后自动收起
            wait_loop = QEventLoop()
            zhujian.QTimer.singleShot(750, wait_loop.quit)
            wait_loop.exec()
            self.assertTrue(panel.resume_body.isHidden())
            self.assertEqual(panel.lbl_head.text(), "解语花")
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_continue_failure_restores_button(self):
        app, ball, panel = self._make_panel()
        try:
            panel.show_resume(self._resume_entry())
            panel._apply_resume_continue_result({"ok": False, "error": "发送失败"})
            self.assertFalse(panel._resume_finished)
            self.assertTrue(panel.btn_resume_continue.isEnabled())
            self.assertEqual(panel.btn_resume_continue.text(), "继续")
            self.assertIn("发送失败", panel.lbl_resume_reason.text())
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_finish_resume_restores_normal_layout(self):
        app, ball, panel = self._make_panel()
        try:
            panel.show_resume(self._resume_entry())
            panel.finish_resume_and_collapse()
            self.assertFalse(panel.is_resume_open())
            self.assertTrue(panel.resume_body.isHidden())
            self.assertEqual(panel.lbl_head.text(), "解语花")
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_ask_priority_blocks_resume(self):
        app, ball, panel = self._make_panel()
        try:
            ask = {
                "askId": "ask_test1",
                "question": "选哪个？",
                "options": [{"label": "甲"}, {"label": "乙"}],
                "selectionMode": "single",
                "ts": 2,
            }
            panel.show_ask(ask)
            panel.show_resume(self._resume_entry())
            self.assertIsNone(panel._resume_entry, "提问优先：断联卡不应弹出")
            self.assertTrue(panel.is_ask_open())
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_resume_replaces_older_resume(self):
        app, ball, panel = self._make_panel()
        try:
            panel.show_resume(self._resume_entry())
            panel.show_resume(self._resume_entry(resumeId="resume_test2", sessionTitle="另一个窗口"))
            self.assertEqual(panel._resume_entry.get("resumeId"), "resume_test2")
            self.assertIn("另一个窗口", panel.lbl_resume_from.text())
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_close_menu_marks_resume_hidden(self):
        app, ball, panel = self._make_panel()
        try:
            panel.show_resume(self._resume_entry())
            panel.close_menu()
            self.assertTrue(panel._resume_user_hidden, "收起断联卡后轮询不应再打回")
            # 手动重开后仍可从面板再看一次（_resume_entry 保留）
            self.assertTrue(panel.is_resume_open())
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_show_resume_notice_shows_and_hides(self):
        app, ball, panel = self._make_panel()
        try:
            panel.show_resume_notice({"agentName": "小花", "title": "插件闲聊", "ts": 1})
            self.assertFalse(panel.lbl_resume_notice.isHidden())
            self.assertIn("插件闲聊", panel.lbl_resume_notice.text())
            wait_loop = QEventLoop()
            zhujian.QTimer.singleShot(4300, wait_loop.quit)
            wait_loop.exec()
            self.assertTrue(panel.lbl_resume_notice.isHidden())
        finally:
            panel.close()
            ball.close()
            app.processEvents()


if __name__ == "__main__":
    unittest.main()