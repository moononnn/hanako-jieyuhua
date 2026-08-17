import importlib.util
import os
import pathlib
import unittest

from PyQt6.QtCore import QEvent, QPointF, Qt
from PyQt6.QtGui import QMouseEvent

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
MODULE_PATH = pathlib.Path(__file__).parents[1] / "python" / "zhujian_app.py"
SPEC = importlib.util.spec_from_file_location("zhujian_app", MODULE_PATH)
zhujian = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(zhujian)


def mouse_press(global_pos, button):
    return QMouseEvent(
        QEvent.Type.MouseButtonPress,
        QPointF(0, 0),
        QPointF(*global_pos),
        button,
        button,
        Qt.KeyboardModifier.NoModifier,
    )


class RightClickToggleTests(unittest.TestCase):
    def _ball(self):
        app = zhujian.QApplication.instance() or zhujian.QApplication([])
        ball = zhujian.ZhujianBall()
        ball.move(200, 200)
        ball.show()
        app.processEvents()
        return app, ball

    def test_first_right_click_opens_second_closes(self):
        # 单击右键展开，再次右键收起（与左键 toggle 一致）
        app, ball = self._ball()
        pos = (250, 250)
        ball._toggle_context_menu(pos)
        app.processEvents()
        self.assertIsNotNone(ball.context_menu)
        self.assertTrue(ball.context_menu.isVisible())
        ball._toggle_context_menu(pos)
        app.processEvents()
        self.assertFalse(ball.context_menu.isVisible())
        ball.close()
        app.processEvents()

    def test_open_context_menu_dismisses_left_panel(self):
        # 互斥：开右键浮签前先收左键面板
        app, ball = self._ball()
        ball._open_menu()
        app.processEvents()
        self.assertTrue(ball.menu.isVisible())
        ball._open_context_menu((250, 250))
        app.processEvents()
        self.assertFalse(ball.menu.isVisible())
        self.assertTrue(ball.context_menu.isVisible())
        ball.close()
        app.processEvents()

    def test_outside_click_dismisses_context_menu(self):
        # 点空白/别的窗口 → 右键浮签关闭（Popup 改 Tool 后的接管行为）
        app, ball = self._ball()
        ball._open_context_menu((250, 250))
        app.processEvents()
        self.assertTrue(ball.context_menu.isVisible())
        # 点击浮签外（比如屏幕另一处）→ 关闭
        ball.eventFilter(None, mouse_press((1000, 800), Qt.MouseButton.LeftButton))
        self.assertFalse(ball.context_menu.isVisible())
        ball.close()
        app.processEvents()

    def test_click_inside_context_menu_keeps_it_open(self):
        app, ball = self._ball()
        ball._open_context_menu((250, 250))
        app.processEvents()
        menu = ball.context_menu
        inside = (menu.x() + menu.width() // 2, menu.y() + menu.height() // 2)
        ball.eventFilter(None, mouse_press(inside, Qt.MouseButton.LeftButton))
        self.assertTrue(menu.isVisible())
        ball.close()
        app.processEvents()

    def test_right_click_on_ball_keeps_menu_for_toggle(self):
        # 右键点在花朵上：filter 放行，交给花朵的 toggle 决定关/开
        app, ball = self._ball()
        ball._open_context_menu((250, 250))
        app.processEvents()
        menu = ball.context_menu
        ball_center = (ball.x() + ball.width() // 2, ball.y() + ball.height() // 2)
        ball.eventFilter(None, mouse_press(ball_center, Qt.MouseButton.RightButton))
        self.assertTrue(menu.isVisible())
        # 随后花朵的 toggle 关闭它
        ball._toggle_context_menu(ball_center)
        self.assertFalse(menu.isVisible())
        ball.close()
        app.processEvents()

    def test_ask_popup_dismisses_context_menu(self):
        # ask 自动弹面板前也收右键浮签（互斥补口）
        app, ball = self._ball()
        ball._open_context_menu((250, 250))
        app.processEvents()
        ball._apply_ask_payload({"ok": True, "pending": []})
        app.processEvents()
        ask = {
            "askId": "ask-mutex",
            "question": "互斥测试",
            "options": [{"label": "甲"}, {"label": "乙"}],
            "ts": 1,
        }
        ball._apply_ask_payload({"ok": True, "pending": [ask]})
        app.processEvents()
        self.assertFalse(ball.context_menu.isVisible())
        ball.close()
        app.processEvents()


if __name__ == "__main__":
    unittest.main()