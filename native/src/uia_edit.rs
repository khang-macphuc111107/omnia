//! Server-side Windows UI Automation (`IRawElementProviderSimple` +
//! `IValueProvider` / `IInvokeProvider`) for the native Rich Composer command
//! `EDIT` control (`ID = 114`) and Win32 `BUTTON` controls.
//!
//! Why this exists (`QUALITY-01`):
//! 1. Observer processes using `UIAutomationClient` without registering
//!    `UIAutomationClientsideProviders` rely on `WM_GETOBJECT` (`UiaRootObjectId = -25`).
//!    Standard Win32 `EDIT` and `BUTTON` controls have no server-side UIA provider
//!    and degrade to `ControlType.Pane`. Attaching a server-side COM provider to
//!    control `114` (while keeping multiline `112` untouched so client-side
//!    observers continue to see `ControlType.Document` + `TextPattern`) ensures
//!    UIA trees always discover a genuine accessible `ControlType.Edit` composer input.
//! 2. Server-side `IInvokeProvider` on native buttons executes `BM_CLICK` directly
//!    on the UI thread after verifying `IsWindowEnabled`, avoiding client-side proxy
//!    `SetFocus` failures when automation runs without foreground activation.

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

use windows_sys::core::GUID;
use windows_sys::Win32::{
    Foundation::{HANDLE, HWND, LPARAM, LRESULT, S_OK, WPARAM},
    System::Threading::GetCurrentThreadId,
    UI::{
        Input::KeyboardAndMouse::{IsWindowEnabled, SetActiveWindow},
        WindowsAndMessaging::{
            CallNextHookEx, CallWindowProcW, GetAncestor, GetDlgItem, GetPropW,
            GetWindowTextLengthW, GetWindowTextW, MessageBoxW, RemovePropW, SendMessageW, SetPropW,
            SetWindowLongPtrW, SetWindowTextW, SetWindowsHookExW, UnhookWindowsHookEx, GA_ROOT,
            GWLP_WNDPROC, HCBT_ACTIVATE, IDCANCEL, IDNO, IDOK, IDYES, WH_CBT, WM_GETOBJECT,
            WM_GETTEXT, WM_GETTEXTLENGTH, WM_NCDESTROY, WNDPROC,
        },
    },
};

const UIA_ROOT_OBJECT_ID: i32 = -25;
const PROVIDER_OPTIONS_SERVER_SIDE: i32 = 0x2 | 0x20; // ServerSideProvider | UseComThreading

const UIA_INVOKE_PATTERN_ID: i32 = 10000;
const UIA_VALUE_PATTERN_ID: i32 = 10002;
const UIA_CONTROL_TYPE_PROPERTY_ID: i32 = 30003;
const UIA_NAME_PROPERTY_ID: i32 = 30005;
const UIA_IS_KEYBOARD_FOCUSABLE_PROPERTY_ID: i32 = 30009;
const UIA_IS_ENABLED_PROPERTY_ID: i32 = 30010;
const UIA_AUTOMATION_ID_PROPERTY_ID: i32 = 30011;
const UIA_IS_CONTROL_ELEMENT_PROPERTY_ID: i32 = 30016;
const UIA_IS_CONTENT_ELEMENT_PROPERTY_ID: i32 = 30017;

const UIA_BUTTON_CONTROL_TYPE_ID: i32 = 50000;
const UIA_EDIT_CONTROL_TYPE_ID: i32 = 50004;

const BM_CLICK_MSG: u32 = 0x00F5;

const VT_EMPTY: u16 = 0;
const VT_I4: u16 = 3;
const VT_BSTR: u16 = 8;
const VT_BOOL: u16 = 11;
const VARIANT_TRUE: i16 = -1;
const VARIANT_FALSE: i16 = 0;

const E_INVALIDARG_HR: i32 = 0x8007_0057_u32 as i32;
const E_POINTER_HR: i32 = 0x8000_4003_u32 as i32;
const E_NOINTERFACE_HR: i32 = 0x8000_4002_u32 as i32;
const UIA_E_ELEMENTNOTENABLED_HR: i32 = 0x8004_0200_u32 as i32;
const UIA_E_ELEMENTNOTAVAILABLE_HR: i32 = 0x8004_0201_u32 as i32;

