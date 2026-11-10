import ctypes
from ctypes import wintypes
import time
from PIL import ImageGrab
import os

user32 = ctypes.windll.user32

class RECT(ctypes.Structure):
    _fields_ = [
        ('left', wintypes.LONG),
        ('top', wintypes.LONG),
        ('right', wintypes.LONG),
        ('bottom', wintypes.LONG)
    ]

hwnd_target = None
def enum_windows_proc(hwnd, lParam):
    global hwnd_target
    length = user32.GetWindowTextLengthW(hwnd)
    if length > 0:
        buff = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buff, length + 1)
        if buff.value == 'Omnia' and user32.IsWindowVisible(hwnd):
            hwnd_target = hwnd
            return False
    return True

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows(WNDENUMPROC(enum_windows_proc), 0)

os.makedirs('artifacts', exist_ok=True)
out_path = 'artifacts/omnia_app_screenshot.png'

if hwnd_target:
    print(f'Found Omnia window: {hwnd_target}')
    user32.ShowWindow(hwnd_target, 9)
    user32.SetForegroundWindow(hwnd_target)
    time.sleep(1.0)
    rect = RECT()
    user32.GetWindowRect(hwnd_target, ctypes.byref(rect))
    print(f'Rect: {rect.left}, {rect.top}, {rect.right}, {rect.bottom}')
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width > 100 and height > 100:
        img = ImageGrab.grab(bbox=(rect.left, rect.top, rect.right, rect.bottom))
    else:
        img = ImageGrab.grab()
    img.save(out_path)
    print(f'Saved: {out_path}')
else:
    print('Omnia window not found, grabbing screen')
    img = ImageGrab.grab()
    img.save(out_path)
    print(f'Saved: {out_path}')
