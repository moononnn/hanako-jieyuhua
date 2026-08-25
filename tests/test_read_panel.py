# 解语花 — 朗读专属弹窗 ReadPanel 无头测试（QT_QPA_PLATFORM=offscreen）
# 覆盖：ReadPanel 构造/命名/播放三态/重听/刷新回复/收藏/错误复位/收起停读，
#       念给我听只加载回复选择、不自动合成，以及主面板朗读工具说明跟随目标 + 推荐面板让位。

import threading
import time
import unittest
from types import SimpleNamespace

from PyQt6.QtCore import QEvent, QPointF, Qt
from PyQt6.QtGui import QMouseEvent

from _zhujian_test_support import QtTestCase, zhujian

# 模块级持有 QApplication：make_panel 里创建的 app 若没被引用，会被 GC 回收，
# Qt 随即销毁所有顶层 widget（已实测：ReadPanel C++ 对象被删 / 0xC0000409）
_APP = zhujian.QApplication.instance() or zhujian.QApplication([])


def make_app():
    return zhujian.QApplication.instance() or zhujian.QApplication([])


class FakePlayer:
    """替身播放器：避免真实 QtMultimedia 出声，只记录状态转移。"""

    def __init__(self):
        self.state = "stopped"
        self.source = None
        self.calls = []

    def playbackState(self):
        s = zhujian.QMediaPlayer.PlaybackState
        return {"stopped": s.StoppedState, "playing": s.PlayingState, "paused": s.PausedState}[self.state]

    def setSource(self, url):
        self.source = url.toString()

    def play(self):
        self.state = "playing"
        self.calls.append("play")

    def pause(self):
        self.state = "paused"
        self.calls.append("pause")

    def stop(self):
        self.state = "stopped"
        self.calls.append("stop")

    def setPosition(self, pos):
        self.calls.append(("setPosition", pos))


def make_panel():
    make_app()
    ball = SimpleNamespace(
        theme_mode="light",
        target_mode="auto",
        pinned_target=None,
        target_name="",
        target_title="",
        screen=lambda: None,
        x=lambda: 0,
        y=lambda: 0,
        width=lambda: 64,
        height=lambda: 64,
        _set_fusion_panel_state=lambda state: None,
    )
    return zhujian.ReadPanel(ball)


def fake_audio_b64():
    import base64
    return base64.b64encode(b"fake-mp3-bytes").decode()


