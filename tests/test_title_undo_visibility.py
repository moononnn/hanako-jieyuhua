import unittest

from _zhujian_test_support import QtTestCase, zhujian


class TitleUndoVisibilityTests(QtTestCase):
    def _make_panel(self):
        app = zhujian.QApplication.instance() or zhujian.QApplication([])
        ball = zhujian.ZhujianBall()
        panel = zhujian.ZhujianMenu(ball)
        panel._sync_target_state = lambda: None
        panel.show()
        app.processEvents()
        return app, ball, panel

    def test_undo_only_appears_after_new_title_and_hides_after_restore(self):
        app, ball, panel = self._make_panel()
        try:
            self.assertTrue(panel.btn_undo.isHidden())

            panel._apply_target_state({
                "seq": panel._target_seq,
                "target": None,
                "mode": "auto",
                "pinned": None,
                "undoAvailable": False,
            })
            self.assertTrue(panel.btn_undo.isHidden())

            panel._apply_rename_result({"ok": True, "title": "新的标题"})
            app.processEvents()
            self.assertFalse(panel.btn_undo.isHidden())
            self.assertTrue(panel.btn_undo.isEnabled())

            panel._apply_undo_result({"ok": True, "restoredTitle": "旧标题"})
            app.processEvents()
            self.assertTrue(panel.btn_undo.isHidden())
        finally:
            panel.close()
            ball.close()
            app.processEvents()

    def test_failed_title_generation_does_not_reveal_undo(self):
        app, ball, panel = self._make_panel()
        try:
            panel._apply_rename_result({"ok": False, "error": "生成失败"})
            self.assertTrue(panel.btn_undo.isHidden())
        finally:
            panel.close()
            ball.close()
            app.processEvents()


if __name__ == "__main__":
    unittest.main()
