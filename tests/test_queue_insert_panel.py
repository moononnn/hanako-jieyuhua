# 解语花 —「等 ta 说完再发」弹窗 QueueInsertDialog 无头测试（QT_QPA_PLATFORM=offscreen）
# 覆盖：构造默认、空输入拦截、存好入队后锁定草稿且禁止重复发送、
#       撤下来恢复编辑、存不进去时保留内容可重试、重复入队提示、状态轮询四种说法、
#       作废后停止轮询、按钮忙碌态与恢复、关闭时停轮询、球拖动实时带上本弹窗。

import threading
import time
import unittest

from _zhujian_test_support import QtTestCase, zhujian

_APP = zhujian.QApplication.instance() or zhujian.QApplication([])


def make_app():
    return zhujian.QApplication.instance() or zhujian.QApplication([])


class FakeBall:
    """QueueInsertDialog 依赖的最小 ball 替身。"""

    def __init__(self):
        self.theme_mode = "light"
        self.target_name = ""
        self.target_title = ""
        self.state = {"panel_side": "left"}
        self.target_mode = "auto"
        self.pinned_target = None
        self.queue_insert_dialog = None
        self.context_menu = None
        self.ask_flower_dialog = None
        self.read_panel = None
        self.menu = None
        self._saved = 0
        self._pos = None

    def screen(self):
        return None

    def x(self):
        return self._pos.x() if self._pos is not None else 0

    def y(self):
        return self._pos.y() if self._pos is not None else 0

    def width(self):
        return 64

    def height(self):
        return 64

    def pos(self):
        from PyQt6.QtCore import QPoint
        return self._pos if self._pos is not None else QPoint(0, 0)

    def move(self, *args):
        from PyQt6.QtCore import QPoint
        if len(args) == 1 and isinstance(args[0], QPoint):
            self._pos = QPoint(args[0])
        elif len(args) >= 2:
            self._pos = QPoint(int(args[0]), int(args[1]))

    def _reset_drag_motion(self):
        pass

    def _record_drag_motion(self):
        pass

    def _release_drag_motion(self):
        pass

    def _save_pos(self):
        self._saved += 1

    def _set_fusion_panel_state(self, state):
        self.state["fusionPanel"] = state


def make_dialog(**ball_kwargs):
    make_app()
    ball = FakeBall()
    for k, v in ball_kwargs.items():
        setattr(ball, k, v)
    dialog = zhujian.QueueInsertDialog(ball)
    ball.queue_insert_dialog = dialog
    return ball, dialog


def pump(app, seconds=0.05):
    """跑事件循环让 worker 线程回包回到主线程。"""
    end = time.time() + seconds
    while time.time() < end:
        app.processEvents()
        time.sleep(0.005)


def menu_rows(menu):
    """列表里当前真正摆着的条目（末尾还有一个 stretch，不算）。"""
    rows = []
    for i in range(menu.list_box.count()):
        w = menu.list_box.itemAt(i).widget()
        if w is not None:
            rows.append(w)
    return rows


class FakePointerEvent:
    def __init__(self, x, y, button, buttons):
        self._pos = zhujian.QPointF(float(x), float(y))
        self._button = button
        self._buttons = buttons

    def globalPosition(self):
        return self._pos

    def button(self):
        return self._button

    def buttons(self):
        return self._buttons

    def accept(self):
        pass


class StubApi:
    """把弹窗用到的 HTTP 入口换成可控替身（不依赖 pytest monkey）。"""

    def __init__(self, post_result=None, get_state=None, get_target=None, get_sessions=None):
        self.calls = {"post": [], "get": 0, "paths": []}
        self._post_result = post_result
        self._get_state = get_state or {}
        self._get_target = get_target or {"ok": True, "mode": "auto", "pinned": None, "target": None}
        self._get_sessions = get_sessions or {"ok": True, "sessions": [], "mode": "auto", "pinned": None}
        self._orig_post = zhujian.api_post
        self._orig_get = zhujian.api_get
        zhujian.api_post = self._post
        zhujian.api_get = self._get

    def _post(self, path, payload, timeout=10):
        self.calls["post"].append((path, payload))
        if path == "/queue-insert/state":
            return {"ok": True, "state": self._get_state}
        if isinstance(self._post_result, Exception):
            raise self._post_result
        return self._post_result

    def _get(self, path, timeout=6):
        self.calls["get"] += 1
        self.calls["paths"].append(path)
        if path == "/target":
            return self._get_target
        if path == "/sessions":
            return self._get_sessions
        return {"ok": True, "state": self._get_state}

    def restore(self):
        zhujian.api_post = self._orig_post
        zhujian.api_get = self._orig_get