class ReadPanelTests(QtTestCase):
    def test_construct_defaults(self):
        rp = make_panel()
        self.assertIn("助手", rp.lbl_head.text())
        self.assertFalse(rp.btn_sub_fav.isEnabled())
        self.assertFalse(rp.btn_replay.isEnabled())
        self.assertEqual(rp.btn_play.text(), "🔊 朗读")
        self.assertIn("自动判断", rp.btn_target.text())
        self.assertIn("最新回复", rp.btn_reply.text())
        self.assertEqual(rp.btn_refresh_replies.text(), "↻ 刷新")
        self.assertFalse(hasattr(rp, "btn_sub_new"))
        rp.close()

    def test_open_for_updates_name_and_waits_for_manual_read(self):
        app = make_app()
        rp = make_panel()
        refresh_calls = []
        rp.refresh_replies_async = lambda auto_read=False: refresh_calls.append(auto_read)
        rp.open_for("阿雪", start=False)
        self.assertIn("阿雪", rp.lbl_head.text())
        self.assertTrue(rp.isVisible())
        self.assertEqual(refresh_calls, [False])
        self.assertFalse(rp._auto_read_pending)
        rp.close()
        app.processEvents()

    def test_loaded_replies_do_not_start_read_without_manual_play(self):
        rp = make_panel()
        rp._replies_seq = 1
        rp._auto_read_pending = False
        read_calls = []
        rp.read_async = lambda: read_calls.append(True)
        rp._apply_replies({
            "seq": 1,
            "ok": True,
            "sessionPath": "C:/conversation.jsonl",
            "target": {"name": "小花", "title": "当前对话"},
            "replies": [{"index": 0, "preview": "最新回复"}],
        })
        self.assertEqual(read_calls, [])
        self.assertEqual(len(rp._replies), 1)
        self.assertEqual(rp._read_session_path, "C:/conversation.jsonl")
        rp.close()

    def test_reply_selector_defaults_latest_and_can_pick_previous_five(self):
        rp = make_panel()
        rp._replies_seq = 1
        rp._apply_replies({
            "seq": 1,
            "ok": True,
            "mode": "auto",
            "pinned": None,
            "target": {"name": "小花", "title": "正在改插件"},
            "replies": [
                {"index": 0, "preview": "最新回复"},
                {"index": 1, "preview": "前一条回复"},
                {"index": 2, "preview": "前两条回复"},
                {"index": 3, "preview": "前三条回复"},
                {"index": 4, "preview": "前四条回复"},
                {"index": 5, "preview": "前五条回复"},
            ],
        })
        self.assertEqual(rp._reply_index, 0)
        self.assertIn("最新回复", rp.btn_reply.text())
        self.assertEqual(rp.reply_list_box.count(), 7)  # 6 条 + stretch
        rp._set_reply_selector_visible(True)
        rp._pick_reply(5)
        self.assertEqual(rp._reply_index, 5)
        self.assertIn("前 5 条回复", rp.btn_reply.text())
        self.assertFalse(rp.reply_menu.isVisible())
        rp.close()

    def test_stale_read_result_is_ignored_after_selection_changes(self):
        rp = make_panel()
        rp._read_seq = 2
        rp._apply_read_result({
            "readSeq": 1,
            "ok": True,
            "audio": fake_audio_b64(),
            "format": "mp3",
            "text": "旧回复",
        })
        self.assertIsNone(rp._last_read)
        rp.close()

    def test_fixed_target_success_refreshes_read_options(self):
        rp = make_panel()
        calls = []
        original_api_post = zhujian.api_post
        original_hook = rp._on_target_changed
        try:
            zhujian.api_post = lambda *args, **kwargs: {"ok": True}
            rp._on_target_changed = lambda: calls.append(True)
            rp.target_menu._pick({
                "agentId": "hanako",
                "agentName": "小花",
                "title": "目标窗口",
                "sessionPath": "C:/target.jsonl",
            })
        finally:
            zhujian.api_post = original_api_post
            rp._on_target_changed = original_hook
        self.assertEqual(calls, [True])
        self.assertEqual(rp.ball.target_mode, "pinned")
        self.assertEqual(rp.ball.pinned_target["sessionPath"], "C:/target.jsonl")
        rp.close()

    def test_toggle_play_play_pause_resume(self):
        rp = make_panel()
        rp._player = FakePlayer()
        rp._last_read = {"audio": fake_audio_b64(), "format": "mp3"}
        # 空闲且有已读内容 → 直接重播（不重新请求）
        rp.toggle_play()
        self.assertEqual(rp._player.state, "playing")
        self.assertTrue(rp.btn_replay.isEnabled())
        # 播放中 → 暂停
        rp.toggle_play()
        self.assertEqual(rp._player.state, "paused")
        self.assertIn("继续", rp.btn_play.text())
        # 暂停中 → 继续
        rp.toggle_play()
        self.assertEqual(rp._player.state, "playing")
        rp.close()

    def test_apply_read_result_success_shows_text_enables_fav(self):
        rp = make_panel()
        rp._player = FakePlayer()
        payload = {
            "ok": True,
            "audio": fake_audio_b64(),
            "format": "mp3",
            "text": "今天天气真好呀",
            "voiceId": "v1",
        }
        rp._apply_read_result(payload)
        self.assertEqual(rp._last_read["text"], "今天天气真好呀")
        self.assertIn("今天天气真好呀", rp.lbl_text.text())
        self.assertTrue(rp.btn_sub_fav.isEnabled())
        self.assertEqual(rp.btn_sub_fav.text(), "♡ 收藏")
        self.assertTrue(rp.btn_replay.isEnabled())
        rp.close()

    def test_refresh_replies_rejects_target_path_drift(self):
        app = make_app()
        rp = make_panel()
        rp._read_session_path = "C:/conversation.jsonl"
        original_api_get = zhujian.api_get
        try:
            zhujian.api_get = lambda *args, **kwargs: {
                "ok": True,
                "sessionPath": "C:/other.jsonl",
                "target": {"name": "小花", "title": "另一个对话"},
                "replies": [{"index": 0, "preview": "不该接收"}],
            }
            rp.refresh_replies_async(reset_read=True)
            for _ in range(20):
                app.processEvents()
                time.sleep(0.01)
            self.assertEqual(rp._replies, [])
            self.assertTrue(rp.btn_refresh_replies.isEnabled())
            self.assertIn("当前对话刚刚变化", rp.lbl_feedback.text())
            self.assertEqual(rp._read_session_path, "C:/conversation.jsonl")
        finally:
            zhujian.api_get = original_api_get
            rp.close()

    def test_refresh_failure_surfaces_feedback_when_reply_menu_is_closed(self):
        rp = make_panel()
        rp._replies_seq = 2
        rp._refresh_feedback_seq = 2
        rp._apply_replies({
            "seq": 2,
            "ok": False,
            "error": "读取失败，点「↻ 刷新」再试",
            "replies": [],
        })
        self.assertIn("↻ 刷新", rp.lbl_feedback.text())
        self.assertTrue(rp.btn_refresh_replies.isEnabled())
        rp.close()

    def test_favorite_success_is_idempotent_and_marks_button(self):
        rp = make_panel()
        rp._apply_fav_result({"ok": True, "already": True, "message": "这段已经收藏过了"})
        self.assertFalse(rp.btn_sub_fav.isEnabled())
        self.assertEqual(rp.btn_sub_fav.text(), "✓ 已收藏")
        self.assertIn("已经收藏", rp.lbl_feedback.text())
        rp._apply_fav_result({"ok": False, "error": "这段音频太大了"})
        self.assertTrue(rp.btn_sub_fav.isEnabled())
        self.assertEqual(rp.btn_sub_fav.text(), "♡ 收藏")
        self.assertIn("音频太大", rp.lbl_feedback.text())
        rp.close()

    def test_inflight_favorite_uses_snapshot_and_ignores_stale_result(self):
        rp = make_panel()
        started = threading.Event()
        release = threading.Event()
        completed = threading.Event()
        captured = {}
        original_api_post = zhujian.api_post
        try:
            zhujian.api_post = lambda path, payload, **kwargs: (
                captured.update(payload),
                started.set(),
                release.wait(1),
                completed.set(),
                {"ok": True, "message": "已收藏"},
            )[-1]
            rp._last_read = {"text": "旧回复", "audio": fake_audio_b64(), "format": "mp3"}
            rp.fav_read_async()
            self.assertTrue(started.wait(1))
            rp._clear_current_read()
            release.set()
            for _ in range(30):
                make_app().processEvents()
                time.sleep(0.01)
            self.assertTrue(completed.is_set())
            self.assertEqual(captured["text"], "旧回复")
            self.assertIsNone(rp._last_read)
            self.assertNotEqual(rp.btn_sub_fav.text(), "✓ 已收藏")
        finally:
            zhujian.api_post = original_api_post
            rp.close()

    def test_apply_read_result_failure_resets(self):
        rp = make_panel()
        rp._apply_read_result({"ok": False, "error": "语音朗读还没开"})
        self.assertFalse(rp._reading)
        self.assertIn("语音朗读还没开", rp.lbl_feedback.text())
        self.assertEqual(rp.btn_play.text(), "🔊 朗读")
        rp.close()

    def test_fav_without_last_read_asks_first(self):
        rp = make_panel()
        rp._last_read = None
        rp.fav_read_async()
        self.assertIn("先朗读一次", rp.lbl_feedback.text())
        rp.close()

    def test_replay_read_plays_from_start(self):
        rp = make_panel()
        rp._player = FakePlayer()
        rp._player.state = "paused"
        rp._media_path = "/tmp/fake.mp3"
        rp.replay_read()
        self.assertEqual(rp._player.state, "playing")
        self.assertIn(("setPosition", 0), rp._player.calls)
        rp.close()

    def test_hide_stops_reading_and_resets(self):
        app = make_app()
        rp = make_panel()
        rp._player = FakePlayer()
        rp._player.state = "playing"
        rp._reading = True
        rp.show()
        app.processEvents()
        rp.hide()
        app.processEvents()
        self.assertEqual(rp._player.state, "stopped")
        self.assertFalse(rp._reading)
        self.assertEqual(rp.btn_play.text(), "🔊 朗读")
        rp.close()
        app.processEvents()

    def test_refresh_replies_resets_selection_without_reading(self):
        app = make_app()
        rp = make_panel()
        rp._reply_index = 4
        rp._read_session_path = "C:/conversation.jsonl"
        rp._last_read = {"audio": fake_audio_b64(), "format": "mp3"}
        captured_route = {}
        original_api_get = zhujian.api_get
        try:
            zhujian.api_get = lambda route, **kwargs: (
                captured_route.update(route=route),
                {
                    "ok": True,
                "sessionPath": "C:/conversation.jsonl",
                "target": {"name": "小花", "title": "刷新后的对话"},
                    "replies": [{"index": 0, "preview": "新回复"}],
                }
            )[-1]
            rp.refresh_replies_async(reset_read=True)
            self.assertEqual(rp._reply_index, 0)
            self.assertIsNone(rp._last_read)
            self.assertFalse(rp.btn_refresh_replies.isEnabled())
            for _ in range(20):
                app.processEvents()
                time.sleep(0.01)
            self.assertIn("sessionPath=", captured_route["route"])
            self.assertTrue(rp.btn_refresh_replies.isEnabled())
            self.assertEqual(len(rp._replies), 1)
            self.assertEqual(rp._replies[0]["preview"], "新回复")
            self.assertIn("回复列表已更新", rp.lbl_feedback.text())
        finally:
            zhujian.api_get = original_api_get
            rp.close()


