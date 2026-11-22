use std::cell::Cell;
use std::ffi::c_void;
use std::mem::offset_of;
use std::ptr::{null, null_mut};
use std::sync::atomic::{fence, AtomicIsize, AtomicU32, Ordering};

use windows_sys::core::{BOOL, BSTR, GUID, HRESULT, PCWSTR};
use windows_sys::Win32::Foundation::{
    SysAllocStringLen, E_INVALIDARG, E_NOINTERFACE, E_POINTER, FALSE, HWND, LPARAM, LRESULT, S_OK,
    TRUE, WPARAM,
};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::System::Variant::{VariantInit, VARIANT, VT_BSTR, VT_EMPTY, VT_I4};
use windows_sys::Win32::UI::Accessibility::{
    ProviderOptions, ProviderOptions_ServerSideProvider, UIA_ButtonControlTypeId,
    UIA_ControlTypePropertyId, UIA_EditControlTypeId, UIA_InvokePatternId, UIA_NamePropertyId,
    UIA_ValuePatternId, UiaDisconnectProvider, UiaHostProviderFromHwnd,
    UiaReturnRawElementProvider, UIA_E_ELEMENTNOTENABLED,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetClassNameW, GetDlgItem, GetParent, GetPropW, GetWindowLongPtrW,
    GetWindowLongW, GetWindowTextLengthW, GetWindowTextW, IsWindow, MessageBoxW, PostMessageW,
    RemovePropW, SendMessageW, SetPropW, SetWindowTextW, SetWindowsHookExW, UnhookWindowsHookEx,
    BM_CLICK, EN_CHANGE, ES_READONLY, GWL_ID, GWL_STYLE, HCBT_ACTIVATE, HHOOK, OBJID_CLIENT,
    WH_CBT, WM_COMMAND, WM_GETOBJECT, WM_NCDESTROY,
};

use crate::types::{strip_mnemonic_ampersands, utf8_to_wide, wide_to_utf8};

const BUTTON_SUBCLASS_ID: usize = 0x4F4D_4E01;
const EDIT_SUBCLASS_ID: usize = 0x4F4D_4E02;
const ATTACHED_PROP_NAME: &str = "OmniaNativeUiaAttached";

const IID_IUNKNOWN: GUID = GUID {
    data1: 0x0000_0000,
    data2: 0x0000,
    data3: 0x0000,
    data4: [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46],
};

const IID_IRAW_ELEMENT_PROVIDER_SIMPLE: GUID = GUID {
    data1: 0xD6DD_68D1,
    data2: 0x86FD,
    data3: 0x4332,
    data4: [0x86, 0x66, 0x9A, 0xBE, 0xDE, 0xA2, 0xD2, 0x4C],
};

const IID_IINVOKE_PROVIDER: GUID = GUID {
    data1: 0x54FC_B24B,
    data2: 0xE18E,
    data3: 0x47A2,
    data4: [0xB4, 0xD3, 0xEC, 0xCB, 0xE7, 0x75, 0x99, 0xA2],
};

const IID_IVALUE_PROVIDER: GUID = GUID {
    data1: 0xC793_5180,
    data2: 0x6FB3,
    data3: 0x4201,
    data4: [0xB1, 0x74, 0x7D, 0xF7, 0x3A, 0xDB, 0xF6, 0x4A],
};

#[inline]
fn guid_eq(a: &GUID, b: &GUID) -> bool {
    a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
}

/// Raw COM vtable matching `IRawElementProviderSimpleVtbl` in `UIAutomationCore.h`.
#[repr(C)]
pub struct IRawElementProviderSimpleVtbl {
    pub query_interface: unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppv_object: *mut *mut c_void,
    ) -> HRESULT,
    pub add_ref: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub release: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub get_provider_options:
        unsafe extern "system" fn(this: *mut c_void, p_ret_val: *mut ProviderOptions) -> HRESULT,
    pub get_pattern_provider: unsafe extern "system" fn(
        this: *mut c_void,
        pattern_id: i32,
        p_ret_val: *mut *mut c_void,
    ) -> HRESULT,
    pub get_property_value: unsafe extern "system" fn(
        this: *mut c_void,
        property_id: i32,
        p_ret_val: *mut VARIANT,
    ) -> HRESULT,
    pub get_host_raw_element_provider:
        unsafe extern "system" fn(this: *mut c_void, p_ret_val: *mut *mut c_void) -> HRESULT,
}

/// Raw COM vtable matching `IInvokeProviderVtbl` in `UIAutomationCore.h`.
#[repr(C)]
pub struct IInvokeProviderVtbl {
    pub query_interface: unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppv_object: *mut *mut c_void,
    ) -> HRESULT,
    pub add_ref: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub release: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub invoke: unsafe extern "system" fn(this: *mut c_void) -> HRESULT,
}

/// Raw COM vtable matching `IValueProviderVtbl` in `UIAutomationCore.h`.
#[repr(C)]
pub struct IValueProviderVtbl {
    pub query_interface: unsafe extern "system" fn(
        this: *mut c_void,
        riid: *const GUID,
        ppv_object: *mut *mut c_void,
    ) -> HRESULT,
    pub add_ref: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub release: unsafe extern "system" fn(this: *mut c_void) -> u32,
    pub set_value: unsafe extern "system" fn(this: *mut c_void, val: PCWSTR) -> HRESULT,
    pub get_value: unsafe extern "system" fn(this: *mut c_void, p_ret_val: *mut BSTR) -> HRESULT,
    pub get_is_read_only:
        unsafe extern "system" fn(this: *mut c_void, p_ret_val: *mut BOOL) -> HRESULT,
}

