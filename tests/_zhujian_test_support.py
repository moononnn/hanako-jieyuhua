import atexit
import importlib.util
import os
import pathlib
import sys
import unittest

from PyQt6.QtCore import QEvent, QTimer

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
MODULE_PATH = pathlib.Path(__file__).parents[1] / "python" / "zhujian_app.py"
_MODULE_NAME = "_jiegehua_zhujian_app_test"

zhujian = sys.modules.get(_MODULE_NAME)
if zhujian is None:
    spec = importlib.util.spec_from_file_location(_MODULE_NAME, MODULE_PATH)
    zhujian = importlib.util.module_from_spec(spec)
    sys.modules[_MODULE_NAME] = zhujian
    spec.loader.exec_module(zhujian)

# 只创建并持有一个 QApplication，避免多个测试模块各自加载一份 Qt 应用模块。
_APP = zhujian.QApplication.instance() or zhujian.QApplication([])


class QtTestCase(unittest.TestCase):
    """每个测试后清理隐藏顶层窗口、全局过滤器和 QTimer，避免 Qt 事件串入下一测。"""

    def tearDown(self):
        app = zhujian.QApplication.instance()
        if app is None:
            return
        for widget in list(app.topLevelWidgets()):
            try:
                for timer in widget.findChildren(QTimer):
                    timer.stop()
                if isinstance(widget, zhujian.ZhujianBall):
                    app.removeEventFilter(widget)
                widget.close()
            except RuntimeError:
                pass
        try:
            app.processEvents()
        except RuntimeError:
            pass


def _shutdown_qt():
    try:
        for widget in list(_APP.topLevelWidgets()):
            try:
                if isinstance(widget, zhujian.ZhujianBall):
                    _APP.removeEventFilter(widget)
                for timer in widget.findChildren(QTimer):
                    timer.stop()
                widget.close()
            except RuntimeError:
                pass
        _APP.processEvents()
        _APP.quit()
    except RuntimeError:
        pass


atexit.register(_shutdown_qt)
