import ctypes
from types import SimpleNamespace
from unittest.mock import Mock, patch

from _zhujian_test_support import QtTestCase, zhujian


class DpiAwarenessTests(QtTestCase):
    def test_windows_uses_per_monitor_v2_context(self):
        setter = Mock(return_value=True)
        with patch.object(zhujian.sys, "platform", "win32"):
            result = zhujian._set_windows_dpi_awareness(setter)

        self.assertTrue(result)
        context = setter.call_args.args[0]
        self.assertEqual(context.value, ctypes.c_void_p(-4).value)

    def test_older_windows_falls_back_to_per_monitor_v1(self):
        user32 = SimpleNamespace(SetProcessDPIAware=Mock(return_value=True))
        shcore = SimpleNamespace(SetProcessDpiAwareness=Mock(return_value=0))
        with patch.object(zhujian.sys, "platform", "win32"), patch(
            "ctypes.WinDLL", side_effect=lambda name, **_kwargs: user32 if name == "user32" else shcore
        ):
            result = zhujian._set_windows_dpi_awareness()

        self.assertTrue(result)
        shcore.SetProcessDpiAwareness.assert_called_once_with(2)

    def test_non_windows_does_not_call_windows_api(self):
        setter = Mock()
        with patch.object(zhujian.sys, "platform", "linux"):
            result = zhujian._set_windows_dpi_awareness(setter)

        self.assertFalse(result)
        setter.assert_not_called()
