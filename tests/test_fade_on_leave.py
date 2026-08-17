import importlib.util
import os
import pathlib
import unittest

from PyQt6.QtCore import QAbstractAnimation

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
MODULE_PATH = pathlib.Path(__file__).parents[1] / "python" / "zhujian_app.py"
SPEC = importlib.util.spec_from_file_location("zhujian_app", MODULE_PATH)
zhujian = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(zhujian)


class FadeHost(zhujian.FadeOnLeaveMixin, zhujian.QFrame):
    """测试宿主：仅挂 fade mixin，不带业务 UI。"""


class FadeOnLeaveTests(unittest.TestCase):
    def _make(self, cursor_inside):
        app = zhujian.QApplication.instance() or zhujian.QApplication([])
        host = FadeHost()
        host.setup_fade_on_leave()
        host._cursor_inside = lambda: cursor_inside
        return app, host

    def test_show_with_cursor_outside_schedules_fade_then_enter_cancels(self):
        # 光标不在窗内：show 要给缓冲期后排期淡出；鼠标一进来就取消淡出
        app, host = self._make(cursor_inside=False)
        host._reset_fade_on_show()
        self.assertTrue(host._fade_out_timer.isActive())
        host._on_fade_enter()
        self.assertFalse(host._fade_out_timer.isActive())
        self.assertEqual(host.windowOpacity(), 1.0)
        host.close()
        app.processEvents()

    def test_show_with_cursor_inside_does_not_schedule(self):
        app, host = self._make(cursor_inside=True)
        host._reset_fade_on_show()
        self.assertFalse(host._fade_out_timer.isActive())
        host.close()
        app.processEvents()

    def test_leave_schedules_and_fade_reaches_floor(self):
        # 鼠标离开 → 宽限后淡出；动画强制走完必须到半透明下限
        app, host = self._make(cursor_inside=False)
        host._on_fade_leave()
        self.assertTrue(host._fade_out_timer.isActive())
        host._begin_fade_out()
        self.assertEqual(host._fade_anim.state(), QAbstractAnimation.State.Running)
        self.assertEqual(host._fade_anim.endValue(), zhujian.FADE_OUT_OPACITY)
        host._fade_anim.setCurrentTime(host._fade_anim.duration())
        self.assertAlmostEqual(host.windowOpacity(), zhujian.FADE_OUT_OPACITY)
        host.close()
        app.processEvents()

    def test_enter_restores_full_opacity_fast(self):
        app, host = self._make(cursor_inside=False)
        host.setWindowOpacity(zhujian.FADE_OUT_OPACITY)
        host._on_fade_enter()
        self.assertEqual(host._fade_anim.endValue(), 1.0)
        host._fade_anim.setCurrentTime(host._fade_anim.duration())
        self.assertEqual(host.windowOpacity(), 1.0)
        host.close()
        app.processEvents()

    def test_fade_grace_survives_reopen_after_hide(self):
        # 关闭后：timer 与动画都被清理，重开不会带着旧排期
        app, host = self._make(cursor_inside=False)
        host._on_fade_leave()
        host._cancel_fade()
        self.assertFalse(host._fade_out_timer.isActive())
        self.assertEqual(host._fade_anim.state(), QAbstractAnimation.State.Stopped)
        host.close()
        app.processEvents()

    def test_ask_mode_stays_solid(self):
        # 提问态：leave 不排期、show 不排期、进入时拉回实体（推荐态则照常淡出）
        app = zhujian.QApplication.instance() or zhujian.QApplication([])
        ball = zhujian.ZhujianBall()
        menu = zhujian.ZhujianMenu(ball)
        ask = {
            "askId": "ask-solid",
            "question": "保持实体吗",
            "options": [{"label": "保持"}, {"label": "淡出"}],
            "ts": 1,
        }
        # 先进入提问态
        menu.show_ask(ask)
        app.processEvents()
        self.assertTrue(menu.is_ask_open())
        # 模拟鼠标离开 → 不得排期淡出
        menu._on_fade_leave()
        self.assertFalse(menu._fade_out_timer.isActive())
        # 模拟光标在窗外重新 show → 不得排期
        menu.setWindowOpacity(0.6)
        menu._cursor_inside = lambda: False
        menu._reset_fade_on_show()
        self.assertEqual(menu.windowOpacity(), 1.0)
        self.assertFalse(menu._fade_out_timer.isActive())
        # 淡出到 0.6 后进入提问态 → 立即拉回实体
        menu._begin_fade_out()
        menu._fade_anim.setCurrentTime(menu._fade_anim.duration())
        app.processEvents()
        self.assertLess(menu.windowOpacity(), 1.0)
        ask2 = {"askId": "ask-solid-2", "question": "第二题", "options": [{"label": "甲"}], "ts": 2}
        menu.show_ask(ask2)
        app.processEvents()
        self.assertEqual(menu.windowOpacity(), 1.0)
        self.assertFalse(menu._fade_out_timer.isActive())
        # 退出提问态恢复推荐 → fade 恢复正常
        menu._ask_responding = True
        menu._ask_finished = True
        menu.restore_recommendations("ask-solid-2")
        app.processEvents()
        self.assertFalse(menu.is_ask_open())
        menu._on_fade_leave()
        self.assertTrue(menu._fade_out_timer.isActive())
        menu.close()
        ball.close()
        app.processEvents()

    def test_real_windows_have_fade_installed(self):
        # 左键面板与右键浮签都挂上了 fade 机制
        app = zhujian.QApplication.instance() or zhujian.QApplication([])
        ball = zhujian.ZhujianBall()
        menu = zhujian.ZhujianMenu(ball)
        ctx = zhujian.SendModeMenu(ball)
        self.assertIsNotNone(menu._fade_out_timer)
        self.assertIsNotNone(menu._fade_anim)
        self.assertIsNotNone(ctx._fade_out_timer)
        self.assertIsNotNone(ctx._fade_anim)
        self.assertTrue(menu._fade_out_timer.isSingleShot())
        self.assertTrue(ctx._fade_out_timer.isSingleShot())
        ctx.close()
        menu.close()
        ball.close()
        app.processEvents()


if __name__ == "__main__":
    unittest.main()