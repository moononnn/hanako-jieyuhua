# 解语花 — 压缩档案弹窗 CompactionPanel 无头测试（QT_QPA_PLATFORM=offscreen）
# 覆盖：构造默认、空态（没压缩过）、最新摘要渲染、历史快照翻页、错误回包、
#       串窗保护、过期回包丢弃、复制摘要、收起回融合状态、时间与 token 格式化，
#       以及鼠标离开淡出排期与跟随花朵双窗拖动（与朗读/润色弹窗同一套行为）。

import unittest
from types import SimpleNamespace

from PyQt6.QtCore import QEvent, QPointF, Qt
from PyQt6.QtGui import QMouseEvent
from PyQt6.QtWidgets import QApplication

from _zhujian_test_support import QtTestCase, zhujian


def make_app():
    return zhujian.QApplication.instance() or zhujian.QApplication([])


def make_panel(fusion_states=None):
    make_app()
    recorded = fusion_states if fusion_states is not None else []
    ball = SimpleNamespace(
        theme_mode="light",
        state={},
        target_mode="auto",
        pinned_target=None,
        target_name="小花",
        target_title="",
        screen=lambda: None,
        x=lambda: 0,
        y=lambda: 0,
        pos=lambda: zhujian.QPoint(0, 0),
        move=lambda *_: None,
        width=lambda: 64,
        height=lambda: 64,
        _set_fusion_panel_state=lambda state: recorded.append(state),
    )
    panel = zhujian.CompactionPanel(ball)
    panel._fusion_states = recorded
    return panel


def archive_payload(seq=1, *, count=3, index=0, compacted=True, entries=162, session_path="C:/sess/a.jsonl"):
    if not compacted:
        return {
            "seq": seq,
            "ok": True,
            "compacted": False,
            "count": 0,
            "items": [],
            "entry": None,
            "verbatim": None,
            "mode": "auto",
            "target": {"name": "小花", "title": "当前对话", "sessionPath": session_path},
        }
    return {
        "seq": seq,
        "ok": True,
        "compacted": True,
        "count": count,
        "index": index,
        "items": [{"index": i, "timestamp": "2026-09-10T01:23:52.602Z", "tokensBefore": 319780, "summaryChars": 7564} for i in range(count)],
        "entry": {
            "index": index,
            "timestamp": "2026-09-10T01:23:52.602Z",
            "tokensBefore": 319780,
            "summaryChars": 7564,
            "summary": "## Goal\n- 完成「渐相知」实机验收。",
            "truncated": False,
            "keptEntryId": "abc123",
        },
        "verbatim": {"entries": entries} if index == 0 else None,
        "mode": "auto",
        "target": {"name": "小花", "title": "当前对话", "sessionPath": session_path},
    }


