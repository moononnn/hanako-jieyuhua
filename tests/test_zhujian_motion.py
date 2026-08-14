import importlib.util
import math
import os
import pathlib
import random
import unittest

from PyQt6.QtGui import QImage, QPainter, QPixmap
from PyQt6.QtSvg import QSvgRenderer


os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
MODULE_PATH = pathlib.Path(__file__).parents[1] / "python" / "zhujian_app.py"
SPEC = importlib.util.spec_from_file_location("zhujian_app", MODULE_PATH)
zhujian = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(zhujian)


class ZhujianMotionTests(unittest.TestCase):
    def test_wind_strength_is_bounded_and_increases_with_speed(self):
        slow = zhujian.wind_strength_from_speed(0)
        medium = zhujian.wind_strength_from_speed(550)
        fast = zhujian.wind_strength_from_speed(99999)
        self.assertEqual(slow, zhujian.MIN_WIND_STRENGTH)
        self.assertLess(slow, medium)
        self.assertLess(medium, fast)
        self.assertEqual(fast, zhujian.MAX_WIND_STRENGTH)

    def test_entry_wind_uses_the_side_where_cursor_came_from(self):
        left_direction, _ = zhujian.calculate_entry_wind(20, 30, 55, 30, 0.1, 50)
        right_direction, _ = zhujian.calculate_entry_wind(80, 30, 55, 30, 0.1, 50)
        down_direction, _ = zhujian.calculate_entry_wind(50, 0, 50, 55, 0.1, 50)
        up_direction, _ = zhujian.calculate_entry_wind(50, 80, 50, 25, 0.1, 50)
        self.assertEqual(left_direction, -1.0)
        self.assertEqual(right_direction, 1.0)
        self.assertEqual(down_direction, -1.0)
        self.assertEqual(up_direction, 1.0)
        self.assertEqual(
            down_direction,
            zhujian.calculate_cursor_sweep(50, 0, 50, 55, 0.1)[0],
        )
        self.assertEqual(
            up_direction,
            zhujian.calculate_cursor_sweep(50, 80, 50, 25, 0.1)[0],
        )

    def test_cursor_sweep_tracks_speed_and_four_directions(self):
        slow = zhujian.calculate_cursor_sweep(10, 10, 10.2, 10, 0.1)
        self.assertEqual(slow[0], 0.0)
        self.assertEqual(slow[1], 0.0)

        barely = zhujian.calculate_cursor_sweep(10, 10, 12.5, 10, 0.1)
        medium = zhujian.calculate_cursor_sweep(10, 10, 20, 10, 0.1)
        self.assertGreater(barely[1], 0.0)
        self.assertLess(barely[1], medium[1])
        self.assertLess(medium[1], zhujian.MAX_WIND_STRENGTH)

        right = zhujian.calculate_cursor_sweep(10, 20, 70, 20, 0.1)
        left = zhujian.calculate_cursor_sweep(70, 20, 10, 20, 0.1)
        down = zhujian.calculate_cursor_sweep(40, 5, 40, 65, 0.1)
        up = zhujian.calculate_cursor_sweep(40, 65, 40, 5, 0.1)
        self.assertEqual(right[0], -1.0)
        self.assertEqual(left[0], 1.0)
        self.assertEqual(down[0], -1.0)
        self.assertEqual(up[0], 1.0)
        self.assertAlmostEqual(right[1], left[1])
        self.assertAlmostEqual(down[1], up[1])
        self.assertGreater(right[2], zhujian.SWEEP_PETAL_SPEED)
        self.assertGreater(right[3], 0.0)
        self.assertEqual(right[4], 0.0)

    def test_hover_zone_follows_visible_branch_flower_and_leaf(self):
        self.assertTrue(zhujian.point_in_flower_zone(50, 46))
        self.assertTrue(zhujian.point_in_flower_zone(8, 22))
        self.assertTrue(zhujian.point_in_flower_zone(31, 21))
        self.assertFalse(zhujian.point_in_flower_zone(50, 70))
        self.assertFalse(zhujian.point_in_flower_zone(3, 76))
        self.assertFalse(zhujian.point_in_flower_zone(77, 76))

    def test_fast_outside_to_outside_segment_still_hits_flower(self):
        self.assertTrue(zhujian.segment_crosses_flower_zone(-30, 46, 110, 46))
        self.assertTrue(zhujian.segment_crosses_flower_zone(50, -30, 50, 110))
        self.assertFalse(zhujian.segment_crosses_flower_zone(-30, 78, 110, 78))

    def test_cursor_sweep_is_disabled_while_pressed_or_dragging(self):
        self.assertTrue(zhujian.should_apply_cursor_sweep(True, False, False))
        self.assertFalse(zhujian.should_apply_cursor_sweep(True, True, False))
        self.assertFalse(zhujian.should_apply_cursor_sweep(True, False, True))
        self.assertFalse(zhujian.should_apply_cursor_sweep(False, False, False))

    def test_sweep_petals_form_four_speed_tiers_below_click_count(self):
        self.assertEqual(zhujian.petal_count_from_sweep_speed(200), 0)
        self.assertEqual(zhujian.petal_count_from_sweep_speed(300), 3)
        self.assertEqual(zhujian.petal_count_from_sweep_speed(700), 5)
        self.assertEqual(zhujian.petal_count_from_sweep_speed(1100), 7)
        self.assertEqual(zhujian.petal_count_from_sweep_speed(1800), 9)
        self.assertLess(zhujian.petal_count_from_sweep_speed(99999), zhujian.PRESS_PETAL_COUNT)

    def test_horizontal_and_vertical_sweeps_use_distinct_motion_channels(self):
        horizontal = zhujian.cursor_wind_components(600, 0, 1.2, -1.0)
        vertical_down = zhujian.cursor_wind_components(0, 600, 1.2, -1.0)
        vertical_up = zhujian.cursor_wind_components(0, -600, 1.2, 1.0)
        diagonal = zhujian.cursor_wind_components(600, 600, 1.2, -1.0)
        self.assertEqual(horizontal, (-1.2, 0.0))
        self.assertEqual(vertical_down, (-0.0, 1.2))
        self.assertEqual(vertical_up, (0.0, -1.2))
        self.assertAlmostEqual(abs(diagonal[0]), 0.6)
        self.assertAlmostEqual(diagonal[1], 0.6)

    def test_component_motion_is_directional_and_leaf_lags_most(self):
        left = zhujian.component_motion(0.7, 0.0, 1.0, -1.0)
        right = zhujian.component_motion(0.7, 0.0, 1.0, 1.0)
        self.assertEqual(len(left), 3)
        for left_value, right_value in zip(left, right):
            self.assertAlmostEqual(left_value, -right_value)
        self.assertGreater(abs(right[2]), abs(right[0]))
        self.assertGreater(abs(right[0]), abs(right[1]))

    def test_flower_uses_three_valid_complete_svg_assets(self):
        app = zhujian.QApplication.instance() or zhujian.QApplication([])
        for name in ("yinghua-branch.svg", "yinghua-ball.svg", "yinghua-leaf.svg"):
            path = MODULE_PATH.parent / name
            svg = path.read_text(encoding="utf-8")
            self.assertIn("<svg", svg)
            self.assertIn("viewBox=", svg)
            self.assertTrue(QSvgRenderer(str(path)).isValid(), name)
        ball = zhujian.ZhujianBall()
        self.assertTrue(ball.layered_flower_ready)
        ball.close()
        ball.deleteLater()
        app.processEvents()

    def test_empty_pixmap_falls_back_without_dividing_by_zero(self):
        app = zhujian.QApplication.instance() or zhujian.QApplication([])
        ball = zhujian.ZhujianBall()
        image = QImage(zhujian.BALL_SIZE, zhujian.BALL_SIZE, QImage.Format.Format_ARGB32_Premultiplied)
        image.fill(0)
        painter = QPainter(image)
        self.assertFalse(ball._draw_layer(painter, QPixmap(), 40, 0, 40, 40))
        ball._draw_fallback_flower(painter, 40, 40, 1.0)
        painter.end()
        self.assertTrue(any(
            image.pixelColor(x, y).alpha() > 0
            for y in range(image.height())
            for x in range(image.width())
        ))
        ball.close()
        ball.deleteLater()
        app.processEvents()

    def test_flower_and_leaf_stay_inside_window_during_press_and_rebound(self):
        app = zhujian.QApplication.instance() or zhujian.QApplication([])
        ball = zhujian.ZhujianBall()
        self.assertEqual(zhujian.FLOWER_SIZE, 34)
        for direction in (-1.0, 1.0):
            for press_amount in (1.08, -0.34):
                t = 1.2
                bloom = 1.0
                gust = zhujian.MAX_WIND_STRENGTH
                angle = 11.0 * direction
                lift = -0.45 * math.sin(t * 1.05)
                rebound = max(0.0, -press_amount)
                branch_offset, flower_offset, leaf_offset = zhujian.component_motion(
                    t, bloom, gust, direction, rebound,
                )
                branch_angle = angle * 0.42 + branch_offset * 0.55 + press_amount * 4.8

                image = QImage(zhujian.BALL_SIZE, zhujian.BALL_SIZE, QImage.Format.Format_ARGB32_Premultiplied)
                image.fill(0)
                painter = QPainter(image)
                painter.translate(zhujian.BRANCH_PIVOT[0], zhujian.BRANCH_PIVOT[1])
                painter.rotate(branch_angle)
                painter.translate(-zhujian.BRANCH_PIVOT[0], -zhujian.BRANCH_PIVOT[1])
                ball._draw_layer(
                    painter, ball.pix_leaf, zhujian.LEAF_SIZE, leaf_offset,
                    zhujian.LEAF_CENTER[0], zhujian.LEAF_CENTER[1] + lift * 0.35,
                )
                ball._draw_layer(
                    painter, ball.pix_flower, zhujian.FLOWER_SIZE, flower_offset,
                    zhujian.FLOWER_CENTER[0], zhujian.FLOWER_CENTER[1] + lift, 1.0,
                )
                painter.end()
                points = [
                    (x, y)
                    for y in range(image.height())
                    for x in range(image.width())
                    if image.pixelColor(x, y).alpha() > 4
                ]
                self.assertTrue(points)
                xs = [point[0] for point in points]
                ys = [point[1] for point in points]
                self.assertGreaterEqual(min(xs), 1)
                self.assertGreaterEqual(min(ys), 1)
                self.assertLessEqual(max(xs), zhujian.BALL_SIZE - 2)
                self.assertLessEqual(max(ys), zhujian.BALL_SIZE - 2)
        ball.close()
        ball.deleteLater()
        app.processEvents()

    def test_press_spring_holds_then_overshoots_and_settles(self):
        amount, velocity = 0.18, 2.6
        for _ in range(24):
            amount, velocity = zhujian.advance_press_spring(amount, velocity, True, 1 / 60)
        self.assertGreater(amount, 0.9)

        velocity = min(velocity, -8.4)
        released = []
        for _ in range(150):
            amount, velocity = zhujian.advance_press_spring(amount, velocity, False, 1 / 60)
            released.append(amount)
        self.assertLess(min(released), -0.12)
        self.assertAlmostEqual(released[-1], 0.0, delta=0.01)

    def test_hover_and_click_petals_stay_tiny_with_expected_counts(self):
        app = zhujian.QApplication.instance() or zhujian.QApplication([])
        ball = zhujian.ZhujianBall()
        ball._petal_rng = random.Random(7)
        ball._spawn_petals(2, burst=False)
        self.assertEqual(len(ball.petal_particles), 2)
        self.assertLessEqual(max(petal["size"] for petal in ball.petal_particles), 1.28)

        ball.petal_particles = []
        ball._petal_rng = random.Random(9)
        ball._spawn_petals(12, burst=False, wind=(900.0, 0.0))
        right_average = sum(petal["vx"] for petal in ball.petal_particles) / len(ball.petal_particles)
        ball.petal_particles = []
        ball._petal_rng = random.Random(9)
        ball._spawn_petals(12, burst=False, wind=(-900.0, 0.0))
        left_average = sum(petal["vx"] for petal in ball.petal_particles) / len(ball.petal_particles)
        self.assertGreater(right_average, 8.0)
        self.assertLess(left_average, -8.0)

        ball.petal_particles = []
        ball._petal_rng = random.Random(10)
        ball._spawn_petals(12, burst=False, wind=(0.0, -1200.0))
        upward_average = sum(petal["vy"] for petal in ball.petal_particles) / len(ball.petal_particles)
        self.assertLess(upward_average, -12.0)
        self.assertTrue(all(petal["gravity"] == 22.0 for petal in ball.petal_particles))
        self.assertTrue(all(petal["life"] >= 1.35 for petal in ball.petal_particles))
        self.assertTrue(all(petal["sway"] > 1.5 for petal in ball.petal_particles))
        self.assertTrue(all(
            (-petal["vy"] / petal["gravity"]) < petal["life"]
            for petal in ball.petal_particles
            if petal["vy"] < 0.0
        ))

        ball.petal_particles = []
        ball._petal_rng = random.Random(13)
        ball._spawn_petals(12, burst=False, wind=(300.0, 0.0))
        slow_average = sum(petal["vx"] for petal in ball.petal_particles) / len(ball.petal_particles)
        ball.petal_particles = []
        ball._petal_rng = random.Random(13)
        ball._spawn_petals(12, burst=False, wind=(1200.0, 0.0))
        fast_average = sum(petal["vx"] for petal in ball.petal_particles) / len(ball.petal_particles)
        self.assertGreater(fast_average, slow_average + 15.0)

        ball.petal_particles = []
        ball._petal_rng = random.Random(11)
        ball._spawn_petals(zhujian.MAX_PETAL_PARTICLES + 20, burst=False)
        self.assertEqual(len(ball.petal_particles), zhujian.MAX_PETAL_PARTICLES)

        ball.petal_particles = []
        ball._begin_press_effect()
        self.assertEqual(len(ball.petal_particles), zhujian.PRESS_PETAL_COUNT)
        ball._end_press_effect()
        self.assertEqual(
            len(ball.petal_particles),
            zhujian.PRESS_PETAL_COUNT + zhujian.RELEASE_PETAL_COUNT,
        )
        self.assertLessEqual(max(petal["size"] for petal in ball.petal_particles), 1.62)
        ball.close()
        ball.deleteLater()
        app.processEvents()

    def test_theme_mode_follows_hana_dark_themes_and_auto(self):
        self.assertEqual(zhujian.resolve_theme_mode("grass-aroma"), "light")
        self.assertEqual(zhujian.resolve_theme_mode("midnight"), "dark")
        self.assertEqual(zhujian.resolve_theme_mode("midnight-contrast"), "dark")
        self.assertEqual(zhujian.resolve_theme_mode("auto", system_dark=True), "dark")
        self.assertEqual(zhujian.resolve_theme_mode("auto", system_dark=False), "light")

    def test_context_menu_keeps_a_gap_and_flips_near_right_edge(self):
        size = zhujian.BALL_SIZE
        x, y = zhujian.position_popup_beside(
            (100, 100, size, size), (220, 170), (0, 0, 800, 600), gap=8
        )
        self.assertEqual((x, y), (100 + size + 8, 100 + size // 2 - 85))

        x, y = zhujian.position_popup_beside(
            (720, 100, size, size), (220, 170), (0, 0, 800, 600), gap=8
        )
        self.assertEqual((x, y), (720 - 220 - 8, 100 + size // 2 - 85))

    def test_anchor_ratio_places_flower_above_panel_below_menu(self):
        # 左键面板：花朵中心在面板高度 38% 处（面板主体在花下方，实机确认）
        size = zhujian.BALL_SIZE
        x, y = zhujian.position_popup_beside(
            (100, 100, size, size), (220, 170), (0, 0, 800, 600),
            gap=8, anchor_ratio=zhujian.PANEL_ANCHOR_RATIO,
        )
        self.assertEqual(x, 100 + size + 8)
        self.assertEqual(y, 100 + size // 2 - int(170 * 0.38))
        # 右键浮签：花朵中心在浮签高度 33% 处（浮签主体在花下方）
        x, y = zhujian.position_popup_beside(
            (100, 100, size, size), (220, 170), (0, 0, 800, 600),
            gap=8, anchor_ratio=zhujian.MENU_ANCHOR_RATIO,
        )
        self.assertEqual(y, 100 + size // 2 - int(170 * 0.33))
        # 面板与浮签的比例都应低于居中，保持花在上/主体在下的视觉呼应
        self.assertLess(zhujian.PANEL_ANCHOR_RATIO, 0.5)
        self.assertLess(zhujian.MENU_ANCHOR_RATIO, 0.5)

    def test_popup_anchor_y_clamps_within_screen(self):
        # 锚点把弹出窗顶到屏幕外时，必须被 clamp 回可视范围
        y = zhujian.popup_anchor_y((100, 0, 64, 64), 300, (0, 0, 800, 600), 0.9)
        self.assertEqual(y, 0)
        y = zhujian.popup_anchor_y((100, 500, 64, 64), 300, (0, 0, 800, 600), 0.1)
        self.assertEqual(y, 300)

    def test_pair_drag_keeps_both_windows_together_at_screen_edges(self):
        # 面板在花朵左侧，整体向右拖；面板和花朵应拿到同一个限位位移。
        dx, dy = zhujian.clamp_pair_drag(
            500, 40,
            (100, 100, 344, 220),
            (452, 178, 64, 64),
            (0, 0, 800, 600),
        )
        self.assertEqual(dx, 284)
        self.assertEqual(dy, 40)

        dx, dy = zhujian.clamp_pair_drag(
            -500, -500,
            (100, 100, 344, 220),
            (452, 178, 64, 64),
            (0, 0, 800, 600),
        )
        self.assertEqual((dx, dy), (-100, -100))

    def test_target_selector_is_embedded_compact_and_limited_to_five(self):
        app = zhujian.QApplication.instance() or zhujian.QApplication([])

        class Ball:
            theme_mode = "light"
            target_mode = "auto"
            pinned_target = None

        class Panel(zhujian.QFrame):
            def __init__(self):
                super().__init__()
                self.ball = Ball()

            def _update_target(self):
                pass

            def _resize_after_target_change(self):
                pass

        panel = Panel()
        selector = zhujian.TargetMenu(panel)
        selector._request_seq = 1
        selector._apply_sessions({
            "seq": 1,
            "mode": "pinned",
            "pinned": None,
            "sessions": [
                {"sessionPath": f"C:/sessions/{i}.jsonl", "title": f"窗口 {i}", "agentId": "hanako"}
                for i in range(7)
            ],
            "error": "",
        })
        session_buttons = selector.findChildren(zhujian.QPushButton, "sessionItem")
        self.assertIs(selector.parent(), panel)
        self.assertFalse(selector.isWindow())
        self.assertFalse(any(
            child.metaObject().className() == "QScrollArea"
            for child in selector.findChildren(zhujian.QWidget)
        ))
        self.assertEqual(len(selector.sessions), zhujian.TARGET_SESSION_LIMIT)
        self.assertEqual(len(session_buttons), 5)
        selector.deleteLater()
        panel.deleteLater()
        app.processEvents()

    def test_hover_uses_a_larger_exit_zone_and_short_grace_period(self):
        # 这个点在进入区外、退出区内：未悬停时不进入，已悬停时继续保持。
        self.assertFalse(zhujian.resolve_hover_state(False, -18, 32, 0.0, 0.01)[0])
        self.assertTrue(zhujian.resolve_hover_state(True, -18, 32, 0.0, 0.01)[0])

        hovered, elapsed = zhujian.resolve_hover_state(True, -50, -50, 0.0, 0.1)
        self.assertTrue(hovered)
        hovered, _ = zhujian.resolve_hover_state(True, -50, -50, elapsed, 0.2)
        self.assertFalse(hovered)


if __name__ == "__main__":
    unittest.main()