class ReadPanelPositionTests(QtTestCase):
    """定位与拖动要和推荐面板一致：贴球旁（默认左侧 8px）、拖动时花朵同步、拖过不再拽回。"""

    def _panel_on_ball(self, bx=200, by=300):
        app = make_app()
        ball = zhujian.ZhujianBall()
        ball.move(bx, by)
        ball.show()
        app.processEvents()
        rp = zhujian.ReadPanel(ball)
        ball.read_panel = rp
        rp.open_for("小花", start=False)
        app.processEvents()
        return app, ball, rp

    def test_move_to_ball_places_panel_left_of_ball_with_gap(self):
        app, ball, rp = self._panel_on_ball(bx=500, by=300)
        rp.move_to_ball()
        # 默认边向 left（左侧放得下）：面板贴着球左侧，间隔 8px
        self.assertEqual(ball.x() - (rp.x() + rp.width()), 8)
        rp.close()
        ball.close()
        app.processEvents()

    def test_move_to_ball_flips_left_when_ball_near_right_edge(self):
        # 800x800 离屏屏：球贴右缘（x=736）→ 面板翻到左边
        app, ball, rp = self._panel_on_ball(bx=736, by=300)
        rp.move_to_ball()
        self.assertLess(rp.x(), ball.x())
        self.assertEqual(ball.x() - (rp.x() + rp.width()), 8)
        rp.close()
        ball.close()
        app.processEvents()

    def test_drag_moves_ball_together(self):
        app, ball, rp = self._panel_on_ball(bx=300, by=400)
        before_ball = ball.pos()
        before_panel = rp.pos()
        press = QMouseEvent(
            QEvent.Type.MouseButtonPress, QPointF(10, 10), QPointF(before_panel.x() + 20, before_panel.y() + 20),
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
        )
        rp.mousePressEvent(press)
        move = QMouseEvent(
            QEvent.Type.MouseMove, QPointF(60, 55), QPointF(before_panel.x() + 20 + 50, before_panel.y() + 20 + 35),
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
        )
        rp.mouseMoveEvent(move)
        app.processEvents()
        self.assertTrue(rp._drag_moved)
        dp = rp.pos() - before_panel
        db = ball.pos() - before_ball
        self.assertGreater(dp.x(), 0)
        self.assertEqual(dp, db)  # 朗读窗与花朵以同一位移一起移动
        self.assertTrue(ball._drag_motion_active)
        self.assertGreater(ball._drag_velocity_x, 0.0)
        release = QMouseEvent(
            QEvent.Type.MouseButtonRelease, QPointF(60, 55), QPointF(before_panel.x() + 70, before_panel.y() + 55),
            Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier,
        )
        rp.mouseReleaseEvent(release)
        self.assertFalse(ball._drag_motion_active)
        rp.close()
        ball.close()
        app.processEvents()

    def test_keep_position_respects_user_drag(self):
        app, ball, rp = self._panel_on_ball(bx=300, by=400)
        rp._user_dragged = True
        p0 = rp.pos()
        rp._keep_position()
        app.processEvents()
        app.processEvents()
        # 用户拖过：内容变化后保持当前位置，不拽回球边
        self.assertEqual(rp.pos(), p0)
        rp.close()
        ball.close()
        app.processEvents()

    def test_ball_drag_moves_open_read_panel_together(self):
        app, ball, rp = self._panel_on_ball(bx=300, by=400)
        before_ball = ball.pos()
        before_panel = rp.pos()
        press = QMouseEvent(
            QEvent.Type.MouseButtonPress, QPointF(10, 10), QPointF(before_ball.x() + 20, before_ball.y() + 20),
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
        )
        ball.mousePressEvent(press)
        move = QMouseEvent(
            QEvent.Type.MouseMove, QPointF(60, 55), QPointF(before_ball.x() + 20 + 50, before_ball.y() + 20 + 35),
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
        )
        ball.mouseMoveEvent(move)
        app.processEvents()
        self.assertTrue(ball._moved)
        db = ball.pos() - before_ball
        dp = rp.pos() - before_panel
        self.assertEqual(dp, db)  # 单独拖花朵时，朗读窗也要跟着走
        rp.close()
        ball.close()
        app.processEvents()

    def test_ball_drag_preserves_manual_read_panel_offset(self):
        app, ball, rp = self._panel_on_ball(bx=300, by=400)
        rp.move(rp.pos() + zhujian.QPoint(70, -18))
        rp._user_dragged = True
        before_ball = ball.pos()
        before_panel = rp.pos()
        press = QMouseEvent(
            QEvent.Type.MouseButtonPress, QPointF(10, 10), QPointF(before_ball.x() + 20, before_ball.y() + 20),
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
        )
        ball.mousePressEvent(press)
        move = QMouseEvent(
            QEvent.Type.MouseMove, QPointF(60, 55), QPointF(before_ball.x() + 20 + 50, before_ball.y() + 20 + 35),
            Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
        )
        ball.mouseMoveEvent(move)
        app.processEvents()
        db = ball.pos() - before_ball
        self.assertEqual(rp.pos() - before_panel, db)
        rp.close()
        ball.close()
        app.processEvents()

    def test_target_choices_show_assistant_name_before_title(self):
        app, ball, rp = self._panel_on_ball(bx=300, by=400)
        menu = rp.target_menu
        menu._request_seq = 1
        menu._apply_sessions({
            "seq": 1,
            "mode": "pinned",
            "pinned": {"sessionPath": "C:/target.jsonl", "agentId": "hanako", "agentName": "小花", "title": "正在改朗读面板"},
            "sessions": [{
                "agentId": "hanako",
                "agentName": "小花",
                "title": "正在改朗读面板",
                "sessionPath": "C:/target.jsonl",
                "lastUserTime": 0,
            }],
            "error": "",
        })
        item = menu.list_box.itemAt(0).widget()
        self.assertIsNotNone(item)
        self.assertIn("小花", item.text())
        self.assertIn("正在改朗读面板", item.text())
        menu._request_seq = 2
        menu._apply_sessions({"seq": 2, "mode": "auto", "pinned": None, "sessions": [], "error": ""})
        self.assertEqual(menu.view_mode, "auto")
        menu._request_seq = 3
        menu._apply_sessions({"seq": 3, "mode": "pinned", "pinned": None, "sessions": [], "error": "读取失败"})
        retry = menu.list_box.itemAt(1).widget()
        self.assertIsNotNone(retry)
        self.assertEqual(retry.text(), "↻ 重新读取")
        rp.close()
        ball.close()
        app.processEvents()