class CompactionPanelTests(QtTestCase):
    def test_construct_defaults(self):
        panel = make_panel()
        self.assertEqual(panel.lbl_head.text(), "压缩档案")
        self.assertFalse(panel.btn_copy.isEnabled())
        self.assertTrue(panel.pager.isHidden())
        self.assertEqual(panel._count, 0)
        self.assertEqual(panel._index, 0)
        panel.close()

    def test_not_compacted_shows_empty_state(self):
        panel = make_panel()
        panel._seq = 1
        panel._apply_archive(archive_payload(seq=1, compacted=False))
        self.assertIn("还没压缩过", panel.lbl_meta.text())
        self.assertIn("全须全尾", panel.lbl_summary.text())
        self.assertFalse(panel.btn_copy.isEnabled())
        self.assertTrue(panel.pager.isHidden())
        panel.close()

    def test_latest_summary_renders_with_meta_and_pager(self):
        panel = make_panel()
        panel._seq = 1
        panel._apply_archive(archive_payload(seq=1, count=3, index=0))
        self.assertIn("摘要 7564 字", panel.lbl_meta.text())
        self.assertIn("压缩于", panel.lbl_meta.text())
        self.assertIn("32.0 万", panel.lbl_meta.text())
        self.assertIn("渐相知", panel.lbl_summary.text())
        self.assertIn("又续了 162 条", panel.lbl_sub.text())
        self.assertTrue(panel.btn_copy.isEnabled())
        self.assertFalse(panel.pager.isHidden())
        self.assertIn("第 1 次", panel.lbl_pager.text())
        self.assertIn("最近一次", panel.lbl_pager.text())
        self.assertTrue(panel.btn_older.isEnabled())
        self.assertFalse(panel.btn_newer.isEnabled())
        panel.close()

    def test_older_snapshot_marks_historical(self):
        panel = make_panel()
        panel._seq = 1
        panel._apply_archive(archive_payload(seq=1, count=3, index=1))
        self.assertIn("历史快照", panel.lbl_sub.text())
        self.assertIn("往前第 1 次", panel.lbl_pager.text())
        self.assertTrue(panel.btn_newer.isEnabled())
        panel.close()

    def test_oldest_snapshot_disables_older_button(self):
        panel = make_panel()
        panel._seq = 1
        panel._apply_archive(archive_payload(seq=1, count=3, index=2))
        self.assertFalse(panel.btn_older.isEnabled())
        self.assertTrue(panel.btn_newer.isEnabled())
        panel.close()

    def test_single_compaction_hides_pager(self):
        panel = make_panel()
        panel._seq = 1
        panel._apply_archive(archive_payload(seq=1, count=1, index=0))
        self.assertTrue(panel.pager.isHidden())
        panel.close()

    def test_error_payload_shows_reason(self):
        panel = make_panel()
        panel._seq = 1
        panel._apply_archive({"seq": 1, "ok": False, "error": "这段对话的会话文件不在了"})
        self.assertIn("不在了", panel.lbl_summary.text())
        self.assertFalse(panel.btn_copy.isEnabled())
        panel.close()

    def test_stale_payload_is_ignored(self):
        panel = make_panel()
        panel._seq = 2
        panel._apply_archive(archive_payload(seq=1, count=3, index=0))
        self.assertEqual(panel._count, 0)
        self.assertIsNone(panel._archive)
        panel.close()

    def test_target_change_during_viewing_blocks_rendering(self):
        panel = make_panel()
        panel._seq = 1
        panel._apply_archive(archive_payload(seq=1, count=2, index=0, session_path="C:/sess/a.jsonl"))
        panel._seq = 2
        panel._apply_archive(archive_payload(seq=2, count=2, index=0, session_path="C:/sess/b.jsonl"))
        self.assertIn("刚刚变了", panel.lbl_summary.text())
        panel.close()

    def test_copy_summary_puts_text_on_clipboard(self):
        panel = make_panel()
        panel._seq = 1
        panel._apply_archive(archive_payload(seq=1, count=1, index=0))
        panel.copy_summary()
        self.assertIn("渐相知", QApplication.clipboard().text())
        self.assertIn("已复制", panel.lbl_feedback.text())
        panel.close()

    def test_copy_without_summary_warns(self):
        panel = make_panel()
        panel.copy_summary()
        self.assertIn("还没有可复制", panel.lbl_feedback.text())
        panel.close()

    def test_hide_resets_state_and_fusion(self):
        panel = make_panel()
        panel._seq = 1
        panel._apply_archive(archive_payload(seq=1, count=3, index=0))
        panel.show()
        panel.hide()
        self.assertIsNone(panel._archive)
        self.assertEqual(panel._count, 0)
        self.assertEqual(panel._index, 0)
        self.assertIn("none", panel._fusion_states)
        panel.close()

    def test_formatters(self):
        self.assertEqual(zhujian.CompactionPanel._format_tokens(319780), "32.0 万")
        self.assertEqual(zhujian.CompactionPanel._format_tokens(999), "999")
        self.assertEqual(zhujian.CompactionPanel._format_tokens(None), "")
        self.assertEqual(zhujian.CompactionPanel._format_ts(""), "")
        self.assertEqual(zhujian.CompactionPanel._format_ts("not-a-date"), "")
        self.assertTrue(zhujian.CompactionPanel._format_ts("2026-09-10T01:23:52.602Z"))


