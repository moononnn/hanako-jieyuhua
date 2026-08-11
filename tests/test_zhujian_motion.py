import importlib.util
import pathlib
import unittest


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
        self.assertEqual(left_direction, -1.0)
        self.assertEqual(right_direction, 1.0)

    def test_theme_mode_follows_hana_dark_themes_and_auto(self):
        self.assertEqual(zhujian.resolve_theme_mode("grass-aroma"), "light")
        self.assertEqual(zhujian.resolve_theme_mode("midnight"), "dark")
        self.assertEqual(zhujian.resolve_theme_mode("midnight-contrast"), "dark")
        self.assertEqual(zhujian.resolve_theme_mode("auto", system_dark=True), "dark")
        self.assertEqual(zhujian.resolve_theme_mode("auto", system_dark=False), "light")

    def test_context_menu_keeps_a_gap_and_flips_near_right_edge(self):
        x, y = zhujian.position_popup_beside(
            (100, 100, 64, 64), (220, 170), (0, 0, 800, 600), gap=8
        )
        self.assertEqual((x, y), (172, 47))

        x, y = zhujian.position_popup_beside(
            (720, 100, 64, 64), (220, 170), (0, 0, 800, 600), gap=8
        )
        self.assertEqual((x, y), (492, 47))

    def test_anchor_ratio_places_flower_above_panel_below_menu(self):
        # 左键面板：花朵中心在面板高度 38% 处（面板主体在花下方，实机确认）
        x, y = zhujian.position_popup_beside(
            (100, 100, 64, 64), (220, 170), (0, 0, 800, 600),
            gap=8, anchor_ratio=zhujian.PANEL_ANCHOR_RATIO,
        )
        self.assertEqual(x, 172)
        self.assertEqual(y, 100 + 32 - int(170 * 0.38))  # 132 - 64 = 68
        self.assertEqual(y, 68)
        # 右键浮签：花朵中心在浮签高度 33% 处（浮签主体在花下方）
        x, y = zhujian.position_popup_beside(
            (100, 100, 64, 64), (220, 170), (0, 0, 800, 600),
            gap=8, anchor_ratio=zhujian.MENU_ANCHOR_RATIO,
        )
        self.assertEqual(y, 100 + 32 - int(170 * 0.33))  # 132 - 56 = 76
        self.assertEqual(y, 76)
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
