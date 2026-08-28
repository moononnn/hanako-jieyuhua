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
import base64
import threading
import tempfile
import urllib.request
import urllib.error
import urllib.parse

from PyQt6.QtCore import Qt, QTimer, QPoint, QPointF, QBuffer, QByteArray, QUrl, QIODevice, pyqtSignal, QPropertyAnimation, QEvent
from PyQt6.QtGui import (
    QPixmap, QPainter, QColor, QFontMetrics, QCursor, QPalette,
)
from PyQt6.QtSvg import QSvgRenderer
from PyQt6.QtWidgets import (
    QApplication, QWidget, QPushButton, QLabel, QFrame, QLineEdit, QScrollArea,
    QVBoxLayout, QHBoxLayout, QGridLayout, QSizePolicy,
)

# 语音朗读播放（PyQt6 自带 QtMultimedia；缺失时按钮给出提示，不硬崩）
try:
    from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput
    _HAS_QMULTIMEDIA = True
except Exception:
    _HAS_QMULTIMEDIA = False





# ── 可点击的推荐条目（QLabel + 点击信号，支持自动换行） ──
class RecLabel(QLabel):
    clicked = pyqtSignal(int)

    def __init__(self, text, index):
        super().__init__(text)
        self._idx = index
        self.setWordWrap(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAccessibleName(text)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setContentsMargins(12, 9, 12, 9)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self._idx)
        super().mousePressEvent(e)

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter, Qt.Key.Key_Space):
            self.clicked.emit(self._idx)
            e.accept()
            return
        super().keyPressEvent(e)


# ── 提问选项：复用推荐展板，不另开第二个窗口 ──
class AskChoiceLabel(QLabel):
    clicked = pyqtSignal()

    def __init__(self, text):
        super().__init__(text)
        self.setObjectName("askChoice")
        self.setWordWrap(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAccessibleName(text)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        self.setContentsMargins(10, 8, 10, 8)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self.isEnabled():
            self.clicked.emit()
        e.accept()

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter, Qt.Key.Key_Space) and self.isEnabled():
            self.clicked.emit()
            e.accept()
            return
        super().keyPressEvent(e)


class AskOptionFrame(QFrame):
    # 提问作答强制直接回传：点击选项/发送按钮走 /ask/respond 的 deferred 通道，
    # 与推荐条的「直接发出/复制到剪贴板」模式（ball.action）完全无关，
    # 复制模式的用户点这里也是直接作答。改这条链路时不要接进 ball.action 分支。
    def __init__(self, label, description="", recommended=False, selection_mode="single"):
        super().__init__()
        self.setObjectName("askOption")
        self._label = label
        self._selection_mode = selection_mode if selection_mode == "multiple" else "single"
        self._selected = False
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
        self.set_selected(False)

    def set_selected(self, selected):
        self._selected = bool(selected)
        if self._selection_mode == "multiple":
            prefix = "☑ " if self._selected else "□ "
            self.choice_label.setText(prefix + self._label)
            self.choice_label.setAccessibleName(("已选：" if self._selected else "未选：") + self._label)
        else:
            self.choice_label.setText(self._label)
            self.choice_label.setAccessibleName(self._label)
        self.setProperty("selected", "true" if self._selected else "false")
        self.style().unpolish(self)
        self.style().polish(self)
        self.update()

    @property
    def selected(self):
        return self._selected


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


def latest_resume_pending(resume):
    """只展示最新一条断联待办；旧条目留在服务端等过期/清理。"""
    if not isinstance(resume, list):
        return None
    valid = [item for item in resume if isinstance(item, dict) and item.get("resumeId")]
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
BALL_VISUAL_SCALE = 0.90  # 整体视觉缩小一档；保留透明窗口与交互定位不变
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
# 拖动响应按窗口真实位移采样；原版与融合版共用同一组目标/弹簧语义。
DRAG_MAX_SPEED = 2400.0
DRAG_FILTER_TAU = 0.035
DRAG_STALE_AFTER = 0.055
DRAG_DECAY_TAU = 0.10

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

# ── 弹窗鼠标离开自动半透明（左键面板 / 右键浮签共用） ──
FADE_OUT_OPACITY = 0.60      # 半透明下限：留存在感，鼠标也找得到窗口
FADE_OUT_DELAY_MS = 450      # 鼠标离开后的宽限，防止快速穿越边缘抖动
FADE_SHOW_GRACE_MS = 900     # 刚弹出时的缓冲：即使光标不在窗内也先全显，再开始判定
FADE_OUT_DURATION_MS = 420   # 淡出渐变时长（慢慢隐退）
FADE_IN_DURATION_MS = 180    # 恢复渐变时长（回来要快）

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


# ── 分支列表时间显示：今天显时分，往年显日期 ──
def format_branch_time(ts):
    try:
        t = time.localtime(ts / 1000 if ts > 1e12 else ts)
        now = time.localtime()
        if (t.tm_year, t.tm_yday) == (now.tm_year, now.tm_yday):
            return time.strftime("%H:%M", t)
        if t.tm_year == now.tm_year:
            return time.strftime("%m-%d %H:%M", t)
        return time.strftime("%Y-%m-%d", t)
    except Exception:
        return ""


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


def position_popup_left_first(anchor_rect, popup_size, bounds, gap=8, anchor_ratio=0.5):
    """优先放锚点左侧，左侧放不下才放右侧；返回 (x, y, side)。"""
    ax, _ay, aw, ah = anchor_rect
    pw, ph = popup_size
    left, top, right, bottom = bounds
    left_x = ax - pw - gap
    right_x = ax + aw + gap
    if left_x >= left:
        x, side = left_x, "left"
    else:
        x, side = right_x, "right"
    return (
        max(left, min(x, right - pw)),
        popup_anchor_y(anchor_rect, ph, bounds, anchor_ratio),
        side,
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


def sample_drag_velocity(
    previous_x,
    previous_y,
    previous_ts,
    previous_vx,
    previous_vy,
    current_x,
    current_y,
    current_ts,
):
    """从窗口真实位移估算平滑拖速；触边限位后不再凭鼠标继续加速。"""
    elapsed = max(float(current_ts) - float(previous_ts), 1.0 / 240.0)
    raw_vx = (float(current_x) - float(previous_x)) / elapsed
    raw_vy = (float(current_y) - float(previous_y)) / elapsed
    raw_speed = math.hypot(raw_vx, raw_vy)
    if raw_speed > DRAG_MAX_SPEED:
        scale = DRAG_MAX_SPEED / raw_speed
        raw_vx *= scale
        raw_vy *= scale
    alpha = 1.0 - math.exp(-min(elapsed, 0.12) / DRAG_FILTER_TAU)
    if math.hypot(float(previous_vx), float(previous_vy)) < 1.0:
        alpha = max(alpha, 0.62)
    vx = float(previous_vx) + (raw_vx - float(previous_vx)) * alpha
    vy = float(previous_vy) + (raw_vy - float(previous_vy)) * alpha
    return vx, vy, vx - float(previous_vx), vy - float(previous_vy), math.hypot(vx, vy)


def flower_drag_targets(velocity_x, velocity_y):
    """把拖速翻译成柔性层目标：根部最稳，花冠次之，轻叶拖尾最大。"""
    vx = float(velocity_x)
    vy = float(velocity_y)
    return (
        max(-7.2, min(-vx * 0.0048, 7.2)),
        max(-13.5, min(-vx * 0.0092, 13.5)),
        max(-19.0, min(-vx * 0.0130, 19.0)),
        max(-4.8, min(-vy * 0.0036, 4.8)),
    )


def flower_drag_impulses(delta_vx, delta_vy):
    """加速/急停产生的局部惯性，越轻的部件获得越大的速度变化。"""
    dvx = float(delta_vx)
    dvy = float(delta_vy)
    return (
        max(-18.0, min(-dvx * 0.018, 18.0)),
        max(-34.0, min(-dvx * 0.036, 34.0)),
        max(-50.0, min(-dvx * 0.055, 50.0)),
        max(-20.0, min(-dvy * 0.018, 20.0)),
    )


def advance_motion_spring(value, velocity, target, stiffness, damping, dt, limit):
    """可中断的局部弹簧；拖动反向时沿用现有速度，不重启动画。"""
    dt = max(0.0, min(float(dt), 0.05))
    acceleration = (
        (float(target) - float(value)) * float(stiffness)
        - float(velocity) * float(damping)
    )
    velocity = float(velocity) + acceleration * dt
    value = float(value) + velocity * dt
    value = max(-abs(float(limit)), min(value, abs(float(limit))))
    if abs(value) < 0.001 and abs(velocity) < 0.01 and abs(float(target)) < 0.001:
        return 0.0, 0.0
    return value, velocity


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


def _api_diag(tag, exc, path=""):
    """API 调用失败时把异常与环境信息落盘（zhujian-api-dbg.log），排查用。"""
    try:
        import traceback
        log_path = os.path.join(HANA_HOME, "data", "jiegehua", "zhujian-api-dbg.log")
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {tag} {path}\n")
            f.write(f"  api_base={API_BASE!r} token_len={len(API_TOKEN)} proxies={urllib.request.getproxies()}\n")
            tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).replace("\n", "\n  ")
            f.write("  " + tb + "\n---\n")
    except Exception:
        pass


def api_get(path, timeout=5):
    try:
        req = urllib.request.Request(API_BASE + path, headers=_api_headers())
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        _api_diag("GET", e, path)
        raise


def api_post(path, payload, timeout=12):
    try:
        req = urllib.request.Request(
            API_BASE + path,
            data=json.dumps(payload).encode("utf-8"),
            headers=_api_headers({"Content-Type": "application/json"}),
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        _api_diag("POST", e, path)
        raise


def load_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    """原子保存位置与融合面板状态，避免协调器读到半截 JSON。"""
    temp_path = STATE_PATH + ".tmp"
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, STATE_PATH)
    except Exception as e:
        try:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        except Exception:
            pass
        print(f"[落樱] 保存状态失败: {e}", file=sys.stderr)


# ─────────────────────────────
#  弹窗鼠标离开自动半透明（mixin，不依赖 MRO，事件由子类显式调用）
# ─────────────────────────────
class FadeOnLeaveMixin:
    """鼠标离开弹窗 → 稍候缓慢半透明；鼠标移回 → 快速恢复不透明。

    弹窗是矩形窗口，enter/leave 事件可靠；但呼出时光标可能就不在窗内
    （点击花朵后鼠标停在旁边），没有离开事件可依，故 show 时主动检查一次。
    用法：子类 __init__ 末尾调 setup_fade_on_leave()，并在对应事件里调
    _reset_fade_on_show / _on_fade_enter / _on_fade_leave。
    """

    def setup_fade_on_leave(self):
        self._fade_out_timer = QTimer(self)
        self._fade_out_timer.setSingleShot(True)
        self._fade_out_timer.timeout.connect(self._begin_fade_out)
        self._fade_anim = QPropertyAnimation(self, b"windowOpacity", self)

    def _fade_allowed(self):
        """是否允许自动淡出；子类可覆写（如提问态保持实体）。"""
        return True

    def _reset_fade_on_show(self):
        """显示时：光标在窗内 → 全不透明且不排期；不在 → 给缓冲期后淡出。"""
        self.setWindowOpacity(1.0)
        self._fade_out_timer.stop()
        self._fade_anim.stop()
        if self._fade_allowed() and not self._cursor_inside():
            self._fade_out_timer.start(FADE_OUT_DELAY_MS + FADE_SHOW_GRACE_MS)

    def _on_fade_enter(self):
        self._fade_out_timer.stop()
        self._fade_to(1.0, FADE_IN_DURATION_MS)

    def _on_fade_leave(self):
        if self._fade_allowed():
            self._fade_out_timer.start(FADE_OUT_DELAY_MS)

    def _cancel_fade(self):
        if self._fade_out_timer is not None:
            self._fade_out_timer.stop()
        if self._fade_anim is not None:
            self._fade_anim.stop()

    def _cursor_inside(self):
        return self.rect().contains(self.mapFromGlobal(QCursor.pos()))

    def _begin_fade_out(self):
        self._fade_to(FADE_OUT_OPACITY, FADE_OUT_DURATION_MS)

    def _fade_to(self, target, duration_ms):
        self._fade_anim.stop()
        self._fade_anim.setStartValue(self.windowOpacity())
        self._fade_anim.setEndValue(target)
        self._fade_anim.setDuration(duration_ms)
        self._fade_anim.start()


