#include "omnia_native/uia_provider.hpp"
#include "omnia_native/types.hpp"

#include <ole2.h>
#include <oleauto.h>
#include <uiautomation.h>

#include <algorithm>
#include <atomic>
#include <memory>
#include <string>
#include <vector>

namespace omnia::native::uia {

namespace {

constexpr wchar_t kSubclassPropName[] = L"OmniaUiaControlSubclass";

enum class ControlKind : uint8_t {
    Edit = 0,
    Button = 1,
};

BSTR alloc_bstr(std::wstring_view text) {
    return SysAllocStringLen(text.data(), static_cast<UINT>(text.size()));
}

class ControlUiaProvider final : public IRawElementProviderSimple,
                                 public IValueProvider,
                                 public IInvokeProvider {
public:
    ControlUiaProvider(
        HWND hwnd,
        ControlKind kind,
        std::wstring automation_id,
        std::wstring accessible_name)
        : hwnd_(reinterpret_cast<intptr_t>(hwnd)),
          kind_(kind),
          automation_id_(std::move(automation_id)),
          accessible_name_(std::move(accessible_name)) {}

    void detach_hwnd() noexcept {
        hwnd_.store(0, std::memory_order_release);
    }

    // IUnknown
    STDMETHODIMP QueryInterface(REFIID riid, void** ppvObject) override {
        if (!ppvObject) {
            return E_POINTER;
        }
        *ppvObject = nullptr;
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IRawElementProviderSimple)) {
            *ppvObject = static_cast<IRawElementProviderSimple*>(this);
            AddRef();
            return S_OK;
        }
        if (kind_ == ControlKind::Edit && riid == __uuidof(IValueProvider)) {
            *ppvObject = static_cast<IValueProvider*>(this);
            AddRef();
            return S_OK;
        }
        if (kind_ == ControlKind::Button && riid == __uuidof(IInvokeProvider)) {
            *ppvObject = static_cast<IInvokeProvider*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }

    STDMETHODIMP_(ULONG) AddRef() override {
        return ref_count_.fetch_add(1, std::memory_order_relaxed) + 1;
    }

    STDMETHODIMP_(ULONG) Release() override {
        const ULONG prev = ref_count_.fetch_sub(1, std::memory_order_acq_rel);
        if (prev == 1) {
            delete this;
            return 0;
        }
        return prev - 1;
    }

    // IRawElementProviderSimple
    STDMETHODIMP get_ProviderOptions(ProviderOptions* pRetVal) override {
        if (!pRetVal) {
            return E_POINTER;
        }
        *pRetVal = static_cast<ProviderOptions>(
            ProviderOptions_ServerSideProvider | ProviderOptions_UseComThreading);
        return S_OK;
    }

    STDMETHODIMP GetPatternProvider(PATTERNID patternId, IUnknown** pRetVal) override {
        if (!pRetVal) {
            return E_POINTER;
        }
        *pRetVal = nullptr;
        if (hwnd_.load(std::memory_order_acquire) == 0) {
            return static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE);
        }
        if (kind_ == ControlKind::Edit && patternId == UIA_ValuePatternId) {
            *pRetVal = static_cast<IValueProvider*>(this);
            AddRef();
        } else if (kind_ == ControlKind::Button && patternId == UIA_InvokePatternId) {
            *pRetVal = static_cast<IInvokeProvider*>(this);
            AddRef();
        }
        return S_OK;
    }

