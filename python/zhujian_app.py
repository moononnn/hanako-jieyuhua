#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
解语花 · 落樱悬浮球
=====================
桌面悬浮「落樱」：一朵会呼吸、会受风的小樱花。
常态轻浮轻摆；光标掠过时按来风方向摇动、微微绽开；点击时旋花一下并弹出面板。

三态：
  ROLLED   （常态）  错拍微风 + 呼吸浮动
  PEEKING  （悬停）  入场阵风 + 绽开 + 花粉微光
  CLICK    （点击）  短促旋花 + 弹性放大

渲染：SVG → pixmap 高清缩放（yinghua-ball.svg），
通过弹簧阻尼、旋转、缩放和极轻量 QPainter 光点叠加动态。

通信：只调解语花插件的本地代理端口（127.0.0.1:18903），
推荐生成 / 发送全部由插件进程执行，Python 只发 HTTP 和画 UI。

启动: python zhujian_app.py
环境变量:
  JIEGEHUA_API  解语花本地代理地址（默认 http://127.0.0.1:18903）
  HANA_HOME     Hana 数据目录（存状态文件用）
"""

import sys
import os
import json
import math
import time
import threading
import urllib.request
import urllib.error

from PyQt6.QtCore import Qt, QTimer, QPoint, QPointF, pyqtSignal
from PyQt6.QtGui import (
    QPixmap, QPainter, QColor, QFontMetrics, QCursor, QPalette,
)
from PyQt6.QtSvg import QSvgRenderer
from PyQt6.QtWidgets import (
    QApplication, QWidget, QPushButton, QLabel, QFrame,
    QVBoxLayout, QHBoxLayout, QGridLayout, QSizePolicy,
)


# ── 可点击的推荐条目（QLabel + 点击信号，支持自动换行） ──
class RecLabel(QLabel):
    clicked = pyqtSignal(int)

    def __init__(self, text, index):
        super().__init__(text)
        self._idx = index
        self.setWordWrap(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setContentsMargins(12, 9, 12, 9)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self._idx)
        super().mousePressEvent(e)


API_BASE = os.environ.get("JIEGEHUA_API", "http://127.0.0.1:18903")
HANA_HOME = os.environ.get("HANA_HOME", os.path.join(os.path.expanduser("~"), ".hanako"))
STATE_PATH = os.path.join(HANA_HOME, "data", "jiegehua", "zhujian-state.json")
PREFERENCES_PATH = os.path.join(HANA_HOME, "user", "preferences.json")
HERE = os.path.dirname(os.path.abspath(__file__))

# ── 尺寸与渲染 ──
BALL_SIZE = 64            # 透明悬浮窗尺寸
FLOWER_SIZE = 34          # 对齐风铃铃铛主体的像素体量，小巧但保留摇摆空间
SVG_SIZE = 400            # SVG 输出基准尺寸
RENDER_SCALE = 3          # 高清渲染倍率
RENDER_SIZE = SVG_SIZE * RENDER_SCALE

# ── 微风动效参数 ──
MIN_WIND_STRENGTH = 0.55
MAX_WIND_STRENGTH = 1.35
FULL_GUST_SPEED = 1100.0
CLICK_BURST_DURATION = 0.62

# ── 鼠标 hover 滞回 ──
EDGE_INSET = 16
HOVER_ENTER_MARGIN = 10
HOVER_EXIT_MARGIN = 24
HOVER_LEAVE_DELAY = 0.24

# ── 弹出窗垂直锚点（花朵中心位于弹出窗高度中的比例，0.5=居中） ──
PANEL_ANCHOR_RATIO = 0.38   # 左键推荐面板：花在面板上部，面板主体在花下方（实机确认）
MENU_ANCHOR_RATIO = 0.33    # 右键发送浮签：主体在花下方，与面板视觉呼应

# ── 手帐风配色：保留落樱自己的薄荷绿与粉色，明暗随 Hana 切换 ──
DARK_THEME_IDS = {"midnight", "midnight-contrast"}
THEME_COLORS = {
    "light": {
        "panel": "#fbf8ef", "surface": "#fffdf7", "surface_alt": "#eef6f1",
        "border": "#b6d1c4", "ink": "#3e4b43", "sub": "#7f8e85",
        "accent": "#5b9a82", "accent_deep": "#3f705d", "accent_text": "#ffffff",
        "pink": "#d893a6", "danger_bg": "#f9edf0", "shadow": "#526a60",
    },
    "dark": {
        "panel": "#384850", "surface": "#42545c", "surface_alt": "#465c5c",
        "border": "#6b877d", "ink": "#e7efeb", "sub": "#b5c4bd",
        "accent": "#86bba6", "accent_deep": "#cfe7dc", "accent_text": "#263a34",
        "pink": "#dda9b7", "danger_bg": "#51464d", "shadow": "#172126",
    },
}


# ── 工具函数 ──
def resolve_theme_mode(theme_id, system_dark=False):
    theme_id = str(theme_id or "warm-paper")
    if theme_id == "auto":
        return "dark" if system_dark else "light"
    return "dark" if theme_id in DARK_THEME_IDS else "light"


def read_hana_theme_mode():
    theme_id = "warm-paper"
    try:
        with open(PREFERENCES_PATH, "r", encoding="utf-8") as f:
            theme_id = (json.load(f).get("appearance") or {}).get("theme") or theme_id
    except Exception:
        pass
    app = QApplication.instance()
    system_dark = False
    if app is not None:
        window_color = app.palette().color(QPalette.ColorRole.Window)
        system_dark = window_color.lightness() < 128
    return resolve_theme_mode(theme_id, system_dark)


def clamp_pair_drag(dx, dy, first_rect, second_rect, bounds):
    """把两个窗口整体限位；bounds 为左/上闭区间、右/下开区间。"""
    left = min(first_rect[0], second_rect[0])
    top = min(first_rect[1], second_rect[1])
    right = max(first_rect[0] + first_rect[2], second_rect[0] + second_rect[2])
    bottom = max(first_rect[1] + first_rect[3], second_rect[1] + second_rect[3])
    screen_left, screen_top, screen_right, screen_bottom = bounds
    return (
        max(screen_left - left, min(int(dx), screen_right - right)),
        max(screen_top - top, min(int(dy), screen_bottom - bottom)),
    )


def popup_anchor_y(anchor_rect, popup_height, bounds, anchor_ratio):
    """垂直锚点：anchor_ratio 是花朵中心在弹出窗高度中的位置（0~1），
    0.5=垂直居中，>0.5 偏上，<0.5 偏下。返回 clamped 后的 y。"""
    ay, ah = anchor_rect[1], anchor_rect[3]
    _, top, _, bottom = bounds
    y = ay + ah // 2 - int(popup_height * anchor_ratio)
    return max(top, min(y, bottom - popup_height))


def position_popup_beside(anchor_rect, popup_size, bounds, gap=8, anchor_ratio=0.5):
    """优先放锚点右侧，放不下翻到左侧；垂直方向按 anchor_ratio 锚定。"""
    ax, ay, aw, ah = anchor_rect
    pw, ph = popup_size
    left, top, right, bottom = bounds
    right_x = ax + aw + gap
    left_x = ax - pw - gap
    x = right_x if right_x + pw <= right else left_x
    return (
        max(left, min(x, right - pw)),
        popup_anchor_y(anchor_rect, ph, bounds, anchor_ratio),
    )


def clamp_position(x, y, width, height, left, top, right, bottom, inset=EDGE_INSET):
    min_x = left + inset
    min_y = top + inset
    max_x = max(min_x, right - width - inset + 1)
    max_y = max(min_y, bottom - height - inset + 1)
    return (
        max(min_x, min(int(x), max_x)),
        max(min_y, min(int(y), max_y)),
    )


def resolve_hover_state(hovered, x, y, outside_elapsed, frame_elapsed):
    """进入区与退出区分开，再加离开宽限，避免花朵边缘反复吃到阵风。"""
    margin = HOVER_EXIT_MARGIN if hovered else HOVER_ENTER_MARGIN
    inside = -margin <= x <= BALL_SIZE + margin and \
             -margin <= y <= BALL_SIZE + margin
    if inside:
        return True, 0.0
    if not hovered:
        return False, 0.0
    outside_elapsed += frame_elapsed
    if outside_elapsed >= HOVER_LEAVE_DELAY:
        return False, 0.0
    return True, outside_elapsed


def wind_strength_from_speed(speed):
    """把光标速度平滑映射成有限风力，慢慢靠近也有轻微回应。"""
    ratio = max(0.0, min(float(speed) / FULL_GUST_SPEED, 1.0))
    smooth = ratio * ratio * (3.0 - 2.0 * ratio)
    return MIN_WIND_STRENGTH + (MAX_WIND_STRENGTH - MIN_WIND_STRENGTH) * smooth


def calculate_entry_wind(previous_x, previous_y, current_x, current_y, elapsed, center_x):
    """根据进入前的光标轨迹，判断风从哪边来以及这阵风有多强。"""
    dx = float(current_x) - float(previous_x)
    dy = float(current_y) - float(previous_y)
    seconds = max(float(elapsed), 1.0 / 240.0)
    speed = math.hypot(dx, dy) / seconds
    if float(previous_x) < float(center_x) - 2.0:
        direction = -1.0
    elif float(previous_x) > float(center_x) + 2.0:
        direction = 1.0
    elif abs(dx) >= 2.0:
        direction = -1.0 if dx > 0 else 1.0
    else:
        direction = -1.0 if float(current_x) <= float(center_x) else 1.0
    return direction, wind_strength_from_speed(speed)


def api_get(path, timeout=5):
    with urllib.request.urlopen(API_BASE + path, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_post(path, payload, timeout=12):
    req = urllib.request.Request(
        API_BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
    except Exception as e:
        print(f"[落樱] 保存状态失败: {e}", file=sys.stderr)


# ─────────────────────────────
#  发送方式浮签（替代粗糙的系统 QMenu）
# ─────────────────────────────
class SendModeMenu(QFrame):
    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.setWindowFlags(
            Qt.WindowType.Popup
            | Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("modeMenu")
        self.setFixedWidth(220)

        root = QVBoxLayout(self)
        root.setContentsMargins(14, 14, 14, 12)
        root.setSpacing(7)

        title = QLabel("发送方式")
        title.setObjectName("menuTitle")
        root.addWidget(title)
        subtitle = QLabel("选择推荐语点下去后的动作")
        subtitle.setObjectName("menuSub")
        root.addWidget(subtitle)

        self.btn_send = QPushButton()
        self.btn_send.setObjectName("modeChoice")
        self.btn_send.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_send.clicked.connect(lambda: self._choose("send"))
        root.addWidget(self.btn_send)

        self.btn_copy = QPushButton()
        self.btn_copy.setObjectName("modeChoice")
        self.btn_copy.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_copy.clicked.connect(lambda: self._choose("copy"))
        root.addWidget(self.btn_copy)

        divider = QFrame()
        divider.setObjectName("menuDivider")
        divider.setFixedHeight(1)
        root.addWidget(divider)

        btn_close = QPushButton("关闭解语花")
        btn_close.setObjectName("closeBall")
        btn_close.setCursor(Qt.CursorShape.PointingHandCursor)
        btn_close.clicked.connect(self._quit_ball)
        root.addWidget(btn_close)
        self.apply_theme()

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #modeMenu {{
                background: transparent; border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#menuTitle {{ font-size: 14px; font-weight: 700; color: {c['accent_deep']}; }}
            QLabel#menuSub {{ font-size: 10px; color: {c['sub']}; padding-bottom: 3px; }}
            QPushButton#modeChoice {{
                min-height: 32px; text-align: left; padding: 0 11px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px; font-size: 12px;
            }}
            QPushButton#modeChoice:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QFrame#menuDivider {{ background: {c['border']}; border: none; margin: 3px 5px; }}
            QPushButton#closeBall {{
                min-height: 28px; color: {c['pink']}; background: transparent;
                border: none; border-radius: 9px; font-size: 11px;
            }}
            QPushButton#closeBall:hover {{ background: {c['danger_bg']}; }}
        """)
        self._sync_choices()

    def _sync_choices(self):
        send_on = self.ball.action == "send"
        self.btn_send.setText(("●  " if send_on else "○  ") + "直接发出")
        self.btn_copy.setText(("●  " if not send_on else "○  ") + "复制到剪贴板")

    def _choose(self, action):
        self.ball._set_action(action)
        self._sync_choices()
        self.close()

    def _quit_ball(self):
        self.ball._close_menu()
        self.close()
        QApplication.instance().quit()

    def show_at(self, global_pos):
        self.apply_theme()
        self.adjustSize()
        ball = self.ball
        screen = ball.screen() or QApplication.screenAt(global_pos) or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        # 右键点位只负责触发；浮签始终锚在花朵旁边，避免点在花心时彼此重叠。
        x, y = position_popup_beside(
            (ball.x(), ball.y(), ball.width(), ball.height()),
            (self.width(), self.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            gap=8,
            anchor_ratio=MENU_ANCHOR_RATIO,
        )
        self.move(x, y)
        self.show()
        self.raise_()

    def paintEvent(self, event):
        super().paintEvent(event)
        c = THEME_COLORS[self.ball.theme_mode]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor(c["border"]))
        painter.setBrush(QColor(c["panel"]))
        painter.drawRoundedRect(self.rect().adjusted(1, 1, -1, -1), 16, 16)
        painter.end()