/// Dual-vtable COM object implementing `IRawElementProviderSimple` + `IInvokeProvider` for Win32 buttons.
#[repr(C)]
pub struct ButtonUiaObject {
    vtbl_raw: *const IRawElementProviderSimpleVtbl,
    vtbl_invoke: *const IInvokeProviderVtbl,
    ref_count: AtomicU32,
    hwnd: AtomicIsize,
    accessible_name: Option<String>,
}

/// Dual-vtable COM object implementing `IRawElementProviderSimple` + `IValueProvider` for Win32 single-line edits.
#[repr(C)]
pub struct EditUiaObject {
    vtbl_raw: *const IRawElementProviderSimpleVtbl,
    vtbl_value: *const IValueProviderVtbl,
    ref_count: AtomicU32,
    hwnd: AtomicIsize,
    accessible_name: Option<String>,
}

static BUTTON_RAW_VTBL: IRawElementProviderSimpleVtbl = IRawElementProviderSimpleVtbl {
    query_interface: button_raw_qi,
    add_ref: button_raw_add_ref,
    release: button_raw_release,
    get_provider_options: button_get_provider_options,
    get_pattern_provider: button_get_pattern_provider,
    get_property_value: button_get_property_value,
    get_host_raw_element_provider: button_get_host_raw_element_provider,
};

static BUTTON_INVOKE_VTBL: IInvokeProviderVtbl = IInvokeProviderVtbl {
    query_interface: button_invoke_qi,
    add_ref: button_invoke_add_ref,
    release: button_invoke_release,
    invoke: button_invoke,
};

static EDIT_RAW_VTBL: IRawElementProviderSimpleVtbl = IRawElementProviderSimpleVtbl {
    query_interface: edit_raw_qi,
    add_ref: edit_raw_add_ref,
    release: edit_raw_release,
    get_provider_options: edit_get_provider_options,
    get_pattern_provider: edit_get_pattern_provider,
    get_property_value: edit_get_property_value,
    get_host_raw_element_provider: edit_get_host_raw_element_provider,
};

static EDIT_VALUE_VTBL: IValueProviderVtbl = IValueProviderVtbl {
    query_interface: edit_value_qi,
    add_ref: edit_value_add_ref,
    release: edit_value_release,
    set_value: edit_set_value,
    get_value: edit_get_value,
    get_is_read_only: edit_get_is_read_only,
};

impl ButtonUiaObject {
    /// Heap-allocate a COM button provider with refcount = 1 returning its primary `IRawElementProviderSimple*`.
    #[must_use]
    pub fn allocate(hwnd: HWND, accessible_name: Option<String>) -> *mut c_void {
        let obj = Box::new(Self {
            vtbl_raw: &raw const BUTTON_RAW_VTBL,
            vtbl_invoke: &raw const BUTTON_INVOKE_VTBL,
            ref_count: AtomicU32::new(1),
            hwnd: AtomicIsize::new(hwnd as isize),
            accessible_name,
        });
        Box::into_raw(obj).cast::<c_void>()
    }

    fn current_hwnd(&self) -> HWND {
        self.hwnd.load(Ordering::Acquire) as HWND
    }

    fn invalidate(&self) {
        self.hwnd.store(0, Ordering::Release);
    }
}

impl EditUiaObject {
    /// Heap-allocate a COM edit provider with refcount = 1 returning its primary `IRawElementProviderSimple*`.
    #[must_use]
    pub fn allocate(hwnd: HWND, accessible_name: Option<String>) -> *mut c_void {
        let obj = Box::new(Self {
            vtbl_raw: &raw const EDIT_RAW_VTBL,
            vtbl_value: &raw const EDIT_VALUE_VTBL,
            ref_count: AtomicU32::new(1),
            hwnd: AtomicIsize::new(hwnd as isize),
            accessible_name,
        });
        Box::into_raw(obj).cast::<c_void>()
    }

    fn current_hwnd(&self) -> HWND {
        self.hwnd.load(Ordering::Acquire) as HWND
    }

    fn invalidate(&self) {
        self.hwnd.store(0, Ordering::Release);
    }
}

/// Read Win32 window text into UTF-8 safely without truncation or panic.
#[must_use]
pub(crate) fn read_hwnd_text_utf8(hwnd: HWND) -> String {
    if hwnd.is_null() {
        return String::new();
    }
    // SAFETY: Caller passes an HWND valid on the UI thread; GetWindowTextLengthW handles invalid HWNDs gracefully.
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; (len as usize) + 1];
    // SAFETY: `buf` holds `len + 1` elements matching `buf.len() as i32`.
    let copied = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if copied <= 0 {
        return String::new();
    }
    wide_to_utf8(&buf[..copied as usize])
}

fn alloc_bstr_from_utf8(text: &str) -> BSTR {
    let wide: Vec<u16> = text.encode_utf16().collect();
    // SAFETY: SysAllocStringLen accepts an empty pointer/length or valid UTF-16 slice and allocates a BSTR.
    unsafe {
        if wide.is_empty() {
            SysAllocStringLen(null(), 0)
        } else {
            SysAllocStringLen(wide.as_ptr(), wide.len() as u32)
        }
    }
}

