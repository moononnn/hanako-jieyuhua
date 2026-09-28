# 解语花 — 润色提示词弹窗 PolishPanel 无头测试（QT_QPA_PLATFORM=offscreen）
# 覆盖：构造默认、两档切换、旧档位回退、空输入拦截、润色成功回填、润色失败提示、
#       发送成功自动收起、发送失败保留内容、旧回包丢弃、主面板收起连带关闭、二级窗定位在面板旁。

import time
import unittest
from types import SimpleNamespace

from PyQt6.QtCore import Qt
from PyQt6.QtTest import QTest

from _zhujian_test_support import QtTestCase, zhujian

_APP = zhujian.QApplication.instance() or zhujian.QApplication([])


def make_app():
    return zhujian.QApplication.instance() or zhujian.QApplication([])


class FakeBall:
    """PolishPanel 依赖的最小 ball 替身。"""

    def __init__(self):
        self.theme_mode = "light"
        self.target_name = ""
        self.target_title = ""
        self.state = {"panel_side": "left"}
        self.target_mode = "auto"
        self.pinned_target = None
        self.polish_panel = None
        self.context_menu = None
        self.ask_flower_dialog = None
        self.read_panel = None
        self.menu = None

    def screen(self):
        return None

    def x(self):
        return 0

    def y(self):
        return 0

    def width(self):
        return 64

    def height(self):
        return 64

    def pos(self):
        from PyQt6.QtCore import QPoint
        return QPoint(0, 0)

    def _reset_drag_motion(self):
        pass

    def _record_drag_motion(self):
        pass

    def _release_drag_motion(self):
        pass

    def _save_pos(self):
        pass

    def _set_fusion_panel_state(self, state):
        pass

    def move(self, *args):
        pass


def make_panel(**ball_kwargs):
    make_app()
    ball = FakeBall()
    for k, v in ball_kwargs.items():
        setattr(ball, k, v)
    panel = zhujian.PolishPanel(ball)
    ball.polish_panel = panel
    return ball, panel


def pump(app, seconds=0.05):
    """跑事件循环让 worker 线程的 signal 回到主线程。"""
    end = time.time() + seconds
    while time.time() < end:
        app.processEvents()
        time.sleep(0.005)