# ─────────────────────────────
#  落樱悬浮球
# ─────────────────────────────
class ZhujianBall(QWidget):
    def __init__(self):
        super().__init__(None)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setFixedSize(BALL_SIZE, BALL_SIZE)

        # 高清预渲染 SVG（花朵，渲染到 RENDER_SIZE = 1200）
        self.pix_flower = self._render_svg_to_pixmap("yinghua-ball.svg", RENDER_SIZE)
        if self.pix_flower.isNull():
            print(f"[落樱] 警告：花朵 SVG 渲染失败，悬浮球会空白", file=sys.stderr)

        self.state = load_state()
        self.action = self.state.get("action") or "copy"
        self.cached = None
        self.target_name = ""
        self.theme_mode = read_hana_theme_mode()
        self.context_menu = None

        # 微风物理：花朵会随来风方向轻摆，移开后慢慢停稳
        self.angle = 0.0
        self.angular_velocity = 0.0
        self.spin_angle = 0.0
        self.spin_velocity = 0.0
        self.hover_wind = 0.0
        self.gust = 0.0
        self.gust_direction = 1.0
        self.hover_strength = 1.0
        self.bloom = 0.0

        # 三态
        self.mode = "rolled"
        self.hovered = False
        self._hover_exit_elapsed = 0.0
        self.click_timer = 0.0

        # 总时长与光标轨迹
        self.t = 0.0
        self._last_ts = time.monotonic()
        cursor = QCursor.pos()
        self._cursor_sample = (cursor.x(), cursor.y(), self._last_ts)

        # 交互
        self._drag = None
        self._press_global = None
        self._moved = False
        self._drag_menu_was_visible = False
        self.menu = None

        timer = QTimer(self)
        timer.timeout.connect(self._tick)
        timer.start(16)

        self.theme_timer = QTimer(self)
        self.theme_timer.timeout.connect(self._sync_theme)
        self.theme_timer.start(1500)

        self._place_from_state()

    def _sync_theme(self):
        mode = read_hana_theme_mode()
        if mode == self.theme_mode:
            return
        self.theme_mode = mode
        if self.menu is not None:
            self.menu.apply_theme()
            self.menu.update()
        if self.context_menu is not None:
            self.context_menu.apply_theme()
            self.context_menu.update()

    # ── SVG 渲染 ──
    def _render_svg_to_pixmap(self, name, size):
        path = os.path.join(HERE, name)
        pix = QPixmap(size, size)
        pix.fill(Qt.GlobalColor.transparent)
        try:
            renderer = QSvgRenderer(path)
            painter = QPainter(pix)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing)
            painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
            renderer.render(painter)
            painter.end()
        except Exception as e:
            print(f"[落樱] 渲染 SVG {name} 失败: {e}", file=sys.stderr)
            return QPixmap()
        return pix

    # ── 位置恢复与屏幕安全 ──
    def _place_from_state(self):
        x = self.state.get("x")
        y = self.state.get("y")
        if x is not None and y is not None:
            self.move(int(x), int(y))
        self._ensure_visible(save=True)

    def _ensure_visible(self, save=False):
        center = QPoint(self.x() + self.width() // 2, self.y() + self.height() // 2)
        screen = QApplication.screenAt(center) or QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()
        x, y = clamp_position(
            self.x(), self.y(), self.width(), self.height(),
            geo.left(), geo.top(), geo.right(), geo.bottom(),
        )
        if x != self.x() or y != self.y():
            self.move(x, y)
            if save:
                self._save_pos()

    def _save_pos(self):
        pos = self.pos()
        self.state["x"] = pos.x()
        self.state["y"] = pos.y()
        save_state(self.state)

    # ── 动画帧 ──
    def _tick(self):
        now = time.monotonic()
        frame_elapsed = max(now - self._last_ts, 0.0)
        dt = min(frame_elapsed, 0.05)
        self._last_ts = now
        self.t += dt

        # 透明异形窗可能漏 enter/leave，每帧读全局光标判定（滞回）
        cursor_global = QCursor.pos()
        cursor = self.mapFromGlobal(cursor_global)
        cursor_hovered, self._hover_exit_elapsed = resolve_hover_state(
            self.hovered, cursor.x(), cursor.y(), self._hover_exit_elapsed, frame_elapsed,
        )
        if cursor_hovered and not self.hovered:
            px, py, pts = self._cursor_sample
            direction, strength = calculate_entry_wind(
                px, py, cursor_global.x(), cursor_global.y(), now - pts,
                self.mapToGlobal(QPoint(BALL_SIZE // 2, BALL_SIZE // 2)).x(),
            )
            self.gust_direction = direction
            self.hover_strength = strength
            self.gust = strength
            self.angular_velocity += 14.0 * direction * strength
        self.hovered = cursor_hovered
        self.mode = "peeking" if self.hovered else "rolled"
        self._cursor_sample = (cursor_global.x(), cursor_global.y(), now)

        # 悬停风来得快、散得慢；和风铃一样保留一小段余韵
        wind_target = 1.0 if self.hovered else 0.0
        wind_tau = 0.14 if self.hovered else 1.10
        self.hover_wind += (wind_target - self.hover_wind) * (1.0 - math.exp(-dt / wind_tau))
        self.gust *= math.exp(-dt / 0.68)
        self.bloom += (self.hover_wind - self.bloom) * (1.0 - math.exp(-dt / 0.22))

        # 三段错拍微风 + 有方向的入场阵风；弹簧阻尼让花自然回正
        base_wind = (
            math.sin(self.t * 0.82)
            + 0.36 * math.sin(self.t * 1.67 + 0.9)
            + 0.14 * math.sin(self.t * 3.15 + 2.2)
        )
        hover_target = self.gust_direction * (
            2.0
            + self.hover_strength * 4.2 * math.sin(self.t * 4.2 + 0.35)
            + self.hover_strength * 1.2 * math.sin(self.t * 7.1 + 1.4)
        )
        target_angle = base_wind * 3.6 * (1.0 - self.hover_wind) + hover_target * self.hover_wind
        target_angle += self.gust_direction * 6.0 * self.gust
        acceleration = (target_angle - self.angle) * 19.0 - self.angular_velocity * 6.2
        self.angular_velocity += acceleration * dt
        self.angle += self.angular_velocity * dt
        self.angle = max(-11.0, min(11.0, self.angle))

        # 点击是一阵短促旋花，随后自然刹住；面板开合逻辑不受动画影响
        if self.click_timer > 0.0:
            self.click_timer = max(0.0, self.click_timer - dt)
        self.spin_angle += self.spin_velocity * dt
        self.spin_velocity *= math.exp(-dt / 0.34)
        if abs(self.spin_velocity) < 0.2:
            self.spin_velocity = 0.0
            self.spin_angle %= 360.0

        self.update()

    # ── 绘制 ──
    def paintEvent(self, _e):
        p = QPainter(self)
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_Source)
        p.fillRect(self.rect(), Qt.GlobalColor.transparent)
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceOver)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)

        cx = BALL_SIZE / 2
        cy = BALL_SIZE / 2
        idle_breath = 0.024 * math.sin(self.t * 1.35)
        click_phase = self.click_timer / CLICK_BURST_DURATION if self.click_timer > 0 else 0.0
        click_pulse = math.sin((1.0 - click_phase) * math.pi) * 0.10 if click_phase else 0.0
        scale = 1.0 + idle_breath + 0.045 * self.bloom + click_pulse
        lift = -1.45 * math.sin(self.t * 1.05) - 1.0 * self.bloom
        self._draw_layer(
            p, self.pix_flower, self.angle + self.spin_angle,
            cx, cy + lift, scale,
        )
        self._draw_pollen_glints(p, cx, cy, self.bloom, click_phase)
        p.end()

    def _draw_layer(self, p, pix, angle, cx, cy, flower_scale=1.0):
        """把高清 SVG 花朵绕中心绘制，并保留四周摇摆余量。"""
        pix_size = pix.width()
        scale = (FLOWER_SIZE / pix_size) * flower_scale
        half = pix_size / 2
        p.save()
        p.translate(cx, cy)
        p.rotate(angle)
        p.scale(scale, scale)
        p.translate(-half, -half)
        p.drawPixmap(0, 0, pix)
        p.restore()

    def _draw_pollen_glints(self, p, cx, cy, hover, click_phase):
        """悬停时浮起三点极淡花粉光，不生成粒子对象，克制且稳定。"""
        strength = max(hover * 0.72, math.sin((1.0 - click_phase) * math.pi) if click_phase else 0.0)
        if strength < 0.03:
            return
        p.save()
        p.setPen(Qt.PenStyle.NoPen)
        for i, (radius, phase) in enumerate(((18.0, 0.2), (21.0, 2.3), (16.0, 4.4))):
            orbit = self.t * (0.72 + i * 0.11) + phase
            x = cx + math.cos(orbit) * radius
            y = cy + math.sin(orbit * 0.86) * (radius * 0.62) - 2.0
            alpha = int(150 * strength * (0.68 + 0.32 * math.sin(orbit * 1.7) ** 2))
            p.setBrush(QColor(239, 191, 105, max(0, min(alpha, 180))))
            dot = 1.15 + i * 0.18
            p.drawEllipse(QPointF(x, y), dot, dot)
        p.restore()

    # ── 鼠标交互 ──
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_menu_was_visible = bool(self.menu and self.menu.isVisible())
            self._press_global = e.globalPosition().toPoint()
            self._drag = self._press_global - self.pos()
            self._moved = False
        e.accept()

    def mouseMoveEvent(self, e):
        if self._drag is not None and (e.buttons() & Qt.MouseButton.LeftButton):
            current = e.globalPosition().toPoint()
            if not self._moved:
                if (current - self._press_global).manhattanLength() < QApplication.startDragDistance():
                    e.accept()
                    return
                self._moved = True
            self.move(current - self._drag)
            self._sync_dragged_menu()
        e.accept()

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._moved:
                self._snap()
                self._save_pos()
                self._sync_dragged_menu()
            else:
                self._toggle_expand()
            self._drag = None
            self._press_global = None
            self._drag_menu_was_visible = False
        elif e.button() == Qt.MouseButton.RightButton:
            self._open_context_menu(e.globalPosition().toPoint())
        e.accept()

    def _sync_dragged_menu(self):
        if not self._drag_menu_was_visible or self.menu is None:
            return
        self.menu.move_to_ball()
        if not self.menu.isVisible():
            self.menu.show()
            self.menu.raise_()

    # ── 贴边吸附 ──
    def _snap(self):
        screen = self.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        margin = 26
        x, y = self.pos().x(), self.pos().y()
        w, h = self.width(), self.height()
        if x < geo.left() + margin:
            x = geo.left() + EDGE_INSET
        elif x + w > geo.right() - margin:
            x = geo.right() - w - EDGE_INSET + 1
        if y < geo.top() + margin:
            y = geo.top() + EDGE_INSET
        elif y + h > geo.bottom() - margin:
            y = geo.bottom() - h - EDGE_INSET + 1
        self.move(x, y)

    # ── 展开 / 收起 ──
    def _toggle_expand(self):
        if self.menu and self.menu.isVisible():
            self._close_menu()
            return
        # 点击像被指尖拨了一下：旋花 + 轻微绽放，同时打开面板
        self.click_timer = CLICK_BURST_DURATION
        self.spin_velocity += 430.0 * self.gust_direction
        self.angular_velocity += 18.0 * self.gust_direction
        self._open_menu()

    def _close_menu(self):
        if self.menu:
            self.menu.close_menu()

    # ── 右键菜单 ──
    def _open_context_menu(self, global_pos):
        if self.context_menu is None:
            self.context_menu = SendModeMenu(self)
        self.context_menu.show_at(global_pos)

    def _set_action(self, action):
        self.action = action
        self.state["action"] = action
        save_state(self.state)
        try:
            api_post("/action", {"action": action}, timeout=5)
        except Exception:
            pass

    # ── 面板 ──
    def _open_menu(self):
        if self.menu is None:
            self.menu = ZhujianMenu(self)
        self.menu.prepare_for_show()
        self.menu.move_to_ball()
        self.menu.show()
        self.menu.raise_()
        self.menu.activateWindow()