# ─────────────────────────────
#  发送方式浮签（替代粗糙的系统 QMenu）
# ─────────────────────────────
class SendModeMenu(FadeOnLeaveMixin, QFrame):
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
        self.setup_fade_on_leave()

    def enterEvent(self, event):
        super().enterEvent(event)
        self._on_fade_enter()

    def leaveEvent(self, event):
        super().leaveEvent(event)
        self._on_fade_leave()

    def showEvent(self, event):
        super().showEvent(event)
        self._reset_fade_on_show()

    def hideEvent(self, event):
        super().hideEvent(event)
        self._cancel_fade()

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
        self.btn_copy.setText(("●  " if not send_on else "○  ") + "复制")

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

        title = QLabel(getattr(self.panel, "target_menu_title", "推荐回复参考哪段对话？"))
        title.setObjectName("menuTitle")
        root.addWidget(title)

        mode_row = QHBoxLayout()
        mode_row.setSpacing(6)
        self.btn_auto = QPushButton("跟随最近")
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
            "跟随最近活跃的对话" if auto_on
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
            lbl.setWordWrap(True)
            lbl.setStyleSheet(f"color: {THEME_COLORS[self.ball.theme_mode]['sub']}; font-size: 11px;")
            self.list_box.addWidget(lbl)
            retry = QPushButton("↻ 重新读取")
            retry.setObjectName("sessionItem")
            retry.setCursor(Qt.CursorShape.PointingHandCursor)
            retry.clicked.connect(lambda checked=False: self.refresh_sessions_async())
            self.list_box.addWidget(retry)
            return
        if not self.sessions:
            lbl = QLabel("还没读取到可选对话")
            lbl.setObjectName("menuSub")
            lbl.setStyleSheet(f"color: {THEME_COLORS[self.ball.theme_mode]['sub']}; font-size: 11px;")
            self.list_box.addWidget(lbl)
            return
        for s in self.sessions:
            title = (s.get("title") or "未命名对话").strip()
            ts = s.get("lastUserTime") or 0
            when = time.strftime("%H:%M", time.localtime(ts / 1000)) if ts else ""
            btn = QPushButton()
            btn.setObjectName("sessionItem")
            # 跨助手混排，不再另起助手分类；列表只呈现对话标题和最近时间。
            btn.setText(btn.fontMetrics().elidedText(title, Qt.TextElideMode.ElideRight, 246))
            btn.setToolTip(f"{title}\n{when}" if when else title)
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
        self.ball.target_revision = getattr(self.ball, "target_revision", 0) + 1
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
        self.panel._flash("已改为跟随最近活跃的对话 ✓")
        self.panel._set_target_selector_visible(False)
        on_target_changed = getattr(self.panel, "_on_target_changed", None)
        if callable(on_target_changed):
            on_target_changed()
        else:
            self.panel._sync_target_state()

    def _pick(self, s):
        self._request_seq += 1
        self.panel.invalidate_target_sync()
        self.ball.target_revision = getattr(self.ball, "target_revision", 0) + 1
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
        self.ball.pinned_target = {
            "sessionPath": s.get("sessionPath") or "",
            "title": s.get("title") or "",
            "agentId": s.get("agentId") or "",
            "agentName": s.get("agentName") or s.get("agentId") or "",
        }
        self.ball.target_name = s.get("agentName") or s.get("agentId") or ""
        self.ball.target_title = s.get("title") or ""
        self.panel._update_target()
        self.panel._flash("已固定这段对话 ✓")
        self.panel._set_target_selector_visible(False)
        on_target_changed = getattr(self.panel, "_on_target_changed", None)
        if callable(on_target_changed):
            on_target_changed()

    def refresh_sessions_async(self):
        self._request_seq += 1
        request_seq = self._request_seq
        target_revision = getattr(self.ball, "target_revision", 0)
        self.loading_sessions = True
        self.sessions_error = ""
        self._sync_ui()

        def worker():
            payload = {"seq": request_seq, "target_revision": target_revision, "sessions": [], "mode": self.ball.target_mode, "pinned": self.ball.pinned_target, "error": "读取失败，可以重新读取"}
            try:
                data = api_get("/sessions", timeout=5)
                if data.get("ok"):
                    payload = {
                        "seq": request_seq,
                        "target_revision": target_revision,
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
        target_state_current = payload.get("target_revision", getattr(self.ball, "target_revision", 0)) == getattr(self.ball, "target_revision", 0)
        if target_state_current:
            self.ball.target_mode = payload.get("mode") or "auto"
            self.ball.pinned_target = payload.get("pinned")
            if self.ball.target_mode == "pinned" and self.ball.pinned_target:
                pinned = self.ball.pinned_target
                self.ball.target_name = pinned.get("agentName") or pinned.get("name") or pinned.get("agentId") or self.ball.target_name
                self.ball.target_title = pinned.get("title") or self.ball.target_title
            self.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
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
        self._closed = False
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
        # 只记录当前运行中的面板，进程重启后不把旧的打开状态冒充成可继承状态。
        self.state["fusionPanel"] = "none"
        save_state(self.state)
        self.action = self.state.get("action") or "copy"
        self.cached = None
        self.target_name = ""
        self.target_title = ""
        self.target_mode = "auto"    # auto=跟随最近 / pinned=固定指定会话
        self.target_revision = 0      # 跨主面板/朗读窗共享，丢弃旧目标状态回包
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
        # 拖动时根部、花冠、叶片与纵向位移各有独立重量；释放后保留速度回弹。
        self.drag_branch_angle = 0.0
        self.drag_branch_velocity = 0.0
        self.drag_flower_angle = 0.0
        self.drag_flower_velocity = 0.0
        self.drag_leaf_angle = 0.0
        self.drag_leaf_velocity = 0.0
        self.drag_vertical = 0.0
        self.drag_vertical_velocity = 0.0

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
        self._drag_motion_active = False
        self._drag_sample_x = 0.0
        self._drag_sample_y = 0.0
        self._drag_sample_ts = self._last_ts
        self._drag_velocity_x = 0.0
        self._drag_velocity_y = 0.0
        self._drag_motion_last_ts = self._last_ts

        # 交互
        self._drag = None
        self._press_global = None
        self._moved = False
        self._drag_menu_was_visible = False
        self._drag_read_was_visible = False
        self._drag_menu_start = None
        self._drag_read_start = None
        self._drag_ball_start = None
        self.menu = None
        self.read_panel = None        # 独立朗读窗口（由主面板「念给我听」打开）
        self._ask_poll_inflight = False
        self.ask_ready.connect(self._apply_ask_payload)
        # 右键浮签不再是 Popup（Popup 会抢在 toggle 前自动关闭，无法实现"再按一次右键收起"），
        # 由这里统一接管「点击外部关闭」：监听所有窗口的鼠标按下
        QApplication.instance().installEventFilter(self)

        self.ask_poll_timer = QTimer(self)
        self.ask_poll_timer.timeout.connect(self._poll_ask_async)
        self.ask_poll_timer.start(ASK_POLL_INTERVAL_MS)

        self.tick_timer = QTimer(self)
        self.tick_timer.timeout.connect(self._tick)
        self.tick_timer.start(16)

        self.theme_timer = QTimer(self)
        self.theme_timer.timeout.connect(self._sync_theme)
        self.theme_timer.start(1500)

        self._place_from_state()

    def closeEvent(self, event):
        # 关闭悬浮球时先解除全局过滤器并停掉自身定时器；子窗口由测试夹具/进程收尾处理，
        # 避免在 Qt close 回调里递归销毁跨窗口信号链。
        self._closed = True
        app = QApplication.instance()
        if app is not None:
            try:
                app.removeEventFilter(self)
            except RuntimeError:
                pass
        for timer in self.findChildren(QTimer):
            try:
                timer.stop()
            except RuntimeError:
                pass
        super().closeEvent(event)

    # ── 提问轮询：网络在线程，界面回主线程 ──
    def _poll_ask_async(self):
        if self._ask_poll_inflight:
            return
        self._ask_poll_inflight = True

        def worker():
            payload = {"ok": False, "pending": [], "resume": [], "resumeAuto": False, "resumeNotices": []}
            try:
                data = api_get("/ask/pending", timeout=4)
                if data.get("ok"):
                    payload = {
                        "ok": True,
                        "pending": data.get("pending") or [],
                        "resume": data.get("resume") or [],
                        "resumeAuto": bool(data.get("resumeAuto")),
                        "resumeNotices": data.get("resumeNotices") or [],
                    }
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.ask_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-ask-poll").start()

    def _apply_ask_payload(self, payload):
        self._ask_poll_inflight = False
        if not payload.get("ok"):
            return
        # 自动续接成功的短暂提示（面板可见时显示）
        notices = payload.get("resumeNotices") or []
        if notices and self.menu is not None and self.menu.isVisible():
            self.menu.show_resume_notice(notices[-1])
        ask = latest_ask_pending(payload.get("pending"))
        if ask is not None:
            if self.menu is None:
                self.menu = ZhujianMenu(self)
            # 面板暂时收起不等于问题已放弃：同一个 ask 仍保留在内存里。
            # 但用户既然主动收起了，就不要被轮询自动重新打回脸上；手动点花朵时再展开原题。
            if (
                self.menu.is_ask_open()
                and self.menu._ask_user_hidden
                and ask.get("askId") == self.menu._ask_entry.get("askId")
            ):
                return
            if not self.menu.isVisible():
                # 已经在提问态时只重新显示原面板，不能先 prepare_for_show 把提问替换成推荐。
                # 互斥：自动弹面板前也先收右键浮签与朗读窗口，保证不并存
                if self.context_menu is not None:
                    self.context_menu.close()
                if self.read_panel is not None and self.read_panel.isVisible():
                    self.read_panel.close()
                if not self.menu.is_ask_open():
                    self.menu.prepare_for_show()
                self.menu.move_to_ball()
                self.menu.show()
                self.menu.raise_()
                self.menu.activateWindow()
            self.menu.show_ask(ask)
            # 提问态需要持续留在前台供用户作答；只有断联卡按一次性提醒处理。
            self.menu.raise_()
            self._set_fusion_panel_state("ask")
            return
        # 没有提问时，断联待办照常弹卡片
        resume = latest_resume_pending(payload.get("resume"))
        if resume is not None:
            if self.menu is None:
                self.menu = ZhujianMenu(self)
            # 用户主动收起断联卡时不打回（同 ask 的语义）
            if (
                self.menu.is_resume_open()
                and self.menu._resume_user_hidden
                and resume.get("resumeId") == self.menu._resume_entry.get("resumeId")
            ):
                return
            # 只在新卡第一次送达时提到当前程序上方；同一张卡后续轮询不再反复 raise，
            # 否则用户切到 QQ 后，轮询会把这张卡一次次顶回 QQ 上面。
            resume_already_visible = (
                self.menu.isVisible()
                and self.menu.is_resume_open()
                and resume.get("resumeId") == self.menu._resume_entry.get("resumeId")
            )
            if not self.menu.isVisible():
                # 互斥：自动弹卡片前也先收右键浮签与朗读窗口，保证不并存
                if self.context_menu is not None:
                    self.context_menu.close()
                if self.read_panel is not None and self.read_panel.isVisible():
                    self.read_panel.close()
                if not self.menu.is_ask_open() and not self.menu.is_resume_open():
                    self.menu.prepare_for_show()
                self.menu.move_to_ball()
                self.menu.show()
                self.menu.raise_()
                self.menu.activateWindow()
            self.menu.set_resume_auto_state(bool(payload.get("resumeAuto")))
            self.menu.show_resume(resume)
            if not resume_already_visible:
                self.menu.raise_()
            return
        if self.menu is not None and self.menu.is_ask_open():
            # ask 消失（作答完成/隐式跳过/过期）后不弹推荐，直接收起面板回悬浮球
            self.menu.finish_ask_and_collapse()
        elif self.menu is not None and self.menu.is_resume_open():
            # 断联卡消失（已继续/用户自己接手/过期）后收起
            self.menu.finish_resume_and_collapse()

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
        if self.read_panel is not None:
            self.read_panel.apply_theme()
            self.read_panel.update()

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

    def _set_fusion_panel_state(self, panel):
        panel = panel if panel in {"none", "menu", "ask", "read"} else "none"
        if self.state.get("fusionPanel") == panel:
            return
        self.state["fusionPanel"] = panel
        save_state(self.state)

    def _reset_drag_motion(self, now=None):
        now = time.monotonic() if now is None else float(now)
        pos = self.pos()
        self._drag_sample_x = float(pos.x())
        self._drag_sample_y = float(pos.y())
        self._drag_sample_ts = now
        self._drag_velocity_x = 0.0
        self._drag_velocity_y = 0.0
        self._drag_motion_last_ts = now
        self._drag_motion_active = False

    def _apply_drag_impulses(self, delta_vx, delta_vy):
        branch, flower, leaf, vertical = flower_drag_impulses(delta_vx, delta_vy)
        self.drag_branch_velocity += branch
        self.drag_flower_velocity += flower
        self.drag_leaf_velocity += leaf
        self.drag_vertical_velocity += vertical

    def _record_drag_motion(self, position=None, now=None):
        now = time.monotonic() if now is None else float(now)
        position = self.pos() if position is None else position
        vx, vy, dvx, dvy, _speed = sample_drag_velocity(
            self._drag_sample_x,
            self._drag_sample_y,
            self._drag_sample_ts,
            self._drag_velocity_x,
            self._drag_velocity_y,
            position.x(),
            position.y(),
            now,
        )
        self._drag_sample_x = float(position.x())
        self._drag_sample_y = float(position.y())
        self._drag_sample_ts = now
        self._drag_velocity_x = vx
        self._drag_velocity_y = vy
        self._drag_motion_last_ts = now
        self._drag_motion_active = True
        self._apply_drag_impulses(dvx, dvy)

    def _release_drag_motion(self):
        if self._drag_motion_active:
            # 极短 flick 也要留下滞后；急停冲量只抵消一部分起步冲量，剩余交给弹簧自然回正。
            self._apply_drag_impulses(
                -self._drag_velocity_x * 0.30,
                -self._drag_velocity_y * 0.30,
            )
        self._drag_velocity_x *= 0.25
        self._drag_velocity_y *= 0.25
        self._drag_motion_active = False
        self._drag_motion_last_ts = time.monotonic()

    def _decay_drag_motion(self, now, dt):
        fresh = (
            self._drag_motion_active
            and now - self._drag_motion_last_ts <= DRAG_STALE_AFTER
        )
        if fresh:
            return
        decay = math.exp(-dt / DRAG_DECAY_TAU)
        self._drag_velocity_x *= decay
        self._drag_velocity_y *= decay
        if math.hypot(self._drag_velocity_x, self._drag_velocity_y) < 0.5:
            self._drag_velocity_x = 0.0
            self._drag_velocity_y = 0.0

    def _cancel_press_for_drag(self):
        """越过拖动阈值后结束点击蓄力，不把拖拽松手误演成一次完整点击爆瓣。"""
        if not self.pressed:
            return
        self.pressed = False
        self.press_velocity = min(self.press_velocity, -3.4)

    # ── 动画帧 ──
    def _tick(self):
        now = time.monotonic()
        frame_elapsed = max(now - self._last_ts, 0.0)
        dt = min(frame_elapsed, 0.05)
        self._last_ts = now
        self.t += dt
        self._decay_drag_motion(now, dt)
        dragging = bool(
            self._drag_motion_active
            and now - self._drag_motion_last_ts <= 0.18
        )
        (
            drag_branch_target,
            drag_flower_target,
            drag_leaf_target,
            drag_vertical_target,
        ) = flower_drag_targets(self._drag_velocity_x, self._drag_velocity_y)
        self.drag_branch_angle, self.drag_branch_velocity = advance_motion_spring(
            self.drag_branch_angle,
            self.drag_branch_velocity,
            drag_branch_target,
            58.0,
            12.5,
            dt,
            7.5,
        )
        self.drag_flower_angle, self.drag_flower_velocity = advance_motion_spring(
            self.drag_flower_angle,
            self.drag_flower_velocity,
            drag_flower_target,
            40.0,
            8.0,
            dt,
            14.0,
        )
        self.drag_leaf_angle, self.drag_leaf_velocity = advance_motion_spring(
            self.drag_leaf_angle,
            self.drag_leaf_velocity,
            drag_leaf_target,
            30.0,
            6.8,
            dt,
            20.0,
        )
        self.drag_vertical, self.drag_vertical_velocity = advance_motion_spring(
            self.drag_vertical,
            self.drag_vertical_velocity,
            drag_vertical_target,
            52.0,
            11.0,
            dt,
            5.0,
        )

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
            resting_strength = (
                0.24
                if cursor_hovered and not self.pressed and not dragging
                else 0.0
            )
            self.hover_strength += (resting_strength - self.hover_strength) * (
                1.0 - math.exp(-dt / 0.30)
            )

        self.hovered = cursor_hovered
        self.mode = "peeking" if self.hovered else "rolled"
        self._cursor_sample = (cursor_global.x(), cursor_global.y(), now)
        self._sweep_petal_cooldown = max(0.0, self._sweep_petal_cooldown - dt)

        # 悬停风来得快、散得慢；和风铃一样保留一小段余韵
        wind_target = 0.12 if dragging else 1.0 if self.hovered else 0.0
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
        return (
            self.angle * 0.42
            + branch_offset * 0.55
            + self.press_amount * 4.8
            + self.drag_branch_angle
        )

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

        # 只缩放可见内容，透明窗口仍保留 80px：悬停命中、贴边和面板锚点不漂移。
        p.save()
        p.translate(BALL_SIZE / 2.0, BALL_SIZE / 2.0)
        p.scale(BALL_VISUAL_SCALE, BALL_VISUAL_SCALE)
        p.translate(-BALL_SIZE / 2.0, -BALL_SIZE / 2.0)
        lift = -0.45 * math.sin(self.t * 1.05)
        self._draw_flower(p, lift)
        self._draw_petals(p)
        p.restore()
        p.end()

    def _draw_flower(self, p, lift):
        """花朵保持旧版尺寸；按压只改变整枝弯曲，不再缩放花朵。"""
        if not self.layered_flower_ready:
            if not self._draw_layer(
                p, self.pix_flower, FLOWER_SIZE,
                self.angle + self.drag_flower_angle,
                FLOWER_CENTER[0],
                FLOWER_CENTER[1] + lift + self.drag_vertical,
                1.0,
            ):
                self._draw_fallback_flower(
                    p,
                    FLOWER_CENTER[0],
                    FLOWER_CENTER[1] + lift + self.drag_vertical,
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
        vertical_offset = self.cursor_lift * 2.8 * motion_scale + self.drag_vertical
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
            p, self.pix_leaf, LEAF_SIZE, leaf_offset + self.drag_leaf_angle,
            LEAF_CENTER[0], LEAF_CENTER[1] + lift * 0.35 + vertical_offset * 0.45,
        )
        self._draw_layer(
            p, self.pix_flower, FLOWER_SIZE, flower_offset + self.drag_flower_angle,
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
            self._drag_read_was_visible = bool(self.read_panel and self.read_panel.isVisible())
            self._drag_menu_start = self.menu.pos() if self._drag_menu_was_visible else None
            self._drag_read_start = self.read_panel.pos() if self._drag_read_was_visible else None
            self._drag_ball_start = self.pos()
            self._press_global = e.globalPosition().toPoint()
            self._drag = self._press_global - self.pos()
            self._moved = False
            self._reset_drag_motion()
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
                self._cancel_press_for_drag()
            delta = current - self._press_global
            if self._drag_menu_was_visible or self._drag_read_was_visible:
                self._sync_dragged_popups(delta)
            else:
                self.move(current - self._drag)
                self._ensure_visible()
            self._record_drag_motion()
        e.accept()

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._end_press_effect()
            if self._moved:
                self._release_drag_motion()
                self._snap()
                self._sync_dragged_popups()
                self._save_pos()
            else:
                self._toggle_expand()
            if not self._moved:
                self._drag_motion_active = False
            self._drag = None
            self._press_global = None
            self._drag_menu_was_visible = False
            self._drag_read_was_visible = False
            self._drag_menu_start = None
            self._drag_read_start = None
            self._drag_ball_start = None
        elif e.button() == Qt.MouseButton.RightButton:
            self._toggle_context_menu(e.globalPosition().toPoint())
        e.accept()

    def _toggle_context_menu(self, global_pos):
        # 单击右键展开 / 再次右键收起（与左键面板一致）
        if self.context_menu is not None and self.context_menu.isVisible():
            self.context_menu.close()
        else:
            self._open_context_menu(global_pos)

    def _sync_dragged_popups(self, desired_delta=None):
        """球被单独拖动时，让已打开的面板保持用户当前的相对位置。"""
        if self._drag_ball_start is None:
            return
        popup = None
        popup_start = None
        if self._drag_read_was_visible and self.read_panel is not None:
            popup = self.read_panel
            popup_start = self._drag_read_start
        elif self._drag_menu_was_visible and self.menu is not None:
            popup = self.menu
            popup_start = self._drag_menu_start
        if popup is None or popup_start is None:
            return
        delta = desired_delta if desired_delta is not None else self.pos() - self._drag_ball_start
        screen = self.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        dx, dy = clamp_pair_drag(
            delta.x(), delta.y(),
            (self._drag_ball_start.x(), self._drag_ball_start.y(), self.width(), self.height()),
            (popup_start.x(), popup_start.y(), popup.width(), popup.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
        )
        self.move(self._drag_ball_start + QPoint(dx, dy))
        # 球带着面板移动也算用户手动调整；延迟布局回调不能再按左优先规则把面板拽走。
        popup._user_dragged = True
        popup.move(popup_start + QPoint(dx, dy))
        if not popup.isVisible():
            popup.show()
            popup.raise_()

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
                # 收起只是隐藏窗口，不改变 ask 状态；再次点花朵仍会回到同一道题。
                self._close_menu()
                return
            self._close_menu()
            return
        # 主面板没开，但朗读窗口开着：点球先收掉它（停读），不展开面板
        if self.read_panel is not None and self.read_panel.isVisible():
            self.read_panel.close()
            return
        self._open_menu()

    def _close_menu(self):
        if self.menu:
            self.menu.close_menu()
        self._set_fusion_panel_state("none")

    # ── 右键菜单 ──
    def _open_context_menu(self, global_pos):
        # 互斥：开右键浮签前先收左键面板与朗读窗口，弹窗永不并存（避免叠放/遮挡干扰 hover）
        self._close_menu()
        if self.read_panel is not None and self.read_panel.isVisible():
            self.read_panel.close()
        if self.context_menu is None:
            self.context_menu = SendModeMenu(self)
        self.context_menu.show_at(global_pos)

    def eventFilter(self, obj, event):
        # 右键浮签开着时，任何窗口上的鼠标按下都先过这里：
        # 按在浮签内 → 放行；按在浮签外 → 关闭（点空白/点别的窗口都算）
        if event.type() == QEvent.Type.MouseButtonPress:
            self._dismiss_context_menu_on_outside_click(event)
        return super().eventFilter(obj, event)

    def _dismiss_context_menu_on_outside_click(self, event):
        menu = self.context_menu
        if menu is None or not menu.isVisible():
            return
        pos = event.globalPosition().toPoint()
        if menu.geometry().contains(pos):
            return
        # 右键点在花朵上：不在这里关，交给花朵的右键 toggle（保持"再按一次右键收起"）
        if event.button() == Qt.MouseButton.RightButton and self.geometry().contains(pos):
            return
        menu.close()

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
        if self.read_panel is not None and self.read_panel.isVisible():
            self.read_panel.close()
        if self.menu is None:
            self.menu = ZhujianMenu(self)
        if not self.menu.is_ask_open():
            self.menu.prepare_for_show()
        else:
            # 手动重新点花朵 = 明确要回来处理这道题，解除“用户主动收起”抑制。
            self.menu._ask_user_hidden = False
        self.menu.move_to_ball()
        self.menu.show()
        self.menu.raise_()
        self.menu.activateWindow()
        self._set_fusion_panel_state("ask" if self.menu.is_ask_open() else "menu")


# ─────────────────────────────
#  解语花主面板：推荐回复 + 对话工具
# ─────────────────────────────
class ZhujianMenu(FadeOnLeaveMixin, QFrame):
    refresh_ready = pyqtSignal(object)
    target_ready = pyqtSignal(object)
    rename_ready = pyqtSignal(object)
    undo_ready = pyqtSignal(object)
    ask_response_ready = pyqtSignal(object)
    resume_continue_ready = pyqtSignal(object)
    resume_auto_ready = pyqtSignal(object)

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
        self._undo_available = False
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
        self._ask_option_frames = []
        self._ask_responding = False
        self._ask_finished = False
        self._ask_user_hidden = False  # 用户主动收起 ask；轮询不自动打回脸上，手动重开仍保留原题
        # ask 挂起期间允许面板暂时收起，但问题状态必须保留到真正作答完成。
        self._ask_response_mode = ""
        self._ask_response_choice = ""
        self._ask_selection_mode = "single"
        self._ask_min_selections = 1
        self._ask_max_selections = 1
        self._ask_selected_indices = []
        self._ask_option_labels = []
        # 断联续接（resume）状态：窗口异常停止时的小卡片
        self._closed = False  # 菜单不销毁但 worker 守卫会引用 _closed（Ball/ReadPanel 都有，菜单漏了——2026-08-27 实机踩到：缺失导致 worker 抛 AttributeError，emit 永不执行，按钮永远「发送中」）
        self._resume_entry = None
        self._resume_responding = False
        self._resume_finished = False
        self._resume_user_hidden = False  # 用户主动收起 resume；轮询不自动打回脸上
        self._resume_auto = False
        self._resume_notice_timer = None
        self.resume_continue_ready.connect(self._apply_resume_continue_result)
        self.resume_auto_ready.connect(self._apply_resume_auto_result)
        self.refresh_ready.connect(self._apply_async_refresh)
        self.target_ready.connect(self._apply_target_state)
        self.rename_ready.connect(self._apply_rename_result)
        self.undo_ready.connect(self._apply_undo_result)
        self.ask_response_ready.connect(self._apply_ask_response)
        self._build_ui()
        self.setup_fade_on_leave()

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
        self.lbl_target_label = QLabel("当前对话")
        self.lbl_target_label.setObjectName("targetLabel")
        self.btn_target = QPushButton("跟随最近 ▾")
        self.btn_target.setObjectName("target")
        self.btn_target.setToolTip("选择推荐、朗读和标题操作要作用于哪段对话")
        self.btn_target.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_target.clicked.connect(self._open_target_menu)
        target_row.addWidget(self.lbl_target_label)
        target_row.addWidget(self.btn_target)
        head_row.addLayout(target_row)
        root.addLayout(head_row)

        # 当前读取的是哪个对话框（跟随最近结果或手动固定的会话），重命名/推荐都基于它
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
        self.lbl_ask_select_hint = QLabel("")
        self.lbl_ask_select_hint.setObjectName("askSelectHint")
        self.lbl_ask_select_hint.setWordWrap(True)
        self.lbl_ask_select_hint.hide()
        ask_body_layout.addWidget(self.lbl_ask_select_hint)
        self.ask_options_grid = QGridLayout()
        self.ask_options_grid.setContentsMargins(0, 0, 0, 0)
        self.ask_options_grid.setSpacing(8)
        ask_body_layout.addLayout(self.ask_options_grid)
        ask_body_layout.addStretch(1)
        self.ask_scroll.setWidget(self.ask_body)
        self.ask_scroll.hide()
        root.addWidget(self.ask_scroll)

        # 推荐区与工具区共用同一张薄荷色卡片，刷新动作自然落在卡片右侧内边。
        self.recommend_body = QFrame()
        self.recommend_body.setObjectName("recommendCard")
        recommend_layout = QVBoxLayout(self.recommend_body)
        recommend_layout.setContentsMargins(10, 8, 10, 8)
        recommend_layout.setSpacing(8)
        self.lbl_recommend_section = QLabel("推荐回复")
        self.lbl_recommend_section.setObjectName("sectionTitle")
        recommend_layout.addWidget(self.lbl_recommend_section)

        self.grid = QGridLayout()
        self.grid.setSpacing(8)
        self.buttons = []
        recommend_layout.addLayout(self.grid)

        row_refresh = QHBoxLayout()
        row_refresh.setContentsMargins(0, 0, 0, 0)
        row_refresh.setSpacing(8)
        self.btn_refresh = QPushButton("刷新推荐")
        self.btn_refresh.setObjectName("refreshBtn")
        self.btn_refresh.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_refresh.clicked.connect(self.refresh_async)
        self.lbl_cache_time = QLabel("")
        self.lbl_cache_time.setObjectName("cacheTime")
        row_refresh.addStretch(1)
        row_refresh.addWidget(self.lbl_cache_time)
        row_refresh.addWidget(self.btn_refresh)
        recommend_layout.addLayout(row_refresh)
        root.addWidget(self.recommend_body)

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

        # 断联续接：窗口异常停止时的小卡片（一键继续 / 自动续接开关）
        self.resume_body = QFrame()
        self.resume_body.setObjectName("resumeCard")
        resume_layout = QVBoxLayout(self.resume_body)
        resume_layout.setContentsMargins(12, 10, 12, 10)
        resume_layout.setSpacing(6)
        self.lbl_resume_from = QLabel("")
        self.lbl_resume_from.setObjectName("resumeFrom")
        self.lbl_resume_from.setWordWrap(True)
        resume_layout.addWidget(self.lbl_resume_from)
        self.lbl_resume_reason = QLabel("")
        self.lbl_resume_reason.setObjectName("resumeReason")
        self.lbl_resume_reason.setWordWrap(True)
        resume_layout.addWidget(self.lbl_resume_reason)
        resume_actions = QHBoxLayout()
        resume_actions.setContentsMargins(0, 0, 0, 0)
        resume_actions.setSpacing(8)
        self.btn_resume_continue = QPushButton("继续")
        self.btn_resume_continue.setObjectName("resumeContinue")
        self.btn_resume_continue.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_resume_continue.setToolTip("往这个窗口发一条「继续」，接上话头")
        self.btn_resume_continue.clicked.connect(self._continue_resume)
        resume_actions.addWidget(self.btn_resume_continue)
        self.btn_resume_auto = QPushButton("自动续接：关")
        self.btn_resume_auto.setObjectName("resumeAuto")
        self.btn_resume_auto.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_resume_auto.setCheckable(True)
        self.btn_resume_auto.setToolTip("打开后检测到窗口断联会自动发「继续」，不再弹窗")
        self.btn_resume_auto.clicked.connect(self._toggle_resume_auto)
        resume_actions.addWidget(self.btn_resume_auto, 0, Qt.AlignmentFlag.AlignRight)
        resume_layout.addLayout(resume_actions)
        self.resume_body.hide()
        root.addWidget(self.resume_body)

        # 自动续接成功的短暂提示条（轮询带回，面板开着时显示几秒）
        self.lbl_resume_notice = QLabel("")
        self.lbl_resume_notice.setObjectName("resumeNotice")
        self.lbl_resume_notice.setWordWrap(True)
        self.lbl_resume_notice.hide()
        root.addWidget(self.lbl_resume_notice)

        self.lbl_section = QLabel("对话工具")
        self.lbl_section.setObjectName("sectionTitle")
        root.addWidget(self.lbl_section)

        # 工具统一成「标题 + 说明 + 动作」的卡片行，未来新增工具沿用同一骨架。
        self.say_tool = QFrame()
        self.say_tool.setObjectName("toolRow")
        say_row = QHBoxLayout(self.say_tool)
        say_row.setContentsMargins(10, 8, 10, 8)
        say_row.setSpacing(10)
        say_copy = QVBoxLayout()
        say_copy.setSpacing(2)
        self.lbl_say_title = QLabel("朗读回复")
        self.lbl_say_title.setObjectName("toolTitle")
        say_copy.addWidget(self.lbl_say_title)
        self.lbl_say_desc = QLabel("让小花把当前回复念出来")
        self.lbl_say_desc.setObjectName("toolDesc")
        self.lbl_say_desc.setWordWrap(True)
        say_copy.addWidget(self.lbl_say_desc)
        say_row.addLayout(say_copy, 1)
        self.btn_say = QPushButton("念给我听")
        self.btn_say.setObjectName("sayBtn")
        self.btn_say.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_say.setToolTip("打开朗读窗口，可选择要朗读的回复（需在设置页开启语音朗读）")
        self.btn_say.clicked.connect(self._open_read_panel)
        say_row.addWidget(self.btn_say)
        root.addWidget(self.say_tool)

        self.rename_tool = QFrame()
        self.rename_tool.setObjectName("toolRow")
        rename_row = QVBoxLayout(self.rename_tool)
        rename_row.setContentsMargins(10, 8, 10, 8)
        rename_row.setSpacing(6)
        rename_copy = QVBoxLayout()
        rename_copy.setSpacing(2)
        self.lbl_rename_title = QLabel("会话标题")
        self.lbl_rename_title.setObjectName("toolTitle")
        rename_copy.addWidget(self.lbl_rename_title)
        self.lbl_rename_desc = QLabel("按整段对话生成一个更贴切的名字")
        self.lbl_rename_desc.setObjectName("toolDesc")
        self.lbl_rename_desc.setWordWrap(True)
        rename_copy.addWidget(self.lbl_rename_desc)
        rename_row.addLayout(rename_copy)
        rename_actions = QVBoxLayout()
        rename_actions.setContentsMargins(0, 0, 0, 0)
        rename_actions.setSpacing(6)
        self.btn_rename = QPushButton("生成新标题")
        self.btn_rename.setObjectName("renameBtn")
        self.btn_rename.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_rename.setToolTip("总结这段对话的整体内容，给会话起个新标题")
        self.btn_rename.clicked.connect(self.rename_async)
        rename_actions.addWidget(self.btn_rename, 0, Qt.AlignmentFlag.AlignRight)
        self.btn_undo = QPushButton("还原")
        self.btn_undo.setObjectName("undoBtn")
        self.btn_undo.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_undo.setToolTip("还原到上一次的标题")
        self.btn_undo.setEnabled(False)
        self.btn_undo.hide()
        self.btn_undo.clicked.connect(self.undo_async)
        rename_actions.addWidget(self.btn_undo, 0, Qt.AlignmentFlag.AlignRight)
        rename_row.addLayout(rename_actions)
        root.addWidget(self.rename_tool)

        self.lbl_feedback = QLabel("")
        self.lbl_feedback.setObjectName("feedback")
        root.addWidget(self.lbl_feedback)

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
            QLabel#sectionTitle {{ color: {c['accent_deep']}; font-size: 12px; font-weight: 700; padding-top: 2px; }}
            QFrame#recommendCard, QFrame#toolRow {{
                background: {c['surface_alt']}; border: 1px dashed {c['border']}; border-radius: 12px;
            }}
            QLabel#toolTitle {{ color: {c['accent_deep']}; font-size: 12px; font-weight: 700; }}
            QLabel#toolDesc {{ color: {c['sub']}; font-size: 10px; }}
            QLabel#cacheTime {{ color: {c['sub']}; font-size: 10px; }}
            QScrollArea#askScroll {{
                border: none; background: transparent;
            }}
            QScrollBar:vertical {{
                width: 8px; background: transparent; margin: 3px 0;
            }}
            QScrollBar::handle:vertical {{
                min-height: 26px; background: #c9dfd3; border-radius: 4px;
            }}
            QScrollBar::handle:vertical:hover {{ background: {c['accent']}; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
            QLabel#askQuestion {{
                color: {c['accent_deep']}; font-size: 14px; font-weight: 700;
                background: {c['surface_alt']}; border-radius: 10px;
                padding: 8px 10px;
            }}
            QLabel#askSelectHint {{
                color: {c['sub_deep']}; font-size: 11px; padding: 0 2px;
            }}
            QLabel#askFrom {{
                color: {c['sub_deep']}; font-size: 11px;
                padding: 0 2px 2px;
            }}
            QFrame#askOption {{
                background: {c['surface']}; border: 1px solid {c['border']}; border-radius: 16px;
            }}
            QFrame#askOption[selected="true"] {{
                background: {c['surface_alt']}; border-color: {c['accent']};
            }}
            QFrame#askOption[selected="true"] QLabel#askChoice {{
                color: {c['accent_deep']}; font-weight: 700;
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
            QFrame#resumeCard {{
                background: {c['surface_alt']}; border: 1px solid {c['border']}; border-radius: 12px;
            }}
            QLabel#resumeFrom {{
                color: {c['accent_deep']}; font-size: 13px; font-weight: 700;
            }}
            QLabel#resumeReason {{ color: {c['sub_deep']}; font-size: 11px; }}
            QPushButton#resumeContinue {{
                min-height: 28px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 10px;
                font-size: 11px; font-weight: 600; padding: 0 14px;
            }}
            QPushButton#resumeContinue:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#resumeContinue:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QPushButton#resumeAuto {{
                min-height: 28px; color: {c['accent_deep']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 11px; font-weight: 600; padding: 0 12px;
            }}
            QPushButton#resumeAuto:checked {{
                color: {c['accent_text']}; background: {c['accent']}; border-color: {c['accent']};
            }}
            QPushButton#resumeAuto:hover {{ border-color: {c['accent']}; }}
            QLabel#resumeNotice {{ color: {c['pink']}; font-size: 11px; font-weight: 600; padding: 2px 2px 0; }}
            QPushButton#refreshBtn, QPushButton#renameBtn, QPushButton#sayBtn {{
                min-height: 28px; min-width: 88px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 10px;
                font-size: 11px; font-weight: 600; padding: 0 11px;
            }}
            QPushButton#refreshBtn:hover, QPushButton#renameBtn:hover, QPushButton#sayBtn:hover {{
                background: {c['accent_deep']}; border-color: {c['accent_deep']};
            }}
            QPushButton#refreshBtn:disabled, QPushButton#renameBtn:disabled, QPushButton#sayBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QPushButton#undoBtn {{
                min-height: 28px; color: {c['accent_deep']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 10px; font-weight: 600; padding: 0 10px;
            }}
            QPushButton#undoBtn:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QPushButton#undoBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QLabel#feedback {{ color: {c['pink']}; font-size: 11px; font-weight: 600; }}
            QLabel#rec {{
                background: {c['surface']}; color: {c['ink']};
                border: 1px solid {c['border']}; border-radius: 14px; font-size: 13px;
            }}
            QLabel#rec:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QLabel#rec:focus {{ border: 2px solid {c['accent']}; }}
        """)
        if self.target_menu is not None:
            self.target_menu.apply_theme()

    def prepare_for_show(self):
        # 普通面板/提问态恢复为原来的互动层；断联卡会在 show_resume 中临时降级。
        self._set_window_stays_on_top(True)
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

    def _set_window_stays_on_top(self, enabled):
        """只让断联卡成为一次性的前台提醒，切换程序后按普通工具窗自然让位。"""
        flag = Qt.WindowType.WindowStaysOnTopHint
        enabled = bool(enabled)
        current = bool(self.windowFlags() & flag)
        if current == enabled:
            return
        was_visible = self.isVisible()
        position = self.pos()
        self.setWindowFlag(flag, enabled)
        if was_visible:
            # Qt 改顶层 flag 时会暂时隐藏窗口，保住用户已经拖好的位置并恢复显示。
            self.move(position)
            self.show()

    def _fade_allowed(self):
        # 提问态/断联卡保持实体：读题/作答/一键继续是强互动，不参与鼠标离开淡出
        return not self.is_ask_open() and not self.is_resume_open()

    def show_ask(self, ask):
        ask_id = ask.get("askId") if isinstance(ask, dict) else ""
        if not ask_id or self._ask_responding or self._ask_finished:
            return
        # 断联卡让位给提问后，提问重新回到原来的互动层。
        self._set_window_stays_on_top(True)
        if self._ask_entry:
            if ask_id == self._ask_entry.get("askId"):
                # 当前题正在显示或等待失败重试时，不用新题覆盖输入状态；下一轮再处理。
                return
            # 新提问（askId 不同）：用最新题替换当前题，仍保持 ask 模式
            #（旧提问由服务端 TTL / 隐式跳过兜底，不丢）
            self._ask_entry = None
        # 提问优先：断联卡让位（下一轮轮询 resume 仍会回来，不丢）
        if self._resume_entry is not None:
            self._resume_entry = None
        self._ask_entry = dict(ask)
        self._ask_user_hidden = False
        # 提问态保持实体：若此前已淡出/正在淡出，立即拉回全不透明并取消排期
        self.setWindowOpacity(1.0)
        self._cancel_fade()
        self._ask_finished = False
        self._ask_responding = False
        self._needs_reanchor = not self._user_dragged
        self._set_ask_mode(True)
        self._render_ask(self._ask_entry)
        self.ball._ask_emitting = True  # 提问挂起：花朵持续散发花瓣
        self.ball._set_fusion_panel_state("ask")
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

    def _set_ask_mode(self, active):
        if active:
            entry = self._ask_entry or {}
            self.lbl_head.setText("❓ " + (entry.get("header") or "请你拍板"))
            self.setMinimumHeight(0)  # 清掉上一轮 settle 残留的最小高度
            for widget in (
                self.lbl_target_label, self.btn_target, self.lbl_target_info,
                self.recommend_body,
                self.lbl_section, self.say_tool, self.rename_tool, self.lbl_hint,
            ):
                widget.hide()
            self.target_menu.hide()
            self.ask_scroll.show()
            self.ask_input.show()
            self.btn_ask_skip.show()
            self.btn_ask_send.show()
            self.btn_ask_send.setText("确认选择" if self._ask_selection_mode == "multiple" else "发送")
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
                self.recommend_body,
                self.lbl_section, self.say_tool, self.rename_tool, self.lbl_hint,
            ):
                widget.show()
            self.ask_scroll.hide()
            self.ask_input.hide()
            self.btn_ask_skip.hide()
            self.btn_ask_send.hide()
            self.btn_ask_send.setText("发送")
            self.lbl_ask_select_hint.hide()
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
        self._ask_selection_mode = "multiple" if ask.get("selectionMode") == "multiple" else "single"
        self._ask_selected_indices = []
        self._ask_option_labels = []
        if self._ask_selection_mode == "multiple":
            min_value = ask.get("minSelections")
            max_value = ask.get("maxSelections")
            self._ask_min_selections = min_value if isinstance(min_value, int) and min_value > 0 else 1
            self._ask_max_selections = max_value if isinstance(max_value, int) and max_value > 0 else len(options)
            self._ask_max_selections = max(self._ask_min_selections, min(self._ask_max_selections, len(options)))
        else:
            self._ask_min_selections = 1
            self._ask_max_selections = 1
        # 选项永远 1 列竖排：每个选项一个整行横条胶囊（跟普通推荐条同款排法）
        for option in options:
            if not isinstance(option, dict):
                continue
            original_label = str(option.get("label") or "").strip()
            if not original_label:
                continue
            recommended = original_label.endswith("(Recommended)")
            display_label = original_label[:-len("(Recommended)")].rstrip() if recommended else original_label
            option_index = len(self._ask_option_labels)
            self._ask_option_labels.append(original_label)
            frame = AskOptionFrame(
                display_label or original_label,
                str(option.get("description") or "").strip(),
                recommended,
                self._ask_selection_mode,
            )
            frame.choice_label.clicked.connect(
                lambda index=option_index: self._toggle_ask_option(index)
            )
            self.ask_options_grid.addWidget(frame, option_index, 0)
            self._ask_option_frames.append(frame)
        self.ask_input.clear()
        self.ask_input.setPlaceholderText(
            "也可以直接填写其他答案…" if self._ask_selection_mode == "multiple"
            else "在此输入文本（嘻嘻，惯性思维了不是？在哪输入不是输入呢？）"
        )
        self.lbl_feedback.setText("")
        self._update_ask_selection_ui()
        self._set_ask_controls_enabled(not self._ask_responding and not self._ask_finished)
        self._sync_size()
        self.keep_current_position(full_height=True)

    def _toggle_ask_option(self, index):
        if not self._ask_entry or self._ask_responding or self._ask_finished:
            return
        if index < 0 or index >= len(self._ask_option_labels):
            return
        if self._ask_selection_mode != "multiple":
            self._respond_ask("option", self._ask_option_labels[index])
            return
        if index in self._ask_selected_indices:
            self._ask_selected_indices.remove(index)
        elif len(self._ask_selected_indices) >= self._ask_max_selections:
            self._flash(f"最多选择 {self._ask_max_selections} 项")
            return
        else:
            self._ask_selected_indices.append(index)
        self._ask_selected_indices.sort()
        self._update_ask_selection_ui()

    def _update_ask_selection_ui(self):
        selected = set(self._ask_selected_indices)
        for index, frame in enumerate(self._ask_option_frames):
            frame.set_selected(index in selected)
        if self._ask_selection_mode == "multiple":
            count = len(self._ask_selected_indices)
            self.lbl_ask_select_hint.setText(
                f"可多选 · 至少 {self._ask_min_selections} 项，最多 {self._ask_max_selections} 项 · 已选 {count} 项"
            )
            self.lbl_ask_select_hint.show()
            self.btn_ask_send.setText("确认选择")
        else:
            self.lbl_ask_select_hint.clear()
            self.lbl_ask_select_hint.hide()
            self.btn_ask_send.setText("发送")

    def _set_ask_controls_enabled(self, enabled):
        for frame in self._ask_option_frames:
            frame.choice_label.setEnabled(bool(enabled))
        self.ask_input.setEnabled(bool(enabled))
        self.btn_ask_skip.setEnabled(bool(enabled))
        self.btn_ask_send.setEnabled(bool(enabled))

    def _send_custom_ask(self):
        value = normalize_custom_answer(self.ask_input.text())
        if value:
            self._respond_ask("custom", value)
            return
        if self._ask_selection_mode == "multiple":
            if len(self._ask_selected_indices) < self._ask_min_selections:
                self._flash(f"至少选择 {self._ask_min_selections} 项")
                return
            choices = [self._ask_option_labels[index] for index in self._ask_selected_indices]
            self._respond_ask("option", choices)
            return
        self._flash("请选择一个选项或填写自定义答案")

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
            if isinstance(choice, list):
                choice_text = "、".join(str(item) for item in choice)
            else:
                choice_text = str(choice)
            self._flash("已跳过" if mode == "skip" else f"已发送 · {choice_text}")
            self._set_ask_controls_enabled(False)
            completed_ask_id = self._ask_entry.get("askId")
            # 作答完成不恢复推荐面板，短暂反馈后直接收起成悬浮球
            QTimer.singleShot(
                650,
                lambda ask_id=completed_ask_id: self.finish_ask_and_collapse(ask_id),
            )
        else:
            self._set_ask_controls_enabled(True)
            self._flash(payload.get("error") or "发送失败，再试一次")

    def finish_ask_and_collapse(self, expected_ask_id=None):
        """提问作答完成 / ask 判定可关闭（隐式跳过、过期等）后：清理提问态并收起面板回悬浮球。

        用户已通过面板作答或直接在主对话继续，不需要再弹推荐面板；
        恢复推荐交给下次手动打开面板时 prepare_for_show 重新渲染。"""
        if not self._ask_entry or self._ask_responding:
            return
        if expected_ask_id and self._ask_entry.get("askId") != expected_ask_id:
            return
        self._ask_entry = None
        self._ask_finished = False
        self._ask_user_hidden = False
        self._ask_response_mode = ""
        self._ask_response_choice = ""
        self._ask_selection_mode = "single"
        self._ask_min_selections = 1
        self._ask_max_selections = 1
        self._ask_selected_indices = []
        self._ask_option_labels = []
        self._needs_reanchor = False
        self.ball._ask_emitting = False  # 提问结束，停止散发花瓣
        self._set_ask_mode(False)
        self._flash("")
        self.close_menu()
        self.ball._set_fusion_panel_state("none")

    # ── 断联续接模式：一键继续 / 自动续接开关 ──
    def is_resume_open(self):
        return self._resume_entry is not None and not self._resume_finished

    def show_resume(self, resume):
        resume_id = resume.get("resumeId") if isinstance(resume, dict) else ""
        if not resume_id or self._resume_responding or self._resume_finished:
            return
        if self.is_ask_open():
            return  # 提问优先：等 ask 完成后下一轮轮询再弹，不打断作答
        # 断联卡不是永久置顶窗：首次 show/raise 后，用户切换其他程序即可自然盖住它。
        self._set_window_stays_on_top(False)
        if self._resume_entry:
            if resume_id == self._resume_entry.get("resumeId"):
                return
            self._resume_entry = None
        self._resume_entry = dict(resume)
        self._resume_user_hidden = False
        self.setWindowOpacity(1.0)
        self._cancel_fade()
        self._resume_finished = False
        self._resume_responding = False
        self._needs_reanchor = not self._user_dragged
        self._set_resume_mode(True)
        self._render_resume(self._resume_entry)
        self._resume_pulse_title()

    def _resume_pulse_title(self, rounds=3):
        """断联卡弹出时标题颜色脉冲（accent_deep ↔ pink），提醒内容是断联。"""
        c = THEME_COLORS[self.ball.theme_mode]
        step_ms = 170
        for i in range(rounds * 2):
            on = i % 2 == 0
            QTimer.singleShot(
                i * step_ms,
                lambda on=on: self.lbl_head.setStyleSheet(f"color: {c['pink']};" if on else ""),
            )

    def set_resume_auto_state(self, enabled):
        self._resume_auto = bool(enabled)
        self.btn_resume_auto.setChecked(self._resume_auto)
        self.btn_resume_auto.setText("自动续接：开" if self._resume_auto else "自动续接：关")

    def _set_resume_mode(self, active):
        if active:
            self.lbl_head.setText("🌸 窗口断联了")
            self.setMinimumHeight(0)
            for widget in (
                self.lbl_target_label, self.btn_target, self.lbl_target_info,
                self.recommend_body,
                self.lbl_section, self.say_tool, self.rename_tool, self.lbl_hint,
            ):
                widget.hide()
            self.target_menu.hide()
            self.ask_scroll.hide()
            self.ask_input.hide()
            self.btn_ask_skip.hide()
            self.btn_ask_send.hide()
            self.resume_body.show()
            self.setMaximumHeight(400)
        else:
            self.setMaximumHeight(16777215)
            self.setMinimumHeight(0)
            self.lbl_head.setText("解语花")
            for widget in (
                self.lbl_target_label, self.btn_target, self.lbl_target_info,
                self.recommend_body,
                self.lbl_section, self.say_tool, self.rename_tool, self.lbl_hint,
            ):
                widget.show()
            self.resume_body.hide()
            self._resume_entry = None

    def _render_resume(self, resume):
        title = str(resume.get("sessionTitle") or "").strip()
        agent = str(resume.get("agentName") or "").strip()
        if title:
            who = f"{title}（{agent}）" if agent else title
            self.lbl_resume_from.setText(f"💬 来自窗口：{who}")
        elif agent:
            self.lbl_resume_from.setText(f"💬 来自：{agent}")
        else:
            self.lbl_resume_from.setText("💬 来自某个窗口")
        self.lbl_resume_reason.setText(str(resume.get("reason") or "窗口断联了"))
        self.btn_resume_continue.setEnabled(True)
        self.btn_resume_continue.setText("继续")

    def _continue_resume(self):
        if not self.is_resume_open() or self._resume_responding:
            return
        self._resume_responding = True
        self.btn_resume_continue.setEnabled(False)
        self.btn_resume_continue.setText("发送中…")
        resume_id = self._resume_entry.get("resumeId") or ""

        def worker():
            result = {"ok": False, "error": "连不上解语花，看看插件开着没"}
            try:
                data = api_post("/resume/continue", {"resumeId": resume_id}, timeout=20)
                if data and data.get("ok"):
                    result = {"ok": True}
                else:
                    result = {"ok": False, "error": (data or {}).get("error") or "发送失败"}
            except urllib.error.HTTPError as e:
                # 后端业务错误（待办已失效/会话已删等）带了真实原因，解析出来上屏
                try:
                    body = json.loads(e.read().decode("utf-8", "replace"))
                    result = {"ok": False, "error": body.get("error") or f"发送失败了 ({e.code})"}
                except Exception:
                    result = {"ok": False, "error": f"发送失败了 ({e.code})"}
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.resume_continue_ready.emit(result)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-resume-continue").start()

    def _apply_resume_continue_result(self, payload):
        if not self.is_resume_open():
            return
        self._resume_responding = False
        if not payload.get("ok"):
            self.btn_resume_continue.setEnabled(True)
            self.btn_resume_continue.setText("继续")
            self.lbl_resume_reason.setText(f"发送失败：{payload.get('error') or '再试一次'}")
            return
        self._flash("已发送 · 继续")
        self._resume_finished = True
        # 已让窗口继续：短暂反馈后收起回悬浮球（下一轮轮询也收不到这条了）
        QTimer.singleShot(650, self.finish_resume_and_collapse)

    def _toggle_resume_auto(self, checked):
        # 视觉先行：点了立刻显示目标状态，失败再回滚
        self._resume_auto = bool(checked)
        self.set_resume_auto_state(self._resume_auto)

        def worker():
            result = {"ok": False}
            try:
                data = api_post("/resume/auto", {"enabled": self._resume_auto}, timeout=6)
                if data and data.get("ok"):
                    result = {"ok": True, "enabled": self._resume_auto}
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.resume_auto_ready.emit(result)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-resume-auto").start()

    def _apply_resume_auto_result(self, payload):
        if payload.get("ok"):
            return
        # 保存失败：回滚开关状态
        self._resume_auto = not self._resume_auto
        self.set_resume_auto_state(self._resume_auto)
        self._flash("自动续接设置没保存上，再试一次")

    def show_resume_notice(self, notice):
        """自动续接成功后的短暂提示（轮询带回，面板可见时显示几秒）。"""
        if not isinstance(notice, dict) or getattr(self, "_closed", False):
            return
        title = str(notice.get("title") or "").strip()
        agent = str(notice.get("agentName") or "").strip()
        who = title or agent or "某个窗口"
        self.lbl_resume_notice.setText(f"✿ 已自动让「{who}」继续")
        self.lbl_resume_notice.show()
        if self._resume_notice_timer is not None:
            self._resume_notice_timer.stop()
        self._resume_notice_timer = QTimer(self)
        self._resume_notice_timer.setSingleShot(True)
        self._resume_notice_timer.timeout.connect(self.lbl_resume_notice.hide)
        self._resume_notice_timer.start(4000)

    def finish_resume_and_collapse(self):
        """断联卡处理完（已继续 / 待办消失 / 用户接手 / 过期）后：清理状态并收起面板回悬浮球。"""
        if not self._resume_entry or self._resume_responding:
            return
        self._resume_entry = None
        self._resume_finished = False
        self._resume_user_hidden = False
        self._needs_reanchor = False
        self._set_resume_mode(False)
        self._flash("")
        self.close_menu()
        # 断联卡收起后，下一次打开普通推荐/提问面板仍使用原来的互动层。
        self._set_window_stays_on_top(True)
        self.ball._set_fusion_panel_state("none")

    def load_cache_async(self):
        target_revision = getattr(self.ball, "target_revision", 0)

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
                        "target_revision": target_revision,
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
        target_revision = getattr(self.ball, "target_revision", 0)
        self._set_refreshing_ui(True)

        def worker():
            payload = {"source": "refresh", "seq": refresh_seq, "target_revision": target_revision, "items": None, "rid": None, "target": None, "error": None, "target_state_loaded": False}
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

    # ── 语音朗读：主面板只留「念给我听」入口，朗读本体在独立 ReadPanel ──
    def _open_read_panel(self):
        """点「念给我听」：只打开选择窗口，等用户选好回复后再点击朗读。"""
        if self.ball.read_panel is None:
            self.ball.read_panel = ReadPanel(self.ball)
        self.close_menu()                       # 推荐面板让位，不再自带朗读按钮
        self.ball.read_panel.open_for(self.ball.target_name, start=False)
        self.ball._set_fusion_panel_state("read")

    def _update_say_btn(self):
        """让朗读工具的说明跟随当前判定的助手名，按钮本身保持统一动作文案。"""
        name = (self.ball.target_name or "").strip()
        try:
            self.btn_say.setText("念给我听")
            self.lbl_say_desc.setText(f"让 {name or '小花'} 把当前回复念出来")
        except RuntimeError:
            pass

    def hideEvent(self, event):
        # 朗读归独立 ReadPanel 管理（它自己有关闭即停读），主面板收起不管声音
        super().hideEvent(event)
        self._cancel_fade()

    def _apply_async_refresh(self, payload):
        if payload.get("source") == "refresh" and payload.get("seq") != self._refresh_seq:
            return
        if payload.get("source") == "refresh":
            self._refreshing = False
            self._set_refreshing_ui(False)
        target_state_current = payload.get("target_revision", getattr(self.ball, "target_revision", 0)) == getattr(self.ball, "target_revision", 0)
        if payload.get("target") and target_state_current:
            self.ball.target_name = payload["target"].get("name") or payload["target"].get("agentId") or ""
            self.ball.target_title = payload["target"].get("title") or self.ball.target_title
        if payload.get("target_state_loaded") and target_state_current:
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
        # 刷新推荐期间仍允许切换目标；回包带 target_revision，旧目标状态只会被丢弃。
        self.btn_target.setEnabled(True)
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
            self._set_undo_available(True)
            self._sync_target_state()
        else:
            self._flash(payload.get("error") or "重命名失败，再试一次")

    def _apply_undo_result(self, payload):
        if payload.get("ok"):
            restored = payload.get("restoredTitle") or "无标题"
            who = f"{payload['agentName']} 的" if payload.get("agentName") else ""
            self._flash(f"已把{who}会话标题退回：{restored}")
            self._set_undo_available(False)
            self._sync_target_state()
        else:
            self._flash(payload.get("error") or "退回失败，再试一次")

    def _set_undo_available(self, available):
        available = bool(available)
        changed = self._undo_available != available
        self._undo_available = available
        self.btn_undo.setVisible(available)
        self.btn_undo.setEnabled(available and not self._renaming)
        if changed and self.isVisible():
            self._resize_after_title_change()

    def _set_renaming_ui(self, renaming):
        self.btn_rename.setEnabled(not renaming)
        self.btn_rename.setText("总结中…" if renaming else "生成新标题")
        self.btn_undo.setEnabled(self._undo_available and not renaming)

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
        self._flash("正在发送…" if action == "send" else "正在填入…")
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
                    self._flash("已复制 ✓ 手动粘贴到对话框")
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
            label = "跟随最近"
        self.btn_target.setText(f"{label} {arrow}")
        self._update_target_info()

    def _update_target_info(self):
        """头部下方显示当前读取的是哪个对话框：固定会话或跟随最近结果。"""
        name = (self.ball.target_name or "").strip()
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            prefix = "固定"
        else:
            title = (self.ball.target_title or "").strip()
            prefix = "跟随最近"
        if title:
            text = " · ".join([prefix, name, title]) if name else " · ".join([prefix, title])
        elif name:
            text = " · ".join([prefix, name]) + "（无标题）"
        else:
            text = "跟随最近 · 正在定位对话…"
        self.lbl_target_info.setText(text)
        self._update_say_btn()

    def _sync_target_state(self):
        self._target_seq += 1
        target_seq = self._target_seq
        target_revision = getattr(self.ball, "target_revision", 0)

        def worker():
            payload = None
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload = {**data, "seq": target_seq, "target_revision": target_revision}
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
        if data.get("target_revision", getattr(self.ball, "target_revision", 0)) != getattr(self.ball, "target_revision", 0):
            return
        t = data.get("target") or {}
        self.ball.target_name = t.get("name") or t.get("agentId") or ""
        self.ball.target_title = t.get("title") or ""
        self.ball.target_mode = "pinned" if data.get("mode") == "pinned" else "auto"
        self.ball.pinned_target = data.get("pinned")
        self._update_target()
        # 退回按钮的显示与可用性都由服务端真实记录驱动。
        if "undoAvailable" in data and not self._renaming:
            self._set_undo_available(data.get("undoAvailable"))

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

    def _resize_after_title_change(self):
        # 还原按钮显示/隐藏会改变面板高度；非手动拖动时重新按比例贴回悬浮球。
        def settle():
            self._sync_size()
            if self.isVisible() and not self._user_dragged:
                self.move_to_ball()
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle))

    def _update_hint(self):
        action = self.ball.action
        mode = "点一下直接发出" if action == "send" else "点一下复制，自己粘贴到对话框"
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
        """与推荐面板同一套定位：左侧优先，左侧放不下才翻到右侧。"""
        self._sync_size()
        b = self.ball
        screen = b.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        bw = b.width()
        bh = b.height()
        x, y, side = position_popup_left_first(
            (b.x(), b.y(), bw, bh),
            (self.width(), self.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            gap=8,
            anchor_ratio=PANEL_ANCHOR_RATIO,
        )
        if side != self.side:
            self.side = side
            b.state["panel_side"] = side
            save_state(b.state)
        self.move(x, y)

    def close_menu(self):
        if self.is_ask_open():
            self._ask_user_hidden = True
        if self.is_resume_open():
            # 断联卡收起 = 放弃这条待办（跟 ask 折叠一致）：本地不再打回，服务端标已消费，
            # 否则每次开球/重启都会再弹（2026-08-27 实机踩到）。
            self._resume_user_hidden = True
            self._dismiss_resume_async(self._resume_entry.get("resumeId") or "")
        if self.target_menu is not None:
            self.target_menu.hide()
        self.hide()

    def _dismiss_resume_async(self, resume_id):
        if not resume_id:
            return

        def worker():
            try:
                api_post("/resume/dismiss", {"resumeId": resume_id}, timeout=6)
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-resume-dismiss").start()

    def showEvent(self, event):
        super().showEvent(event)
        self.activateWindow()
        self._reset_fade_on_show()

    def hideEvent(self, event):
        super().hideEvent(event)
        self._cancel_fade()

    def enterEvent(self, event):
        super().enterEvent(event)
        self._on_fade_enter()

    def leaveEvent(self, event):
        super().leaveEvent(event)
        self._on_fade_leave()

    # ── 面板拖拽：按住空白处时，展板与花朵保持原距离一起移动 ──
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_press = e.globalPosition().toPoint()
            self._drag_panel_start = self.pos()
            self._drag_ball_start = self.ball.pos()
            self._drag_moved = False
            reset_motion = getattr(self.ball, "_reset_drag_motion", None)
            if callable(reset_motion):
                reset_motion()
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
            record_motion = getattr(self.ball, "_record_drag_motion", None)
            if callable(record_motion):
                record_motion()
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._drag_moved:
                release_motion = getattr(self.ball, "_release_drag_motion", None)
                if callable(release_motion):
                    release_motion()
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
#  朗读专属弹窗（点主面板「念给我听」打开）
# ─────────────────────────────
class ReadPanel(QFrame):
    """独立朗读窗口：把播放/暂停/继续、重听、刷新回复、收藏集中在一处，
    从推荐面板拆出，空间宽裕不拥挤。关闭即停读；播完自动复位。"""

    read_ready = pyqtSignal(object)   # /tts/speak 回包
    fav_ready = pyqtSignal(object)    # /tts/favorite 回包
    target_ready = pyqtSignal(object) # /target 回包
    replies_ready = pyqtSignal(object) # /tts/replies 回包

    WIDTH = 320

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.target_menu_title = "朗读哪段对话？"
        self._name = ""
        # 面板边向：与推荐面板共用同一份 panel_side（贴边翻边后写入），默认左
        self.side = str((getattr(self.ball, "state", None) or {}).get("panel_side") or "left")
        # 双窗拖动状态：朗读窗与花朵始终作为一组移动（与推荐面板一致）
        self._drag_press = None
        self._drag_panel_start = None
        self._drag_ball_start = None
        self._drag_moved = False
        self._user_dragged = False
        self._reading = False
        self._player = None
        self._audio_out = None
        self._media_path = None    # 临时音频文件路径（播放走文件，Qt 内存播 mp3 不稳）
        self._last_read = None     # 最近一次朗读的内容（文本/音频/音色），供收藏
        self._replies = []         # 最新在前，最多 6 条助手回复
        self._reply_index = 0      # 0=最新，1~5=往前第几条
        self._replies_loading = False
        self._replies_error = ""
        self._read_session_path = ""
        self._auto_read_pending = False
        self._read_seq = 0
        self._fav_seq = 0
        self._target_seq = 0
        self._replies_seq = 0
        self._refresh_feedback_seq = 0
        self._closed = False

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("readPanel")
        self.setFixedWidth(self.WIDTH)

        self.read_ready.connect(self._apply_read_result)
        self.fav_ready.connect(self._apply_fav_result)
        self.target_ready.connect(self._apply_target_state)
        self.replies_ready.connect(self._apply_replies)
        self._build_ui()
        self.apply_theme()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 14, 20, 16)
        root.setSpacing(10)

        # 头部：当前助手名 + 关闭
        head = QHBoxLayout()
        head.setSpacing(8)
        self.lbl_head = QLabel("让 助手 说话")
        self.lbl_head.setObjectName("readHead")
        head.addWidget(self.lbl_head)
        head.addStretch(1)
        self.btn_close = QPushButton("✕")
        self.btn_close.setObjectName("readCloseBtn")
        self.btn_close.setFixedSize(24, 24)
        self.btn_close.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_close.setToolTip("收起朗读（停止播放）")
        self.btn_close.clicked.connect(self.close)
        head.addWidget(self.btn_close)
        root.addLayout(head)

        # 朗读目标窗口：与推荐面板共用跟随最近/手动固定逻辑
        target_row = QHBoxLayout()
        target_row.setSpacing(6)
        self.lbl_target_label = QLabel("选择对话")
        self.lbl_target_label.setObjectName("readTargetLabel")
        self.btn_target = QPushButton("跟随最近 ▾")
        self.btn_target.setObjectName("readTargetBtn")
        self.btn_target.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_target.setToolTip("跟随最近活跃的对话，或固定一段窗口")
        self.btn_target.clicked.connect(self._open_target_menu)
        target_row.addWidget(self.lbl_target_label)
        target_row.addWidget(self.btn_target)
        target_row.addStretch(1)
        root.addLayout(target_row)

        self.lbl_target_info = QLabel("")
        self.lbl_target_info.setObjectName("readTargetInfo")
        self.lbl_target_info.setWordWrap(True)
        root.addWidget(self.lbl_target_info)

        self.target_menu = TargetMenu(self)
        self.target_menu.hide()
        root.addWidget(self.target_menu)

        # 朗读哪一条：默认最新，列表里再给最新前的 5 条
        reply_row = QHBoxLayout()
        reply_row.setSpacing(6)
        self.lbl_reply_label = QLabel("选择回复")
        self.lbl_reply_label.setObjectName("readReplyLabel")
        self.btn_reply = QPushButton("最新回复 ▾")
        self.btn_reply.setObjectName("readReplyBtn")
        self.btn_reply.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_reply.setToolTip("默认朗读最新回复，也可以从前 5 条里挑一条")
        self.btn_reply.clicked.connect(self._open_reply_menu)
        self.btn_refresh_replies = QPushButton("↻ 刷新")
        self.btn_refresh_replies.setObjectName("readRefreshBtn")
        self.btn_refresh_replies.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_refresh_replies.setToolTip("重新读取这段对话的最新 6 条助手回复，不会自动朗读")
        self.btn_refresh_replies.clicked.connect(
            lambda checked=False: self.refresh_replies_async(reset_read=True)
        )
        reply_row.addWidget(self.lbl_reply_label)
        reply_row.addWidget(self.btn_reply)
        reply_row.addWidget(self.btn_refresh_replies)
        reply_row.addStretch(1)
        root.addLayout(reply_row)

        self.reply_menu = QFrame(self)
        self.reply_menu.setObjectName("readReplyMenu")
        reply_menu_layout = QVBoxLayout(self.reply_menu)
        reply_menu_layout.setContentsMargins(8, 8, 8, 8)
        reply_menu_layout.setSpacing(5)
        self.reply_list_box = QVBoxLayout()
        self.reply_list_box.setContentsMargins(0, 0, 0, 0)
        self.reply_list_box.setSpacing(5)
        reply_menu_layout.addLayout(self.reply_list_box)
        self.reply_menu.hide()
        root.addWidget(self.reply_menu)

        # 朗读文本预览：完整显示不截断，超长限高；可选中复制
        self.lbl_text = QLabel("")
        self.lbl_text.setObjectName("readText")
        self.lbl_text.setWordWrap(True)
        self.lbl_text.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.lbl_text.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.lbl_text.setMaximumHeight(132)
        root.addWidget(self.lbl_text)

        # 主播放键：读 / 暂停 / 继续 三态
        self.btn_play = QPushButton("🔊 朗读")
        self.btn_play.setObjectName("readPlayBtn")
        self.btn_play.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_play.clicked.connect(self.toggle_play)
        root.addWidget(self.btn_play)

        # 次键：重听 / 收藏（都只作用于当前选中的回复）
        row = QHBoxLayout()
        row.setSpacing(8)
        self.btn_replay = QPushButton("↻ 重听")
        self.btn_replay.setObjectName("readSubBtn")
        self.btn_replay.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_replay.setToolTip("从头重新播放当前选中的回复")
        self.btn_replay.clicked.connect(self.replay_read)
        self.btn_replay.setEnabled(False)
        self.btn_sub_fav = QPushButton("♡ 收藏")
        self.btn_sub_fav.setObjectName("readSubBtn")
        self.btn_sub_fav.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_sub_fav.setToolTip("把当前选中的回复存进收藏，以后不用重新合成、随时能听")
        self.btn_sub_fav.clicked.connect(self.fav_read_async)
        self.btn_sub_fav.setEnabled(False)
        for b in (self.btn_replay, self.btn_sub_fav):
            row.addWidget(b)
        row.addStretch(1)
        root.addLayout(row)

        self.lbl_feedback = QLabel("")
        self.lbl_feedback.setObjectName("readFeedback")
        root.addWidget(self.lbl_feedback)

    # ── 目标窗口与回复选择 ──
    def _clear_reply_menu(self):
        while self.reply_list_box.count():
            item = self.reply_list_box.takeAt(0)
            widget = item.widget()
            if widget:
                widget.hide()
                widget.deleteLater()

    def _reply_choice_text(self, index, preview=""):
        prefix = "最新回复" if index == 0 else f"前 {index} 条回复"
        clean = " ".join(str(preview or "").split())
        return f"{prefix} · {clean or '（没有可预览的文字）'}"

    def _update_reply_button(self):
        label = "最新回复" if self._reply_index == 0 else f"前 {self._reply_index} 条回复"
        self.btn_reply.setText(label + " ▾")

    def _render_replies(self):
        self._clear_reply_menu()
        if self._replies_loading:
            lbl = QLabel("正在读取这段对话的回复…")
            lbl.setObjectName("readReplySub")
            self.reply_list_box.addWidget(lbl)
            return
        if self._replies_error:
            lbl = QLabel(self._replies_error)
            lbl.setObjectName("readReplySub")
            lbl.setWordWrap(True)
            self.reply_list_box.addWidget(lbl)
            retry = QPushButton("↻ 重新读取")
            retry.setObjectName("replyItem")
            retry.setCursor(Qt.CursorShape.PointingHandCursor)
            retry.clicked.connect(lambda checked=False: self.refresh_replies_async(reset_read=True))
            self.reply_list_box.addWidget(retry)
            return
        if not self._replies:
            lbl = QLabel("还没找到可朗读的助手回复")
            lbl.setObjectName("readReplySub")
            self.reply_list_box.addWidget(lbl)
            return
        for index, item in enumerate(self._replies):
            preview = str(item.get("preview") or "")
            btn = QPushButton()
            btn.setObjectName("replyItem")
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setProperty("active", "true" if index == self._reply_index else "false")
            label = self._reply_choice_text(index, preview)
            btn.setText(btn.fontMetrics().elidedText(label, Qt.TextElideMode.ElideRight, 250))
            btn.setToolTip(preview or label)
            btn.clicked.connect(lambda checked=False, i=index: self._pick_reply(i))
            self.reply_list_box.addWidget(btn)
        self.reply_list_box.addStretch(1)

    def _open_reply_menu(self):
        show = not self.reply_menu.isVisible()
        if show:
            self._set_target_selector_visible(False)
        self._set_reply_selector_visible(show)
        if show and not self._replies and not self._replies_loading:
            self.refresh_replies_async()

    def _set_reply_selector_visible(self, visible):
        self.reply_menu.setVisible(bool(visible))
        if visible:
            self.target_menu.hide()
        self._resize_after_target_change()

    def _pick_reply(self, index):
        if index < 0 or index >= len(self._replies):
            return
        self._reply_index = index
        self._update_reply_button()
        self._render_replies()
        self._set_reply_selector_visible(False)
        self._clear_current_read()
        label = "最新回复" if index == 0 else f"前 {index} 条回复"
        self._flash(f"已选{label}，点「朗读」播放")

    def _clear_current_read(self):
        self._read_seq += 1
        self._fav_seq += 1
        self._stop_read()
        self._reset_read_ui()
        self._last_read = None
        self.btn_sub_fav.setEnabled(False)
        self.btn_sub_fav.setText("♡ 收藏")
        self.lbl_text.setText("")

    def _open_target_menu(self):
        show = not self.target_menu.isVisible()
        if show:
            self._set_reply_selector_visible(False)
        self._set_target_selector_visible(show)
        if show:
            self.target_menu.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
            self.target_menu.refresh_sessions_async()

    def _update_target(self):
        arrow = "▴" if self.target_menu.isVisible() else "▾"
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            label = f"固定 · {title[:6]}" if title else "固定"
        else:
            label = "跟随最近"
        self.btn_target.setText(label + " " + arrow)
        self._update_target_info()

    def _update_target_info(self):
        name = (self.ball.target_name or "").strip()
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            prefix = "固定"
        else:
            title = (self.ball.target_title or "").strip()
            prefix = "跟随最近"
        if title:
            text = " · ".join([prefix, name, title]) if name else " · ".join([prefix, title])
        elif name:
            text = " · ".join([prefix, name]) + "（无标题）"
        else:
            text = "跟随最近 · 正在定位对话…"
        self.lbl_target_info.setText(text)
        self._name = name
        self.lbl_head.setText("让 " + (name or "助手") + " 说话")

    def _on_target_changed(self):
        """TargetMenu 已完成 pin：清掉旧目标，立刻按新目标重拉回复列表。"""
        self._auto_read_pending = False
        self._read_session_path = ""
        self._reply_index = 0
        self._clear_current_read()
        self._update_reply_button()
        self.refresh_replies_async()

    def _sync_target_state(self):
        self._target_seq += 1
        target_seq = self._target_seq
        target_revision = getattr(self.ball, "target_revision", 0)

        def worker():
            payload = None
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload = {**data, "seq": target_seq, "target_revision": target_revision}
            except Exception:
                pass
            if payload is not None and not self._closed:
                try:
                    self.target_ready.emit(payload)
                except RuntimeError:
                    pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-read-target").start()

    def _apply_target_state(self, data):
        if data.get("seq") != self._target_seq:
            return
        if data.get("target_revision", getattr(self.ball, "target_revision", 0)) != getattr(self.ball, "target_revision", 0):
            return
        target = data.get("target")
        if target:
            self.ball.target_name = target.get("name") or target.get("agentId") or ""
            self.ball.target_title = target.get("title") or ""
        else:
            self.ball.target_name = ""
            self.ball.target_title = ""
        self.ball.target_mode = "pinned" if data.get("mode") == "pinned" else "auto"
        self.ball.pinned_target = data.get("pinned")
        self._update_target()
        if self.isVisible():
            self.refresh_replies_async()

    def invalidate_target_sync(self):
        """用户主动切换窗口时，让旧目标的声音和回复列表立即失效。"""
        self._target_seq += 1
        self._auto_read_pending = False
        # 先停掉旧语音，但保留旧列表；/pin 失败时仍能回到原选择。
        self._clear_current_read()

    def _set_target_selector_visible(self, visible):
        self.target_menu.setVisible(bool(visible))
        self._update_target()
        self._resize_after_target_change()

    def _resize_after_target_change(self):
        # 与推荐面板一致：菜单/内容变化后重新定位，用户拖过则保持手动位置
        if self.isVisible():
            self._keep_position()

    def refresh_replies_async(self, auto_read=False, reset_read=False):
        if reset_read:
            self._reply_index = 0
            self._clear_current_read()
            self._update_reply_button()
            self._flash("正在刷新回复列表…")
        self._auto_read_pending = bool(auto_read)
        self._replies_seq += 1
        replies_seq = self._replies_seq
        self._refresh_feedback_seq = replies_seq if reset_read else 0
        self._replies_loading = True
        self._replies_error = ""
        self.btn_refresh_replies.setEnabled(False)
        self._render_replies()
        expected_session_path = str(self._read_session_path or "") if reset_read else ""

        def worker():
            payload = {"seq": replies_seq, "ok": False, "replies": [], "sessionPath": expected_session_path, "error": "读取失败，点「↻ 刷新」再试"}
            try:
                route = "/tts/replies"
                if expected_session_path:
                    route += "?sessionPath=" + urllib.parse.quote(expected_session_path, safe="")
                data = api_get(route, timeout=5)
                if data.get("ok"):
                    returned_session_path = str(data.get("sessionPath") or "")
                    same_path = bool(
                        expected_session_path
                        and returned_session_path
                        and os.path.normcase(os.path.normpath(expected_session_path))
                        == os.path.normcase(os.path.normpath(returned_session_path))
                    )
                    if expected_session_path and not same_path:
                        payload["sessionPath"] = expected_session_path
                        payload["error"] = "当前对话刚刚变化了，点「↻ 刷新」再试"
                    else:
                        payload = {
                            "seq": replies_seq,
                            "ok": True,
                            "replies": data.get("replies") or [],
                            "sessionPath": returned_session_path,
                            "target": data.get("target"),
                            "mode": data.get("mode") or "auto",
                            "pinned": data.get("pinned"),
                            "error": "",
                        }
                else:
                    payload["error"] = data.get("error") or payload["error"]
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"读取失败了 ({e.code})"
                except Exception:
                    payload["error"] = f"读取失败了 ({e.code})"
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.replies_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-read-replies").start()

    def _apply_replies(self, payload):
        if payload.get("seq") != self._replies_seq:
            return
        self._replies_loading = False
        self.btn_refresh_replies.setEnabled(True)
        show_refresh_feedback = payload.get("seq") == self._refresh_feedback_seq
        if show_refresh_feedback:
            self._refresh_feedback_seq = 0
        self._replies_error = payload.get("error") or ""
        self._read_session_path = str(payload.get("sessionPath") or "")
        auto_read = self._auto_read_pending
        self._auto_read_pending = False
        target = payload.get("target")
        if target:
            self.ball.target_name = target.get("name") or target.get("agentId") or ""
            self.ball.target_title = target.get("title") or ""
        elif payload.get("ok"):
            self.ball.target_name = ""
            self.ball.target_title = ""
        if payload.get("ok"):
            self.ball.target_mode = "pinned" if payload.get("mode") == "pinned" else "auto"
            self.ball.pinned_target = payload.get("pinned")
            self._replies = [item for item in (payload.get("replies") or []) if isinstance(item, dict)][:6]
            self._reply_index = 0
        else:
            self._replies = []
        self._update_target()
        self._update_reply_button()
        self._render_replies()
        self._resize_after_target_change()
        if show_refresh_feedback:
            self._flash(
                "回复列表已更新，点「朗读」播放"
                if payload.get("ok")
                else (self._replies_error or "回复列表读取失败，点「↻ 刷新」再试")
            )
        if auto_read and payload.get("ok") and self._read_session_path and self._replies and self.isVisible():
            QTimer.singleShot(0, self.read_async)

    # ── 打开 / 定位 ──
    def open_for(self, name, start=False):
        self._closed = False
        self._user_dragged = False
        self._read_seq += 1
        self._fav_seq += 1
        self._target_seq += 1
        self._replies_seq += 1
        requested_name = (name or "").strip()
        self._name = requested_name
        self._reply_index = 0
        self._last_read = None
        self._replies = []
        self._replies_error = ""
        self._replies_loading = False
        self._read_session_path = ""
        self._auto_read_pending = bool(start)
        self.target_menu.hide()
        self.reply_menu.hide()
        self.lbl_head.setText("让 " + (self._name or "助手") + " 说话")
        self.lbl_text.setText("")
        self._stop_read()
        self._reset_read_ui()
        self.btn_sub_fav.setEnabled(False)
        self.btn_sub_fav.setText("♡ 收藏")
        self.btn_refresh_replies.setEnabled(True)
        self._update_reply_button()
        self._update_target()
        if requested_name and not self.ball.target_name:
            self._name = requested_name
            self.lbl_head.setText("让 " + requested_name + " 说话")
        self._render_replies()
        self.apply_theme()
        self.move_to_ball()
        self.show()
        self.raise_()
        self.activateWindow()
        # 布局稳定后再校准一次位置（空文本时高度偏小，读到内容后还会再 settle）
        self._settle()
        # 打开弹窗只读取可选回复，不自动消耗语音额度；start=True 仅保留给
        # 旧调用方的显式兼容路径，正常入口传 False，必须由用户点击「朗读」才合成。
        self.refresh_replies_async(auto_read=bool(start))

    def move_to_ball(self):
        """与推荐面板同一套定位：左侧优先，左侧放不下才翻到右侧。"""
        self._sync_size()
        b = self.ball
        screen = b.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        bw = b.width()
        bh = b.height()
        x, y, side = position_popup_left_first(
            (b.x(), b.y(), bw, bh),
            (self.width(), self.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            gap=8,
            anchor_ratio=PANEL_ANCHOR_RATIO,
        )
        if side != self.side:
            self.side = side
            if getattr(b, "state", None) is not None:
                b.state["panel_side"] = side
                save_state(b.state)
        self.move(x, y)

    def _keep_position(self):
        """内容高度变化后：用户拖过就保持当前，没拖过按球重新锚定（两轮事件循环后）。"""
        if not self.isVisible():
            return
        def settle_now():
            self._sync_size()
            if self._user_dragged:
                screen = self.ball.screen() or QApplication.primaryScreen()
                geo = screen.availableGeometry()
                x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
                y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
                self.move(x, y)
            else:
                self.move_to_ball()
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle_now))

    def _sync_size(self):
        if self.layout() is not None:
            self.layout().activate()
        self.adjustSize()

    def _settle(self):
        # 内容高度变化后等两轮事件循环再调尺寸与位置，避免跳动
        if not self.isVisible():
            return
        self._keep_position()

    # ── 播放控制 ──
    def toggle_play(self):
        if not _HAS_QMULTIMEDIA:
            self._flash("缺少音频播放组件（PyQt6 需要 QtMultimedia），重新安装 PyQt6 就好")
            return
        if self._player is not None:
            st = self._player.playbackState()
            if st == QMediaPlayer.PlaybackState.PlayingState:
                self._player.pause()
                self.btn_play.setText("▶ 继续")
                self._flash("已暂停 · 点 ▶ 继续")
                return
            if st == QMediaPlayer.PlaybackState.PausedState:
                self._player.play()
                self.btn_play.setText("⏸ 暂停")
                self._flash("继续播放中…")
                return
        if self._reading:
            self._flash("正在生成语音，等一下")
            return
        if self._last_read and self._last_read.get("audio"):
            # 播完/复位过：直接重播刚读的这段（不重新合成）
            self._play_audio(self._last_read["audio"], self._last_read.get("format") or "mp3")
            return
        self.read_async()

    def read_async(self):
        if not _HAS_QMULTIMEDIA:
            self._flash("缺少音频播放组件（PyQt6 需要 QtMultimedia），重新安装 PyQt6 就好")
            return
        if self._reading:
            self._flash("正在生成语音，等一下")
            return
        if self.isVisible() and self._replies_loading:
            self._flash("正在读取对话和回复，等一下")
            return
        if self.isVisible() and not self._read_session_path:
            self._flash("还没拿到目标对话，正在重新读取…")
            self.refresh_replies_async()
            return
        self._read_seq += 1
        read_seq = self._read_seq
        reply_index = self._reply_index
        session_path = self._read_session_path
        selected_reply = self._replies[reply_index] if 0 <= reply_index < len(self._replies) else None
        self._reading = True
        self._stop_read()
        self.btn_play.setEnabled(False)
        self.btn_play.setText("正在生成语音…")
        choice = "最新一条回复" if reply_index == 0 else f"前 {reply_index} 条回复"
        self.lbl_feedback.setText("正在读 " + (self._name or "助手") + " 的" + choice + "…")
        self.lbl_text.setText("")

        def worker():
            payload = {"ok": False, "error": None, "audio": None, "text": None, "readSeq": read_seq}
            try:
                request = {"replyIndex": reply_index}
                if session_path:
                    request["sessionPath"] = session_path
                # 第 1~5 条带稳定身份，避免新回复插入后按序号错位；最新一条故意动态取 0。
                if reply_index > 0 and selected_reply:
                    entry_id = str(selected_reply.get("entryId") or "").strip()
                    reply_ts = selected_reply.get("ts") or 0
                    if entry_id:
                        request["replyEntryId"] = entry_id
                    if isinstance(reply_ts, (int, float)) and reply_ts > 0:
                        request["replyTs"] = reply_ts
                data = api_post("/tts/speak", request, timeout=40)
                payload.update(data or {})
                payload["readSeq"] = read_seq
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"出错了 ({e.code})"
                except Exception:
                    payload["error"] = f"出错了 ({e.code})"
            except Exception:
                payload["error"] = "连不上解语花，看看插件开着没"
            if self._closed:
                return
            try:
                self.read_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-read").start()

    def _apply_read_result(self, payload):
        if payload.get("readSeq") is not None and payload.get("readSeq") != self._read_seq:
            return
        if payload.get("ok") and payload.get("audio"):
            self._last_read = {
                "text": payload.get("text") or "",
                "audio": payload["audio"],
                "format": payload.get("format") or "mp3",
                "voiceId": payload.get("voiceId") or "",
                "replyIndex": payload.get("replyIndex", self._reply_index),
                # 来源助手：speak 回包已带 agentId，透传进收藏，按助手分组才认得出是谁
                "agentId": payload.get("agentId") or "",
            }
            if isinstance(payload.get("replyIndex"), int) and payload["replyIndex"] >= 0:
                self._reply_index = min(payload["replyIndex"], 5)
                self._update_reply_button()
            self._play_audio(payload["audio"], payload.get("format") or "mp3")
            text = payload.get("text") or ""
            self.lbl_text.setText(text if text else "（这一段是纯符号或太短，没读到文字）")
            self.btn_sub_fav.setText("♡ 收藏")
            self.btn_sub_fav.setEnabled(True)
            self.btn_play.setEnabled(True)
            self.btn_play.setText("⏸ 暂停")
            self._settle()
        else:
            self._reset_read_ui()
            self._flash(payload.get("error") or "朗读失败，再试一次")
            self.btn_play.setText("🔊 朗读")
            self.lbl_text.setText("")

    def replay_read(self):
        if self._player is None or not self._media_path:
            return
        try:
            self._player.setPosition(0)
            self._player.play()
        except Exception:
            self._flash("重播失败，再点一次朗读试试")
            return
        self.btn_play.setText("⏸ 暂停")
        self._flash("重新播放中…")

    def fav_read_async(self):
        if not self._last_read or not self._last_read.get("audio"):
            self._flash("先朗读一次，才能收藏这段")
            return
        self.btn_sub_fav.setEnabled(False)
        fav_seq = self._fav_seq
        favorite_payload = dict(self._last_read)
        # 保险：万一回包没带 agentId，把当前朗读目标会话路径也带上，后端能据路径推断来源助手
        if not favorite_payload.get("agentId") and self._read_session_path:
            favorite_payload["sessionPath"] = self._read_session_path

        def worker():
            payload = {"ok": False, "error": None, "favSeq": fav_seq}
            try:
                data = api_post("/tts/favorite", favorite_payload, timeout=20)
                payload.update(data or {})
                payload["favSeq"] = fav_seq
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"收藏失败了 ({e.code})"
                except Exception:
                    payload["error"] = f"收藏失败了 ({e.code})"
            except Exception:
                payload["error"] = "收藏失败了，再试一次"
            if self._closed:
                return
            try:
                self.fav_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-fav").start()

    def _apply_fav_result(self, payload):
        if "favSeq" in payload and payload.get("favSeq") != self._fav_seq:
            return
        try:
            self.btn_sub_fav.setEnabled(not payload.get("ok"))
            self.btn_sub_fav.setText("✓ 已收藏" if payload.get("ok") else "♡ 收藏")
        except Exception:
            pass
        if payload.get("ok"):
            self._flash(payload.get("message") or "已收藏 ♡ 主页「语音收藏」里能听")
        else:
            self._flash(payload.get("error") or "收藏失败")

    def _init_player(self):
        if self._player is not None:
            return
        self._player = QMediaPlayer(self)
        self._audio_out = QAudioOutput(self)
        self._audio_out.setVolume(1.0)
        self._player.setAudioOutput(self._audio_out)
        self._player.mediaStatusChanged.connect(self._on_media_status)
        self._player.errorOccurred.connect(self._on_media_error)

    def _cleanup_media_file(self):
        p = self._media_path
        self._media_path = None
        if p:
            try:
                os.unlink(p)
            except Exception:
                pass

    def _play_audio(self, b64_audio, fmt="mp3"):
        try:
            self._init_player()
            raw = base64.b64decode(b64_audio)
            # QtMultimedia 从 QBuffer 内存播 mp3 不稳，写临时文件再播，文件路径最稳
            ext = "wav" if fmt == "wav" else "mp3"
            fd, tmp_path = tempfile.mkstemp(prefix="jiegehua_read_", suffix="." + ext)
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(raw)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass
                raise
            self._cleanup_media_file()
            self._media_path = tmp_path
            self._player.setSource(QUrl.fromLocalFile(tmp_path))
            self._player.play()
            self.btn_play.setEnabled(True)
            self.btn_play.setText("⏸ 暂停")
            self.btn_replay.setEnabled(True)
        except Exception as e:
            self._reset_read_ui()
            self._flash(f"播放失败：{e}")

    def _on_media_status(self, status):
        if status == QMediaPlayer.MediaStatus.EndOfMedia:
            self._stop_read()
            self._reset_read_ui()
            self._flash("读完了 · 想再听就点 ↻ 重听")
        elif status == QMediaPlayer.MediaStatus.InvalidMedia:
            self._reset_read_ui()
            self._flash("音频格式不支持，换个音色试试")

    def _on_media_error(self, error):
        self._reset_read_ui()
        self._flash("播放出错了，再试一次")

    def _stop_read(self):
        try:
            if self._player is not None:
                self._player.stop()
        except Exception:
            pass

    def _reset_read_ui(self):
        self._reading = False
        self._cleanup_media_file()
        try:
            self.btn_play.setEnabled(True)
            self.btn_play.setText("🔊 朗读")
            self.btn_replay.setEnabled(False)
            self.lbl_feedback.setText("")
        except RuntimeError:
            pass

    def _flash(self, text):
        self.lbl_feedback.setText(text)

    def closeEvent(self, event):
        self._closed = True
        self._read_seq += 1
        self._fav_seq += 1
        self._target_seq += 1
        self._replies_seq += 1
        self._stop_read()
        super().closeEvent(event)

    def hideEvent(self, event):
        # 收起朗读窗口 = 结束朗读，别让声音在背后自己放
        self._read_seq += 1
        self._fav_seq += 1
        self._target_seq += 1
        self._replies_seq += 1
        self._refresh_feedback_seq = 0
        self._auto_read_pending = False
        self._read_session_path = ""
        self._last_read = None
        self.target_menu.hide()
        self.reply_menu.hide()
        self._stop_read()
        self._reset_read_ui()
        self.ball._set_fusion_panel_state("none")
        super().hideEvent(event)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_press = e.globalPosition().toPoint()
            self._drag_panel_start = self.pos()
            self._drag_ball_start = self.ball.pos()
            self._drag_moved = False
            reset_motion = getattr(self.ball, "_reset_drag_motion", None)
            if callable(reset_motion):
                reset_motion()
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
            record_motion = getattr(self.ball, "_record_drag_motion", None)
            if callable(record_motion):
                record_motion()
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._drag_moved:
                release_motion = getattr(self.ball, "_release_drag_motion", None)
                if callable(release_motion):
                    release_motion()
                try:
                    self.ball._save_pos()
                except Exception:
                    pass
            self._drag_press = None
            self._drag_panel_start = None
            self._drag_ball_start = None
            self._drag_moved = False
        super().mouseReleaseEvent(e)

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #readPanel {{
                background: transparent; border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#readHead {{ color: {c['accent_deep']}; font-size: 14px; font-weight: 700; }}
            QLabel#readTargetLabel, QLabel#readReplyLabel {{ color: {c['sub_deep']}; font-size: 11px; }}
            QLabel#readTargetInfo {{ color: {c['sub']}; font-size: 10px; padding-left: 2px; }}
            QPushButton#readTargetBtn, QPushButton#readReplyBtn, QPushButton#readRefreshBtn {{
                min-height: 28px; padding: 0 10px;
                color: {c['accent_deep']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 11px; font-weight: 600;
            }}
            QPushButton#readTargetBtn:hover, QPushButton#readReplyBtn:hover, QPushButton#readRefreshBtn:hover {{
                background: {c['surface']}; border-color: {c['accent']};
            }}
            QFrame#readReplyMenu {{
                background: {c['surface_alt']}; border: 1px dashed {c['border']}; border-radius: 12px;
            }}
            QPushButton#replyItem {{
                min-height: 34px; max-height: 34px; text-align: left; padding: 0 9px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 9px; font-size: 10px;
            }}
            QPushButton#replyItem:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QPushButton#replyItem[active="true"] {{
                color: {c['accent_deep']}; background: {c['surface_alt']}; border-color: {c['accent']};
                font-weight: 600;
            }}
            QLabel#readReplySub {{ color: {c['sub']}; font-size: 10px; padding: 3px 2px; }}
            QLabel#readText {{
                background: {c['surface_alt']}; border-radius: 10px;
                padding: 9px 11px; font-size: 12px; line-height: 1.6;
            }}
            QLabel#readFeedback {{ color: {c['pink']}; font-size: 11px; font-weight: 600; }}
            QPushButton#readCloseBtn {{
                color: {c['sub']}; background: transparent; border: none;
                border-radius: 12px; font-size: 13px;
            }}
            QPushButton#readCloseBtn:hover {{ background: {c['danger_bg']}; color: {c['pink']}; }}
            QPushButton#readPlayBtn {{
                min-height: 36px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 12px;
                font-size: 13px; font-weight: 600;
            }}
            QPushButton#readPlayBtn:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#readPlayBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QPushButton#readSubBtn {{
                min-height: 28px; padding: 0 10px;
                color: {c['accent_deep']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 11px; font-weight: 600;
            }}
            QPushButton#readSubBtn:hover {{ background: {c['surface']}; border-color: {c['accent']}; }}
            QPushButton#readSubBtn:disabled {{ color: {c['sub']}; }}
        """)
        if hasattr(self, "target_menu"):
            self.target_menu.apply_theme()
        self._render_replies()

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
        painter.end()