fn set_variant_i4(out: *mut VARIANT, value: i32) {
    // SAFETY: Caller checked `out` is non-null; VariantInit zeroes it before assigning VT_I4.
    unsafe {
        VariantInit(out);
        (*out).Anonymous.Anonymous.vt = VT_I4;
        (*out).Anonymous.Anonymous.Anonymous.lVal = value;
    }
}

fn set_variant_bstr(out: *mut VARIANT, text: &str) {
    let bstr = alloc_bstr_from_utf8(text);
    // SAFETY: Caller checked `out` is non-null; `bstr` is owned by the output VARIANT (`VT_BSTR`).
    unsafe {
        VariantInit(out);
        (*out).Anonymous.Anonymous.vt = VT_BSTR;
        (*out).Anonymous.Anonymous.Anonymous.bstrVal = bstr;
    }
}

fn set_variant_empty(out: *mut VARIANT) {
    // SAFETY: Caller checked `out` is non-null; VariantInit sets `vt = VT_EMPTY`.
    unsafe {
        VariantInit(out);
        (*out).Anonymous.Anonymous.vt = VT_EMPTY;
    }
}

// --- Button COM implementation ---

unsafe fn button_from_raw<'a>(this: *mut c_void) -> &'a ButtonUiaObject {
    // SAFETY: Primary vptr is at offset 0 of `ButtonUiaObject`, created via `ButtonUiaObject::allocate`.
    unsafe { &*this.cast::<ButtonUiaObject>() }
}

unsafe fn button_from_invoke<'a>(this: *mut c_void) -> &'a ButtonUiaObject {
    // SAFETY: Secondary vptr `vtbl_invoke` lies at `offset_of!(ButtonUiaObject, vtbl_invoke)`.
    unsafe {
        let base = this
            .cast::<u8>()
            .sub(offset_of!(ButtonUiaObject, vtbl_invoke))
            .cast::<ButtonUiaObject>();
        &*base
    }
}

unsafe fn button_qi_impl(
    obj: *mut ButtonUiaObject,
    riid: *const GUID,
    ppv_object: *mut *mut c_void,
) -> HRESULT {
    if ppv_object.is_null() {
        return E_POINTER;
    }
    // SAFETY: `ppv_object` is non-null; initialize to null on failure.
    unsafe {
        *ppv_object = null_mut();
    }
    if riid.is_null() {
        return E_INVALIDARG;
    }
    // SAFETY: `riid` and `obj` are valid pointers passed across the COM ABI boundary.
    let iid = unsafe { &*riid };
    if guid_eq(iid, &IID_IUNKNOWN) || guid_eq(iid, &IID_IRAW_ELEMENT_PROVIDER_SIMPLE) {
        // SAFETY: `obj` points to an initialized `ButtonUiaObject`.
        unsafe {
            (*obj).ref_count.fetch_add(1, Ordering::Relaxed);
            *ppv_object = (&raw mut (*obj).vtbl_raw).cast::<c_void>();
        }
        return S_OK;
    }
    if guid_eq(iid, &IID_IINVOKE_PROVIDER) {
        // SAFETY: Secondary interface pointer must point to `vtbl_invoke` field within `obj`.
        unsafe {
            (*obj).ref_count.fetch_add(1, Ordering::Relaxed);
            *ppv_object = (&raw mut (*obj).vtbl_invoke).cast::<c_void>();
        }
        return S_OK;
    }
    E_NOINTERFACE
}

unsafe fn button_add_ref_impl(obj: *const ButtonUiaObject) -> u32 {
    // SAFETY: Caller supplies a live `ButtonUiaObject` pointer.
    let prev = unsafe { (*obj).ref_count.fetch_add(1, Ordering::Relaxed) };
    prev + 1
}

unsafe fn button_release_impl(obj: *mut ButtonUiaObject) -> u32 {
    // SAFETY: Standard atomic COM refcount release with Acquire fence before deallocation.
    let prev = unsafe { (*obj).ref_count.fetch_sub(1, Ordering::Release) };
    if prev == 1 {
        fence(Ordering::Acquire);
        // SAFETY: Last COM reference dropped; reconstruct Box allocated in `ButtonUiaObject::allocate`.
        unsafe {
            drop(Box::from_raw(obj));
        }
        return 0;
    }
    prev - 1
}

unsafe extern "system" fn button_raw_qi(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    // SAFETY: `this` is primary `IRawElementProviderSimple*` on `ButtonUiaObject`.
    unsafe { button_qi_impl(this.cast::<ButtonUiaObject>(), riid, ppv) }
}

unsafe extern "system" fn button_raw_add_ref(this: *mut c_void) -> u32 {
    // SAFETY: `this` is primary `IRawElementProviderSimple*` on `ButtonUiaObject`.
    unsafe { button_add_ref_impl(this.cast::<ButtonUiaObject>()) }
}

unsafe extern "system" fn button_raw_release(this: *mut c_void) -> u32 {
    // SAFETY: `this` is primary `IRawElementProviderSimple*` on `ButtonUiaObject`.
    unsafe { button_release_impl(this.cast::<ButtonUiaObject>()) }
}

unsafe extern "system" fn button_invoke_qi(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    // SAFETY: Adjust `this` from `vtbl_invoke` offset to base `ButtonUiaObject`.
    unsafe {
        let base = this
            .cast::<u8>()
            .sub(offset_of!(ButtonUiaObject, vtbl_invoke))
            .cast::<ButtonUiaObject>();
        button_qi_impl(base, riid, ppv)
    }
}