class PolishPanelTests(QtTestCase):
    def test_corner_close_button_present(self):
        """二级窗右上角统一有 ✕，不能指望用户猜“点悬浮球才能关”。"""
        _ball, p = make_panel()
        closers = [b for b in p.findChildren(zhujian.QPushButton) if b.text() == "✕"]
        self.assertEqual(len(closers), 1, "捋一捋窗右上角要有一个 ✕")
        self.assertIs(closers[0], p.btn_close)
        p.close()

    def test_construct_defaults(self):
        ball, p = make_panel()
        self.assertIn("帮我捋捋", p.lbl_head.text())
        self.assertIn("原意不乱", p.lbl_desc.text())
        self.assertEqual(p._level, "standard")
        # 默认标准档选中
        active = [b.property("level") for b in p.level_btns if b.property("active") == "true"]
        self.assertEqual(active, ["standard"])
        # 初始两个动作按钮可用，状态行隐藏
        self.assertTrue(p.btn_polish.isEnabled())
        self.assertTrue(p.btn_send.isEnabled())
        self.assertFalse(p.lbl_status.isVisible())
        self.assertEqual(p.polish_text(), "")
        p.close()

    def test_level_buttons_switch_and_keep_single_active(self):
        ball, p = make_panel()
        p._pick_level("light")  # 旧档位不再提供，安全回退标准
        self.assertEqual(p._level, "standard")
        active = [b.property("level") for b in p.level_btns if b.property("active") == "true"]
        self.assertEqual(active, ["standard"])
        p._pick_level("deep")
        self.assertEqual(p._level, "deep")
        active = [b.property("level") for b in p.level_btns if b.property("active") == "true"]
        self.assertEqual(active, ["deep"])
        p._pick_level("bogus")  # 非法档位回退标准
        self.assertEqual(p._level, "standard")
        p.close()

    def test_polish_with_empty_input_blocks_and_hints(self):
        ball, p = make_panel()
        p.polish_async()
        self.assertFalse(p._polishing)
        self.assertIn("先写点什么", p.lbl_status.text())
        self.assertTrue(p.btn_polish.isEnabled())
        p.close()

    def test_polish_success_fills_input_with_result(self):
        app = make_app()
        ball, p = make_panel()
        original_api_post = zhujian.api_post

        def fake_post(path, payload, timeout=12):
            self.assertEqual(path, "/polish")
            self.assertEqual(payload["level"], "standard")
            self.assertIn("帮我看看", payload["text"])
            return {"ok": True, "text": "帮我看下这段文案，读着顺不顺，给三个修改方向", "level": "standard"}

        try:
            zhujian.api_post = fake_post
            p.input.setPlainText("帮我看看这段咋样")
            p.polish_async()
            self.assertTrue(p._polishing)
            pump(app, 0.3)
            self.assertFalse(p._polishing)
            self.assertEqual(p.polish_text(), "帮我看下这段文案，读着顺不顺，给三个修改方向")
            self.assertIn("捋好了", p.lbl_status.text())
            self.assertTrue(p.btn_polish.isEnabled())
            self.assertTrue(p.btn_send.isEnabled())
        finally:
            zhujian.api_post = original_api_post
            p.close()

    def test_polish_failure_shows_error_and_keeps_input(self):
        app = make_app()
        ball, p = make_panel()
        original_api_post = zhujian.api_post
        try:
            zhujian.api_post = lambda path, payload, **kw: {"ok": False, "error": "模型配置不完整"}
            p.input.setPlainText("帮我看看这段")
            p.polish_async()
            pump(app, 0.3)
            self.assertFalse(p._polishing)
            self.assertIn("模型配置不完整", p.lbl_status.text())
            self.assertEqual(p.polish_text(), "帮我看看这段")  # 原内容保留
        finally:
            zhujian.api_post = original_api_post
            p.close()

    def test_stale_polish_result_is_ignored_after_new_request(self):
        ball, p = make_panel()
        p.input.setPlainText("新内容")
        p._request_seq = 2
        p._apply_polish_result({"seq": 1, "ok": True, "text": "旧结果"})
        self.assertEqual(p.polish_text(), "新内容")
        self.assertFalse(p._polishing)
        p.close()

    def test_send_with_empty_input_blocks(self):
        ball, p = make_panel()
        p.send_async()
        self.assertFalse(p._sending)
        self.assertIn("没有可发送", p.lbl_status.text())
        p.close()

    def test_send_success_closes_panel_and_clears(self):
        app = make_app()
        ball, p = make_panel()
        original_api_post = zhujian.api_post
        try:
            zhujian.api_post = lambda path, payload, **kw: (
                self.assertEqual(path, "/polish/send"),
                {"ok": True, "sessionPath": "C:/target.jsonl"},
            )[-1]
            p.input.setPlainText("帮我看下这段文案顺不顺")
            p._level = "deep"
            p.show()
            app.processEvents()
            p.send_async()
            pump(app, 0.3)
            # 发送成功 → 450ms 后收起
            pump(app, 0.6)
            self.assertFalse(p.isVisible())
            self.assertEqual(p.polish_text(), "")          # 内容已清
            self.assertEqual(p._level, "standard")          # 档位复位
        finally:
            zhujian.api_post = original_api_post
            p.close()

    def test_send_failure_keeps_panel_and_content(self):
        app = make_app()
        ball, p = make_panel()
        original_api_post = zhujian.api_post
        try:
            zhujian.api_post = lambda path, payload, **kw: {"ok": False, "error": "找不到要发送的对话"}
            p.input.setPlainText("帮我看下这段文案顺不顺")
            p.show()
            app.processEvents()
            p.send_async()
            pump(app, 0.3)
            self.assertFalse(p._sending)
            self.assertTrue(p.isVisible())  # 面板还在
            self.assertEqual(p.polish_text(), "帮我看下这段文案顺不顺")  # 内容保留可重试
            self.assertIn("找不到要发送的对话", p.lbl_status.text())
        finally:
            zhujian.api_post = original_api_post
            p.close()

    def test_target_selector_ui_present_and_defaults_follow(self):
        """润色窗有「发送到」目标选择区：默认跟随最近，显示目标按钮/信息。"""
        app = make_app()
        ball, p = make_panel()
        try:
            # 发送到区域存在
            self.assertTrue(hasattr(p, "btn_target"))
            self.assertTrue(hasattr(p, "lbl_target_info"))
            self.assertTrue(hasattr(p, "target_menu"))
            self.assertIn("跟随最近", p.btn_target.text())
            # 默认目标选择器收起
            self.assertFalse(p.target_menu.isVisible())
            # 有固定目标时按钮显示「固定」
            ball.target_mode = "pinned"
            ball.pinned_target = {"title": "角色设定讨论", "sessionPath": "C:/a.jsonl"}
            ball.target_title = "角色设定讨论"
            p._update_target()
            self.assertIn("固定", p.btn_target.text())
            self.assertIn("角色设定讨论", p.lbl_target_info.text())
        finally:
            p.close()

    def test_target_selector_toggle_shows_menu(self):
        """点「发送到」→ 目标选择菜单展开；再点收起。"""
        app = make_app()
        ball, p = make_panel()
        try:
            p.show()
            app.processEvents()
            self.assertFalse(p.target_menu.isVisible())
            p._open_target_menu()
            pump(app, 0.3)  # 等 refresh_sessions_async 的线程回包（失败也无妨，只验证展开）
            self.assertTrue(p.target_menu.isVisible())
            p._open_target_menu()
            app.processEvents()
            self.assertFalse(p.target_menu.isVisible())
        finally:
            p.close()

    def test_open_polish_panel_replaces_menu_and_toggle_closes(self):
        """跟朗读同款：点「捋一捋」→ 主面板让位，只留帮我捋捋弹窗；再点球收起。"""
        app = make_app()
        ball = zhujian.ZhujianBall()
        ball.move(200, 300)
        ball.show()
        app.processEvents()
        ball._open_menu()
        app.processEvents()
        menu = ball.menu
        # 工具卡存在
        self.assertTrue(hasattr(menu, "polish_tool"))
        self.assertEqual(menu.btn_polish.text(), "捋一捋")
        # 点「捋一捋」→ 主面板让位，帮我捋捋窗口独立展示
        menu._open_polish_panel()
        app.processEvents()
        self.assertIsNotNone(ball.polish_panel)
        self.assertTrue(ball.polish_panel.isVisible())
        self.assertFalse(menu.isVisible())  # 主面板已让位，不并存
        # 点球 → 收起帮我捋捋窗口（不展开主面板，跟朗读同款）
        ball._toggle_expand()
        app.processEvents()
        self.assertFalse(ball.polish_panel.isVisible())
        ball.polish_panel.close()
        ball.close()
        app.processEvents()

    def test_reopen_polish_from_menu_reuses_instance(self):
        """再开一次复用同一实例（跟朗读 reopen 同款）。"""
        app = make_app()
        ball = zhujian.ZhujianBall()
        ball.show()
        app.processEvents()
        ball._open_menu()
        app.processEvents()
        menu = ball.menu
        menu._open_polish_panel()
        app.processEvents()
        first = ball.polish_panel
        self.assertTrue(first.isVisible())
        # 收掉后从主面板再开，复用同一实例
        first.close()
        app.processEvents()
        ball._open_menu()
        app.processEvents()
        ball.menu._open_polish_panel()
        app.processEvents()
        self.assertIs(ball.polish_panel, first)
        self.assertFalse(ball.polish_panel._closed)
        self.assertTrue(ball.polish_panel.isVisible())
        ball.polish_panel.close()
        ball.close()
        app.processEvents()

    def test_menu_close_collapses_polish_panel_too(self):
        app = make_app()
        ball = zhujian.ZhujianBall()
        ball.show()
        app.processEvents()
        ball._open_menu()
        app.processEvents()
        menu = ball.menu
        menu._open_polish_panel()
        app.processEvents()
        self.assertTrue(ball.polish_panel.isVisible())
        # 主面板已经让位；重新开主面板会先收起润色窗
        ball._open_menu()
        app.processEvents()
        self.assertFalse(ball.polish_panel.isVisible())
        self.assertTrue(menu.isVisible())
        ball.close()
        app.processEvents()

    def test_ask_mode_hides_polish_tool_card(self):
        app = make_app()
        ball = zhujian.ZhujianBall()
        ball.show()
        app.processEvents()
        ball._open_menu()
        app.processEvents()
        menu = ball.menu
        menu._set_ask_mode(True)
        self.assertFalse(menu.polish_tool.isVisible())
        menu._set_ask_mode(False)
        app.processEvents()
        self.assertTrue(menu.polish_tool.isVisible())
        menu.close_menu()
        ball.close()
        app.processEvents()


if __name__ == "__main__":
    unittest.main()