const IID_IUNKNOWN: GUID = GUID {
    data1: 0x0000_0000,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

// {d6dd68d1-86fd-4332-8666-9abedea2d24c}
const IID_IRAW_ELEMENT_PROVIDER_SIMPLE: GUID = GUID {
    data1: 0xd6dd_68d1,
    data2: 0x86fd,
    data3: 0x4332,
    data4: [0x86, 0x66, 0x9a, 0xbe, 0xde, 0xa2, 0xd2, 0x4c],
};

// {c7935180-6fb3-4201-b174-7df73adbf64a}
const IID_IVALUE_PROVIDER: GUID = GUID {
    data1: 0xc793_5180,
    data2: 0x6fb3,
    data3: 0x4201,
    data4: [0xb1, 0x74, 0x7d, 0xf7, 0x3a, 0xdb, 0xf6, 0x4a],
};

// {54fcb24b-e18e-47a2-b4d3-eccbe77599a2}
const IID_IINVOKE_PROVIDER: GUID = GUID {
    data1: 0x54fc_b24b,
    data2: 0xe18e,
    data3: 0x47a2,
    data4: [0xb4, 0xd3, 0xec, 0xcb, 0xe7, 0x75, 0x99, 0xa2],
};

#[link(name = "uiautomationcore")]
extern "system" {
    fn UiaReturnRawElementProvider(
        hwnd: HWND,
        wparam: WPARAM,
        lparam: LPARAM,
        el: *mut c_void,
    ) -> LRESULT;
    fn UiaHostProviderFromHwnd(hwnd: HWND, pp_provider: *mut *mut c_void) -> i32;
}

#[link(name = "oleaut32")]
extern "system" {
    fn SysAllocStringLen(str_in: *const u16, ui: u32) -> *mut u16;
}

/// 24-byte COM `VARIANT` ABI on x86_64 Windows (16 bytes on x86).
#[repr(C)]
struct ComVariant {
    vt: u16,
    w_reserved1: u16,
    w_reserved2: u16,
    w_reserved3: u16,
    data0: usize,
    data1: usize,
}

impl ComVariant {
    const fn empty() -> Self {
        Self {
            vt: VT_EMPTY,
            w_reserved1: 0,
            w_reserved2: 0,
            w_reserved3: 0,
            data0: 0,
            data1: 0,
        }
    }

    fn i4(val: i32) -> Self {
        Self {
            vt: VT_I4,
            data0: (val as u32) as usize,
            ..Self::empty()
        }
    }

    fn bool_val(val: bool) -> Self {
        let raw = if val { VARIANT_TRUE } else { VARIANT_FALSE };
        Self {
            vt: VT_BOOL,
            data0: (raw as u16) as usize,
            ..Self::empty()
        }
    }

    unsafe fn bstr(text: &str) -> Self {
        let utf16: Vec<u16> = text.encode_utf16().collect();
        let ptr = SysAllocStringLen(utf16.as_ptr(), utf16.len() as u32);
        Self {
            vt: VT_BSTR,
            data0: ptr as usize,
            ..Self::empty()
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ControlKind {
    Edit,
    Button,
}

#[repr(C)]
struct RawProviderVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_provider_options: unsafe extern "system" fn(*mut c_void, *mut i32) -> i32,
    get_pattern_provider: unsafe extern "system" fn(*mut c_void, i32, *mut *mut c_void) -> i32,
    get_property_value: unsafe extern "system" fn(*mut c_void, i32, *mut ComVariant) -> i32,
    get_host_raw_element_provider: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
}

#[repr(C)]
struct ValueProviderVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    set_value: unsafe extern "system" fn(*mut c_void, *const u16) -> i32,
    get_value: unsafe extern "system" fn(*mut c_void, *mut *mut u16) -> i32,
    get_is_read_only: unsafe extern "system" fn(*mut c_void, *mut i32) -> i32,
}

#[repr(C)]
struct InvokeProviderVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    invoke: unsafe extern "system" fn(*mut c_void) -> i32,
}

#[repr(C)]
struct ControlUiaProvider {
    raw_vtbl: *const RawProviderVtbl,
    val_vtbl: *const ValueProviderVtbl,
    inv_vtbl: *const InvokeProviderVtbl,
    ref_count: AtomicU32,
    hwnd: AtomicIsize,
    kind: ControlKind,
    automation_id: String,
    accessible_name: String,
}

static RAW_VTBL: RawProviderVtbl = RawProviderVtbl {
    query_interface: raw_qi,
    add_ref: raw_add_ref,
    release: raw_release,
    get_provider_options: raw_get_provider_options,
    get_pattern_provider: raw_get_pattern_provider,
    get_property_value: raw_get_property_value,
    get_host_raw_element_provider: raw_get_host_provider,
};

static VAL_VTBL: ValueProviderVtbl = ValueProviderVtbl {
    query_interface: val_qi,
    add_ref: val_add_ref,
    release: val_release,
    set_value: val_set_value,
    get_value: val_get_value,
    get_is_read_only: val_get_is_read_only,
};

static INV_VTBL: InvokeProviderVtbl = InvokeProviderVtbl {
    query_interface: inv_qi,
    add_ref: inv_add_ref,
    release: inv_release,
    invoke: inv_invoke,
};

fn guid_eq(a: &GUID, b: &GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

unsafe fn from_raw(this: *mut c_void) -> *mut ControlUiaProvider {
    this.cast::<ControlUiaProvider>()
}

unsafe fn from_val(this: *mut c_void) -> *mut ControlUiaProvider {
    this.cast::<*const c_void>()
        .sub(1)
        .cast::<ControlUiaProvider>()
}

unsafe fn from_inv(this: *mut c_void) -> *mut ControlUiaProvider {
    this.cast::<*const c_void>()
        .sub(2)
        .cast::<ControlUiaProvider>()
}

unsafe fn qi_common(
    provider: *mut ControlUiaProvider,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> i32 {
    if ppv.is_null() {
        return E_POINTER_HR;
    }
    *ppv = ptr::null_mut();
    if riid.is_null() {
        return E_INVALIDARG_HR;
    }
    let iid = &*riid;
    if guid_eq(iid, &IID_IUNKNOWN) || guid_eq(iid, &IID_IRAW_ELEMENT_PROVIDER_SIMPLE) {
        (*provider).ref_count.fetch_add(1, Ordering::Relaxed);
        *ppv = provider.cast::<c_void>();
        S_OK
    } else if (*provider).kind == ControlKind::Edit && guid_eq(iid, &IID_IVALUE_PROVIDER) {
        (*provider).ref_count.fetch_add(1, Ordering::Relaxed);
        *ppv = ptr::addr_of_mut!((*provider).val_vtbl).cast::<c_void>();
        S_OK
    } else if (*provider).kind == ControlKind::Button && guid_eq(iid, &IID_IINVOKE_PROVIDER) {
        (*provider).ref_count.fetch_add(1, Ordering::Relaxed);
        *ppv = ptr::addr_of_mut!((*provider).inv_vtbl).cast::<c_void>();
        S_OK
    } else {
        E_NOINTERFACE_HR
    }
}

unsafe fn add_ref_common(provider: *mut ControlUiaProvider) -> u32 {
    (*provider).ref_count.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe fn release_common(provider: *mut ControlUiaProvider) -> u32 {
    let prev = (*provider).ref_count.fetch_sub(1, Ordering::Release);
    if prev == 1 {
        std::sync::atomic::fence(Ordering::Acquire);
        drop(Box::from_raw(provider));
        0
    } else {
        prev - 1
    }
}

unsafe extern "system" fn raw_qi(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> i32 {
    qi_common(from_raw(this), riid, ppv)
}

unsafe extern "system" fn raw_add_ref(this: *mut c_void) -> u32 {
    add_ref_common(from_raw(this))
}

unsafe extern "system" fn raw_release(this: *mut c_void) -> u32 {
    release_common(from_raw(this))
}

unsafe extern "system" fn val_qi(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> i32 {
    qi_common(from_val(this), riid, ppv)
}

unsafe extern "system" fn val_add_ref(this: *mut c_void) -> u32 {
    add_ref_common(from_val(this))
}

unsafe extern "system" fn val_release(this: *mut c_void) -> u32 {
    release_common(from_val(this))
}

unsafe extern "system" fn inv_qi(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> i32 {
    qi_common(from_inv(this), riid, ppv)
}

unsafe extern "system" fn inv_add_ref(this: *mut c_void) -> u32 {
    add_ref_common(from_inv(this))
}

unsafe extern "system" fn inv_release(this: *mut c_void) -> u32 {
    release_common(from_inv(this))
}

unsafe extern "system" fn raw_get_provider_options(_this: *mut c_void, p_ret_val: *mut i32) -> i32 {
    if p_ret_val.is_null() {
        return E_POINTER_HR;
    }
    *p_ret_val = PROVIDER_OPTIONS_SERVER_SIDE;
    S_OK
}

unsafe extern "system" fn raw_get_pattern_provider(
    this: *mut c_void,
    pattern_id: i32,
    p_ret_val: *mut *mut c_void,
) -> i32 {
    if p_ret_val.is_null() {
        return E_POINTER_HR;
    }
    *p_ret_val = ptr::null_mut();
    let provider = from_raw(this);
    if (*provider).hwnd.load(Ordering::Acquire) == 0 {
        return UIA_E_ELEMENTNOTAVAILABLE_HR;
    }
    match ((*provider).kind, pattern_id) {
        (ControlKind::Edit, UIA_VALUE_PATTERN_ID) => {
            (*provider).ref_count.fetch_add(1, Ordering::Relaxed);
            *p_ret_val = ptr::addr_of_mut!((*provider).val_vtbl).cast::<c_void>();
        }
        (ControlKind::Button, UIA_INVOKE_PATTERN_ID) => {
            (*provider).ref_count.fetch_add(1, Ordering::Relaxed);
            *p_ret_val = ptr::addr_of_mut!((*provider).inv_vtbl).cast::<c_void>();
        }
        _ => {}
    }
    S_OK
}

unsafe extern "system" fn raw_get_property_value(
    this: *mut c_void,
    property_id: i32,
    p_ret_val: *mut ComVariant,
) -> i32 {
    if p_ret_val.is_null() {
        return E_POINTER_HR;
    }
    *p_ret_val = ComVariant::empty();
    let provider = from_raw(this);
    let raw_hwnd = (*provider).hwnd.load(Ordering::Acquire);
    if raw_hwnd == 0 {
        return UIA_E_ELEMENTNOTAVAILABLE_HR;
    }
    let hwnd = raw_hwnd as HWND;
    match property_id {
        UIA_CONTROL_TYPE_PROPERTY_ID => {
            let type_id = match (*provider).kind {
                ControlKind::Edit => UIA_EDIT_CONTROL_TYPE_ID,
                ControlKind::Button => UIA_BUTTON_CONTROL_TYPE_ID,
            };
            *p_ret_val = ComVariant::i4(type_id);
        }
        UIA_NAME_PROPERTY_ID => {
            *p_ret_val = ComVariant::bstr(&(*provider).accessible_name);
        }
        UIA_AUTOMATION_ID_PROPERTY_ID => {
            *p_ret_val = ComVariant::bstr(&(*provider).automation_id);
        }
        UIA_IS_ENABLED_PROPERTY_ID => {
            *p_ret_val = ComVariant::bool_val(IsWindowEnabled(hwnd) != 0);
        }
        UIA_IS_CONTROL_ELEMENT_PROPERTY_ID
        | UIA_IS_CONTENT_ELEMENT_PROPERTY_ID
        | UIA_IS_KEYBOARD_FOCUSABLE_PROPERTY_ID => {
            *p_ret_val = ComVariant::bool_val(true);
        }
        _ => {}
    }
    S_OK
}

unsafe extern "system" fn raw_get_host_provider(
    this: *mut c_void,
    p_ret_val: *mut *mut c_void,
) -> i32 {
    if p_ret_val.is_null() {
        return E_POINTER_HR;
    }
    *p_ret_val = ptr::null_mut();
    let provider = from_raw(this);
    let raw_hwnd = (*provider).hwnd.load(Ordering::Acquire);
    if raw_hwnd == 0 {
        return UIA_E_ELEMENTNOTAVAILABLE_HR;
    }
    UiaHostProviderFromHwnd(raw_hwnd as HWND, p_ret_val)
}

unsafe extern "system" fn val_set_value(this: *mut c_void, val: *const u16) -> i32 {
    let provider = from_val(this);
    let raw_hwnd = (*provider).hwnd.load(Ordering::Acquire);
    if raw_hwnd == 0 {
        return UIA_E_ELEMENTNOTAVAILABLE_HR;
    }
    let hwnd = raw_hwnd as HWND;
    if IsWindowEnabled(hwnd) == 0 {
        return UIA_E_ELEMENTNOTENABLED_HR;
    }
    let empty: [u16; 1] = [0];
    let ptr = if val.is_null() { empty.as_ptr() } else { val };
    SetWindowTextW(hwnd, ptr);
    S_OK
}

unsafe extern "system" fn val_get_value(this: *mut c_void, p_ret_val: *mut *mut u16) -> i32 {
    if p_ret_val.is_null() {
        return E_POINTER_HR;
    }
    *p_ret_val = ptr::null_mut();
    let provider = from_val(this);
    let raw_hwnd = (*provider).hwnd.load(Ordering::Acquire);
    if raw_hwnd == 0 {
        return UIA_E_ELEMENTNOTAVAILABLE_HR;
    }
    let hwnd = raw_hwnd as HWND;
    let len = SendMessageW(hwnd, WM_GETTEXTLENGTH, 0, 0).max(0) as usize;
    let mut buf = vec![0u16; len + 1];
    let copied = if len > 0 {
        SendMessageW(hwnd, WM_GETTEXT, buf.len(), buf.as_mut_ptr() as isize).max(0) as usize
    } else {
        0
    };
    *p_ret_val = SysAllocStringLen(buf.as_ptr(), copied.min(len) as u32);
    S_OK
}

unsafe extern "system" fn val_get_is_read_only(_this: *mut c_void, p_ret_val: *mut i32) -> i32 {
    if p_ret_val.is_null() {
        return E_POINTER_HR;
    }
    *p_ret_val = 0;
    S_OK
}

unsafe extern "system" fn inv_invoke(this: *mut c_void) -> i32 {
    let provider = from_inv(this);
    let raw_hwnd = (*provider).hwnd.load(Ordering::Acquire);
    if raw_hwnd == 0 {
        return UIA_E_ELEMENTNOTAVAILABLE_HR;
    }
    let hwnd = raw_hwnd as HWND;
    if IsWindowEnabled(hwnd) == 0 {
        return UIA_E_ELEMENTNOTENABLED_HR;
    }
    let root = GetAncestor(hwnd, GA_ROOT);
    if !root.is_null() {
        let _ = SetActiveWindow(root);
    }
    SendMessageW(hwnd, BM_CLICK_MSG, 0, 0);
    S_OK
}

struct SubclassState {
    original_proc: WNDPROC,
    provider: *mut ControlUiaProvider,
}

fn prop_name() -> Vec<u16> {
    "OmniaUiaControlSubclass\0".encode_utf16().collect()
}

unsafe extern "system" fn control_subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let key = prop_name();
    let state_ptr = GetPropW(hwnd, key.as_ptr()) as *mut SubclassState;
    if state_ptr.is_null() {
        return 0;
    }

    if message == WM_GETOBJECT && (lparam as i32) == UIA_ROOT_OBJECT_ID {
        let provider = (*state_ptr).provider;
        return UiaReturnRawElementProvider(hwnd, wparam, lparam, provider.cast::<c_void>());
    }

    let orig = (*state_ptr).original_proc;
    if message == WM_NCDESTROY {
        RemovePropW(hwnd, key.as_ptr());
        let state = Box::from_raw(state_ptr);
        (*state.provider).hwnd.store(0, Ordering::Release);
        let _ = UiaReturnRawElementProvider(hwnd, 0, 0, ptr::null_mut());
        release_common(state.provider);
        if let Some(proc_fn) = orig {
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, proc_fn as *const () as usize as isize);
            return CallWindowProcW(Some(proc_fn), hwnd, message, wparam, lparam);
        }
        return 0;
    }

    CallWindowProcW(orig, hwnd, message, wparam, lparam)
}

unsafe fn attach_kind(hwnd: HWND, kind: ControlKind, automation_id: &str, accessible_name: &str) {
    if hwnd.is_null() {
        return;
    }
    let key = prop_name();
    if !GetPropW(hwnd, key.as_ptr()).is_null() {
        return;
    }
    let provider = Box::into_raw(Box::new(ControlUiaProvider {
        raw_vtbl: &RAW_VTBL,
        val_vtbl: &VAL_VTBL,
        inv_vtbl: &INV_VTBL,
        ref_count: AtomicU32::new(1),
        hwnd: AtomicIsize::new(hwnd as isize),
        kind,
        automation_id: automation_id.to_string(),
        accessible_name: accessible_name.to_string(),
    }));
    let prev_proc_raw = SetWindowLongPtrW(
        hwnd,
        GWLP_WNDPROC,
        control_subclass_proc as *const () as usize as isize,
    );
    let original_proc: WNDPROC = if prev_proc_raw == 0 {
        None
    } else {
        Some(std::mem::transmute::<
            isize,
            unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
        >(prev_proc_raw))
    };
    let state = Box::into_raw(Box::new(SubclassState {
        original_proc,
        provider,
    }));
    SetPropW(hwnd, key.as_ptr(), state as HANDLE);
}

/// Subclasses a Win32 `EDIT` control so `WM_GETOBJECT` returns an accessible
/// server-side `ControlType.Edit` (`50004`) + `ValuePattern` provider.
pub unsafe fn attach(hwnd: HWND, automation_id: &str, accessible_name: &str) {
    attach_kind(hwnd, ControlKind::Edit, automation_id, accessible_name);
}

/// Subclasses a Win32 `BUTTON` control so `WM_GETOBJECT` returns an accessible
/// server-side `ControlType.Button` (`50000`) + `InvokePattern` provider.
pub unsafe fn attach_button(hwnd: HWND, automation_id: &str, accessible_name: &str) {
    attach_kind(hwnd, ControlKind::Button, automation_id, accessible_name);
}

unsafe fn read_button_label(hwnd: HWND, fallback: &str) -> String {
    let len = GetWindowTextLengthW(hwnd).max(0) as usize;
    if len == 0 {
        return fallback.to_string();
    }
    let mut buf = vec![0u16; len + 1];
    let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32).max(0) as usize;
    let raw = String::from_utf16_lossy(&buf[..copied.min(len)]).replace('&', "");
    if raw.trim().is_empty() {
        fallback.to_string()
    } else {
        raw
    }
}

unsafe extern "system" fn cbt_dialog_hook(n_code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if n_code == HCBT_ACTIVATE as i32 {
        let dlg = wparam as HWND;
        if !dlg.is_null() {
            for (dlg_id, id_str, fallback) in [
                (IDOK, "1", "OK"),
                (IDCANCEL, "2", "Cancel"),
                (IDYES, "6", "Yes"),
                (IDNO, "7", "No"),
            ] {
                let btn = GetDlgItem(dlg, dlg_id);
                if !btn.is_null() {
                    let label = read_button_label(btn, fallback);
                    attach_button(btn, id_str, &label);
                }
            }
        }
    }
    CallNextHookEx(ptr::null_mut(), n_code, wparam, lparam)
}

/// Displays a modal `MessageBoxW` with a thread-scoped `WH_CBT` hook so standard
/// `#32770` dialog buttons (`IDOK`/`IDCANCEL`/`IDYES`/`IDNO`) expose server-side
/// UIA `InvokePattern` without requiring foreground focus.
pub unsafe fn modal_message_box(
    owner: HWND,
    text: *const u16,
    caption: *const u16,
    flags: u32,
) -> i32 {
    let hook = SetWindowsHookExW(
        WH_CBT,
        Some(cbt_dialog_hook),
        ptr::null_mut(),
        GetCurrentThreadId(),
    );
    let result = MessageBoxW(owner, text, caption, flags);
    if !hook.is_null() {
        let _ = UnhookWindowsHookEx(hook);
    }
    result
}