unsafe extern "system" fn button_invoke_add_ref(this: *mut c_void) -> u32 {
    // SAFETY: Adjust `this` from `vtbl_invoke` offset to base `ButtonUiaObject`.
    unsafe {
        let base = this
            .cast::<u8>()
            .sub(offset_of!(ButtonUiaObject, vtbl_invoke))
            .cast::<ButtonUiaObject>();
        button_add_ref_impl(base)
    }
}

unsafe extern "system" fn button_invoke_release(this: *mut c_void) -> u32 {
    // SAFETY: Adjust `this` from `vtbl_invoke` offset to base `ButtonUiaObject`.
    unsafe {
        let base = this
            .cast::<u8>()
            .sub(offset_of!(ButtonUiaObject, vtbl_invoke))
            .cast::<ButtonUiaObject>();
        button_release_impl(base)
    }
}

unsafe extern "system" fn button_get_provider_options(
    _this: *mut c_void,
    p_ret_val: *mut ProviderOptions,
) -> HRESULT {
    if p_ret_val.is_null() {
        return E_POINTER;
    }
    // SAFETY: Caller provided valid out pointer `p_ret_val`.
    unsafe {
        *p_ret_val = ProviderOptions_ServerSideProvider;
    }
    S_OK
}

unsafe extern "system" fn button_get_pattern_provider(
    this: *mut c_void,
    pattern_id: i32,
    p_ret_val: *mut *mut c_void,
) -> HRESULT {
    if p_ret_val.is_null() {
        return E_POINTER;
    }
    // SAFETY: Initialize out pointer before inspecting `pattern_id`.
    unsafe {
        *p_ret_val = null_mut();
    }
    if pattern_id == UIA_InvokePatternId {
        let iid = IID_IINVOKE_PROVIDER;
        // SAFETY: QueryInterface for `IInvokeProvider` handles AddRef and pointer offset.
        unsafe {
            return button_qi_impl(this.cast::<ButtonUiaObject>(), &raw const iid, p_ret_val);
        }
    }
    S_OK
}

unsafe extern "system" fn button_get_property_value(
    this: *mut c_void,
    property_id: i32,
    p_ret_val: *mut VARIANT,
) -> HRESULT {
    if p_ret_val.is_null() {
        return E_POINTER;
    }
    // SAFETY: `this` is valid `ButtonUiaObject` primary vptr.
    let obj = unsafe { button_from_raw(this) };
    if property_id == UIA_ControlTypePropertyId {
        set_variant_i4(p_ret_val, UIA_ButtonControlTypeId);
        return S_OK;
    }
    if property_id == UIA_NamePropertyId {
        let name = if let Some(ref explicit) = obj.accessible_name {
            explicit.clone()
        } else {
            strip_mnemonic_ampersands(&read_hwnd_text_utf8(obj.current_hwnd()))
        };
        if !name.is_empty() {
            set_variant_bstr(p_ret_val, &name);
            return S_OK;
        }
    }
    set_variant_empty(p_ret_val);
    S_OK
}

unsafe extern "system" fn button_get_host_raw_element_provider(
    this: *mut c_void,
    p_ret_val: *mut *mut c_void,
) -> HRESULT {
    if p_ret_val.is_null() {
        return E_POINTER;
    }
    // SAFETY: Initialize out pointer first; read valid `hwnd` atomically.
    unsafe {
        *p_ret_val = null_mut();
        let obj = button_from_raw(this);
        let hwnd = obj.current_hwnd();
        if hwnd.is_null() {
            return S_OK;
        }
        UiaHostProviderFromHwnd(hwnd, p_ret_val)
    }
}

unsafe extern "system" fn button_invoke(this: *mut c_void) -> HRESULT {
    // SAFETY: Recover `ButtonUiaObject` from `vtbl_invoke` secondary pointer.
    let obj = unsafe { button_from_invoke(this) };
    let hwnd = obj.current_hwnd();
    // SAFETY: Win32 HWND validation before posting click asynchronously.
    unsafe {
        if hwnd.is_null() || IsWindow(hwnd) == 0 || IsWindowEnabled(hwnd) == 0 {
            return UIA_E_ELEMENTNOTENABLED as HRESULT;
        }
        // Async PostMessageW ensures Invoke() never blocks if BM_CLICK opens a modal #32770 dialog.
        let _ = PostMessageW(hwnd, BM_CLICK, 0, 0);
    }
    S_OK
}

// --- Edit COM implementation ---

unsafe fn edit_from_raw<'a>(this: *mut c_void) -> &'a EditUiaObject {
    // SAFETY: Primary vptr is at offset 0 of `EditUiaObject`.
    unsafe { &*this.cast::<EditUiaObject>() }
}

unsafe fn edit_from_value<'a>(this: *mut c_void) -> &'a EditUiaObject {
    // SAFETY: Secondary vptr `vtbl_value` lies at `offset_of!(EditUiaObject, vtbl_value)`.
    unsafe {
        let base = this
            .cast::<u8>()
            .sub(offset_of!(EditUiaObject, vtbl_value))
            .cast::<EditUiaObject>();
        &*base
    }
}