    STDMETHODIMP GetPropertyValue(PROPERTYID propertyId, VARIANT* pRetVal) override {
        if (!pRetVal) {
            return E_POINTER;
        }
        VariantInit(pRetVal);
        const intptr_t raw = hwnd_.load(std::memory_order_acquire);
        if (raw == 0) {
            return static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE);
        }
        const HWND hwnd = reinterpret_cast<HWND>(raw);
        switch (propertyId) {
            case UIA_ControlTypePropertyId:
                pRetVal->vt = VT_I4;
                pRetVal->lVal = (kind_ == ControlKind::Edit)
                    ? UIA_EditControlTypeId
                    : UIA_ButtonControlTypeId;
                break;
            case UIA_NamePropertyId:
                pRetVal->vt = VT_BSTR;
                pRetVal->bstrVal = alloc_bstr(accessible_name_);
                break;
            case UIA_AutomationIdPropertyId:
                pRetVal->vt = VT_BSTR;
                pRetVal->bstrVal = alloc_bstr(automation_id_);
                break;
            case UIA_IsEnabledPropertyId:
                pRetVal->vt = VT_BOOL;
                pRetVal->boolVal = (IsWindowEnabled(hwnd) != FALSE) ? VARIANT_TRUE : VARIANT_FALSE;
                break;
            case UIA_IsControlElementPropertyId:
            case UIA_IsContentElementPropertyId:
            case UIA_IsKeyboardFocusablePropertyId:
                pRetVal->vt = VT_BOOL;
                pRetVal->boolVal = VARIANT_TRUE;
                break;
            default:
                break;
        }
        return S_OK;
    }

    STDMETHODIMP get_HostRawElementProvider(IRawElementProviderSimple** pRetVal) override {
        if (!pRetVal) {
            return E_POINTER;
        }
        *pRetVal = nullptr;
        const intptr_t raw = hwnd_.load(std::memory_order_acquire);
        if (raw == 0) {
            return static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE);
        }
        return UiaHostProviderFromHwnd(reinterpret_cast<HWND>(raw), pRetVal);
    }

    // IValueProvider
    STDMETHODIMP SetValue(LPCWSTR val) override {
        const intptr_t raw = hwnd_.load(std::memory_order_acquire);
        if (raw == 0) {
            return static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE);
        }
        const HWND hwnd = reinterpret_cast<HWND>(raw);
        if (IsWindowEnabled(hwnd) == FALSE) {
            return static_cast<HRESULT>(UIA_E_ELEMENTNOTENABLED);
        }
        if ((GetWindowLongW(hwnd, GWL_STYLE) & ES_READONLY) != 0) {
            return static_cast<HRESULT>(UIA_E_ELEMENTNOTENABLED);
        }
        const wchar_t empty[] = L"";
        SetWindowTextW(hwnd, val ? val : empty);
        const HWND parent = GetParent(hwnd);
        if (parent) {
            const int ctrl_id = GetDlgCtrlID(hwnd);
            SendMessageW(
                parent,
                WM_COMMAND,
                MAKEWPARAM(static_cast<WORD>(ctrl_id), EN_CHANGE),
                reinterpret_cast<LPARAM>(hwnd));
        }
        return S_OK;
    }

    STDMETHODIMP get_Value(BSTR* pRetVal) override {
        if (!pRetVal) {
            return E_POINTER;
        }
        *pRetVal = nullptr;
        const intptr_t raw = hwnd_.load(std::memory_order_acquire);
        if (raw == 0) {
            return static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE);
        }
        const HWND hwnd = reinterpret_cast<HWND>(raw);
        const LRESULT len_res = SendMessageW(hwnd, WM_GETTEXTLENGTH, 0, 0);
        const size_t len = len_res > 0 ? static_cast<size_t>(len_res) : 0;
        std::vector<wchar_t> buf(len + 1, L'\0');
        size_t copied = 0;
        if (len > 0) {
            const LRESULT copy_res = SendMessageW(
                hwnd,
                WM_GETTEXT,
                static_cast<WPARAM>(buf.size()),
                reinterpret_cast<LPARAM>(buf.data()));
            copied = copy_res > 0 ? std::min(len, static_cast<size_t>(copy_res)) : 0;
        }
        *pRetVal = SysAllocStringLen(buf.data(), static_cast<UINT>(copied));
        return S_OK;
    }

    STDMETHODIMP get_IsReadOnly(BOOL* pRetVal) override {
        if (!pRetVal) {
            return E_POINTER;
        }
        const intptr_t raw = hwnd_.load(std::memory_order_acquire);
        if (raw == 0) {
            *pRetVal = FALSE;
            return S_OK;
        }
        const HWND hwnd = reinterpret_cast<HWND>(raw);
        *pRetVal = ((GetWindowLongW(hwnd, GWL_STYLE) & ES_READONLY) != 0) ? TRUE : FALSE;
        return S_OK;
    }

    // IInvokeProvider
    STDMETHODIMP Invoke() override {
        const intptr_t raw = hwnd_.load(std::memory_order_acquire);
        if (raw == 0) {
            return static_cast<HRESULT>(UIA_E_ELEMENTNOTAVAILABLE);
        }
        const HWND hwnd = reinterpret_cast<HWND>(raw);
        if (IsWindowEnabled(hwnd) == FALSE) {
            return static_cast<HRESULT>(UIA_E_ELEMENTNOTENABLED);
        }
        const HWND root = GetAncestor(hwnd, GA_ROOT);
        if (root) {
            SetActiveWindow(root);
        }
        SendMessageW(hwnd, BM_CLICK, 0, 0);
        return S_OK;
    }

private:
    ~ControlUiaProvider() = default;

    std::atomic<ULONG> ref_count_{1};
    std::atomic<intptr_t> hwnd_{0};
    ControlKind kind_;
    std::wstring automation_id_;
    std::wstring accessible_name_;
};

struct SubclassState {
    WNDPROC original_proc{nullptr};
    ControlUiaProvider* provider{nullptr};
};