# ─────────────────────────────
#  推荐面板（未变动，沿用）
# ─────────────────────────────
class ZhujianMenu(QFrame):
    refresh_ready = pyqtSignal(object)

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("panel")
        self.setFixedWidth(344)
        # 面板边向：默认左；读持久化的 panel_side（贴边换边时写入）
        self.side = str(self.ball.state.get("panel_side") or "left")
        self._refreshing = False
        # 面板拖拽状态：面板与花朵始终作为一组移动
        self._drag_press = None
        self._drag_panel_start = None
        self._drag_ball_start = None
        self._drag_moved = False
        self._needs_reanchor = False  # 本次打开后内容尚未以完整高度锚定过
        self._user_dragged = False    # 本次打开后用户是否手动拖过面板（拖过则尊重手动位置）
        self.refresh_ready.connect(self._apply_async_refresh)
        self._build_ui()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 18, 20, 18)
        root.setSpacing(9)

        head_row = QHBoxLayout()
        head_row.setSpacing(8)
        self.lbl_head = QLabel("解语花")
        self.lbl_head.setObjectName("head")
        self.lbl_target = QLabel("跟随当前对话 · 读取中")
        self.lbl_target.setObjectName("target")
        head_row.addWidget(self.lbl_head)
        head_row.addStretch(1)
        head_row.addWidget(self.lbl_target)
        root.addLayout(head_row)

        self.grid = QGridLayout()
        self.grid.setSpacing(8)
        self.buttons = []
        root.addLayout(self.grid)

        self.lbl_feedback = QLabel("")
        self.lbl_feedback.setObjectName("feedback")
        root.addWidget(self.lbl_feedback)

        row_refresh = QHBoxLayout()
        row_refresh.setSpacing(8)
        self.btn_refresh = QPushButton("刷新推荐")
        self.btn_refresh.setObjectName("refreshBtn")
        self.btn_refresh.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_refresh.clicked.connect(self.refresh_async)
        row_refresh.addWidget(self.btn_refresh)
        self.lbl_cache_time = QLabel("")
        self.lbl_cache_time.setObjectName("cacheTime")
        row_refresh.addWidget(self.lbl_cache_time)
        row_refresh.addStretch(1)
        root.addLayout(row_refresh)

        self.lbl_hint = QLabel("")
        self.lbl_hint.setObjectName("hint")
        self.lbl_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(self.lbl_hint)
        self.apply_theme()

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #panel {{
                background: transparent; border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ color: {c['ink']}; background: transparent; }}
            QLabel#head {{ color: {c['accent_deep']}; font-size: 15px; font-weight: 700; }}
            QLabel#target {{
                color: {c['sub']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 9px;
                font-size: 10px; padding: 3px 8px;
            }}
            QLabel#hint {{ color: {c['sub']}; font-size: 11px; padding: 2px 0; }}
            QLabel#cacheTime {{ color: {c['sub']}; font-size: 10px; }}
            QPushButton#refreshBtn {{
                min-height: 28px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 10px;
                font-size: 11px; font-weight: 600; padding: 0 13px;
            }}
            QPushButton#refreshBtn:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#refreshBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QLabel#feedback {{ color: {c['pink']}; font-size: 11px; font-weight: 600; }}
            QLabel#rec {{
                background: {c['surface']}; color: {c['ink']};
                border: 1px solid {c['border']}; border-radius: 14px; font-size: 13px;
            }}
            QLabel#rec:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
        """)

    def prepare_for_show(self):
        self._needs_reanchor = True
        self._user_dragged = False
        self._flash("")
        self._update_target()
        cached = self.ball.cached
        if cached and cached.get("items"):
            self._render_items(cached["items"])
        else:
            self._render_empty()
        self.load_cache_async()

    def load_cache_async(self):
        def worker():
            try:
                data = api_get("/cache", timeout=4)
                if data.get("ok") and data.get("cached") and data["cached"].get("items"):
                    self.refresh_ready.emit({
                        "items": data["cached"]["items"],
                        "rid": data["cached"].get("rid") or "",
                        "ts": data["cached"].get("ts") or 0,
                        "target": data["cached"].get("target"),
                        "fromCache": True,
                    })
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-cache").start()

    def refresh_async(self):
        if self._refreshing:
            return
        self._refreshing = True
        self._set_refreshing_ui(True)

        def worker():
            payload = {"items": None, "rid": None, "target": None, "error": None}
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok") and data.get("target"):
                    payload["target"] = data["target"]
            except Exception:
                pass
            try:
                data = api_get("/suggest", timeout=30)
                if data.get("ok"):
                    payload["items"] = data.get("items") or []
                    payload["rid"] = data.get("rid") or ""
                    # 兜底：/target 超时但 /suggest 成功时，从生成响应补 target
                    if data.get("target") and not payload["target"]:
                        payload["target"] = data["target"]
            except Exception as e:
                payload["error"] = str(e)
            try:
                self.refresh_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-refresh").start()

    def _apply_async_refresh(self, payload):
        self._refreshing = False
        self._set_refreshing_ui(False)
        if payload.get("target"):
            self.ball.target_name = payload["target"].get("name") or payload["target"].get("agentId") or ""
        self._update_target()
        if payload.get("items"):
            ts = payload.get("ts") or (int(time.time() * 1000) if not payload.get("fromCache") else (self.ball.cached or {}).get("ts") or 0)
            self.ball.cached = {"items": payload["items"], "rid": payload["rid"], "ts": ts}
            self._render_items(payload["items"])
        elif payload.get("error"):
            self._render_error(payload["error"])

    def _render_empty(self):
        self._clear_buttons()
        lbl = QLabel("点「刷新推荐」生成一批")
        lbl.setObjectName("hint")
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.grid.addWidget(lbl, 0, 0)
        self.lbl_cache_time.setText("")
        self.keep_current_position()

    def _render_loading(self):
        self._clear_buttons()
        lbl = QLabel("正在取推荐…")
        lbl.setObjectName("hint")
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.grid.addWidget(lbl, 0, 0)
        self.lbl_hint.setText("")
        self.keep_current_position()

    def _set_refreshing_ui(self, refreshing):
        self.btn_refresh.setEnabled(not refreshing)
        self.btn_refresh.setText("正在取推荐…" if refreshing else "刷新推荐")

    def _update_cache_time(self):
        ts = (self.ball.cached or {}).get("ts") or 0
        if ts:
            self.lbl_cache_time.setText(f"上次生成 {time.strftime('%H:%M', time.localtime(ts / 1000))}")
        else:
            self.lbl_cache_time.setText("")

    def _render_error(self, err):
        self._clear_buttons()
        lbl = QLabel("推荐生成失败，再点一次试试")
        lbl.setObjectName("hint")
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.grid.addWidget(lbl, 0, 0)
        self._flash("")
        self.keep_current_position()

    def _render_items(self, items):
        self._clear_buttons()
        self.buttons = []
        for i, item in enumerate(items):
            text = item.get("text") or ""
            if not text:
                continue
            lbl = RecLabel(text, i)
            lbl.setObjectName("rec")
            lbl.clicked.connect(self._pick)
            self.grid.addWidget(lbl, i, 0)
            self.buttons.append(lbl)
        self._update_hint()
        self._update_cache_time()
        self.keep_current_position(full_height=True)

    def _clear_buttons(self):
        while self.grid.count():
            item = self.grid.takeAt(0)
            w = item.widget()
            if w:
                w.hide()
                w.deleteLater()
        self.buttons = []

    def _pick(self, index):
        items = self.ball.cached.get("items") if self.ball.cached else None
        if not items or index >= len(items):
            self._flash("推荐已失效，重新打开试试")
            return
        item = items[index]
        text = item.get("text") or ""
        if not text:
            return
        rid = (self.ball.cached or {}).get("rid") or ""
        action = self.ball.action
        self._flash("正在发送…" if action == "send" else "正在复制…")
        try:
            if action == "send":
                res = api_post("/apply", {"rid": rid, "index": index}, timeout=20)
                if res.get("ok"):
                    self._flash("已发送 ✓")
                else:
                    self._flash(res.get("error") or "发送失败")
            else:
                res = api_post("/copy", {"rid": rid, "index": index}, timeout=8)
                if res.get("ok") and res.get("text"):
                    self._copy_to_clipboard(res["text"])
                    self._flash("已复制 ✓")
                else:
                    self._flash(res.get("error") or "复制失败")
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode("utf-8"))
                self._flash(body.get("error") or f"出错了 ({e.code})")
            except Exception:
                self._flash(f"出错了 ({e.code})")
        except Exception:
            self._flash("连不上解语花，看看插件开着没")

    def _copy_to_clipboard(self, text):
        try:
            from PyQt6.QtGui import QGuiApplication
            QGuiApplication.clipboard().setText(text)
        except Exception:
            pass

    def _update_target(self):
        name = self.ball.target_name
        self.lbl_target.setText(f"跟随当前对话 · {name}" if name else "跟随当前对话 · 读取中")

    def _update_hint(self):
        action = self.ball.action
        self.lbl_hint.setText("点一下直接发出" if action == "send" else "点一下复制，粘到输入框发出")
        self._flash("")

    def _flash(self, text):
        self.lbl_feedback.setText(text)

    def keep_current_position(self, full_height=False):
        """
        保持/校正面板位置。full_height=True 表示本次渲染是完整内容高度
        （推荐条已就绪），此时若尚未正式锚定则按花朵重新锚定，保证每次
        打开最终位置一致；内容未就绪时先贴近花朵，避免闪现左上角。
        """
        if self._user_dragged:
            # 用户拖过面板：尊重手动位置，内容变化只保持
            self._needs_reanchor = False
        elif full_height and self._needs_reanchor:
            # 布局尺寸要在事件循环跑过两轮后才稳定：第一轮给推荐条分配宽度，
            # 第二轮换行高度才生效。延迟锚定保证用真实全高计算位置。
            self._needs_reanchor = False
            QTimer.singleShot(0, lambda: QTimer.singleShot(0, self._reanchor_once))
            return
        elif self._needs_reanchor:
            # 内容未就绪（空/加载中）：先贴到花朵旁边，等 full_height 时正式锚定
            self.move_to_ball()
            return
        self._sync_size()
        screen = self.ball.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
        y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
        self.move(x, y)

    def _reanchor_once(self):
        """延迟锚定：等布局稳定后按花朵重新定位（用于内容就绪后的首次锚定）。"""
        if not self.isVisible():
            return
        self.move_to_ball()

    def _sync_size(self):
        """同步布局后 adjustSize：刚 addWidget 的内容在事件循环前 sizeHint 未生效，
        直接 adjustSize 会拿到旧高度导致锚定漂移（首次打开位置不一致的根因）。"""
        if self.layout() is not None:
            self.layout().activate()
        self.adjustSize()

    def move_to_ball(self):
        self._sync_size()
        b = self.ball
        screen = b.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        bw = b.width()
        bh = b.height()
        # 球在中间时保持记住的边向，移开后不弹回
        snap_margin = 26
        if b.x() + bw > geo.right() - snap_margin:
            side = "left"      # 球贴右缘 → 面板翻到左边
        elif b.x() < geo.left() + snap_margin:
            side = "right"     # 球贴左缘 → 面板翻到右边
        else:
            side = self.side   # 中间：保持当前边向
        if side != self.side:
            self.side = side
            b.state["panel_side"] = side
            save_state(b.state)
        # 按边向放面板；当前侧放不下（窄屏/球太靠边）自动翻另一侧兜底
        if side == "left":
            x = b.x() - self.width() - 8
            if x < geo.left():
                side = "right"
                x = b.x() + bw + 8
        else:
            x = b.x() + bw + 8
            if x + self.width() > geo.right():
                side = "left"
                x = b.x() - self.width() - 8
        if side != self.side:
            self.side = side
            b.state["panel_side"] = side
            save_state(b.state)
        x = max(geo.left(), min(x, geo.right() - self.width() + 1))
        y = popup_anchor_y(
            (b.x(), b.y(), bw, bh), self.height(),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            PANEL_ANCHOR_RATIO,
        )
        self.move(x, y)

    def close_menu(self):
        self.hide()

    def showEvent(self, event):
        super().showEvent(event)
        self.activateWindow()

    def hideEvent(self, event):
        super().hideEvent(event)

    # ── 面板拖拽：按住空白处时，展板与花朵保持原距离一起移动 ──
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_press = e.globalPosition().toPoint()
            self._drag_panel_start = self.pos()
            self._drag_ball_start = self.ball.pos()
            self._drag_moved = False
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._drag_press is not None and (e.buttons() & Qt.MouseButton.LeftButton):
            cur = e.globalPosition().toPoint()
            delta = cur - self._drag_press
            if not self._drag_moved:
                if delta.manhattanLength() < QApplication.startDragDistance():
                    return
                self._drag_moved = True
                self._user_dragged = True
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry()
            dx, dy = clamp_pair_drag(
                delta.x(), delta.y(),
                (self._drag_panel_start.x(), self._drag_panel_start.y(), self.width(), self.height()),
                (self._drag_ball_start.x(), self._drag_ball_start.y(), self.ball.width(), self.ball.height()),
                (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            )
            self.move(self._drag_panel_start + QPoint(dx, dy))
            self.ball.move(self._drag_ball_start + QPoint(dx, dy))
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._drag_moved:
                self.ball._save_pos()
            self._drag_press = None
            self._drag_panel_start = None
            self._drag_ball_start = None
            self._drag_moved = False
        super().mouseReleaseEvent(e)

    def paintEvent(self, event):
        super().paintEvent(event)
        c = THEME_COLORS[self.ball.theme_mode]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        shadow = QColor(c["shadow"])
        shadow.setAlpha(28 if self.ball.theme_mode == "light" else 52)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(shadow)
        painter.drawRoundedRect(self.rect().adjusted(7, 8, -5, -3), 20, 20)

        painter.setPen(QColor(c["border"]))
        painter.setBrush(QColor(c["panel"]))
        painter.drawRoundedRect(self.rect().adjusted(4, 3, -4, -6), 20, 20)

        accent = QColor(c["pink"])
        accent.setAlpha(175)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(accent)
        painter.drawEllipse(QPointF(22, 19), 2.2, 2.2)
        painter.end()


# ─────────────────────────────
#  入口
# ─────────────────────────────
def main():
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    ball = ZhujianBall()
    ball.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
