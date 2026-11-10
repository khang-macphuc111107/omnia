import ctypes
from ctypes import wintypes
import time
from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

hwnd = 51452382
user32.ShowWindow(hwnd, 9)
user32.SetForegroundWindow(hwnd)
time.sleep(0.3)

# Convert client point (24, 125) to screen point for Chats icon
pt = wintypes.POINT(24, 125)
user32.ClientToScreen(hwnd, ctypes.byref(pt))
user32.SetCursorPos(pt.x, pt.y)
time.sleep(0.1)
user32.mouse_event(2, 0, 0, 0, 0)
time.sleep(0.05)
user32.mouse_event(4, 0, 0, 0, 0)
time.sleep(1.0)

# Capture
rect = wintypes.RECT()
user32.GetClientRect(hwnd, ctypes.byref(rect))
w, h = rect.right - rect.left, rect.bottom - rect.top
hdc_src = user32.GetDC(hwnd)
hdc_mem = gdi32.CreateCompatibleDC(hdc_src)
hbmp = gdi32.CreateCompatibleBitmap(hdc_src, w, h)
gdi32.SelectObject(hdc_mem, hbmp)
user32.PrintWindow(hwnd, hdc_mem, 2)

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG), ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD), ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG), ('biYPelsPerMeter', wintypes.LONG), ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD)]

bmi = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
buf = ctypes.create_string_buffer(w * h * 4)
gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf, ctypes.byref(bmi), 0)
img = Image.frombuffer('RGBA', (w, h), buf, 'raw', 'BGRA', 0, 1)
img.save('artifacts/omnia_chats_screen.png')
print('Clicked Chats icon and saved artifacts/omnia_chats_screen.png')

gdi32.DeleteObject(hbmp)
gdi32.DeleteDC(hdc_mem)
user32.ReleaseDC(hwnd, hdc_src)
