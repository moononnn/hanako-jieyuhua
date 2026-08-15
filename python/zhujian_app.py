#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
解语花 · 落樱悬浮球
=====================
桌面悬浮「落樱」：一枝会呼吸、会受风的小樱花。
常态轻浮轻摆；悬停时零碎落瓣；按下时枝条蓄力弯曲，松手后快速回弹并洒落花瓣。

三态：
  ROLLED   （常态）  花枝微摆 + 旧版体量花朵
  PEEKING  （悬停）  入场阵风 + 一两枚碎瓣飘落
  CLICK    （按压）  枝条压弯蓄力 → 松手越界回弹 + 两次花瓣簇

渲染：三个完整 SVG → pixmap 高清缩放（细枝 / 花朵 / 跟随叶），
通过共同支点、弹簧阻尼和不同重量的相位差形成局部物理。

通信：只调解语花插件的本地代理端口（127.0.0.1:18903），
推荐生成 / 发送全部由插件进程执行，Python 只发 HTTP 和画 UI。

启动: python zhujian_app.py
环境变量:
  JIEGEHUA_API        解语花本地代理地址（默认 http://127.0.0.1:18903）
  JIEGEHUA_API_TOKEN  提问面板本地通道令牌（由插件进程注入）
  HANA_HOME            Hana 数据目录（存状态文件用）