class CompactionPanelFadeTests(QtTestCase):
    """鼠标离开淡出：与主面板/润色弹窗同一套 mixin，开关必须真接上。"""

    def test_fade_installed_and_show_schedules_when_cursor_outside(self):
        panel = make_panel()
        self.assertIsNotNone(panel._fade_out_timer)
        self.assertIsNotNone(panel._fade_anim)
        self.assertTrue(panel._fade_out_timer.isSingleShot())
        panel._cursor_inside = lambda: False
        panel.show()
        self.assertTrue(panel._fade_out_timer.isActive())
        panel.close()

    def test_enter_cancels_fade_and_leave_schedules(self):
        panel = make_panel()
        panel._cursor_inside = lambda: False
        panel._reset_fade_on_show()
        self.assertTrue(panel._fade_out_timer.isActive())
        panel._on_fade_enter()
        self.assertFalse(panel._fade_out_timer.isActive())
        self.assertEqual(panel.windowOpacity(), 1.0)
        panel._on_fade_leave()
        self.assertTrue(panel._fade_out_timer.isActive())
        panel._begin_fade_out()
        panel._fade_anim.setCurrentTime(panel._fade_anim.duration())
        self.assertAlmostEqual(panel.windowOpacity(), zhujian.FADE_OUT_OPACITY)
        panel.close()

    def test_hide_cancels_pending_fade(self):
        panel = make_panel()
        panel._cursor_inside = lambda: False
        panel.show()
        panel._on_fade_leave()
        panel.hide()
        self.assertFalse(panel._fade_out_timer.isActive())


class CompactionPanelPositionTests(QtTestCase):
    """定位与拖动同推荐面板：贴球左侧 8px，球被单独拖动时档案窗同步跟随。"""

    def _panel_on_ball(self, bx=300, by=400):
        app = make_app()
        ball = zhujian.ZhujianBall()
        ball.move(bx, by)
        ball.show()
        app.processEvents()
        panel = zhujian.CompactionPanel(ball)
        ball.compaction_panel = panel
        panel.move_to_ball()
        panel.show()
        app.processEvents()
        return app, ball, panel

    def test_move_to_ball_places_panel_left_of_ball_with_gap(self):
        app, ball, panel = self._panel_on_ball(bx=500, by=300)
        panel.move_to_ball()
        app.processEvents()
        self.assertLess(panel.x(), ball.x())
        self.assertEqual(ball.x() - (panel.x() + panel.width()), 8)
        panel.close()
        ball.close()
        app.processEvents()

    def test_ball_drag_moves_open_compaction_panel_together(self):
        app, ball, panel = self._panel_on_ball(bx=300, by=400)
        before_ball = ball.pos()
        before_panel = panel.pos()
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
        dp = panel.pos() - before_panel
        self.assertEqual(dp, db)  # 单独拖花朵时，压缩档案窗也要跟着走
        self.assertTrue(panel._user_dragged)
        release = QMouseEvent(
            QEvent.Type.MouseButtonRelease, QPointF(60, 55), QPointF(before_ball.x() + 70, before_ball.y() + 55),
            Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton, Qt.KeyboardModifier.NoModifier,
        )
        ball.mouseReleaseEvent(release)
        self.assertFalse(ball._drag_compaction_was_visible)
        panel.close()
        ball.close()
        app.processEvents()

    def test_keep_position_respects_user_drag(self):
        app, ball, panel = self._panel_on_ball(bx=300, by=400)
        panel._user_dragged = True
        p0 = panel.pos()
        panel._keep_position()
        app.processEvents()
        app.processEvents()
        # 用户拖过：内容变化后保持当前位置，不拽回球边
        self.assertEqual(panel.pos(), p0)
        panel.close()
        ball.close()
        app.processEvents()


if __name__ == "__main__":
    unittest.main()
