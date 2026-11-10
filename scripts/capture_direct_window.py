import ctypes
from ctypes import wintypes
from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

hwnd = 51452382
user32.ShowWindow(hwnd, 9) # SW_RESTORE
user32.SetForegroundWindow(hwnd)

rect = wintypes.RECT()
user32.GetClientRect(hwnd, ctypes.byref(rect))
w = rect.right - rect.left
h = rect.bottom - rect.top
print(f'Client rect: {w}x{h}')

hdc_src = user32.GetDC(hwnd)
hdc_mem = gdi32.CreateCompatibleDC(hdc_src)
hbmp = gdi32.CreateCompatibleBitmap(hdc_src, w, h)
gdi32.SelectObject(hdc_mem, hbmp)
# PW_RENDERFULLCONTENT = 2
user32.PrintWindow(hwnd, hdc_mem, 2)

# Extract bitmap bits
class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', wintypes.DWORD),
        ('biWidth', wintypes.LONG),
        ('biHeight', wintypes.LONG),
        ('biPlanes', wintypes.WORD),
        ('biBitCount', wintypes.WORD),
        ('biCompression', wintypes.DWORD),
        ('biSizeImage', wintypes.DWORD),
        ('biXPelsPerMeter', wintypes.LONG),
        ('biYPelsPerMeter', wintypes.LONG),
        ('biClrUsed', wintypes.DWORD),
        ('biClrImportant', wintypes.DWORD),
    ]

bmi = BITMAPINFOHEADER()
bmi.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bmi.biWidth = w
bmi.biHeight = -h # top-down
bmi.biPlanes = 1
bmi.biBitCount = 32
bmi.biCompression = 0 # BI_RGB

buffer = ctypes.create_string_buffer(w * h * 4)
gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buffer, ctypes.byref(bmi), 0)

img = Image.frombuffer('RGBA', (w, h), buffer, 'raw', 'BGRA', 0, 1)
img.save('artifacts/omnia_direct_capture.png')
print('Saved artifacts/omnia_direct_capture.png')

gdi32.DeleteObject(hbmp)
gdi32.DeleteDC(hdc_mem)
user32.ReleaseDC(hwnd, hdc_src)
