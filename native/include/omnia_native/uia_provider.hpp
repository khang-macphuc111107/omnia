#pragma once

#include <windows.h>

#include <string_view>

namespace omnia::native::uia {

// Subclasses a Win32 EDIT control so WM_GETOBJECT (UiaRootObjectId = -25)
// returns an accessible server-side ControlType.Edit (50004) + IValueProvider
// without requiring UIAutomationClientsideProviders.
void attach_edit(HWND hwnd, std::string_view automation_id, std::string_view accessible_name);

// Subclasses a Win32 BUTTON control so WM_GETOBJECT (UiaRootObjectId = -25)
// returns an accessible server-side ControlType.Button (50000) + IInvokeProvider
// that executes BM_CLICK without requiring foreground focus.
void attach_button(HWND hwnd, std::string_view automation_id, std::string_view accessible_name);

// Displays a modal MessageBoxW wrapped in a thread-scoped WH_CBT hook so
// standard #32770 dialog buttons (IDOK=1, IDCANCEL=2, IDYES=6, IDNO=7) expose
// server-side IInvokeProvider with duplicate-subclass protection.
int modal_message_box(HWND owner, const wchar_t* text, const wchar_t* caption, UINT flags);

} // namespace omnia::native::uia