unsafe fn edit_qi_impl(
    obj: *mut EditUiaObject,
    riid: *const GUID,
    ppv_object: *mut *mut c_void,
) -> HRESULT {
    if ppv_object.is_null() {
        return E_POINTER;
    }
    // SAFETY: `ppv_object` is non-null.
    unsafe {
        *ppv_object = null_mut();
    }
    if riid.is_null() {
        return E_INVALIDARG;
    }
    // SAFETY: `riid` and `obj` are valid COM pointers.
    let iid = unsafe { &*riid };
    if guid_eq(iid, &IID_IUNKNOWN) || guid_eq(iid, &IID_IRAW_ELEMENT_PROVIDER_SIMPLE) {
        // SAFETY: Return primary vptr with incremented refcount.
        unsafe {
            (*obj).ref_count.fetch_add(1, Ordering::Relaxed);
            *ppv_object = (&raw mut (*obj).vtbl_raw).cast::<c_void>();
        }
        return S_OK;
    }
    if guid_eq(iid, &IID_IVALUE_PROVIDER) {
        // SAFETY: Return `vtbl_value` field address with incremented refcount.
        unsafe {
            (*obj).ref_count.fetch_add(1, Ordering::Relaxed);
            *ppv_object = (&raw mut (*obj).vtbl_value).cast::<c_void>();
        }
        return S_OK;
    }
    E_NOINTERFACE
}

unsafe fn edit_add_ref_impl(obj: *const EditUiaObject) -> u32 {
    // SAFETY: Caller supplies a live `EditUiaObject`.
    let prev = unsafe { (*obj).ref_count.fetch_add(1, Ordering::Relaxed) };
    prev + 1
}

unsafe fn edit_release_impl(obj: *mut EditUiaObject) -> u32 {
    // SAFETY: Release COM reference cleanly with Acquire fence before freeing heap allocation.
    let prev = unsafe { (*obj).ref_count.fetch_sub(1, Ordering::Release) };
    if prev == 1 {
        fence(Ordering::Acquire);
        // SAFETY: Last reference dropped; reconstruct Box allocated in `EditUiaObject::allocate`.
        unsafe {
            drop(Box::from_raw(obj));
        }
        return 0;
    }
    prev - 1
}

unsafe extern "system" fn edit_raw_qi(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    // SAFETY: `this` is primary `IRawElementProviderSimple*` on `EditUiaObject`.
    unsafe { edit_qi_impl(this.cast::<EditUiaObject>(), riid, ppv) }
}

unsafe extern "system" fn edit_raw_add_ref(this: *mut c_void) -> u32 {
    // SAFETY: `this` is primary `IRawElementProviderSimple*` on `EditUiaObject`.
    unsafe { edit_add_ref_impl(this.cast::<EditUiaObject>()) }
}

unsafe extern "system" fn edit_raw_release(this: *mut c_void) -> u32 {
    // SAFETY: `this` is primary `IRawElementProviderSimple*` on `EditUiaObject`.
    unsafe { edit_release_impl(this.cast::<EditUiaObject>()) }
}

unsafe extern "system" fn edit_value_qi(
    this: *mut c_void,
    riid: *const GUID,
    ppv: *mut *mut c_void,
) -> HRESULT {
    // SAFETY: Adjust `this` from `vtbl_value` offset to base `EditUiaObject`.
    unsafe {
        let base = this
            .cast::<u8>()
            .sub(offset_of!(EditUiaObject, vtbl_value))
            .cast::<EditUiaObject>();
        edit_qi_impl(base, riid, ppv)
    }
}

unsafe extern "system" fn edit_value_add_ref(this: *mut c_void) -> u32 {
    // SAFETY: Adjust `this` from `vtbl_value` offset to base `EditUiaObject`.
    unsafe {
        let base = this
            .cast::<u8>()
            .sub(offset_of!(EditUiaObject, vtbl_value))
            .cast::<EditUiaObject>();
        edit_add_ref_impl(base)
    }
}

unsafe extern "system" fn edit_value_release(this: *mut c_void) -> u32 {
    // SAFETY: Adjust `this` from `vtbl_value` offset to base `EditUiaObject`.
    unsafe {
        let base = this
            .cast::<u8>()
            .sub(offset_of!(EditUiaObject, vtbl_value))
            .cast::<EditUiaObject>();
        edit_release_impl(base)
    }
}

unsafe extern "system" fn edit_get_provider_options(
    _this: *mut c_void,
    p_ret_val: *mut ProviderOptions,
) -> HRESULT {
    if p_ret_val.is_null() {
        return E_POINTER;
    }
    // SAFETY: `p_ret_val` is valid out pointer.
    unsafe {
        *p_ret_val = ProviderOptions_ServerSideProvider;
    }
    S_OK
}

unsafe extern "system" fn edit_get_pattern_provider(
    this: *mut c_void,
    pattern_id: i32,
    p_ret_val: *mut *mut c_void,
) -> HRESULT {
    if p_ret_val.is_null() {
        return E_POINTER;
    }
    // SAFETY: Initialize out pointer before inspecting `pattern_id`.
    unsafe {
        *p_ret_val = null_mut();
    }
    if pattern_id == UIA_ValuePatternId {
        let iid = IID_IVALUE_PROVIDER;
        // SAFETY: QueryInterface for `IValueProvider` handles AddRef and pointer offset.
        unsafe {
            return edit_qi_impl(this.cast::<EditUiaObject>(), &raw const iid, p_ret_val);
        }
    }
    S_OK
}