class PanelSayButtonTests(QtTestCase):
    def _ball_with_menu(self):
        app = make_app()
        ball = zhujian.ZhujianBall()
        ball.show()
        app.processEvents()
        ball._open_menu()
        app.processEvents()
        return app, ball

    def test_say_tool_keeps_action_label_and_follows_target_name_in_description(self):
        app, ball = self._ball_with_menu()
        menu = ball.menu
        menu.ball.target_name = "阿雪"
        menu._update_say_btn()
        self.assertEqual(menu.btn_say.text(), "念给我听")
        self.assertIn("阿雪", menu.lbl_say_desc.text())
        menu.ball.target_name = ""
        menu._update_say_btn()
        self.assertEqual(menu.btn_say.text(), "念给我听")
        self.assertIn("小花", menu.lbl_say_desc.text())
        menu.close_menu()
        ball.close()
        app.processEvents()

    def test_open_read_panel_hides_menu_and_shows_reader(self):
        app, ball = self._ball_with_menu()
        menu = ball.menu
        menu._open_read_panel()
        app.processEvents()
        self.assertFalse(menu.isVisible())
        self.assertIsNotNone(ball.read_panel)
        self.assertTrue(ball.read_panel.isVisible())
        self.assertFalse(ball.read_panel._auto_read_pending)
        ball.read_panel.close()
        ball.close()
        app.processEvents()

    def test_reopen_read_panel_reuses_instance(self):
        app, ball = self._ball_with_menu()
        menu = ball.menu
        menu._open_read_panel()
        app.processEvents()
        first = ball.read_panel
        first.close()
        # 再开一次，复用同一实例
        ball._open_menu()
        app.processEvents()
        ball.menu._open_read_panel()
        app.processEvents()
        self.assertIs(ball.read_panel, first)
        self.assertTrue(ball.read_panel.isVisible())
        ball.read_panel.close()
        ball.close()
        app.processEvents()

    def test_click_ball_closes_reader_without_opening_panel(self):
        app, ball = self._ball_with_menu()
        menu = ball.menu
        menu._open_read_panel()
        app.processEvents()
        self.assertTrue(ball.read_panel.isVisible())
        # 主面板没开时再点球 → 只收朗读窗口，不展开推荐面板
        ball._toggle_expand()
        app.processEvents()
        self.assertFalse(ball.read_panel.isVisible())
        self.assertFalse(ball.menu.isVisible())
        ball.close()
        app.processEvents()


if __name__ == "__main__":
    unittest.main()