"""

import sys
import os
import json
import math
import random
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
    QApplication, QWidget, QPushButton, QLabel, QFrame, QLineEdit, QScrollArea,
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


# ── 提问选项：复用推荐展板，不另开第二个窗口 ──
class AskChoiceLabel(QLabel):
    clicked = pyqtSignal()

    def __init__(self, text):
        super().__init__(text)
        self.setObjectName("askChoice")
        self.setWordWrap(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        self.setContentsMargins(10, 8, 10, 8)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self.isEnabled():
            self.clicked.emit()
        e.accept()


class AskOptionFrame(QFrame):
    # 提问作答强制直接回传：点击选项/发送按钮走 /ask/respond 的 deferred 通道，
    # 与推荐条的「直接发出/复制到剪贴板」模式（ball.action）完全无关，
    # 复制模式的用户点这里也是直接作答。改这条链路时不要接进 ball.action 分支。
    def __init__(self, label, description="", recommended=False):
        super().__init__()
        self.setObjectName("askOption")
        # 垂直 Expanding：同排选项在 QGridLayout 里等高（行高取最高卡片），文字超了整排一起放大
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        head = QHBoxLayout()
        head.setContentsMargins(0, 0, 0, 0)
        head.setSpacing(3)
        self.choice_label = AskChoiceLabel(label)
        head.addWidget(self.choice_label, 1)
        if recommended:
            badge = QLabel("推荐")
            badge.setObjectName("askRecommended")
            head.addWidget(badge, 0, Qt.AlignmentFlag.AlignTop)
        layout.addLayout(head)
        if description:
            detail = QLabel(description)
            detail.setObjectName("askDescription")
            detail.setWordWrap(True)
            detail.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
            layout.addWidget(detail)
        # 弹性吸收：等高拉伸后内容顶部对齐，底部空白均匀
        layout.addStretch(1)


def latest_ask_pending(pending):
    """只展示最新一条提问；旧提问留在服务端等过期/清理。"""
    if not isinstance(pending, list):
        return None
    valid = [item for item in pending if isinstance(item, dict) and item.get("askId")]
    if not valid:
        return None

    def timestamp(item):
        try:
            return int(item.get("ts") or 0)
        except (TypeError, ValueError):
            return 0

    return max(valid, key=timestamp)


def normalize_custom_answer(text):
    return str(text or "").strip()[:ASK_INPUT_MAX_LENGTH]


API_BASE = os.environ.get("JIEGEHUA_API", "http://127.0.0.1:18903")
API_TOKEN = os.environ.get("JIEGEHUA_API_TOKEN", "")
HANA_HOME = os.environ.get("HANA_HOME", os.path.join(os.path.expanduser("~"), ".hanako"))
STATE_PATH = os.path.join(HANA_HOME, "data", "jiegehua", "zhujian-state.json")
PREFERENCES_PATH = os.path.join(HANA_HOME, "user", "preferences.json")
HERE = os.path.dirname(os.path.abspath(__file__))

# ── 尺寸与渲染 ──
BALL_SIZE = 80            # 透明悬浮窗尺寸；给花枝与跟随叶留出完整摇摆空间
FLOWER_SIZE = 34          # 恢复旧版花朵体量；枝条、叶片与80px窗口保持新版结构
BRANCH_SIZE = 80          # 主枝横穿透明窗并在两侧被裁断，暗示树冠延伸到画面外
LEAF_SIZE = 56            # SVG 画布留白较多，放大后叶片本体约 18px
SVG_SIZE = 400            # SVG 输出基准尺寸
RENDER_SCALE = 3          # 高清渲染倍率
RENDER_SIZE = SVG_SIZE * RENDER_SCALE
FLOWER_CENTER = (50.0, 46.0)
LEAF_CENTER = (31.0, 21.0)   # 叶柄贴在主枝与细枝的分叉附近
BRANCH_PIVOT = (0.5, 31.5)   # 主枝从左边界进入，绕画外树身连接处轻摆

# ── 微风动效参数 ──
MIN_WIND_STRENGTH = 0.55
MAX_WIND_STRENGTH = 1.35
FULL_GUST_SPEED = 1100.0
HOVER_PETAL_INTERVAL = (0.26, 0.52)
PRESS_PETAL_COUNT = 11
RELEASE_PETAL_COUNT = 16
SWEEP_FADE_START = 24.0
SWEEP_MIN_SPEED = 45.0
SWEEP_PETAL_SPEED = 210.0
MAX_PETAL_PARTICLES = 48

# ── 鼠标 hover 滞回 ──
EDGE_INSET = 16
HOVER_ENTER_MARGIN = 4
HOVER_EXIT_MARGIN = 12
HOVER_LEAVE_DELAY = 0.24

# ── 弹出窗垂直锚点（花朵中心位于弹出窗高度中的比例，0.5=居中） ──
PANEL_ANCHOR_RATIO = 0.38   # 左键推荐面板：花在面板上部，面板主体在花下方（实机确认）
MENU_ANCHOR_RATIO = 0.33    # 右键发送浮签：主体在花下方，与面板视觉呼应
TARGET_SESSION_LIMIT = 5    # 目标选择只展示最近活跃的 5 个窗口，避免面板过长
ASK_INPUT_MAX_LENGTH = 200  # 自定义回答上限，和服务端校验保持一致
ASK_POLL_INTERVAL_MS = 1500
ASK_PANEL_MAX_HEIGHT = 600

# ── 手帐风配色：保留落樱自己的薄荷绿与粉色，明暗随 Hana 切换 ──
DARK_THEME_IDS = {"midnight", "midnight-contrast"}
THEME_COLORS = {
    "light": {
        "panel": "#fbf8ef", "surface": "#fffdf7", "surface_alt": "#eef6f1",
        "border": "#b6d1c4", "ink": "#3e4b43", "sub": "#7f8e85", "sub_deep": "#6b7a71",
        "accent": "#5b9a82", "accent_deep": "#3f705d", "accent_text": "#ffffff",
        "pink": "#d893a6", "danger_bg": "#f9edf0", "shadow": "#526a60",
    },
    "dark": {
        "panel": "#384850", "surface": "#42545c", "surface_alt": "#465c5c",
        "border": "#6b877d", "ink": "#e7efeb", "sub": "#b5c4bd", "sub_deep": "#a4b4ac",
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


def point_in_flower_zone(x, y, margin=0.0):
    """只沿主枝、叶片和花朵附近响应，避免透明窗四角提前吃掉入场阵风。"""
    x = float(x)
    y = float(y)
    margin = max(0.0, float(margin))
    on_branch = -margin <= x <= BALL_SIZE + margin and 8.0 - margin <= y <= 36.0 + margin
    flower_rx = 19.0 + margin
    flower_ry = 18.0 + margin
    on_flower = (
        ((x - FLOWER_CENTER[0]) / flower_rx) ** 2
        + ((y - FLOWER_CENTER[1]) / flower_ry) ** 2
        <= 1.0
    )
    leaf_rx = 18.0 + margin
    leaf_ry = 14.0 + margin
    on_leaf = (
        ((x - LEAF_CENTER[0]) / leaf_rx) ** 2
        + ((y - LEAF_CENTER[1]) / leaf_ry) ** 2
        <= 1.0
    )
    return on_branch or on_flower or on_leaf


def segment_crosses_flower_zone(x1, y1, x2, y2, margin=0.0):
    """采样两帧间的整段轨迹，防止高速光标从区域外直接穿过花枝。"""
    distance = math.hypot(float(x2) - float(x1), float(y2) - float(y1))
    steps = max(1, min(int(math.ceil(distance / 3.0)), 48))
    for index in range(steps + 1):
        ratio = index / steps
        x = float(x1) + (float(x2) - float(x1)) * ratio
        y = float(y1) + (float(y2) - float(y1)) * ratio
        if point_in_flower_zone(x, y, margin):
            return True
    return False


def resolve_hover_state(hovered, x, y, outside_elapsed, frame_elapsed):
    """沿可见花枝做进出滞回和离开宽限，避免透明区提前触发。"""
    margin = HOVER_EXIT_MARGIN if hovered else HOVER_ENTER_MARGIN
    if point_in_flower_zone(x, y, margin):
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


def sweep_strength_from_speed(speed):
    speed = max(0.0, float(speed))
    if speed <= SWEEP_FADE_START:
        return 0.0
    fade_ratio = max(0.0, min((speed - SWEEP_FADE_START) / (SWEEP_MIN_SPEED * 2.0), 1.0))
    fade = fade_ratio * fade_ratio * (3.0 - 2.0 * fade_ratio)
    return wind_strength_from_speed(speed) * fade


def calculate_entry_wind(previous_x, previous_y, current_x, current_y, elapsed, center_x):
    """进入风与连续风使用同一方向语义和渐入强度，避免刚进来先反向抽动。"""
    dx = float(current_x) - float(previous_x)
    dy = float(current_y) - float(previous_y)
    seconds = max(float(elapsed), 1.0 / 240.0)
    speed = math.hypot(dx, dy) / seconds
    if abs(dx) >= abs(dy) * 0.42 and abs(dx) >= 0.55:
        direction = -1.0 if dx > 0.0 else 1.0
    elif abs(dy) >= 0.55:
        direction = -1.0 if dy > 0.0 else 1.0
    else:
        direction = -1.0 if float(current_x) <= float(center_x) else 1.0
    return direction, sweep_strength_from_speed(speed)


def should_apply_cursor_sweep(cursor_hovered, pressed, dragging):
    return bool(cursor_hovered and not pressed and not dragging)


def calculate_cursor_sweep(previous_x, previous_y, current_x, current_y, elapsed):
    """连续读取掠过轨迹；风力从零渐入，避免阈值附近突然跳档。"""
    dx = float(current_x) - float(previous_x)
    dy = float(current_y) - float(previous_y)
    distance = math.hypot(dx, dy)
    seconds = max(float(elapsed), 1.0 / 240.0)
    speed = distance / seconds
    if speed < SWEEP_FADE_START or distance < 0.55:
        return 0.0, 0.0, speed, 0.0, 0.0
    if abs(dx) >= abs(dy) * 0.42:
        direction = -1.0 if dx > 0.0 else 1.0
    else:
        direction = -1.0 if dy > 0.0 else 1.0
    strength = sweep_strength_from_speed(speed)
    return direction, strength, speed, dx / seconds, dy / seconds


def petal_count_from_sweep_speed(speed):
    """掠风按速度落 3/5/7/9 枚，最高仍低于按下时的 11 枚。"""
    speed = max(0.0, float(speed))
    if speed < SWEEP_PETAL_SPEED:
        return 0
    if speed < 560.0:
        return 3
    if speed < 920.0:
        return 5
    if speed < 1500.0:
        return 7
    return 9


def cursor_wind_components(velocity_x, velocity_y, strength, direction):
    """左右掠过负责横摆，上下掠过负责花头升降，斜向则按比例混合。"""
    velocity_x = float(velocity_x)
    velocity_y = float(velocity_y)
    axis_total = max(abs(velocity_x) + abs(velocity_y), 1.0)
    horizontal = float(direction) * float(strength) * abs(velocity_x) / axis_total
    vertical_sign = 1.0 if velocity_y > 0.0 else -1.0 if velocity_y < 0.0 else 0.0
    vertical = vertical_sign * float(strength) * abs(velocity_y) / axis_total
    return horizontal, vertical


def component_motion(t, bloom, gust, direction, rebound_pulse=0.0):
    """花枝先受力，花朵随后，叶片拖尾；左右来风保持镜像。"""
    bloom = max(0.0, min(float(bloom), 1.0))
    gust = max(0.0, float(gust))
    direction = -1.0 if float(direction) < 0.0 else 1.0
    rebound_pulse = max(0.0, min(float(rebound_pulse), 1.0))
    branch = direction * gust * 1.15 + bloom * 0.45 * math.sin(float(t) * 3.1)
    flower = direction * gust * 0.72 + bloom * 0.78 * math.sin(float(t) * 3.8 + 0.48)
    leaf = direction * gust * 4.8 + bloom * 3.2 * math.sin(float(t) * 4.15 + 1.18)
    flower += direction * rebound_pulse * 1.25
    leaf += direction * rebound_pulse * 7.5
    return branch, flower, leaf


def advance_press_spring(amount, velocity, pressed, dt):
    """按住时蓄力下压，松开后快速越过原位并衰减回弹。"""
    dt = max(0.0, min(float(dt), 0.05))
    target = 1.0 if pressed else 0.0
    stiffness = 82.0 if pressed else 118.0
    damping = 16.0 if pressed else 10.5
    acceleration = (target - float(amount)) * stiffness - float(velocity) * damping
    velocity = float(velocity) + acceleration * dt
    amount = float(amount) + velocity * dt
    amount = max(-0.34, min(amount, 1.08))
    return amount, velocity


def rotate_point_around(x, y, pivot_x, pivot_y, angle_degrees):
    """把局部点绕枝条支点旋转，供粒子从真实花心附近生成。"""
    radians = math.radians(float(angle_degrees))
    dx = float(x) - float(pivot_x)
    dy = float(y) - float(pivot_y)
    cosine = math.cos(radians)
    sine = math.sin(radians)
    return (
        float(pivot_x) + dx * cosine - dy * sine,
        float(pivot_y) + dx * sine + dy * cosine,
    )


def _api_headers(extra=None):
    headers = dict(extra or {})
    if API_TOKEN:
        headers["X-Jiegehua-Token"] = API_TOKEN
    return headers


def api_get(path, timeout=5):
    req = urllib.request.Request(API_BASE + path, headers=_api_headers())
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_post(path, payload, timeout=12):
    req = urllib.request.Request(
        API_BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers=_api_headers({"Content-Type": "application/json"}),
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
#  推荐目标选择浮签（面板右上角下拉）
# ─────────────────────────────
class TargetMenu(QFrame):
    """最近对话（默认）/ 固定指定会话。
    数据来自代理 /sessions；选择通过 /pin 写入，重启后仍保持。"""

    sessions_ready = pyqtSignal(object)

    def __init__(self, panel):
        super().__init__(panel)
        self.panel = panel
        self.ball = panel.ball
        self.sessions = []
        self.loading_sessions = False
        self.sessions_error = ""
        self._request_seq = 0
        self.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
        self.sessions_ready.connect(self._apply_sessions)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("targetMenu")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 11, 12, 11)
        root.setSpacing(6)

        title = QLabel("推荐回复参考哪段对话？")
        title.setObjectName("menuTitle")
        root.addWidget(title)

        mode_row = QHBoxLayout()
        mode_row.setSpacing(6)
        self.btn_auto = QPushButton("自动判断")
        self.btn_auto.setObjectName("modeChoice")
        self.btn_auto.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_auto.clicked.connect(self._pick_auto)
        mode_row.addWidget(self.btn_auto)
        self.btn_fixed = QPushButton("自己选择")
        self.btn_fixed.setObjectName("modeChoice")
        self.btn_fixed.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_fixed.clicked.connect(self._show_fixed)
        mode_row.addWidget(self.btn_fixed)
        root.addLayout(mode_row)

        self.lbl_mode_hint = QLabel("")
        self.lbl_mode_hint.setObjectName("menuSub")
        self.lbl_mode_hint.setWordWrap(True)
        root.addWidget(self.lbl_mode_hint)

        self.list_host = QWidget(self)
        self.list_host.setObjectName("targetListHost")
        self.list_box = QVBoxLayout(self.list_host)
        self.list_box.setContentsMargins(0, 0, 0, 0)
        self.list_box.setSpacing(5)
        root.addWidget(self.list_host)
        self.apply_theme()

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #targetMenu {{ background: transparent; border: none; font-family: "LXGW WenKai", "Microsoft YaHei UI"; }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#menuTitle {{ font-size: 13px; font-weight: 700; color: {c['accent_deep']}; }}
            QLabel#menuSub {{ font-size: 10px; color: {c['sub']}; padding-bottom: 2px; }}
            QPushButton#modeChoice {{
                min-height: 32px; padding: 0 10px;
                color: {c['sub']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px; font-size: 12px;
            }}
            QPushButton#modeChoice:hover {{ color: {c['accent_deep']}; background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QPushButton#modeChoice[active="true"] {{
                color: {c['accent_text']}; background: {c['accent']};
                border-color: {c['accent']}; font-weight: 600;
            }}
            QWidget#targetListHost {{ background: transparent; border: none; }}
            QPushButton#sessionItem {{
                min-height: 30px; max-height: 30px; text-align: left; padding: 0 9px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px; font-size: 11px;
            }}
            QPushButton#sessionItem:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QPushButton#sessionItem[active="true"] {{
                color: {c['accent_deep']}; border-color: {c['accent']};
                background: {c['surface_alt']};
            }}
        """)
        self._sync_ui()

    def _clear_list(self):
        while self.list_box.count():
            item = self.list_box.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()

    def _sync_ui(self):
        auto_on = self.view_mode == "auto"
        self.btn_auto.setProperty("active", "true" if auto_on else "false")
        self.btn_fixed.setProperty("active", "false" if auto_on else "true")
        self.btn_auto.style().unpolish(self.btn_auto)
        self.btn_auto.style().polish(self.btn_auto)
        self.btn_fixed.style().unpolish(self.btn_fixed)
        self.btn_fixed.style().polish(self.btn_fixed)
        self.lbl_mode_hint.setText(
            "刷新时自动判断最近活跃的对话" if auto_on
            else "从下面最近活跃的 5 个对话中固定一个"
        )
        self.list_host.setVisible(not auto_on)
        self._clear_list()
        if self.loading_sessions:
            lbl = QLabel("正在读取对话列表…")
            lbl.setObjectName("menuSub")
            lbl.setStyleSheet(f"color: {THEME_COLORS[self.ball.theme_mode]['sub']}; font-size: 11px;")
            self.list_box.addWidget(lbl)
            return
        if self.sessions_error:
            lbl = QLabel(self.sessions_error)
            lbl.setObjectName("menuSub")
            lbl.setStyleSheet(f"color: {THEME_COLORS[self.ball.theme_mode]['sub']}; font-size: 11px;")
            self.list_box.addWidget(lbl)
            return
        if not self.sessions:
            lbl = QLabel("还没读取到可选对话")
            lbl.setObjectName("menuSub")
            lbl.setStyleSheet(f"color: {THEME_COLORS[self.ball.theme_mode]['sub']}; font-size: 11px;")
            self.list_box.addWidget(lbl)
            return
        for s in self.sessions:
            name = s.get("agentName") or s.get("agentId") or "未命名助手"
            title = (s.get("title") or "未命名对话").strip()
            ts = s.get("lastUserTime") or 0
            when = time.strftime("%H:%M", time.localtime(ts / 1000)) if ts else ""
            meta = f"{name} · {when}" if when else name
            btn = QPushButton()
            btn.setObjectName("sessionItem")
            btn.setText(btn.fontMetrics().elidedText(title, Qt.TextElideMode.ElideRight, 246))
            btn.setToolTip(f"{title}\n{meta}")
            btn.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setProperty("active", "true" if (self.ball.pinned_target and self.ball.pinned_target.get("sessionPath") == s.get("sessionPath")) else "false")
            btn.clicked.connect(lambda checked=False, s=s: self._pick(s))
            self.list_box.addWidget(btn)
        self.list_box.addStretch(1)

    def _show_fixed(self):
        self.view_mode = "pinned"
        self._sync_ui()
        self.panel._resize_after_target_change()

    def _pick_auto(self):
        self._request_seq += 1
        self.panel.invalidate_target_sync()
        try:
            result = api_post("/pin", {}, timeout=5)
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or "切换失败")
        except Exception:
            self.lbl_mode_hint.setText("切换失败，稍后再试")
            self.panel._flash("切换失败，原来的选择没有改变")
            return
        self.view_mode = "auto"
        self.ball.target_mode = "auto"
        self.ball.pinned_target = None
        self.ball.target_name = ""
        self.ball.target_title = ""
        self.panel._update_target()
        self.panel._flash("已改为自动判断活跃窗口 ✓")
        self.panel._sync_target_state()
        self.panel._set_target_selector_visible(False)

    def _pick(self, s):
        self._request_seq += 1
        self.panel.invalidate_target_sync()
        try:
            result = api_post("/pin", {
                "sessionPath": s.get("sessionPath") or "",
                "agentId": s.get("agentId") or "",
                "title": s.get("title") or "",
            }, timeout=5)
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or "固定失败")
        except Exception:
            self.lbl_mode_hint.setText("固定失败，原来的选择没有改变")
            self.panel._flash("固定失败，原来的选择没有改变")
            return
        self.view_mode = "pinned"
        self.ball.target_mode = "pinned"
        self.ball.pinned_target = {"sessionPath": s.get("sessionPath") or "", "title": s.get("title") or ""}
        self.ball.target_name = s.get("agentName") or s.get("agentId") or ""
        self.ball.target_title = s.get("title") or ""
        self.panel._update_target()
        self.panel._flash("已固定这段对话 ✓")
        self.panel._set_target_selector_visible(False)

    def refresh_sessions_async(self):
        self._request_seq += 1
        request_seq = self._request_seq
        self.loading_sessions = True
        self.sessions_error = ""
        self._sync_ui()

        def worker():
            payload = {"seq": request_seq, "sessions": [], "mode": self.ball.target_mode, "pinned": self.ball.pinned_target, "error": "读取失败，关闭后重开再试"}
            try:
                data = api_get("/sessions", timeout=5)
                if data.get("ok"):
                    payload = {
                        "seq": request_seq,
                        "sessions": data.get("sessions") or [],
                        "mode": "pinned" if data.get("mode") == "pinned" else "auto",
                        "pinned": data.get("pinned"),
                        "error": "",
                    }
            except Exception:
                pass
            try:
                self.sessions_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-targetlist").start()

    def _apply_sessions(self, payload):
        if payload.get("seq") != self._request_seq:
            return
        self.loading_sessions = False
        self.sessions_error = payload.get("error") or ""
        self.sessions = (payload.get("sessions") or [])[:TARGET_SESSION_LIMIT]
        self.ball.target_mode = payload.get("mode") or "auto"
        self.ball.pinned_target = payload.get("pinned")
        self.view_mode = "pinned" if self.ball.target_mode == "pinned" else self.view_mode
        self.apply_theme()
        self.panel._update_target()
        self.panel._resize_after_target_change()

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
    ask_ready = pyqtSignal(object)

    def __init__(self):
        super().__init__(None)
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setFixedSize(BALL_SIZE, BALL_SIZE)

        # 三个完整 SVG 各自预渲染：花枝定结构，花朵作主体，叶片负责拖尾。
        # 不再按 elementId 拆花瓣，避免 QSvgRenderer 把局部元素拉伸成诡异圆块。
        self.pix_branch = self._render_svg_to_pixmap("yinghua-branch.svg", RENDER_SIZE)
        self.pix_flower = self._render_svg_to_pixmap("yinghua-ball.svg", RENDER_SIZE)
        self.pix_leaf = self._render_svg_to_pixmap("yinghua-leaf.svg", RENDER_SIZE)
        self.layered_flower_ready = all(
            not pix.isNull() for pix in (self.pix_branch, self.pix_flower, self.pix_leaf)
        )
        if not self.layered_flower_ready:
            print("[落樱] 花枝/花朵/叶片资源渲染失败", file=sys.stderr)

        self.state = load_state()
        self.action = self.state.get("action") or "copy"
        self.cached = None
        self.target_name = ""
        self.target_title = ""
        self.target_mode = "auto"    # auto=跟随最近 / pinned=固定指定会话
        self.pinned_target = None    # {sessionPath, agentId, title} 或 None
        self.theme_mode = read_hana_theme_mode()
        self.context_menu = None

        # 微风物理：花朵会随来风方向轻摆，移开后慢慢停稳
        self.angle = 0.0
        self.angular_velocity = 0.0
        self.hover_wind = 0.0
        self.gust = 0.0
        self.gust_direction = 1.0
        self.hover_strength = 1.0
        self.cursor_wind = 0.0
        self.cursor_lift = 0.0
        self.cursor_velocity = (0.0, 0.0)
        self.bloom = 0.0

        # 三态
        self.mode = "rolled"
        self.hovered = False
        self._hover_exit_elapsed = 0.0

        # 按压弹簧 + 细碎花瓣。press_amount: 0=原位，1=压下，负值=松手后越界回弹。
        self.pressed = False
        self.press_amount = 0.0
        self.press_velocity = 0.0
        self.petal_particles = []
        self._petal_rng = random.Random()
        self._hover_petal_timer = self._petal_rng.uniform(*HOVER_PETAL_INTERVAL)
        self._sweep_petal_cooldown = 0.0
        # 提问挂起时持续散发细小花瓣（点击花朵同款放射簇，低密度）
        self._ask_emitting = False
        self._ask_petal_timer = 0.0
        self._ask_bounce_timer = 0.0

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
        self._ask_poll_inflight = False
        self.ask_ready.connect(self._apply_ask_payload)

        self.ask_poll_timer = QTimer(self)
        self.ask_poll_timer.timeout.connect(self._poll_ask_async)
        self.ask_poll_timer.start(ASK_POLL_INTERVAL_MS)

        timer = QTimer(self)
        timer.timeout.connect(self._tick)
        timer.start(16)

        self.theme_timer = QTimer(self)
        self.theme_timer.timeout.connect(self._sync_theme)
        self.theme_timer.start(1500)

        self._place_from_state()

    # ── 提问轮询：网络在线程，界面回主线程 ──
    def _poll_ask_async(self):
        if self._ask_poll_inflight:
            return
        self._ask_poll_inflight = True

        def worker():
            payload = {"ok": False, "pending": []}
            try:
                data = api_get("/ask/pending", timeout=4)
                if data.get("ok"):
                    payload = {"ok": True, "pending": data.get("pending") or []}
            except Exception:
                pass
            try:
                self.ask_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-ask-poll").start()

    def _apply_ask_payload(self, payload):
        self._ask_poll_inflight = False
        if not payload.get("ok"):
            return
        ask = latest_ask_pending(payload.get("pending"))
        if ask is not None:
            if self.menu is None:
                self.menu = ZhujianMenu(self)
            # 折叠（放弃）过的提问不再弹出——无论菜单是否可见都挡，
            # 防止「折叠后重新打开菜单又被弹回、标志被 show_ask 重置」的死循环；
            # 新提问（askId 不在集合）照常弹出。
            if ask.get("askId") in self.menu._collapsed_ask_ids:
                return
            if not self.menu.isVisible():
                # 已经在提问态时只重新显示原面板，不能先 prepare_for_show 把提问替换成推荐。
                if not self.menu.is_ask_open():
                    self.menu.prepare_for_show()
                self.menu.move_to_ball()
                self.menu.show()
                self.menu.raise_()
                self.menu.activateWindow()
            self.menu.show_ask(ask)
            self.menu.raise_()
            return
        if self.menu is not None and self.menu.is_ask_open():
            self.menu.restore_recommendations()

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
            if not renderer.isValid():
                return QPixmap()
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
        px, py, pts = self._cursor_sample
        previous_cursor = self.mapFromGlobal(QPoint(int(px), int(py)))
        cursor_hovered, self._hover_exit_elapsed = resolve_hover_state(
            self.hovered, cursor.x(), cursor.y(), self._hover_exit_elapsed, frame_elapsed,
        )
        crossed_visible = segment_crosses_flower_zone(
            previous_cursor.x(), previous_cursor.y(), cursor.x(), cursor.y(),
            HOVER_ENTER_MARGIN,
        )
        if crossed_visible:
            cursor_hovered = True
            self._hover_exit_elapsed = 0.0
        sample_elapsed = now - pts
        sweep_direction, sweep_strength, sweep_speed, sweep_vx, sweep_vy = calculate_cursor_sweep(
            px, py, cursor_global.x(), cursor_global.y(), sample_elapsed,
        )
        entered_now = cursor_hovered and not self.hovered
        if entered_now and not self.pressed and self._drag is None:
            direction, strength = calculate_entry_wind(
                px, py, cursor_global.x(), cursor_global.y(), sample_elapsed,
                self.mapToGlobal(QPoint(BALL_SIZE // 2, BALL_SIZE // 2)).x(),
            )
            self.gust_direction = direction
            self.hover_strength = strength
            self.gust = strength
            self.angular_velocity += 14.0 * direction * strength
            entry_petals = petal_count_from_sweep_speed(sweep_speed)
            entry_petals = 3 if entry_petals <= 0 else min(entry_petals, 7)
            self._spawn_petals(entry_petals, burst=False, wind=(sweep_vx, sweep_vy))
            self._sweep_petal_cooldown = 0.22

        allow_sweep = should_apply_cursor_sweep(
            cursor_hovered, self.pressed, self._drag is not None,
        )
        if allow_sweep and sweep_strength > 0.0:
            self.cursor_velocity = (sweep_vx, sweep_vy)
            target_cursor_wind, target_cursor_lift = cursor_wind_components(
                sweep_vx, sweep_vy, sweep_strength, sweep_direction,
            )
            blend = 1.0 - math.exp(-dt / 0.055)
            self.cursor_wind += (target_cursor_wind - self.cursor_wind) * blend
            self.cursor_lift += (target_cursor_lift - self.cursor_lift) * blend
            self.hover_strength += (sweep_strength - self.hover_strength) * blend
            if abs(self.cursor_wind) >= 0.08:
                self.gust_direction = -1.0 if self.cursor_wind < 0.0 else 1.0
            self.gust = max(self.gust, sweep_strength * 0.58)
            petal_count = petal_count_from_sweep_speed(sweep_speed)
            if petal_count > 0 and self._sweep_petal_cooldown <= 0.0:
                self._spawn_petals(petal_count, burst=False, wind=(sweep_vx, sweep_vy))
                self._sweep_petal_cooldown = 0.24
        else:
            self.cursor_wind *= math.exp(-dt / 0.16)
            self.cursor_lift *= math.exp(-dt / 0.16)
            self.cursor_velocity = (0.0, 0.0)
            resting_strength = 0.24 if cursor_hovered and not self.pressed else 0.0
            self.hover_strength += (resting_strength - self.hover_strength) * (
                1.0 - math.exp(-dt / 0.30)
            )

        self.hovered = cursor_hovered
        self.mode = "peeking" if self.hovered else "rolled"
        self._cursor_sample = (cursor_global.x(), cursor_global.y(), now)
        self._sweep_petal_cooldown = max(0.0, self._sweep_petal_cooldown - dt)

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
            0.65
            + self.hover_strength * 2.4 * math.sin(self.t * 4.2 + 0.35)
            + self.hover_strength * 0.62 * math.sin(self.t * 7.1 + 1.4)
        )
        target_angle = base_wind * 3.6 * (1.0 - self.hover_wind) + hover_target * self.hover_wind
        target_angle += (
            self.gust_direction * 3.2 * self.gust
            + self.cursor_wind * 5.4
            + self.cursor_lift * 3.6
        )
        if self.pressed:
            target_angle *= 0.18
        acceleration = (target_angle - self.angle) * 19.0 - self.angular_velocity * 6.2
        self.angular_velocity += acceleration * dt
        self.angle += self.angular_velocity * dt
        self.angle = max(-11.0, min(11.0, self.angle))

        # 按住时枝条蓄力下压；松开后快速越界，再衰减回到原位。
        self.press_amount, self.press_velocity = advance_press_spring(
            self.press_amount, self.press_velocity, self.pressed, dt,
        )
        if not self.pressed and abs(self.press_amount) < 0.002 and abs(self.press_velocity) < 0.03:
            self.press_amount = 0.0
            self.press_velocity = 0.0

        # 悬停只零碎落下一两枚小花瓣；按压与松手的较大花瓣簇由鼠标事件触发。
        if self.hovered and not self.pressed:
            self._hover_petal_timer -= dt
            if self._hover_petal_timer <= 0.0:
                self._spawn_petals(
                    self._petal_rng.randint(1, 2), burst=False, wind=self.cursor_velocity,
                )
                self._hover_petal_timer = self._petal_rng.uniform(*HOVER_PETAL_INTERVAL)
        else:
            self._hover_petal_timer = min(
                self._hover_petal_timer, HOVER_PETAL_INTERVAL[0],
            )
        # 提问挂起：花朵持续散发花瓣 + 周期性轻拨树枝（弹簧回弹，视觉上一直在晃）
        if self._ask_emitting:
            self._ask_petal_timer -= dt
            if self._ask_petal_timer <= 0.0:
                self._spawn_petals(self._petal_rng.randint(4, 6), burst=True, size_scale=1.8)
                self._ask_petal_timer = self._petal_rng.uniform(0.22, 0.38)
            if not self.pressed:
                self._ask_bounce_timer -= dt
                if self._ask_bounce_timer <= 0.0:
                    # 直接把枝条推到明显下压位再回弹，幅度才看得见（仅脉冲力度太小）
                    self.press_amount = max(self.press_amount, 0.6)
                    self.press_velocity = max(self.press_velocity, 2.2)
                    self._spawn_petals(self._petal_rng.randint(2, 3), burst=True, size_scale=1.4)
                    self._ask_bounce_timer = self._petal_rng.uniform(0.6, 1.1)
        self._update_petals(dt)

        self.update()

    def _branch_angle(self):
        rebound = max(0.0, -self.press_amount)
        motion_scale = 0.18 if self.pressed else 1.0
        effective_gust = max(self.gust, abs(self.cursor_wind) * 0.9) * motion_scale
        effective_direction = -1.0 if self.cursor_wind < -0.03 else 1.0 if self.cursor_wind > 0.03 else self.gust_direction
        branch_offset, _, _ = component_motion(
            self.t, self.bloom, effective_gust, effective_direction, rebound,
        )
        return self.angle * 0.42 + branch_offset * 0.55 + self.press_amount * 4.8

    def _flower_origin(self):
        return rotate_point_around(
            FLOWER_CENTER[0], FLOWER_CENTER[1],
            BRANCH_PIVOT[0], BRANCH_PIVOT[1], self._branch_angle(),
        )

    def _spawn_petals(self, count, burst, wind=(0.0, 0.0), size_scale=1.0):
        """生成碎瓣；掠风是有方向的小簇，点击仍是更盛大的放射簇。
        size_scale 用于 ask 提醒场景把花瓣放大约 1.8 倍，更显眼。"""
        cx, cy = self._flower_origin()
        wind_x, wind_y = float(wind[0]), float(wind[1])
        source_wind_speed = math.hypot(wind_x, wind_y)
        swept = not burst and source_wind_speed > 0.0
        if swept:
            wind_scale = min(source_wind_speed * 0.024, 32.0) / source_wind_speed
            wind_x *= wind_scale
            wind_y *= wind_scale
        for _ in range(max(0, int(count))):
            size = self._petal_rng.uniform(0.82, 1.62 if burst else 1.28) * size_scale
            if burst:
                direction = self._petal_rng.uniform(0.0, math.tau)
                radius = self._petal_rng.uniform(10.0, 17.0)
                speed = self._petal_rng.uniform(15.0, 31.0)
                x = cx + math.cos(direction) * radius
                y = cy + math.sin(direction) * radius * 0.72
                vx = math.cos(direction) * speed
                vy = math.sin(direction) * speed * 0.68 - 2.0
                gravity = 15.0
                sway = 1.5
                life = self._petal_rng.uniform(0.82, 1.35)
                spin_limit = 150.0
            else:
                direction = self._petal_rng.uniform(0.0, math.tau)
                radius = self._petal_rng.uniform(11.0, 17.0)
                x = cx + math.cos(direction) * radius
                y = cy + math.sin(direction) * radius * 0.78
                vx = self._petal_rng.uniform(-5.0, 5.0) + wind_x
                vy = self._petal_rng.uniform(4.0, 8.5) + wind_y * 0.8
                gravity = 22.0 if swept else 15.0
                sway = 1.5 + min(source_wind_speed / 600.0, 2.4) if swept else 1.5
                life = self._petal_rng.uniform(1.35, 1.95) if swept else self._petal_rng.uniform(0.82, 1.12)
                spin_limit = min(150.0 + source_wind_speed * 0.08, 300.0) if swept else 150.0
            self.petal_particles.append({
                "x": x,
                "y": y,
                "vx": vx,
                "vy": vy,
                "size": size,
                "angle": self._petal_rng.uniform(0.0, 360.0),
                "spin": self._petal_rng.uniform(-spin_limit, spin_limit),
                "phase": self._petal_rng.uniform(0.0, math.tau),
                "gravity": gravity,
                "sway": sway,
                "age": 0.0,
                "life": life,
                "color": self._petal_rng.choice(("#f2b8c7", "#f7cfda", "#e9a3b8")),
            })
        if len(self.petal_particles) > MAX_PETAL_PARTICLES:
            self.petal_particles = self.petal_particles[-MAX_PETAL_PARTICLES:]

    def _update_petals(self, dt):
        alive = []
        for petal in self.petal_particles:
            petal["age"] += dt
            if petal["age"] >= petal["life"]:
                continue
            petal["vx"] *= math.exp(-dt * 0.72)
            petal["vy"] += petal.get("gravity", 15.0) * dt
            petal["x"] += petal["vx"] * dt + math.sin(
                petal["age"] * 8.0 + petal["phase"]
            ) * petal.get("sway", 1.5) * dt
            petal["y"] += petal["vy"] * dt
            petal["angle"] += petal["spin"] * dt
            if petal["y"] <= BALL_SIZE + 3:
                alive.append(petal)
        self.petal_particles = alive

    # ── 绘制 ──
    def paintEvent(self, _e):
        p = QPainter(self)
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_Source)
        p.fillRect(self.rect(), Qt.GlobalColor.transparent)
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceOver)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)

        lift = -0.45 * math.sin(self.t * 1.05)
        self._draw_flower(p, lift)
        self._draw_petals(p)
        p.end()

    def _draw_flower(self, p, lift):
        """花朵保持旧版尺寸；按压只改变整枝弯曲，不再缩放花朵。"""
        if not self.layered_flower_ready:
            if not self._draw_layer(
                p, self.pix_flower, FLOWER_SIZE,
                self.angle, FLOWER_CENTER[0], FLOWER_CENTER[1] + lift, 1.0,
            ):
                self._draw_fallback_flower(
                    p, FLOWER_CENTER[0], FLOWER_CENTER[1] + lift,
                    FLOWER_SIZE / 47.0,
                )
            return

        rebound = max(0.0, -self.press_amount)
        motion_scale = 0.18 if self.pressed else 1.0
        effective_gust = max(self.gust, abs(self.cursor_wind) * 0.9) * motion_scale
        effective_direction = -1.0 if self.cursor_wind < -0.03 else 1.0 if self.cursor_wind > 0.03 else self.gust_direction
        _, flower_offset, leaf_offset = component_motion(
            self.t, self.bloom, effective_gust, effective_direction, rebound,
        )
        vertical_offset = self.cursor_lift * 2.8 * motion_scale
        branch_angle = self._branch_angle()

        # 整枝绕画外树身连接处弯下；松手后 press_amount 越过 0，形成快速回弹。
        p.save()
        p.translate(BRANCH_PIVOT[0], BRANCH_PIVOT[1])
        p.rotate(branch_angle)
        p.translate(-BRANCH_PIVOT[0], -BRANCH_PIVOT[1])
        self._draw_layer(
            p, self.pix_branch, BRANCH_SIZE, 0.0, BALL_SIZE / 2, BALL_SIZE / 2,
        )
        self._draw_layer(
            p, self.pix_leaf, LEAF_SIZE, leaf_offset,
            LEAF_CENTER[0], LEAF_CENTER[1] + lift * 0.35 + vertical_offset * 0.45,
        )
        self._draw_layer(
            p, self.pix_flower, FLOWER_SIZE, flower_offset,
            FLOWER_CENTER[0], FLOWER_CENTER[1] + lift + vertical_offset, 1.0,
        )
        p.restore()

    def _draw_layer(self, p, pix, target_size, angle, cx, cy, layer_scale=1.0):
        """把完整 SVG 作为一个零件围绕自身中心绘制；空资源安全跳过。"""
        if pix is None or pix.isNull() or pix.width() <= 0:
            return False
        pix_size = pix.width()
        scale = (target_size / pix_size) * layer_scale
        half = pix_size / 2
        p.save()
        p.translate(cx, cy)
        p.rotate(angle)
        p.scale(scale, scale)
        p.translate(-half, -half)
        p.drawPixmap(0, 0, pix)
        p.restore()
        return True

    def _draw_fallback_flower(self, p, cx, cy, flower_scale=1.0):
        """SVG 全部失效时仍画一朵稳定简花，避免悬浮球空白或崩溃。"""
        p.save()
        p.translate(cx, cy)
        p.scale(flower_scale, flower_scale)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor("#efb3c3"))
        for _ in range(5):
            p.drawEllipse(QPointF(0.0, -10.5), 7.8, 12.5)
            p.rotate(72.0)
        p.setBrush(QColor("#edc46f"))
        p.drawEllipse(QPointF(0.0, 0.0), 5.2, 5.2)
        p.restore()

    def _draw_petals(self, p):
        """绘制零碎小花瓣；单瓣始终小于 2px，不借数量偷换成大花瓣。"""
        p.save()
        p.setPen(Qt.PenStyle.NoPen)
        for petal in self.petal_particles:
            progress = petal["age"] / max(petal["life"], 0.001)
            alpha = int(205 * max(0.0, 1.0 - progress) ** 0.72)
            color = QColor(petal["color"])
            color.setAlpha(max(0, min(alpha, 205)))
            p.setBrush(color)
            p.save()
            p.translate(petal["x"], petal["y"])
            p.rotate(petal["angle"])
            p.drawEllipse(
                QPointF(0.0, 0.0),
                petal["size"] * 0.62,
                petal["size"],
            )
            p.restore()
        p.restore()

    # ── 鼠标交互 ──
    def _begin_press_effect(self):
        self.pressed = True
        self.press_amount = max(self.press_amount, 0.18)
        self.press_velocity = max(self.press_velocity, 2.6)
        self._spawn_petals(PRESS_PETAL_COUNT, burst=True)

    def _end_press_effect(self):
        if not self.pressed:
            return
        self.pressed = False
        self.press_velocity = min(self.press_velocity, -8.4)
        self._spawn_petals(RELEASE_PETAL_COUNT, burst=True)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_menu_was_visible = bool(self.menu and self.menu.isVisible())
            self._press_global = e.globalPosition().toPoint()
            self._drag = self._press_global - self.pos()
            self._moved = False
            self._begin_press_effect()
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
            self._end_press_effect()
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
            if self.menu.is_ask_open():
                # 提问挂起：第一次点击只提醒不折叠，第二次确认后折叠
                if not self.menu._ask_close_armed:
                    self.menu._ask_close_armed = True
                    self.menu._ask_warn_close()
                    return
                # 第二次点击 = 确认放弃这条提问：本地恢复推荐 + 服务端静默作废（不回传）
                dismiss_ask_id = self.menu._ask_entry.get("askId") or ""
                if dismiss_ask_id:
                    self.menu._collapsed_ask_ids.append(dismiss_ask_id)
                    if len(self.menu._collapsed_ask_ids) > 50:
                        del self.menu._collapsed_ask_ids[:-50]
                self.menu.restore_recommendations()
                if dismiss_ask_id:
                    def dismiss_worker():
                        try:
                            api_post("/ask/dismiss", {"askId": dismiss_ask_id}, timeout=5)
                        except Exception:
                            pass
                    threading.Thread(
                        target=dismiss_worker, daemon=True, name="zhujian-ask-dismiss",
                    ).start()
            self._close_menu()
            return
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
        # 模式切换后同步面板底部的模式文案
        if self.menu is not None:
            self.menu._update_hint()

    # ── 面板 ──
    def _open_menu(self):
        if self.menu is None:
            self.menu = ZhujianMenu(self)
        if not self.menu.is_ask_open():
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
    target_ready = pyqtSignal(object)
    rename_ready = pyqtSignal(object)
    undo_ready = pyqtSignal(object)
    ask_response_ready = pyqtSignal(object)

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
        self._renaming = False
        self._target_seq = 0
        self._refresh_seq = 0
        # 面板拖拽状态：面板与花朵始终作为一组移动
        self._drag_press = None
        self._drag_panel_start = None
        self._drag_ball_start = None
        self._drag_moved = False
        self._needs_reanchor = False  # 本次打开后内容尚未以完整高度锚定过
        self._user_dragged = False    # 本次打开后用户是否手动拖过面板（拖过则尊重手动位置）
        self._ask_entry = None
        self._ask_restore_cache = None
        self._ask_option_frames = []
        self._ask_responding = False
        self._ask_finished = False
        # 确认式折叠：ask 挂起时第一次点球只提醒，第二次才收起；
        # _collapsed_ask_ids 记录用户主动折叠（放弃）的提问 id，轮询不再弹出这些题；
        # 新提问（askId 不在集合里）照常弹出（花朵花瓣继续提醒）
        self._ask_close_armed = False
        self._collapsed_ask_ids = []
        self._ask_response_mode = ""
        self._ask_response_choice = ""
        self.refresh_ready.connect(self._apply_async_refresh)
        self.target_ready.connect(self._apply_target_state)
        self.rename_ready.connect(self._apply_rename_result)
        self.undo_ready.connect(self._apply_undo_result)
        self.ask_response_ready.connect(self._apply_ask_response)
        self._build_ui()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 18, 20, 18)
        root.setSpacing(9)

        head_row = QHBoxLayout()
        head_row.setSpacing(8)
        self.lbl_head = QLabel("解语花")
        self.lbl_head.setObjectName("head")
        head_row.addWidget(self.lbl_head)
        head_row.addStretch(1)

        target_row = QHBoxLayout()
        target_row.setSpacing(6)
        self.lbl_target_label = QLabel("这里可以选择按哪段对话推荐回复 →")
        self.lbl_target_label.setObjectName("targetLabel")
        self.btn_target = QPushButton("自动判断 ▾")
        self.btn_target.setObjectName("target")
        self.btn_target.setToolTip("点这里选参考对话：自动跟着最近对话，或固定一段")
        self.btn_target.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_target.clicked.connect(self._open_target_menu)
        target_row.addWidget(self.lbl_target_label)
        target_row.addWidget(self.btn_target)
        head_row.addLayout(target_row)
        root.addLayout(head_row)

        # 当前读取的是哪个对话框（自动判断结果或手动固定的会话），重命名/推荐都基于它
        self.lbl_target_info = QLabel("")
        self.lbl_target_info.setObjectName("targetInfo")
        root.addWidget(self.lbl_target_info)

        self.target_menu = TargetMenu(self)
        self.target_menu.hide()
        root.addWidget(self.target_menu)

        # 提问模式复用同一块展板：推荐条暂时让位，答完后恢复原缓存。
        self.ask_scroll = QScrollArea()
        self.ask_scroll.setObjectName("askScroll")
        self.ask_scroll.setAutoFillBackground(False)
        self.ask_scroll.viewport().setAutoFillBackground(False)
        self.ask_scroll.setWidgetResizable(True)
        self.ask_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.ask_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.ask_scroll.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.ask_body = QFrame()
        self.ask_body.setObjectName("askBody")
        ask_body_layout = QVBoxLayout(self.ask_body)
        ask_body_layout.setContentsMargins(0, 0, 0, 0)
        ask_body_layout.setSpacing(8)
        self.lbl_ask_from = QLabel("")
        self.lbl_ask_from.setObjectName("askFrom")
        self.lbl_ask_from.setWordWrap(True)
        self.lbl_ask_from.hide()
        ask_body_layout.addWidget(self.lbl_ask_from)
        self.lbl_ask_question = QLabel("")
        self.lbl_ask_question.setObjectName("askQuestion")
        self.lbl_ask_question.setWordWrap(True)
        ask_body_layout.addWidget(self.lbl_ask_question)
        self.ask_options_grid = QGridLayout()
        self.ask_options_grid.setContentsMargins(0, 0, 0, 0)
        self.ask_options_grid.setSpacing(8)
        ask_body_layout.addLayout(self.ask_options_grid)
        ask_body_layout.addStretch(1)
        self.ask_scroll.setWidget(self.ask_body)
        self.ask_scroll.hide()
        root.addWidget(self.ask_scroll)

        self.grid = QGridLayout()
        self.grid.setSpacing(8)
        self.buttons = []
        root.addLayout(self.grid)

        self.ask_input = QLineEdit()
        self.ask_input.setObjectName("askInput")
        self.ask_input.setMaxLength(ASK_INPUT_MAX_LENGTH)
        # 俏皮文案：弹窗里能写，主对话框直接说也行（隐式跳开会静默收起提问，助手上下文仍能对上）
        # 字号调小到 10px 保证这 26 个字在输入框里完整显示
        self.ask_input.setPlaceholderText("在此输入文本（嘻嘻，惯性思维了不是？在哪输入不是输入呢？）")
        self.ask_input.returnPressed.connect(self._send_custom_ask)
        self.ask_input.hide()
        root.addWidget(self.ask_input)
        self.btn_ask_skip = QPushButton("跳过本题")
        self.btn_ask_skip.setObjectName("askSkip")
        self.btn_ask_skip.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_ask_skip.clicked.connect(lambda: self._respond_ask("skip", ""))
        self.btn_ask_skip.hide()
        self.btn_ask_send = QPushButton("发送")
        self.btn_ask_send.setObjectName("askSend")
        self.btn_ask_send.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_ask_send.clicked.connect(self._send_custom_ask)
        self.btn_ask_send.hide()
        ask_actions = QHBoxLayout()
        ask_actions.setSpacing(8)
        ask_actions.addWidget(self.btn_ask_skip)
        ask_actions.addWidget(self.btn_ask_send)
        root.addLayout(ask_actions)

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

        self.lbl_section = QLabel("会话标题")
        self.lbl_section.setObjectName("sectionTitle")
        root.addWidget(self.lbl_section)

        row_rename = QHBoxLayout()
        row_rename.setSpacing(8)
        self.btn_rename = QPushButton("重命名标题")
        self.btn_rename.setObjectName("renameBtn")
        self.btn_rename.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_rename.setToolTip("总结这段对话的整体内容，给会话起个新标题")
        self.btn_rename.clicked.connect(self.rename_async)
        row_rename.addWidget(self.btn_rename)
        self.btn_undo = QPushButton("退回")
        self.btn_undo.setObjectName("undoBtn")
        self.btn_undo.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_undo.setToolTip("退回到上一次的标题")
        self.btn_undo.setEnabled(False)
        self.btn_undo.clicked.connect(self.undo_async)
        row_rename.addWidget(self.btn_undo)
        row_rename.addStretch(1)
        # 提示语长度受行宽限制：按钮 88+48+间距后约剩 150px，14 字会截断，用 10 字版本完整显示
        self.lbl_rename_hint = QLabel("← 这里可以退回旧标题")
        self.lbl_rename_hint.setObjectName("renameHint")
        row_rename.addWidget(self.lbl_rename_hint)
        root.addLayout(row_rename)

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
            QLabel#targetLabel {{ color: {c['sub']}; font-size: 10px; padding-bottom: 1px; }}
            QLabel#targetInfo {{ color: {c['sub']}; font-size: 10px; }}
            QPushButton#target {{
                color: {c['sub']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 9px;
                font-size: 11px; padding: 3px 8px;
            }}
            QPushButton#target:hover {{ color: {c['accent_deep']}; border-color: {c['accent']}; }}
            QPushButton#target:disabled {{ color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']}; }}
            QLabel#hint {{ color: {c['sub']}; font-size: 11px; padding: 2px 0; }}
            QLabel#sectionTitle {{ color: {c['accent_deep']}; font-size: 12px; font-weight: 700; }}
            QLabel#renameHint {{ color: {c['sub']}; font-size: 10px; }}
            QLabel#cacheTime {{ color: {c['sub']}; font-size: 10px; }}
            QScrollArea#askScroll {{
                border: none; background: transparent;
            }}
            QScrollBar:vertical {{
                width: 8px; background: transparent; margin: 3px 0;
            }}
            QScrollBar::handle:vertical {{
                min-height: 26px; background: {c['border']}; border-radius: 4px;
            }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QLabel#askQuestion {{
                color: {c['accent_deep']}; font-size: 14px; font-weight: 700;
                background: {c['surface_alt']}; border-radius: 10px;
                padding: 8px 10px;
            }}
            QLabel#askFrom {{
                color: {c['sub_deep']}; font-size: 11px;
                padding: 0 2px 2px;
            }}
            QFrame#askOption {{
                background: {c['surface']}; border: 1px solid {c['border']}; border-radius: 16px;
            }}
            QLabel#askChoice {{
                color: {c['ink']}; font-size: 13px; font-weight: 600;
            }}
            QLabel#askDescription {{
                color: {c['sub_deep']}; font-size: 11px; padding: 2px 10px 8px;
            }}
            QLabel#askRecommended {{
                color: {c['pink']}; font-size: 10px; padding: 8px 8px 0 0;
            }}
            QLineEdit#askInput {{
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 9px; padding: 7px 10px;
            }}
            QPushButton#askSkip, QPushButton#askSend {{
                min-height: 28px; border-radius: 10px; font-size: 11px; font-weight: 600; padding: 0 13px;
            }}
            QPushButton#askSkip {{
                color: {c['accent_deep']}; background: transparent; border: 1px solid {c['border']};
            }}
            QPushButton#askSend {{
                color: {c['accent_text']}; background: {c['accent']}; border: 1px solid {c['accent']};
            }}
            QPushButton#askSkip:hover {{ border-color: {c['accent']}; background: {c['surface_alt']}; }}
            QPushButton#askSend:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#askSkip:disabled, QPushButton#askSend:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QPushButton#refreshBtn, QPushButton#renameBtn {{
                min-height: 28px; min-width: 88px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 10px;
                font-size: 11px; font-weight: 600; padding: 0 13px;
            }}
            QPushButton#refreshBtn:hover, QPushButton#renameBtn:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#refreshBtn:disabled, QPushButton#renameBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QPushButton#undoBtn {{
                min-height: 28px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 10px;
                font-size: 11px; font-weight: 600; padding: 0 13px;
            }}
            QPushButton#undoBtn:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#undoBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QLabel#feedback {{ color: {c['pink']}; font-size: 11px; font-weight: 600; }}
            QLabel#rec {{
                background: {c['surface']}; color: {c['ink']};
                border: 1px solid {c['border']}; border-radius: 14px; font-size: 13px;
            }}
            QLabel#rec:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
        """)
        if self.target_menu is not None:
            self.target_menu.apply_theme()

    def prepare_for_show(self):
        self._needs_reanchor = True
        self._user_dragged = False
        self._flash("")
        self._update_target()
        self._sync_target_state()
        cached = self.ball.cached
        if cached and cached.get("items"):
            self._render_items(cached["items"])
        else:
            self._render_empty()
        self.load_cache_async()

    # ── 提问模式：推荐条让位，作答后恢复原缓存 ──
    def is_ask_open(self):
        return self._ask_entry is not None and not self._ask_finished

    @staticmethod
    def _copy_cache(cache):
        if not isinstance(cache, dict) or not cache.get("items"):
            return None
        return {
            **cache,
            "items": [dict(item) for item in cache.get("items") if isinstance(item, dict)],
        }

    def show_ask(self, ask):
        ask_id = ask.get("askId") if isinstance(ask, dict) else ""
        if not ask_id or self._ask_responding or self._ask_finished:
            return
        if self._ask_entry:
            if ask_id == self._ask_entry.get("askId"):
                # 当前题正在显示或等待失败重试时，不用新题覆盖输入状态；下一轮再处理。
                return
            # 新提问（askId 不同）：旧提问可能已被用户折叠，切换显示新提问
            #（旧提问由服务端 TTL / 隐式跳过兑底，不丢）
            self._ask_entry = None
            self._ask_restore_cache = None
        self._ask_restore_cache = self._copy_cache(self.ball.cached)
        self._ask_entry = dict(ask)
        self._ask_finished = False
        self._ask_responding = False
        self._ask_close_armed = False
        # 注意：不清理 _collapsed_ask_ids——折叠集合是历史放弃记录，
        # 新提问（askId 不同）天然不受影响，清理反而会让折叠过的旧题再次弹出。
        self._needs_reanchor = not self._user_dragged
        self._set_ask_mode(True)
        self._render_ask(self._ask_entry)
        self.ball._ask_emitting = True  # 提问挂起：花朵持续散发花瓣
        self._ask_pulse_title()

    def _ask_pulse_title(self, rounds=3):
        """提问弹出时标题颜色脉冲（accent_deep ↔ pink），提醒面板内容已切换成提问。"""
        c = THEME_COLORS[self.ball.theme_mode]
        step_ms = 170
        for i in range(rounds * 2):
            on = i % 2 == 0
            QTimer.singleShot(
                i * step_ms,
                lambda on=on: self.lbl_head.setStyleSheet(f"color: {c['pink']};" if on else ""),
            )

    def _ask_warn_close(self):
        """确认式折叠：第一次点球时闪烁提醒，不折叠；提示文字短暂显示后自动消失。"""
        c = THEME_COLORS[self.ball.theme_mode]
        step_ms = 130
        for i in range(4):
            on = i % 2 == 0
            QTimer.singleShot(
                i * step_ms,
                lambda on=on: self.lbl_head.setStyleSheet(f"color: {c['pink']};" if on else ""),
            )
        self._flash("还有问题没答哦，再点一次才收起")
        QTimer.singleShot(2200, lambda: self._flash("") if self._ask_entry else None)

    def _set_ask_mode(self, active):
        if active:
            entry = self._ask_entry or {}
            self.lbl_head.setText("❓ " + (entry.get("header") or "请你拍板"))
            self.setMinimumHeight(0)  # 清掉上一轮 settle 残留的最小高度
            for widget in (
                self.lbl_target_label, self.btn_target, self.lbl_target_info,
                self.btn_refresh, self.lbl_cache_time, self.lbl_section,
                self.btn_rename, self.btn_undo, self.lbl_rename_hint, self.lbl_hint,
            ):
                widget.hide()
            self.target_menu.hide()
            self.ask_scroll.show()
            self.ask_input.show()
            self.btn_ask_skip.show()
            self.btn_ask_send.show()
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry() if screen else None
            max_height = ASK_PANEL_MAX_HEIGHT
            if geo is not None:
                max_height = min(max_height, max(280, int(geo.height() * 0.60)))
            self.setMaximumHeight(max_height)
            self.ask_scroll.setMinimumHeight(min(180, max_height - 124))
            self.ask_scroll.setMaximumHeight(max(120, max_height - 124))
            self._set_ask_controls_enabled(not self._ask_responding and not self._ask_finished)
            # QScrollArea 的 sizeHint 不反映内容高度，直接 adjustSize 会让窗口停在小高度，
            # 长内容时选项被压在折叠区。等两轮布局稳定后按内容真实高度撑起面板。
            QTimer.singleShot(0, lambda: QTimer.singleShot(0, self._settle_ask_height))
        else:
            self.setMaximumHeight(16777215)
            self.setMinimumHeight(0)
            self.lbl_head.setText("解语花")
            for widget in (
                self.lbl_target_label, self.btn_target, self.lbl_target_info,
                self.btn_refresh, self.lbl_cache_time, self.lbl_section,
                self.btn_rename, self.btn_undo, self.lbl_rename_hint, self.lbl_hint,
            ):
                widget.show()
            self.ask_scroll.hide()
            self.ask_input.hide()
            self.btn_ask_skip.hide()
            self.btn_ask_send.hide()
            self._set_ask_controls_enabled(False)

    def _settle_ask_height(self):
        """提问态布局稳定后，按内容真实高度调整面板高度：
        内容少时面板紧凑（不小于 180 滚动区），内容多时封顶 max_height 内部滚动。"""
        if not self.is_ask_open() or self._ask_responding or self._ask_finished:
            return
        max_height = self.maximumHeight()
        if max_height <= 0 or max_height >= 16777215:
            return
        body = self.ask_scroll.widget()
        if body is None:
            return
        body_layout = body.layout()
        if body_layout is not None:
            body_layout.activate()
        content_h = body.sizeHint().height()
        fixed_h = 160  # 标题 + 输入框 + 按钮 + feedback + 边距 + 间距（近似）
        # 下限 440：内容少时面板也要舒展（手帐风低信息密度），内容多再往上长
        target = min(max_height, max(440, fixed_h + max(180, content_h)))
        if target <= 0 or target == self.height():
            return
        # 用 setFixedHeight 锁死：move_to_ball 里的 adjustSize 不会把高度压回
        #（QScrollArea 的 sizeHint 是默认小值，直接 resize 会被 adjustSize 覆盖）
        self.setFixedHeight(target)
        self.move_to_ball()

    def _clear_ask_options(self):
        while self.ask_options_grid.count():
            item = self.ask_options_grid.takeAt(0)
            widget = item.widget()
            if widget:
                widget.hide()
                widget.deleteLater()
        self._ask_option_frames = []

    def _render_ask(self, ask):
        self._clear_buttons()
        self._clear_ask_options()
        title = str(ask.get("sessionTitle") or "").strip()
        agent = str(ask.get("agentName") or "").strip()
        if title:
            self.lbl_ask_from.setText(f"💬 来自窗口：{title}")
            self.lbl_ask_from.show()
        elif agent:
            self.lbl_ask_from.setText(f"💬 来自：{agent}")
            self.lbl_ask_from.show()
        else:
            self.lbl_ask_from.hide()
        self.lbl_ask_question.setText(str(ask.get("question") or ""))
        options = ask.get("options") if isinstance(ask.get("options"), list) else []
        # 选项永远 1 列竖排：每个选项一个整行横条胶囊（跟普通推荐条同款排法）
        for index, option in enumerate(options):
            if not isinstance(option, dict):
                continue
            original_label = str(option.get("label") or "").strip()
            if not original_label:
                continue
            recommended = original_label.endswith("(Recommended)")
            display_label = original_label[:-len("(Recommended)")].rstrip() if recommended else original_label
            frame = AskOptionFrame(
                display_label or original_label,
                str(option.get("description") or "").strip(),
                recommended,
            )
            frame.choice_label.clicked.connect(
                lambda label=original_label: self._respond_ask("option", label)
            )
            self.ask_options_grid.addWidget(frame, index, 0)
            self._ask_option_frames.append(frame)
        self.ask_input.clear()
        self.lbl_feedback.setText("")
        self._set_ask_controls_enabled(not self._ask_responding and not self._ask_finished)
        self._sync_size()
        self.keep_current_position(full_height=True)

    def _set_ask_controls_enabled(self, enabled):
        for frame in self._ask_option_frames:
            frame.choice_label.setEnabled(bool(enabled))
        self.ask_input.setEnabled(bool(enabled))
        self.btn_ask_skip.setEnabled(bool(enabled))
        self.btn_ask_send.setEnabled(bool(enabled))

    def _send_custom_ask(self):
        value = normalize_custom_answer(self.ask_input.text())
        if not value:
            self._flash("请选择一个选项或填写自定义答案")
            return
        self._respond_ask("custom", value)

    def _respond_ask(self, mode, choice):
        if not self._ask_entry or self._ask_responding or self._ask_finished:
            return
        ask_id = self._ask_entry.get("askId") or ""
        self._ask_responding = True
        self._ask_response_mode = mode
        self._ask_response_choice = choice
        self._set_ask_controls_enabled(False)
        self._flash("正在发送…")

        def worker():
            payload = {
                "askId": ask_id,
                "mode": mode,
                "choice": choice,
                "ok": False,
                "error": "连不上解语花，看看插件开着没",
            }
            try:
                data = api_post("/ask/respond", {
                    "askId": ask_id,
                    "mode": mode,
                    "choice": choice,
                }, timeout=20)
                payload.update(data or {})
                payload["askId"] = ask_id
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"出错了 ({e.code})"
                except Exception:
                    payload["error"] = f"出错了 ({e.code})"
            except Exception:
                pass
            try:
                self.ask_response_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-ask-response").start()

    def _apply_ask_response(self, payload):
        if not self._ask_entry or payload.get("askId") != self._ask_entry.get("askId"):
            return
        self._ask_responding = False
        if payload.get("ok"):
            self._ask_finished = True
            mode = payload.get("mode") or self._ask_response_mode
            choice = payload.get("choice") or self._ask_response_choice
            self._flash("已跳过" if mode == "skip" else f"已发送 · {choice}")
            self._set_ask_controls_enabled(False)
            completed_ask_id = self._ask_entry.get("askId")
            QTimer.singleShot(
                650,
                lambda ask_id=completed_ask_id: self.restore_recommendations(ask_id),
            )
        else:
            self._set_ask_controls_enabled(True)
            self._flash(payload.get("error") or "发送失败，再试一次")

    def restore_recommendations(self, expected_ask_id=None):
        if not self._ask_entry or self._ask_responding:
            return
        if expected_ask_id and self._ask_entry.get("askId") != expected_ask_id:
            return
        cache = self._ask_restore_cache or self._copy_cache(self.ball.cached)
        self._ask_entry = None
        self._ask_restore_cache = None
        self._ask_finished = False
        self._ask_response_mode = ""
        self._ask_response_choice = ""
        self._needs_reanchor = False
        # 注意：不清理 _collapsed_ask_ids——折叠场景调 restore 时
        # 折叠集合是“服务端作废失败”的本地兜底，清理会让折叠失效（关了又弹）
        self._ask_close_armed = False
        self.ball._ask_emitting = False  # 弹窗关闭，停止散发花瓣
        self._set_ask_mode(False)
        if cache and cache.get("items"):
            self.ball.cached = cache
            self._render_items(cache["items"])
        else:
            self._render_empty()
        self._flash("")
        self._sync_size()
        self.keep_current_position()

    def load_cache_async(self):
        def worker():
            try:
                data = api_get("/cache", timeout=4)
                if data.get("ok") and data.get("cached") and data["cached"].get("items"):
                    self.refresh_ready.emit({
                        "source": "cache",
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
        self._refresh_seq += 1
        refresh_seq = self._refresh_seq
        self._set_refreshing_ui(True)

        def worker():
            payload = {"source": "refresh", "seq": refresh_seq, "items": None, "rid": None, "target": None, "error": None, "target_state_loaded": False}
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload["target"] = data["target"]
                    payload["mode"] = data.get("mode") or "auto"
                    payload["pinned"] = data.get("pinned")
                    payload["target_state_loaded"] = True
            except Exception:
                pass
            try:
                data = api_get("/suggest", timeout=30)
                if data.get("ok"):
                    payload["items"] = data.get("items") or []
                    payload["rid"] = data.get("rid") or ""
                    # 兜底：/target 超时但 /suggest 成功时，只补显示名；
                    # 不覆盖本地 mode/pinned，避免把未知状态误写成自动模式。
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
        if payload.get("source") == "refresh" and payload.get("seq") != self._refresh_seq:
            return
        if payload.get("source") == "refresh":
            self._refreshing = False
            self._set_refreshing_ui(False)
        if payload.get("target"):
            self.ball.target_name = payload["target"].get("name") or payload["target"].get("agentId") or ""
            self.ball.target_title = payload["target"].get("title") or self.ball.target_title
        if payload.get("target_state_loaded"):
            self.ball.target_mode = "pinned" if payload.get("mode") == "pinned" else "auto"
            self.ball.pinned_target = payload.get("pinned")
        self._update_target()
        if payload.get("items"):
            ts = payload.get("ts") or (int(time.time() * 1000) if not payload.get("fromCache") else (self.ball.cached or {}).get("ts") or 0)
            self.ball.cached = {"items": payload["items"], "rid": payload["rid"], "ts": ts}
            if self._ask_entry is None:
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
        lbl = QLabel("正在获取推荐回复…")
        lbl.setObjectName("hint")
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.grid.addWidget(lbl, 0, 0)
        self.lbl_hint.setText("")
        self.keep_current_position()

    def _set_refreshing_ui(self, refreshing):
        self.btn_refresh.setEnabled(not refreshing)
        self.btn_target.setEnabled(not refreshing)
        self.btn_refresh.setText("正在获取推荐回复…" if refreshing else "刷新推荐")

    def rename_async(self):
        """重命名标题：总结整段对话 → 改宿主标题，服务端会记下旧标题供退回。"""
        if self._renaming:
            return
        self._renaming = True
        self._set_renaming_ui(True)

        def worker():
            payload = {"ok": False, "error": None, "title": None, "agentName": "", "fallback": False}
            try:
                data = api_post("/rename", {}, timeout=40)
                payload["ok"] = bool(data.get("ok"))
                payload["title"] = data.get("title") or ""
                payload["agentName"] = data.get("agentName") or ""
                payload["fallback"] = bool(data.get("fallback"))
                payload["error"] = data.get("error")
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"出错了 ({e.code})"
                except Exception:
                    payload["error"] = f"出错了 ({e.code})"
            except Exception:
                payload["error"] = "连不上解语花，看看插件开着没"
            try:
                self.rename_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-rename").start()

    def undo_async(self):
        """退回：把标题恢复到最近一次重命名之前。"""
        if self._renaming:
            return

        def worker():
            payload = {"ok": False, "error": None, "restoredTitle": None, "agentName": ""}
            try:
                data = api_post("/rename/undo", {}, timeout=15)
                payload["ok"] = bool(data.get("ok"))
                payload["restoredTitle"] = data.get("restoredTitle") or ""
                payload["agentName"] = data.get("agentName") or ""
                payload["error"] = data.get("error")
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"出错了 ({e.code})"
                except Exception:
                    payload["error"] = f"出错了 ({e.code})"
            except Exception:
                payload["error"] = "连不上解语花，看看插件开着没"
            try:
                self.undo_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-undo").start()

    def _apply_rename_result(self, payload):
        self._renaming = False
        self._set_renaming_ui(False)
        if payload.get("ok") and payload.get("title"):
            # 第一行显示新标题，第二行提示宿主侧栏的刷新规律（回合结束才重拉列表）
            tip = "（兜底标题）" if payload.get("fallback") else ""
            self._flash(f"已改为：{payload['title']}\n{tip}聊一句后自动刷新")
            self.btn_undo.setEnabled(True)
            self._sync_target_state()
        else:
            self._flash(payload.get("error") or "重命名失败，再试一次")

    def _apply_undo_result(self, payload):
        if payload.get("ok"):
            restored = payload.get("restoredTitle") or "无标题"
            who = f"{payload['agentName']} 的" if payload.get("agentName") else ""
            self._flash(f"已把{who}会话标题退回：{restored}")
            self.btn_undo.setEnabled(False)
            self._sync_target_state()
        else:
            self._flash(payload.get("error") or "退回失败，再试一次")

    def _set_renaming_ui(self, renaming):
        self.btn_rename.setEnabled(not renaming)
        self.btn_rename.setText("总结中…" if renaming else "重命名标题")
        if renaming:
            self.btn_undo.setEnabled(False)

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
        arrow = "▴" if self.target_menu is not None and self.target_menu.isVisible() else "▾"
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            # target_title 是最近一次 /target 拉的值（重命名后会更新），比固定时存的 pinned_target.title 新
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            label = f"固定 · {title[:6]}" if title else "固定"
        else:
            label = "自动判断"
        self.btn_target.setText(f"{label} {arrow}")
        self._update_target_info()

    def _update_target_info(self):
        """头部下方显示当前读取的是哪个对话框：固定会话或自动判断结果。"""
        name = (self.ball.target_name or "").strip()
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            prefix = "固定"
        else:
            title = (self.ball.target_title or "").strip()
            prefix = "自动"
        if title:
            text = " · ".join([prefix, name, title]) if name else " · ".join([prefix, title])
        elif name:
            text = " · ".join([prefix, name]) + "（无标题）"
        else:
            text = "自动 · 正在定位对话…"
        self.lbl_target_info.setText(text)

    def _sync_target_state(self):
        self._target_seq += 1
        target_seq = self._target_seq

        def worker():
            payload = None
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload = {**data, "seq": target_seq}
            except Exception:
                pass
            if payload is not None:
                try:
                    self.target_ready.emit(payload)
                except RuntimeError:
                    pass

        threading.Thread(target=worker, daemon=True, name="zhujian-target").start()

    def _apply_target_state(self, data):
        if data.get("seq") != self._target_seq:
            return
        t = data.get("target") or {}
        self.ball.target_name = t.get("name") or t.get("agentId") or ""
        self.ball.target_title = t.get("title") or ""
        self.ball.target_mode = "pinned" if data.get("mode") == "pinned" else "auto"
        self.ball.pinned_target = data.get("pinned")
        self._update_target()
        # 退回按钮可用性由服务端真实记录驱动（面板打开/重命名/退回都会刷新）
        if "undoAvailable" in data and not self._renaming:
            self.btn_undo.setEnabled(bool(data.get("undoAvailable")))

    def invalidate_target_sync(self):
        """用户主动切换目标时作废先前的 /target 回包，避免旧状态覆盖新选择。"""
        self._target_seq += 1

    def _open_target_menu(self):
        show = not self.target_menu.isVisible()
        self._set_target_selector_visible(show)
        if show:
            self.target_menu.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
            self.target_menu.refresh_sessions_async()

    def _set_target_selector_visible(self, visible):
        self.target_menu.setVisible(bool(visible))
        self._update_target()
        self._resize_after_target_change()

    def _resize_after_target_change(self):
        # 展开区和列表都是面板自身内容；等两轮布局稳定后按花朵重新锚定。
        def settle():
            self._sync_size()
            if self.isVisible():
                self.move_to_ball()
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle))

    def _update_hint(self):
        action = self.ball.action
        mode = "点一下直接发出" if action == "send" else "点一下复制，粘到输入框发出"
        self.lbl_hint.setText(f"当前模式：{mode}")
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
        # 内容已就绪且已锚定过：尺寸同步延迟到布局稳定（两轮事件循环）后再 adjustSize。
        # 换行 QLabel 的 sizeHint 在宽度分配后两轮才正确，立即 adjustSize 会拿到
        # 未换行的错误高度，把推荐条压扁/撑爆（图1 错位残字的根因）。
        self._schedule_size_sync()
        screen = self.ball.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
        y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
        self.move(x, y)

    def _schedule_size_sync(self):
        """延迟到布局稳定（两轮事件循环）后再 adjustSize。"""
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, self._sync_size))

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
        if self.target_menu is not None:
            self.target_menu.hide()
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