# ─────────────────────────────
#  我的另一枝 · 分支列表（面板内嵌）
# ─────────────────────────────
class BranchListMenu(QFrame):
    """已开分支列表：数据来自代理 /branch/list；点某项打开对应聊天窗口。"""

    branches_ready = pyqtSignal(object)

    def __init__(self, panel):
        super().__init__(panel)
        self.panel = panel
        self.ball = panel.ball
        self.branches = []
        self.loading = False
        self.branches_ready.connect(self._apply_branches)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("branchListMenu")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 11, 12, 11)
        root.setSpacing(6)
        title = QLabel("我的另一枝（点开继续聊）")
        title.setObjectName("menuTitle")
        root.addWidget(title)
        self.lbl_hint = QLabel("")
        self.lbl_hint.setObjectName("menuSub")
        self.lbl_hint.setWordWrap(True)
        root.addWidget(self.lbl_hint)
        self.list_host = QWidget(self)
        self.list_host.setObjectName("branchListHost")
        self.list_box = QVBoxLayout(self.list_host)
        self.list_box.setContentsMargins(0, 0, 0, 0)
        self.list_box.setSpacing(5)
        root.addWidget(self.list_host)
        self.apply_theme()

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #branchListMenu {{ background: transparent; border: none; font-family: "LXGW WenKai", "Microsoft YaHei UI"; }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#menuTitle {{ font-size: 13px; font-weight: 700; color: {c['accent_deep']}; }}
            QLabel#menuSub {{ font-size: 10px; color: {c['sub']}; padding-bottom: 2px; }}
            QWidget#branchListHost {{ background: transparent; border: none; }}
            QPushButton#branchItem {{
                min-height: 30px; max-height: 30px; text-align: left; padding: 0 9px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px; font-size: 11px;
            }}
            QPushButton#branchItem:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
        """)
        self._sync_ui()

    def refresh_async(self):
        if self.loading:
            return
        self.loading = True
        self.lbl_hint.setText("正在读取…")

        def worker():
            payload = {"ok": False, "branches": []}
            try:
                data = api_get("/branch/list", timeout=5)
                if data.get("ok"):
                    payload = data
            except Exception:
                pass
            try:
                self.branches_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="branch-list").start()

    def _apply_branches(self, payload):
        self.loading = False
        self.branches = payload.get("branches") or [] if payload.get("ok") else []
        self._sync_ui()

    def _sync_ui(self):
        self._clear_list()
        if not self.branches:
            self.lbl_hint.setText("还没开过另一枝，点上面的「另开一枝」试试")
            return
        self.lbl_hint.setText("")
        for b in self.branches:
            btn = QPushButton(self._item_label(b))
            btn.setObjectName("branchItem")
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setToolTip("打开这个分支的聊天窗口")
            btn.clicked.connect(lambda _=False, branch=b: self._open(branch))
            self.list_box.addWidget(btn)

    @staticmethod
    def _item_label(b):
        preview = str(b.get("preview") or "").strip()
        when = format_branch_time(int(b.get("lastTs") or b.get("createdAt") or 0))
        text = "另一枝 · " + when if when else "另一枝"
        if preview:
            text += "  " + preview
        return text

    def _open(self, branch):
        self.panel._toggle_branch_list_off()
        self.ball.open_branch_window(branch)

    def _clear_list(self):
        while self.list_box.count():
            item = self.list_box.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()


# ─────────────────────────────
#  另一枝 · 独立聊天窗口
# ─────────────────────────────
class BranchChatWindow(QFrame):
    """分支会话的独立聊天窗口：可随时关闭（对话保留在服务端），
    从面板「我的另一枝」列表可重新打开；多开互不干扰。"""

    history_ready = pyqtSignal(object)     # 加载 / 轮询历史回包
    chat_sent_ready = pyqtSignal(object)   # 发送回包

    WIDTH = 380
    HEIGHT = 520
    REPLY_POLL_MS = 1500
    REPLY_TIMEOUT_S = 120

    def __init__(self, ball, branch):
        super().__init__(None)
        self._closed = False
        self.ball = ball
        self.branch = branch
        self.branch_id = str(branch.get("id") or "")
        self.branch_title = str(branch.get("title") or "另一枝")
        self._rendered = 0          # 已渲染的消息条数（轮询增量追加）
        self._awaiting_reply = False
        self._sending = False
        self._poll_inflight = False
        self._poll_started = 0.0
        self._poll_timer = None
        self._status_row = None     # 「正在回复…」占位行
        self._title_bar = None
        self._drag_press = None
        self._drag_start = None

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("chatRoot")
        self.setFixedSize(self.WIDTH, self.HEIGHT)

        self.history_ready.connect(self._apply_history)
        self.chat_sent_ready.connect(self._apply_chat_sent)

        self._build_ui()
        self.apply_theme()
        self._load_history_async()

    # ── UI ──
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # 标题栏：拖拽移动 + 关闭
        bar = QFrame()
        bar.setObjectName("chatTitleBar")
        bar.setFixedHeight(38)
        bar.installEventFilter(self)
        self._title_bar = bar
        bar_layout = QHBoxLayout(bar)
        bar_layout.setContentsMargins(14, 0, 8, 0)
        bar_layout.setSpacing(8)
        self.lbl_title = QLabel(self.branch_title)
        self.lbl_title.setObjectName("chatTitle")
        bar_layout.addWidget(self.lbl_title)
        bar_layout.addStretch(1)
        self.btn_close = QPushButton("✕")
        self.btn_close.setObjectName("chatClose")
        self.btn_close.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_close.setFixedSize(22, 22)
        self.btn_close.setToolTip("关闭窗口（分支对话保留，可随时再打开）")
        self.btn_close.clicked.connect(self.close)
        bar_layout.addWidget(self.btn_close)
        root.addWidget(bar)

        # 消息滚动区
        self.scroll = QScrollArea()
        self.scroll.setObjectName("chatScroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.body = QFrame()
        self.body.setObjectName("chatBody")
        self.msg_box = QVBoxLayout(self.body)
        self.msg_box.setContentsMargins(14, 12, 14, 12)
        self.msg_box.setSpacing(8)
        self.msg_box.addStretch(1)
        self.scroll.setWidget(self.body)
        root.addWidget(self.scroll, 1)

        # 输入行
        input_bar = QFrame()
        input_bar.setObjectName("chatInputBar")
        input_bar.setFixedHeight(52)
        input_layout = QHBoxLayout(input_bar)
        input_layout.setContentsMargins(14, 8, 14, 8)
        input_layout.setSpacing(8)
        self.input = QLineEdit()
        self.input.setObjectName("chatInput")
        self.input.setMaxLength(500)
        self.input.setPlaceholderText("和分支里的小花聊两句…")
        self.input.returnPressed.connect(self._send_text)
        input_layout.addWidget(self.input, 1)
        self.btn_send = QPushButton("发送")
        self.btn_send.setObjectName("chatSend")
        self.btn_send.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_send.setFixedWidth(64)
        self.btn_send.clicked.connect(self._send_text)
        input_layout.addWidget(self.btn_send)
        root.addWidget(input_bar)

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #chatRoot {{
                background: {c['panel']};
                border: 1px solid {c['border']};
                border-radius: 14px;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            #chatTitleBar {{ background: {c['surface_alt']}; border-top-left-radius: 14px; border-top-right-radius: 14px; }}
            #chatTitle {{ color: {c['accent_deep']}; font-size: 13px; font-weight: 700; background: transparent; }}
            #chatClose {{
                color: {c['sub']}; background: transparent; border: none;
                border-radius: 11px; font-size: 12px; font-weight: 700;
            }}
            #chatClose:hover {{ color: {c['accent_text']}; background: {c['accent']}; }}
            QScrollArea#chatScroll {{ background: transparent; border: none; }}
            QWidget#chatBody {{ background: transparent; }}
            QLabel#bubbleUser {{
                background: {c['accent']}; color: {c['accent_text']};
                border-radius: 12px; padding: 8px 12px; font-size: 12px;
            }}
            QLabel#bubbleAssistant {{
                background: {c['surface']}; color: {c['ink']};
                border: 1px solid {c['border']}; border-radius: 12px;
                padding: 8px 12px; font-size: 12px;
            }}
            QLabel#bubbleStatus {{ color: {c['sub']}; font-size: 11px; background: transparent; }}
            #chatInputBar {{ background: {c['surface_alt']}; border-bottom-left-radius: 14px; border-bottom-right-radius: 14px; }}
            #chatInput {{
                min-height: 32px; padding: 0 12px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 12px; font-size: 12px;
            }}
            #chatInput:focus {{ border-color: {c['accent']}; }}
            #chatSend {{
                min-height: 32px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 12px; font-size: 12px; font-weight: 600;
            }}
            #chatSend:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            #chatSend:disabled {{ color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']}; }}
        """)

    # ── 事件：标题栏拖拽 ──
    def eventFilter(self, obj, event):
        if obj is self._title_bar:
            etype = event.type()
            if etype == QEvent.Type.MouseButtonPress and event.button() == Qt.MouseButton.LeftButton:
                self._drag_press = event.globalPosition().toPoint()
                self._drag_start = self.pos()
                return True
            if etype == QEvent.Type.MouseMove and self._drag_press is not None:
                if event.buttons() & Qt.MouseButton.LeftButton:
                    delta = event.globalPosition().toPoint() - self._drag_press
                    self.move(self._drag_start + delta)
                    return True
            if etype == QEvent.Type.MouseButtonRelease:
                self._drag_press = None
        return super().eventFilter(obj, event)

    # ── 消息渲染 ──
    def _append_message(self, role, text):
        bubble = QLabel(text)
        bubble.setObjectName("bubbleUser" if role == "user" else "bubbleAssistant")
        bubble.setWordWrap(True)
        bubble.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        bubble.setMaximumWidth(int(self.WIDTH * 0.72))
        row = QHBoxLayout()
        row.setSpacing(0)
        if role == "user":
            row.addStretch(1)
            row.addWidget(bubble)
        else:
            row.addWidget(bubble)
            row.addStretch(1)
        self.msg_box.insertLayout(self.msg_box.count() - 1, row)
        self._scroll_bottom()

    def _append_status(self, text):
        self._clear_status()
        lbl = QLabel(text)
        lbl.setObjectName("bubbleStatus")
        row = QHBoxLayout()
        row.setSpacing(0)
        row.addWidget(lbl)
        row.addStretch(1)
        self._status_row = row
        self.msg_box.insertLayout(self.msg_box.count() - 1, row)
        self._scroll_bottom()

    def _clear_status(self):
        if self._status_row is not None:
            while self._status_row.count():
                item = self._status_row.takeAt(0)
                w = item.widget()
                if w:
                    w.deleteLater()
            self.msg_box.removeItem(self._status_row)
            self._status_row = None

    def _scroll_bottom(self):
        bar = self.scroll.verticalScrollBar()
        QTimer.singleShot(0, lambda: None if self._closed else bar.setValue(bar.maximum()))

    # ── 历史加载 ──
    def _load_history_async(self):
        branch_id = self.branch_id

        def worker():
            payload = {"ok": False, "messages": []}
            try:
                data = api_get("/branch/history?branchId=" + urllib.parse.quote(branch_id), timeout=6)
                if data.get("ok"):
                    payload = data
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.history_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="branch-history").start()

    # ── 发送 ──
    def _send_text(self):
        if self._sending:
            return
        text = self.input.text().strip()
        if not text:
            return
        self.input.clear()
        self._sending = True
        self.btn_send.setEnabled(False)
        self._append_message("user", text)
        self._append_status("正在回复…")
        self._poll_started = time.monotonic()
        branch_id = self.branch_id

        def worker():
            payload = {"ok": False, "error": "连不上解语花，看看插件开着没"}
            try:
                data = api_post("/branch/chat", {"branchId": branch_id, "text": text}, timeout=20)
                payload.update(data or {})
            except urllib.error.HTTPError as e:
                try:
                    payload.update(json.loads(e.read().decode("utf-8", "replace")) or {})
                except Exception:
                    pass
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.chat_sent_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="branch-chat-send").start()

    def _apply_chat_sent(self, payload):
        if not payload.get("ok"):
            self._clear_status()
            self._append_status(payload.get("error") or "发送失败，再试一次")
            self._sending = False
            self.btn_send.setEnabled(True)
            return
        # 发送成功：轮询分支会话，等助手新消息
        self._awaiting_reply = True
        self._poll_timer = QTimer(self)
        self._poll_timer.timeout.connect(self._poll_reply)
        self._poll_timer.start(self.REPLY_POLL_MS)
        self._poll_reply()

    def _poll_reply(self):
        if self._closed or self._poll_inflight or not self._awaiting_reply:
            return
        self._poll_inflight = True
        branch_id = self.branch_id

        def worker():
            payload = {"ok": False, "messages": []}
            try:
                data = api_get("/branch/history?branchId=" + urllib.parse.quote(branch_id), timeout=5)
                if data.get("ok"):
                    payload = data
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.history_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="branch-poll").start()

    def _apply_history(self, payload):
        if self._closed:
            return
        self._poll_inflight = False
        if not payload.get("ok"):
            if self._awaiting_reply:
                self._finish_reply(payload.get("error") or "回复获取失败，再试一次")
            else:
                self._append_status(payload.get("error") or "分支历史加载失败")
            return
        messages = payload.get("messages") or []
        if self._awaiting_reply:
            # 轮询模式：增量追加；出现新的助手消息即完成
            if len(messages) > self._rendered:
                for m in messages[self._rendered:]:
                    self._append_message(m.get("role"), m.get("content") or "")
                self._rendered = len(messages)
            last = messages[-1] if messages else {}
            if last.get("role") == "assistant":
                self._finish_reply("")
                return
            if time.monotonic() - self._poll_started > self.REPLY_TIMEOUT_S:
                self._finish_reply("小花好像还没回，看看 Hana 那边是不是卡了")
            return
        # 初次加载：全量渲染
        if not messages:
            self._append_status("从这里开始聊吧")
            return
        for m in messages:
            self._append_message(m.get("role"), m.get("content") or "")
        self._rendered = len(messages)

    def closeEvent(self, event):
        self._closed = True
        self._awaiting_reply = False
        self._sending = False
        self._poll_inflight = False
        if self._poll_timer is not None:
            self._poll_timer.stop()
            self._poll_timer = None
        super().closeEvent(event)

    def _finish_reply(self, error_msg):
        if self._closed:
            return
        self._awaiting_reply = False
        self._sending = False
        self.btn_send.setEnabled(True)
        self._clear_status()
        if self._poll_timer is not None:
            self._poll_timer.stop()
            self._poll_timer = None
        if error_msg:
            self._append_status(error_msg)


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