LRESULT CALLBACK control_subclass_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* state = static_cast<SubclassState*>(GetPropW(hwnd, kSubclassPropName));
    if (!state) {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }

    if (message == WM_GETOBJECT && static_cast<long>(lparam) == static_cast<long>(UiaRootObjectId)) {
        return UiaReturnRawElementProvider(
            hwnd,
            wparam,
            lparam,
            static_cast<IRawElementProviderSimple*>(state->provider));
    }

    const WNDPROC orig = state->original_proc;
    if (message == WM_NCDESTROY) {
        RemovePropW(hwnd, kSubclassPropName);
        ControlUiaProvider* provider = state->provider;
        delete state;
        if (provider) {
            provider->detach_hwnd();
            (void)UiaDisconnectProvider(static_cast<IRawElementProviderSimple*>(provider));
            (void)UiaReturnRawElementProvider(hwnd, 0, 0, nullptr);
            provider->Release();
        }
        if (orig) {
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(orig));
            return CallWindowProcW(orig, hwnd, message, wparam, lparam);
        }
        return 0;
    }

    return orig ? CallWindowProcW(orig, hwnd, message, wparam, lparam)
                : DefWindowProcW(hwnd, message, wparam, lparam);
}

void attach_kind(
    HWND hwnd,
    ControlKind kind,
    std::string_view automation_id,
    std::string_view accessible_name) {
    if (!hwnd || !IsWindow(hwnd)) {
        return;
    }
    if (GetPropW(hwnd, kSubclassPropName) != nullptr) {
        return;
    }

    auto* provider = new ControlUiaProvider(
        hwnd,
        kind,
        utf8_to_wide(automation_id),
        utf8_to_wide(accessible_name));

    const LONG_PTR prev_raw = SetWindowLongPtrW(
        hwnd,
        GWLP_WNDPROC,
        reinterpret_cast<LONG_PTR>(&control_subclass_proc));
    if (prev_raw == 0) {
        provider->Release();
        return;
    }

    auto* state = new SubclassState{
        reinterpret_cast<WNDPROC>(prev_raw),
        provider,
    };
    if (!SetPropW(hwnd, kSubclassPropName, reinterpret_cast<HANDLE>(state))) {
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, prev_raw);
        delete state;
        provider->Release();
    }
}

std::string read_button_label_utf8(HWND hwnd, std::string_view fallback) {
    const int len = GetWindowTextLengthW(hwnd);
    if (len <= 0) {
        return std::string(fallback);
    }
    std::wstring buf(static_cast<size_t>(len) + 1, L'\0');
    const int copied = GetWindowTextW(hwnd, buf.data(), static_cast<int>(buf.size()));
    if (copied <= 0) {
        return std::string(fallback);
    }
    buf.resize(static_cast<size_t>(copied));
    buf.erase(std::remove(buf.begin(), buf.end(), L'&'), buf.end());
    std::string utf8 = wide_to_utf8(buf);
    if (trim_ascii(utf8).empty()) {
        return std::string(fallback);
    }
    return utf8;
}

LRESULT CALLBACK cbt_dialog_hook(int code, WPARAM wparam, LPARAM lparam) {
    if (code == HCBT_ACTIVATE) {
        const HWND dlg = reinterpret_cast<HWND>(wparam);
        if (dlg && IsWindow(dlg)) {
            struct DialogBtn {
                int id;
                std::string_view id_str;
                std::string_view fallback;
            };
            constexpr DialogBtn kButtons[] = {
                {IDOK, "1", "OK"},
                {IDCANCEL, "2", "Cancel"},
                {IDYES, "6", "Yes"},
                {IDNO, "7", "No"},
            };
            for (const auto& entry : kButtons) {
                const HWND btn = GetDlgItem(dlg, entry.id);
                if (btn) {
                    const std::string label = read_button_label_utf8(btn, entry.fallback);
                    attach_button(btn, entry.id_str, label);
                }
            }
        }
    }
    return CallNextHookEx(nullptr, code, wparam, lparam);
}

} // namespace

void attach_edit(HWND hwnd, std::string_view automation_id, std::string_view accessible_name) {
    attach_kind(hwnd, ControlKind::Edit, automation_id, accessible_name);
}

void attach_button(HWND hwnd, std::string_view automation_id, std::string_view accessible_name) {
    attach_kind(hwnd, ControlKind::Button, automation_id, accessible_name);
}

int modal_message_box(HWND owner, const wchar_t* text, const wchar_t* caption, UINT flags) {
    const HHOOK hook = SetWindowsHookExW(
        WH_CBT,
        &cbt_dialog_hook,
        nullptr,
        GetCurrentThreadId());
    const int result = MessageBoxW(owner, text, caption, flags);
    if (hook) {
        UnhookWindowsHookEx(hook);
    }
    return result;
}

} // namespace omnia::native::uia