unsafe extern "system" fn edit_get_property_value(
    this: *mut c_void,
    property_id: i32,
    p_ret_val: *mut VARIANT,
) -> HRESULT {
    if p_ret_val.is_null() {
        return E_POINTER;
    }
    // SAFETY: `this` is valid `EditUiaObject` primary vptr.
    let obj = unsafe { edit_from_raw(this) };
    if property_id == UIA_ControlTypePropertyId {
        set_variant_i4(p_ret_val, UIA_EditControlTypeId);
        return S_OK;
    }
    if property_id == UIA_NamePropertyId {
        if let Some(ref explicit) = obj.accessible_name {
            if !explicit.is_empty() {
                set_variant_bstr(p_ret_val, explicit);
                return S_OK;
            }
        }
    }
    set_variant_empty(p_ret_val);
    S_OK
}

unsafe extern "system" fn edit_get_host_raw_element_provider(
    this: *mut c_void,
    p_ret_val: *mut *mut c_void,
) -> HRESULT {
    if p_ret_val.is_null() {
        return E_POINTER;
    }
    // SAFETY: Initialize out pointer first and query host provider if HWND is still alive.
    unsafe {
        *p_ret_val = null_mut();
        let obj = edit_from_raw(this);
        let hwnd = obj.current_hwnd();
        if hwnd.is_null() {
            return S_OK;
        }
        UiaHostProviderFromHwnd(hwnd, p_ret_val)
    }
}

unsafe extern "system" fn edit_set_value(this: *mut c_void, val: PCWSTR) -> HRESULT {
    if val.is_null() {
        return E_INVALIDARG;
    }
    // SAFETY: Recover `EditUiaObject` from `vtbl_value` secondary pointer.
    let obj = unsafe { edit_from_value(this) };
    let hwnd = obj.current_hwnd();
    // SAFETY: Validate HWND enabled and writable state before writing Win32 EDIT text.
    unsafe {
        if hwnd.is_null() || IsWindow(hwnd) == 0 || IsWindowEnabled(hwnd) == 0 {
            return UIA_E_ELEMENTNOTENABLED as HRESULT;
        }
        let style = GetWindowLongW(hwnd, GWL_STYLE);
        if (style & ES_READONLY) != 0 {
            return UIA_E_ELEMENTNOTENABLED as HRESULT;
        }
        if SetWindowTextW(hwnd, val) == 0 {
            return windows_sys::Win32::Foundation::E_FAIL;
        }
        let parent = GetParent(hwnd);
        if !parent.is_null() {
            let ctrl_id = (GetWindowLongPtrW(hwnd, GWL_ID) as i32) & 0xFFFF;
            let wparam = ((EN_CHANGE as usize) << 16) | (ctrl_id as usize);
            let _ = SendMessageW(parent, WM_COMMAND, wparam, hwnd as LPARAM);
        }
    }
    S_OK
}

unsafe extern "system" fn edit_get_value(this: *mut c_void, p_ret_val: *mut BSTR) -> HRESULT {
    if p_ret_val.is_null() {
        return E_POINTER;
    }
    // SAFETY: Recover `EditUiaObject` and read live window text as newly allocated `BSTR`.
    let obj = unsafe { edit_from_value(this) };
    let text = read_hwnd_text_utf8(obj.current_hwnd());
    let bstr = alloc_bstr_from_utf8(&text);
    // SAFETY: `p_ret_val` was checked non-null.
    unsafe {
        *p_ret_val = bstr;
    }
    if bstr.is_null() {
        windows_sys::Win32::Foundation::E_OUTOFMEMORY
    } else {
        S_OK
    }
}

unsafe extern "system" fn edit_get_is_read_only(
    this: *mut c_void,
    p_ret_val: *mut BOOL,
) -> HRESULT {
    if p_ret_val.is_null() {
        return E_POINTER;
    }
    // SAFETY: Recover `EditUiaObject` and inspect window style/enabled state.
    let obj = unsafe { edit_from_value(this) };
    let hwnd = obj.current_hwnd();
    // SAFETY: Check `IsWindowEnabled` and `ES_READONLY`.
    let read_only = unsafe {
        if hwnd.is_null() || IsWindow(hwnd) == 0 || IsWindowEnabled(hwnd) == 0 {
            TRUE
        } else {
            let style = GetWindowLongW(hwnd, GWL_STYLE);
            if (style & ES_READONLY) != 0 {
                TRUE
            } else {
                FALSE
            }
        }
    };
    // SAFETY: `p_ret_val` was checked non-null.
    unsafe {
        *p_ret_val = read_only;
    }
    S_OK
}

// --- Subclass plumbing & #32770 WH_CBT guard ---

struct AttachedButtonState {
    provider: *mut c_void,
}

struct AttachedEditState {
    provider: *mut c_void,
}

fn mark_attached_prop(hwnd: HWND) -> bool {
    let prop_w = utf8_to_wide(ATTACHED_PROP_NAME);
    // SAFETY: Check and set a window property on the owning HWND thread to guard against duplicate subclassing.
    unsafe {
        if !GetPropW(hwnd, prop_w.as_ptr()).is_null() {
            return false;
        }
        SetPropW(hwnd, prop_w.as_ptr(), std::ptr::dangling_mut::<c_void>()) != 0
    }
}

fn clear_attached_prop(hwnd: HWND) {
    let prop_w = utf8_to_wide(ATTACHED_PROP_NAME);
    // SAFETY: Remove marker property on `WM_NCDESTROY`.
    unsafe {
        let _ = RemovePropW(hwnd, prop_w.as_ptr());
    }
}