class QueueInsertDialogTests(QtTestCase):
    def setUp(self):
        super().setUp()
        self._stub = None

    def tearDown(self):
        if self._stub is not None:
            self._stub.restore()
            self._stub = None
        super().tearDown()

    def stub(self, post_result=None, get_state=None, get_target=None, get_sessions=None):
        self._stub = StubApi(
            post_result=post_result,
            get_state=get_state,
            get_target=get_target,
            get_sessions=get_sessions,
        )
        return self._stub.calls

    def test_construct_defaults(self):
        ball, d = make_dialog()
        labels = [lb.text() for lb in d.findChildren(zhujian.QLabel)]
        self.assertTrue(any("等 ta 说完再发" in t for t in labels), "弹窗标题要说明是等这轮说完再发")
        self.assertTrue(any("这一轮结束就自动发出去" in t for t in labels), "要直说是等这轮说完才接上")
        self.assertTrue(d.btn_send.isEnabled())
        self.assertTrue(d.btn_cancel.isEnabled())
        self.assertEqual(d.btn_send.text(), "就这么发")
        self.assertEqual(d.input.toPlainText(), "")
        self.assertFalse(d.lbl_status.isVisible())
        self.assertFalse(d.poll_timer.isActive())
        d.close()

    def test_target_selector_matches_primary_panel_modes(self):
        ball, d = make_dialog()
        self.stub()
        self.assertEqual(d.lbl_target_label.text(), "发送到")
        self.assertIn("跟随最近", d.btn_target.text())
        self.assertEqual(d.target_menu.btn_auto.text(), "跟随最近")
        self.assertEqual(d.target_menu.btn_fixed.text(), "自己选择")
        d.close()

    def test_auto_target_info_shows_specific_recent_dialog_title(self):
        ball, d = make_dialog()
        d._apply_target_state({
            "seq": d._target_seq,
            "target_revision": 0,
            "mode": "auto",
            "target": {"name": "小花", "title": "解语花界面修订"},
        })
        self.assertIn("跟随最近", d.lbl_target_info.text())
        self.assertIn("解语花界面修订", d.lbl_target_info.text())
        d.close()

    def test_switch_back_to_auto_refreshes_followed_dialog_name(self):
        ball, d = make_dialog()
        self.stub(
            post_result={"ok": True},
            get_state={"state": "empty"},
            get_target={
                "ok": True, "mode": "auto", "pinned": None,
                "target": {"name": "小花", "title": "解语花界面修订"},
            },
        )
        d._apply_target_state({
            "seq": d._target_seq, "target_revision": 0, "mode": "auto",
            "target": {"name": "小花", "title": "解语花界面修订"},
        })
        d.target_menu._pick_auto()
        pump(_APP, 0.15)
        self.assertIn("/target", self._stub.calls["paths"], "切回跟随最近后必须重新定位当前对话")
        self.assertIn("解语花界面修订", d.lbl_target_info.text(), "切回跟随最近要重新显示是哪段对话")
        self.assertNotIn("正在读取", d.lbl_target_info.text())
        d.close()

    def test_auto_target_without_active_session_says_so_instead_of_loading_forever(self):
        ball, d = make_dialog()
        self.stub()
        d._apply_target_state({
            "seq": d._target_seq, "target_revision": 0, "mode": "auto", "target": None,
        })
        self.assertNotIn("正在读取", d.lbl_target_info.text())
        self.assertIn("没找到活跃的对话", d.lbl_target_info.text())
        d.close()

    def test_manual_picker_stays_open_when_sessions_arrive(self):
        sessions = [
            {
                "sessionPath": f"C:/agents/hanako/sessions/s{i}.jsonl",
                "agentId": "hanako", "agentName": "小花", "title": f"对话{i}", "lastUserTime": 0,
            }
            for i in range(5)
        ]
        ball, d = make_dialog()
        self.stub(
            get_state={"state": "empty"},
            get_sessions={"ok": True, "sessions": sessions, "mode": "auto", "pinned": None},
        )
        menu = d.target_menu
        d._set_target_selector_visible(True)
        menu.begin_browse()
        menu.refresh_sessions_async()
        menu._show_fixed()
        pump(_APP, 0.15)
        self.assertEqual(menu.view_mode, "pinned", "点了自己选择后，回包不能把列表收回跟随最近")
        self.assertFalse(menu.list_host.isHidden(), "最近 5 个对话要直接展开，不该再点一次")
        items = menu_rows(menu)
        self.assertEqual(len(items), 5)

        # 再来一次后台回包也不能弹回去
        menu._apply_sessions({
            "seq": menu._request_seq, "target_revision": 0,
            "sessions": sessions, "mode": "auto", "pinned": None, "error": "",
        })
        self.assertEqual(menu.view_mode, "pinned")
        self.assertFalse(menu.list_host.isHidden())
        d.close()

    def test_empty_input_blocked_without_api_call(self):
        ball, d = make_dialog()
        calls = self.stub(post_result={"ok": True, "id": "q1"})
        d.show()
        d.input.setPlainText("   \n  ")
        d._send()
        pump(_APP, 0.05)
        send_calls = [call for call in calls["post"] if call[0] == "/queue-insert"]
        self.assertEqual(send_calls, [], "空内容不该发入队请求")
        self.assertTrue(d.lbl_status.isVisible())
        self.assertIn("写点什么", d.lbl_status.text())
        d.close()

    def test_send_queues_and_shows_confirmed_receipt(self):
        ball, d = make_dialog()
        self.stub(post_result={"ok": True, "id": "q1"})
        d.input.setPlainText("那我们先吃饭，回头再聊")
        d._send()
        pump(_APP, 0.35)

        self.assertEqual(d.input.toPlainText(), "那我们先吃饭，回头再聊", "入队成功后要保留原句供取消后修改")
        self.assertEqual(d._watched_id, "q1")
        self.assertIn(("/queue-insert", {"text": "那我们先吃饭，回头再聊", "sessionPath": ""}), self._stub.calls["post"])
        self.assertIn("存好了", d.lbl_status.text())
        self.assertTrue(d.input.isReadOnly(), "排队期间输入框必须锁定")
        self.assertFalse(d.btn_target.isEnabled(), "排队后目标也必须冻结")
        self.assertFalse(d.btn_send.isEnabled(), "排队期间不能重复发送")
        self.assertEqual(d.btn_cancel.text(), "先不发")
        d.close()

    def test_fixed_target_is_submitted_and_frozen_with_queue_item(self):
        pinned = {"sessionPath": "C:/agents/hanako/sessions/fixed.jsonl", "title": "固定窗口", "agentId": "hanako"}
        ball, d = make_dialog(target_mode="pinned", pinned_target=pinned, target_title="固定窗口", target_name="小花")
        calls = self.stub(post_result={"ok": True, "id": "q-fixed", "sessionPath": pinned["sessionPath"]})
        d.show()
        pump(_APP, 0.1)
        main_thread = threading.get_ident()
        captured_on = []

        def capture_target():
            captured_on.append(threading.get_ident())
            return pinned["sessionPath"]

        d._current_target_path = capture_target
        d.target_menu.setVisible(True)
        d.input.setPlainText("发到固定窗口")
        d._send()
        self.assertTrue(d.target_menu.isHidden(), "发送请求期间必须关闭整个目标菜单")
        pump(_APP, 0.35)
        self.assertEqual(captured_on, [main_thread], "目标必须在点击发送的 UI 线程当场冻结，后台不得重新读取")
        self.assertIn(("/queue-insert", {"text": "发到固定窗口", "sessionPath": pinned["sessionPath"]}), calls["post"])
        self.assertEqual(d._queued_session_path, pinned["sessionPath"])
        self.assertFalse(d.btn_target.isEnabled())
        d.close()

    def test_cancel_queued_message_keeps_text_and_restores_editing(self):
        ball, d = make_dialog()
        calls = self.stub(post_result={"ok": True, "id": "q1", "text": "原句"})
        d.input.setPlainText("原句")
        d._watched_id = "q1"
        d._set_queued(True)
        d.poll_timer.start()
        d._cancel_or_close()
        self.assertFalse(d.poll_timer.isActive(), "取消开始就要暂停轮询，不能让旧 pending 回包重新锁住界面")
        pump(_APP, 0.35)

        cancel_calls = [call for call in calls["post"] if call[0] == "/queue-insert/cancel"]
        self.assertEqual(cancel_calls, [("/queue-insert/cancel", {"id": "q1"})])
        self.assertEqual(d.input.toPlainText(), "原句")
        self.assertFalse(d.input.isReadOnly())
        self.assertTrue(d.btn_send.isEnabled())
        self.assertTrue(d.btn_target.isEnabled())
        self.assertEqual(d.btn_cancel.text(), "取消")
        self.assertIn("继续改", d.lbl_status.text())
        d.close()

    def test_duplicate_queue_says_already_queued(self):
        ball, d = make_dialog()
        self.stub(post_result={"ok": True, "id": "q1", "duplicated": True})
        d.input.setPlainText("这句已经在排队里了")
        d._send()
        pump(_APP, 0.35)
        self.assertIn("已经在队列里", d.lbl_status.text())
        d.close()

    def test_send_failure_keeps_text_for_retry(self):
        ball, d = make_dialog()
        self.stub(post_result={"ok": False, "error": "找不到要发进哪个对话"})
        d.input.setPlainText("这句得留住")
        d._send()
        pump(_APP, 0.35)
        self.assertEqual(d.input.toPlainText(), "这句得留住", "失败不能把用户写的话清掉")
        self.assertIn("找不到", d.lbl_status.text())
        self.assertTrue(d.btn_send.isEnabled())
        d.close()

    def test_network_error_keeps_text(self):
        ball, d = make_dialog()
        self.stub(post_result=RuntimeError("连不上"))
        d.input.setPlainText("网络断了也留着")
        d._send()
        pump(_APP, 0.35)
        self.assertEqual(d.input.toPlainText(), "网络断了也留着")
        self.assertIn("连不上", d.lbl_status.text())
        d.close()

    def test_retry_after_read_failure_keeps_manual_picker_open(self):
        sessions = [
            {
                "sessionPath": f"C:/agents/hanako/sessions/r{i}.jsonl",
                "agentId": "hanako", "agentName": "小花", "title": f"重读后对话{i}", "lastUserTime": 0,
            }
            for i in range(5)
        ]
        ball, d = make_dialog()
        # 第一次读失败
        self.stub(get_sessions={"ok": False, "error": "读取失败，可以重新读取"})
        menu = d.target_menu
        d._set_target_selector_visible(True)
        menu.begin_browse()
        menu.refresh_sessions_async()
        menu._show_fixed()
        pump(_APP, 0.1)
        self.assertTrue(menu.sessions_error, "第一次应当报读取失败")
        self.assertEqual(menu.view_mode, "pinned", "读失败也不能把用户选好的「自己选择」弹回去")

        # 用户点「↻ 重新读取」：这次给真实数据
        self._stub._get_sessions = {"ok": True, "sessions": sessions, "mode": "auto", "pinned": None}
        retry = [b for b in menu.findChildren(zhujian.QPushButton) if "重新读取" in b.text()]
        self.assertEqual(len(retry), 1, "失败时要给一个重新读取的按钮")
        retry[0].click()
        pump(_APP, 0.15)
        self.assertFalse(menu.sessions_error)
        self.assertEqual(menu.view_mode, "pinned", "重读成功也不能把列表收回跟随最近")
        self.assertFalse(menu.list_host.isHidden())
        self.assertEqual(len(menu_rows(menu)), 5, "重读后应该直接看到最近 5 个对话")
        titles = [w.text() for w in menu_rows(menu)]
        self.assertTrue(all("重读后对话" in t for t in titles), "列表要是新读到的那批，不是旧的")
        d.close()

    def test_known_list_stays_visible_while_refreshing(self):
        sessions = [
            {
                "sessionPath": f"C:/agents/hanako/sessions/k{i}.jsonl",
                "agentId": "hanako", "agentName": "小花", "title": f"旧数据{i}", "lastUserTime": 0,
            }
            for i in range(5)
        ]
        ball, d = make_dialog()
        self.stub(get_sessions={"ok": True, "sessions": sessions, "mode": "auto", "pinned": None})
        menu = d.target_menu
        d._set_target_selector_visible(True)
        menu.begin_browse()
        menu.refresh_sessions_async()
        menu._show_fixed()
        pump(_APP, 0.15)
        # 再点一次触发后台重读，旧列表该继续摆着，而不是清成“正在读取对话列表…”
        menu.refresh_sessions_async()
        self.assertEqual(menu.loading_sessions, True)
        # 有旧数据时刷新要继续摆着旧列表，而不是清成“正在读取对话列表…”
        self.assertEqual(len(menu_rows(menu)), 5)
        self.assertNotIn(
            "正在读取对话列表…",
            [w.text() for w in menu_rows(menu)],
        )
        self.assertIn("正在刷新", menu.lbl_mode_hint.text())
        pump(_APP, 0.15)
        d.close()

    def test_dialog_opens_toward_screen_center_on_ball_half(self):
        self.stub(get_state={"state": "empty"})
        ball, d = make_dialog()
        screen = ball.screen() or zhujian.QApplication.primaryScreen()
        geo = screen.availableGeometry()
        ball.move(geo.left() + geo.width() // 4, geo.top() + 200)
        d.show_near_ball()
        pump(_APP, 0.05)
        self.assertEqual(d.side, "right", "球在左半屏就该往右开，不贴屏幕左边")
        self.assertGreater(d.x(), ball.x(), "弹窗不能压在球上")
        ball.move(geo.left() + geo.width() * 3 // 4, geo.top() + 200)
        d.move_to_ball()
        self.assertEqual(d.side, "left", "球跑到右半屏，弹窗应该改开左边")
        self.assertLess(d.x(), ball.x())
        d.close()

    def test_corner_close_button_present_and_locks_when_queued(self):
        """二级窗右上角统一有 ✕；句子进了队列后锁住，避免关窗被误认为不发了。"""
        ball, d = make_dialog()
        self.assertEqual(d.btn_head_close.text(), "✕")
        self.assertTrue(d.btn_head_close.isEnabled(), "没入队时可以随手关窗，草稿还在")
        d._watched_id = "q1"
        d._set_queued(True)
        self.assertFalse(d.btn_head_close.isEnabled(), "入队后 ✕ 要锁住，撤回得用「先不发」")
        self.assertIn("先不发", d.btn_head_close.toolTip())
        d._set_queued(False)
        self.assertTrue(d.btn_head_close.isEnabled())
        d.close()

    def test_queued_state_renames_cancel_button_to_withdraw(self):
        ball, d = make_dialog()
        self.stub()
        d._watched_id = "q1"
        d._set_queued(True)
        self.assertEqual(d.btn_cancel.text(), "先不发", "入队后左边不再是「取消」，而是把这句话撤下来")
        d._set_queued(False)
        self.assertEqual(d.btn_cancel.text(), "取消", "没入队时它就是关闭弹窗")

    def test_mismatched_id_repeatedly_unlocks_instead_of_stuck_forever(self):
        ball, d = make_dialog()
        self.stub()
        d._watched_id = "q-new"
        d._set_queued(True)
        # 队列回报的始终是另一条（旧条目）→ 不能一直卡在“存好了”
        for _ in range(3):
            d._apply_state({"state": "sent", "id": "q-old", "text": "旧的"})
        self.assertEqual(d._watched_id, "")
        self.assertFalse(d._queued, "对不上就对不上，不能把界面锁死")
        self.assertIn("不在队列里", d.lbl_status.text())
        d.close()

    def test_state_pending_shows_queue_message(self):
        ball, d = make_dialog()
        self.stub(get_state={"state": "pending", "id": "q1", "text": "队列里那句"})
        d.input.setPlainText("未发送草稿")
        d._apply_state({"state": "pending", "id": "q1", "text": "队列里那句"})
        self.assertEqual(d.input.toPlainText(), "队列里那句", "活队列原文是准的，不能锁住另一份旧草稿")
        self.assertTrue(d.input.isReadOnly())
        self.assertIn("在等着", d.lbl_status.text())

    def test_old_terminal_history_does_not_clear_new_draft(self):
        ball, d = make_dialog()
        self.stub()
        d.input.setPlainText("我正在写的新句子")
        d._apply_state({"state": "sent", "id": "old", "text": "早已发出的旧句"})
        self.assertEqual(d.input.toPlainText(), "我正在写的新句子")
        self.assertFalse(d.input.isReadOnly())

    def test_state_sent_stops_polling_and_confirms(self):
        ball, d = make_dialog()
        self.stub(get_state={"state": "sent", "id": "q1", "text": "排队那句"})
        d._watched_id = "q1"
        d.poll_timer.start()
        d._apply_state({"state": "sent", "id": "q1", "text": "排队那句"})
        self.assertIn("发出去了", d.lbl_status.text())
        self.assertFalse(d.poll_timer.isActive(), "送达后不该再轮询")
        self.assertEqual(d._watched_id, "")

    def test_state_skipped_shows_reason_and_stops(self):
        ball, d = make_dialog()
        self.stub()
        d._watched_id = "q1"
        d.poll_timer.start()
        d._apply_state({"state": "skipped", "id": "q1", "reason": "你自己已经接过话了"})
        self.assertIn("你自己已经接过话了", d.lbl_status.text())
        self.assertFalse(d.poll_timer.isActive())

    def test_state_of_other_item_does_not_overwrite(self):
        ball, d = make_dialog()
        self.stub()
        d._watched_id = "q1"
        d._set_status("存好了，这轮结束就发", "ok")
        d._apply_state({"state": "sent", "id": "q9", "text": "别人的"})
        self.assertIn("存好了", d.lbl_status.text(), "别的排队句的状态不能盖掉当前这句")

    def test_left_click_ball_closes_queue_dialog_without_opening_main_menu(self):
        self.stub(get_state={"state": "pending", "id": "q1", "text": "排队中那句"})
        ball = zhujian.ZhujianBall()
        d = zhujian.QueueInsertDialog(ball)
        ball.queue_insert_dialog = d
        ball.move(400, 200)
        d.show()
        pump(_APP, 0.05)
        d.input.setPlainText("排队中那句")
        d._watched_id = "q1"
        d._set_queued(True)
        self.assertTrue(d.isVisible())

        ball._toggle_expand()
        pump(_APP, 0.05)
        self.assertFalse(d.isVisible(), "左键点悬浮球应该把排队插话窗收掉，而不是弹出一级窗口叠着")
        self.assertFalse(ball.menu is not None and ball.menu.isVisible(), "不该顺手再展开主面板")
        self.assertEqual(ball.state.get("fusionPanel"), "none")

        # 重新打开：队列里的句子要按服务端状态原样接回，不丢
        d.show()
        pump(_APP, 0.2)
        self.assertTrue(d._queued, "重新打开要恢复排队中的锁定态")
        self.assertEqual(d.input.toPlainText(), "排队中那句")
        d.close()
        pump(_APP, 0.05)
        d.deleteLater()
        ball.close()
        ball.deleteLater()

    def test_closing_dialog_keeps_unfinished_draft(self):
        self.stub(get_state={"state": "empty"})
        ball, d = make_dialog()
        d.input.setPlainText("写到一半的半句话")
        d.show()
        pump(_APP, 0.05)
        d.close()
        pump(_APP, 0.05)
        self.assertEqual(d.input.toPlainText(), "写到一半的半句话", "关窗不能清掉还没存下的草稿")
        d.show()
        pump(_APP, 0.15)
        self.assertEqual(d.input.toPlainText(), "写到一半的半句话", "重新打开要接着写")
        self.assertFalse(d._queued)
        d.close()

    def test_close_stops_polling_and_resets_fusion_state(self):
        ball, d = make_dialog()
        self.stub()
        d.show()
        pump(_APP, 0.05)
        d.poll_timer.start()
        d._set_status("在等着，这轮结束就发", "normal")
        d.close()
        pump(_APP, 0.05)
        self.assertFalse(d.poll_timer.isActive())
        self.assertEqual(ball.state.get("fusionPanel"), "none")

    def test_ball_drag_live_sync_includes_queue_insert_dialog(self):
        self.stub(get_state={"state": "empty"})
        ball = zhujian.ZhujianBall()
        d = zhujian.QueueInsertDialog(ball)
        ball.queue_insert_dialog = d
        ball.move(420, 260)
        d.move(140, 220)
        d.show()
        pump(_APP, 0.05)
        ball_start = ball.pos()
        dialog_start = d.pos()
        press_x = ball_start.x() + 20
        press_y = ball_start.y() + 20
        left = zhujian.Qt.MouseButton.LeftButton
        none = zhujian.Qt.MouseButton.NoButton
        ball.mousePressEvent(FakePointerEvent(press_x, press_y, left, left))
        ball.mouseMoveEvent(FakePointerEvent(press_x + 42, press_y + 28, left, left))
        ball_delta = ball.pos() - ball_start
        dialog_delta = d.pos() - dialog_start
        self.assertGreater(ball_delta.manhattanLength(), 0)
        self.assertEqual((dialog_delta.x(), dialog_delta.y()), (ball_delta.x(), ball_delta.y()), "拖动中的每一帧都要保持双窗同位移")
        ball.mouseReleaseEvent(FakePointerEvent(press_x + 42, press_y + 28, left, none))
        self.assertFalse(ball._drag_qi_was_visible)
        self.assertIsNone(ball._drag_qi_start)
        d.close()
        ball.close()
        d.deleteLater()
        ball.deleteLater()


if __name__ == "__main__":
    unittest.main()
