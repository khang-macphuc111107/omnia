import ctypes
from ctypes import wintypes
import time
from PIL import ImageGrab

user32 = ctypes.windll.user32

class RECT(ctypes.Structure):
    _fields_ = [('left', wintypes.LONG), ('top', wintypes.LONG), ('right', wintypes.LONG), ('bottom', wintypes.LONG)]

hwnd = user32.FindWindowW(None, 'Omnia')
if hwnd:
    rect = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    # Click Home icon: rect.left + 25, rect.top + 50
    click_x = rect.left + 25
    click_y = rect.top + 50
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.3)
    user32.SetCursorPos(click_x, click_y)
    time.sleep(0.1)
    user32.mouse_event(2, 0, 0, 0, 0) # MOUSEEVENTF_LEFTDOWN
    time.sleep(0.05)
    user32.mouse_event(4, 0, 0, 0, 0) # MOUSEEVENTF_LEFTUP
    time.sleep(1.0)
    img = ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom))
    img.save('artifacts/omnia_home_screenshot.png')
    print('Clicked Home icon and saved artifacts/omnia_home_screenshot.png')
else:
    print('Omnia window not found')