unsafe extern "system" fn button_subclass_proc(
    hwnd: HWND,
    umsg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    u_id_subclass: usize,
    dw_ref_data: usize,
) -> LRESULT {
    let state = dw_ref_data as *mut AttachedButtonState;
    if umsg == WM_GETOBJECT && (lparam as i32) == OBJID_CLIENT && !state.is_null() {
        // SAFETY: `state` and `state.provider` remain valid until `WM_NCDESTROY`.
        unsafe {
            return UiaReturnRawElementProvider(hwnd, wparam, lparam, (*state).provider);
        }
    }
    if umsg == WM_NCDESTROY {
        // SAFETY: First let DefSubclassProc finish or disconnect provider cleanly, then remove subclass and drop state.
        let res = unsafe { DefSubclassProc(hwnd, umsg, wparam, lparam) };
        if !state.is_null() {
            // SAFETY: Disconnect UIA provider from destroyed HWND and release owned refcount once.
            unsafe {
                let provider = (*state).provider;
                (*provider.cast::<ButtonUiaObject>()).invalidate();
                let _ = UiaDisconnectProvider(provider);
                let _ = button_raw_release(provider);
                drop(Box::from_raw(state));
            }
        }
        clear_attached_prop(hwnd);
        // SAFETY: Unregister subclass from `hwnd`.
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(button_subclass_proc), u_id_subclass);
        }
        return res;
    }
    // SAFETY: Delegate all unhandled messages along the ComCtl32 subclass chain.
    unsafe { DefSubclassProc(hwnd, umsg, wparam, lparam) }
}

unsafe extern "system" fn edit_subclass_proc(
    hwnd: HWND,
    umsg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    u_id_subclass: usize,
    dw_ref_data: usize,
) -> LRESULT {
    let state = dw_ref_data as *mut AttachedEditState;
    if umsg == WM_GETOBJECT && (lparam as i32) == OBJID_CLIENT && !state.is_null() {
        // SAFETY: `state` and `state.provider` remain valid until `WM_NCDESTROY`.
        unsafe {
            return UiaReturnRawElementProvider(hwnd, wparam, lparam, (*state).provider);
        }
    }
    if umsg == WM_NCDESTROY {
        // SAFETY: Pass WM_NCDESTROY down subclass chain before releasing UIA state.
        let res = unsafe { DefSubclassProc(hwnd, umsg, wparam, lparam) };
        if !state.is_null() {
            // SAFETY: Disconnect UIA provider and drop owned Box allocation exactly once.
            unsafe {
                let provider = (*state).provider;
                (*provider.cast::<EditUiaObject>()).invalidate();
                let _ = UiaDisconnectProvider(provider);
                let _ = edit_raw_release(provider);
                drop(Box::from_raw(state));
            }
        }
        clear_attached_prop(hwnd);
        // SAFETY: Unregister subclass from `hwnd`.
        unsafe {
            let _ = RemoveWindowSubclass(hwnd, Some(edit_subclass_proc), u_id_subclass);
        }
        return res;
    }
    // SAFETY: Delegate all unhandled messages along the ComCtl32 subclass chain.
    unsafe { DefSubclassProc(hwnd, umsg, wparam, lparam) }
}

/// Attach a server-side `ControlType.Button` + `IInvokeProvider` UIA provider to a button `HWND`.
///
/// Idempotent: safely ignores `null` or already-attached HWNDs.
pub(crate) fn attach_button(hwnd: HWND, accessible_name: Option<&str>) {
    if hwnd.is_null() {
        return;
    }
    if !mark_attached_prop(hwnd) {
        return;
    }
    let provider = ButtonUiaObject::allocate(hwnd, accessible_name.map(str::to_owned));
    let state = Box::into_raw(Box::new(AttachedButtonState { provider }));
    // SAFETY: `SetWindowSubclass` owns `state` until `WM_NCDESTROY`; on failure free `state` & release provider immediately.
    let ok = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(button_subclass_proc),
            BUTTON_SUBCLASS_ID,
            state as usize,
        )
    };
    if ok == 0 {
        // SAFETY: Subclass registration failed; clean up allocated state before returning.
        unsafe {
            let _ = button_raw_release(provider);
            drop(Box::from_raw(state));
        }
        clear_attached_prop(hwnd);
    }
}

/// Attach a server-side `ControlType.Edit` + `IValueProvider` UIA provider to a single-line `EDIT` `HWND`.
///
/// Do NOT attach this to multiline draft editor `112` (which must keep Win32's native `Document` + `TextPattern`).
pub(crate) fn attach_edit(hwnd: HWND, accessible_name: Option<&str>) {
    if hwnd.is_null() {
        return;
    }
    if !mark_attached_prop(hwnd) {
        return;
    }
    let provider = EditUiaObject::allocate(hwnd, accessible_name.map(str::to_owned));
    let state = Box::into_raw(Box::new(AttachedEditState { provider }));
    // SAFETY: `SetWindowSubclass` owns `state` until `WM_NCDESTROY`; on failure clean up immediately.
    let ok = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(edit_subclass_proc),
            EDIT_SUBCLASS_ID,
            state as usize,
        )
    };
    if ok == 0 {
        // SAFETY: Subclass registration failed; release state cleanly.
        unsafe {
            let _ = edit_raw_release(provider);
            drop(Box::from_raw(state));
        }
        clear_attached_prop(hwnd);
    }
}

thread_local! {
    static ACTIVE_CBT_HOOK: Cell<HHOOK> = const { Cell::new(null_mut()) };
}

unsafe extern "system" fn cbt_dialog_hook_proc(
    n_code: i32,
    w_param: WPARAM,
    l_param: LPARAM,
) -> LRESULT {
    let hook = ACTIVE_CBT_HOOK.with(Cell::get);
    if n_code == HCBT_ACTIVATE as i32 {
        let dialog_hwnd = w_param as HWND;
        if !dialog_hwnd.is_null() {
            let mut class_buf = [0u16; 64];
            // SAFETY: Query class name of newly activated window on this thread.
            let len = unsafe {
                GetClassNameW(dialog_hwnd, class_buf.as_mut_ptr(), class_buf.len() as i32)
            };
            if len > 0 && wide_to_utf8(&class_buf[..len as usize]) == "#32770" {
                for btn_id in [1i32, 2, 6, 7] {
                    // SAFETY: Inspect standard MessageBox button IDs (OK=1, Cancel=2, Yes=6, No=7).
                    let btn_hwnd = unsafe { GetDlgItem(dialog_hwnd, btn_id) };
                    if !btn_hwnd.is_null() {
                        attach_button(btn_hwnd, None);
                    }
                }
            }
        }
    }
    // SAFETY: Chain to next CBT hook on the current thread.
    unsafe { CallNextHookEx(hook, n_code, w_param, l_param) }
}

struct CbtHookGuard {
    prev: HHOOK,
    hook: HHOOK,
}

impl Drop for CbtHookGuard {
    fn drop(&mut self) {
        ACTIVE_CBT_HOOK.with(|slot| slot.set(self.prev));
        if !self.hook.is_null() {
            // SAFETY: Remove thread-scoped WH_CBT hook installed in `modal_message_box`.
            unsafe {
                let _ = UnhookWindowsHookEx(self.hook);
            }
        }
    }
}

/// Show a modal `MessageBoxW` guarded by a thread-scoped `WH_CBT` hook so `#32770` buttons
/// (`OK`/`Cancel`/`Yes`/`No`) expose `IInvokeProvider` cleanly to UIA automation.
pub(crate) fn modal_message_box(owner: HWND, text: &str, title: &str, flags: u32) -> i32 {
    let prev = ACTIVE_CBT_HOOK.with(Cell::get);
    // SAFETY: Install a thread-scoped WH_CBT hook (`hMod = null`, `dwThreadId = GetCurrentThreadId()`).
    let hook = unsafe {
        SetWindowsHookExW(
            WH_CBT,
            Some(cbt_dialog_hook_proc),
            null_mut(),
            GetCurrentThreadId(),
        )
    };
    ACTIVE_CBT_HOOK.with(|slot| slot.set(hook));
    let _guard = CbtHookGuard { prev, hook };

    let text_w = utf8_to_wide(text);
    let title_w = utf8_to_wide(title);
    // SAFETY: Passing NUL-terminated UTF-16 buffers to `MessageBoxW` on the UI thread.
    unsafe { MessageBoxW(owner, text_w.as_ptr(), title_w.as_ptr(), flags) }
}

// --- Direct COM testing helpers (exercised by Rust unit/integration tests) ---

/// Invoke `IUnknown::QueryInterface` directly on a COM provider pointer created by this module.
///
/// # Safety
/// `provider` must point to a live `ButtonUiaObject` or `EditUiaObject` primary `IRawElementProviderSimple*`.
pub unsafe fn com_query_interface(
    provider: *mut c_void,
    iid: &GUID,
) -> Result<*mut c_void, HRESULT> {
    let mut out: *mut c_void = null_mut();
    // SAFETY: First vtable slot is always `QueryInterface`.
    let vtbl = unsafe { *provider.cast::<*const IRawElementProviderSimpleVtbl>() };
    // SAFETY: Calling `QueryInterface` through validated vtable entry.
    let hr = unsafe { ((*vtbl).query_interface)(provider, iid, &raw mut out) };
    if hr >= 0 {
        Ok(out)
    } else {
        Err(hr)
    }
}

/// Invoke `IUnknown::AddRef` directly on any COM interface pointer from this module.
///
/// # Safety
/// `iface` must point to a live COM interface pointer (`IRawElementProviderSimple*`, `IInvokeProvider*`, or `IValueProvider*`).
pub unsafe fn com_add_ref(iface: *mut c_void) -> u32 {
    // SAFETY: Slot 1 in every COM vtable is `AddRef`.
    let vtbl = unsafe { *iface.cast::<*const IRawElementProviderSimpleVtbl>() };
    // SAFETY: Calling `AddRef` on live COM interface pointer.
    unsafe { ((*vtbl).add_ref)(iface) }
}

/// Invoke `IUnknown::Release` directly on any COM interface pointer from this module.
///
/// # Safety
/// `iface` must point to a live COM interface pointer with refcount >= 1.
pub unsafe fn com_release(iface: *mut c_void) -> u32 {
    // SAFETY: Slot 2 in every COM vtable is `Release`.
    let vtbl = unsafe { *iface.cast::<*const IRawElementProviderSimpleVtbl>() };
    // SAFETY: Calling `Release` on live COM interface pointer.
    unsafe { ((*vtbl).release)(iface) }
}

/// Expose canonical UIA IIDs for unit tests.
#[must_use]
pub const fn iids() -> (GUID, GUID, GUID, GUID) {
    (
        IID_IUNKNOWN,
        IID_IRAW_ELEMENT_PROVIDER_SIMPLE,
        IID_IINVOKE_PROVIDER,
        IID_IVALUE_PROVIDER,
    )
}
