#include "omnia_native/session_panel.hpp"
#include "omnia_native/sessions.hpp"
#include "omnia_native/uia_provider.hpp"
#include "omnia_native/win32_shell.hpp"

#include <commctrl.h>
#include <uxtheme.h>

#include <algorithm>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

namespace omnia::native {

namespace {

constexpr UINT kMsgWorkerCompleted = WM_APP + 25;
constexpr wchar_t kSessionPanelClass[] = L"OmniaNativeSessionPanel";

constexpr COLORREF kCardBgColor = RGB(21, 30, 43);
constexpr COLORREF kInputBgColor = RGB(13, 19, 28);
constexpr COLORREF kTextPrimary = RGB(236, 242, 250);
constexpr COLORREF kTextMuted = RGB(159, 176, 199);
constexpr COLORREF kTextAccent = RGB(92, 200, 255);
constexpr COLORREF kTextStatus = RGB(214, 226, 242);

struct PanelHandles {
    HWND header_label{nullptr};
    HWND list{nullptr};
    HWND new_btn{nullptr};
    HWND title_label{nullptr};
    HWND title{nullptr};
    HWND model_label{nullptr};
    HWND model{nullptr};
    HWND effort_label{nullptr};
    HWND effort{nullptr};
    HWND apply{nullptr};
    HWND status{nullptr};
    HWND refresh{nullptr};
    HWND previous{nullptr};
    HWND next{nullptr};
};

struct PanelModel {
    std::unique_ptr<SessionWorker> worker;
    bool pending{false};
    std::vector<AgentSessionSummary> rows;
    std::optional<AgentSessionSummary> active;
    int64_t nav_revision{0};
    std::optional<AgentSessionPageCursor> cursor;
    std::optional<AgentSessionPageCursor> next_cursor;
    std::vector<std::optional<AgentSessionPageCursor>> history;
    std::optional<std::vector<std::optional<AgentSessionPageCursor>>> pending_history;
    std::optional<SessionForm> baseline;
};

struct SessionPanelState {
    PanelHandles handles;
    std::shared_ptr<PanelModel> model;
    HBRUSH card_brush{nullptr};
    HBRUSH input_brush{nullptr};

    ~SessionPanelState() {
        if (card_brush) {
            DeleteObject(card_brush);
        }
        if (input_brush) {
            DeleteObject(input_brush);
        }
    }
};

void set_text_utf8(HWND hwnd, std::string_view value) {
    const std::wstring wide = utf8_to_wide(value);
    SetWindowTextW(hwnd, wide.c_str());
}

std::string read_text_utf8(HWND hwnd) {
    std::vector<wchar_t> buffer(1025, L'\0');
    const LRESULT len_res = SendMessageW(
        hwnd,
        WM_GETTEXT,
        static_cast<WPARAM>(buffer.size()),
        reinterpret_cast<LPARAM>(buffer.data()));
    const size_t len = len_res > 0
        ? std::min(static_cast<size_t>(1024), static_cast<size_t>(len_res))
        : 0;
    return wide_to_utf8(std::wstring_view(buffer.data(), len));
}

Result<HWND> create_ctrl(
    HWND parent,
    const wchar_t* class_name,
    std::string_view label,
    DWORD style,
    uint16_t id,
    int y,
    int height) {
    const std::wstring wlabel = utf8_to_wide(label);
    const HWND handle = CreateWindowExW(
        0,
        class_name,
        wlabel.c_str(),
        WS_CHILD | WS_VISIBLE | style,
        0,
        y,
        282,
        height,
        parent,
        reinterpret_cast<HMENU>(static_cast<uintptr_t>(id)),
        GetModuleHandleW(nullptr),
        nullptr);
    if (!handle) {
        return Result<HWND>::err(NativeError::make(
            "win32_control_failed",
            "Session control " + std::to_string(id) + " could not be created"));
    }
    return Result<HWND>::ok(handle);
}

std::vector<std::wstring> current_process_args() {
    std::vector<std::wstring> out;
    if (__argc > 1 && __wargv != nullptr) {
        for (int i = 1; i < __argc; ++i) {
            if (__wargv[i]) {
                out.emplace_back(__wargv[i]);
            }
        }
    }
    return out;
}

void layout_panel(HWND hwnd, const PanelHandles& handles) {
    RECT rect{};
    if (!GetClientRect(hwnd, &rect)) {
        return;
    }
    const uint32_t dpi = window_dpi(hwnd);
    const auto s = [dpi](int32_t v) { return scale_px(v, dpi); };
    const int width = std::max<int>(rect.right - rect.left, s(220));
    const int height = std::max<int>(rect.bottom - rect.top, s(560));

    // Reserve generous room for the multi-line status label (ID = 126) above Refresh sessions (ID = 127).
    const int extra_vertical = std::max<int>(height - s(650), 0);
    const int list_h = s(100) + (extra_vertical / 2);

    int y = 0;
    MoveWindow(handles.header_label, 0, y, width, s(22), TRUE);
    y += s(25);
    MoveWindow(handles.new_btn, 0, y, width, s(30), TRUE);
    y += s(35);
    MoveWindow(handles.list, 0, y, width, list_h, TRUE);
    y += list_h + s(6);

    const int half_gap = s(8);
    const int page_btn_w = std::max<int>((width - half_gap) / 2, s(60));
    MoveWindow(handles.previous, 0, y, page_btn_w, s(28), TRUE);
    MoveWindow(
        handles.next,
        page_btn_w + half_gap,
        y,
        std::max<int>(width - page_btn_w - half_gap, s(60)),
        s(28),
        TRUE);
    y += s(34);

    MoveWindow(handles.title_label, 0, y, width, s(20), TRUE);
    y += s(22);
    MoveWindow(handles.title, 0, y, width, s(26), TRUE);
    y += s(32);

    MoveWindow(handles.model_label, 0, y, width, s(20), TRUE);
    y += s(22);
    MoveWindow(handles.model, 0, y, width, s(26), TRUE);
    y += s(32);

    MoveWindow(handles.effort_label, 0, y, width, s(20), TRUE);
    y += s(22);
    // For CBS_DROPDOWNLIST, height specifies the expanded dropdown box height.
    MoveWindow(handles.effort, 0, y, width, s(220), TRUE);
    y += s(34);

    MoveWindow(handles.apply, 0, y, width, s(30), TRUE);
    y += s(38);

    const int refresh_h = s(30);
    const int refresh_y = std::max<int>(height - refresh_h - s(2), y + s(156));
    const int status_h = std::max<int>(refresh_y - y - s(6), s(150));
    MoveWindow(handles.status, 0, y, width, status_h, TRUE);
    MoveWindow(handles.refresh, 0, refresh_y, width, refresh_h, TRUE);
}

SessionForm read_form(const PanelHandles& handles) {
    const LRESULT index = SendMessageW(handles.effort, CB_GETCURSEL, 0, 0);
    std::optional<size_t> effort_idx;
    if (index >= 0) {
        effort_idx = static_cast<size_t>(index);
    }
    return SessionForm{
        read_text_utf8(handles.title),
        read_text_utf8(handles.model),
        effort_idx,
    };
}

void set_busy(const PanelHandles& handles, bool busy) {
    const BOOL enabled = busy ? FALSE : TRUE;
    for (HWND item : {
             handles.new_btn,
             handles.list,
             handles.apply,
             handles.refresh,
             handles.previous,
             handles.next,
         }) {
        EnableWindow(item, enabled);
    }
    if (busy) {
        for (HWND input : {handles.title, handles.model, handles.effort}) {
            EnableWindow(input, FALSE);
        }
        set_text_utf8(
            handles.status,
            "Storage operation pending on one bounded worker. UI remains interactive.");
    }
}

void render_panel(const PanelHandles& handles, PanelModel& model) {
    const bool previous_enabled = !model.history.empty();
    const bool next_enabled = model.next_cursor.has_value();

    EnableWindow(handles.previous, previous_enabled ? TRUE : FALSE);
    EnableWindow(handles.next, next_enabled ? TRUE : FALSE);
    SendMessageW(handles.list, LB_RESETCONTENT, 0, 0);

    for (size_t index = 0; index < model.rows.size(); ++index) {
        const std::wstring wtitle = utf8_to_wide(model.rows[index].title);
        SendMessageW(handles.list, LB_ADDSTRING, 0, reinterpret_cast<LPARAM>(wtitle.c_str()));
        if (model.active.has_value() && model.active->id == model.rows[index].id) {
            SendMessageW(handles.list, LB_SETCURSEL, static_cast<WPARAM>(index), 0);
        }
    }

    const bool active_exists = model.active.has_value();
    for (HWND item : {handles.title, handles.model, handles.effort, handles.apply}) {
        EnableWindow(item, active_exists ? TRUE : FALSE);
    }

    if (model.active.has_value()) {
        const auto& active = *model.active;
        const bool on_page = std::any_of(
            model.rows.begin(),
            model.rows.end(),
            [&](const AgentSessionSummary& row) { return row.id == active.id; });
        const char* location = on_page
            ? "Active session is on this page."
            : "Active session is outside this page; settings remain selected.";

        set_text_utf8(handles.title, active.title);
        set_text_utf8(handles.model, active.model);

        size_t effort_index = 3; // medium default
        if (active.reasoning_effort.has_value()) {
            const auto it = std::find(
                kEfforts.begin(), kEfforts.end(), std::string_view(*active.reasoning_effort));
            if (it != kEfforts.end()) {
                effort_index = static_cast<size_t>(std::distance(kEfforts.begin(), it));
            }
        }
        SendMessageW(handles.effort, CB_SETCURSEL, static_cast<WPARAM>(effort_index), 0);

        const std::string msg =
            "Settings revision " + std::to_string(active.settings_revision) + "\n" +
            std::to_string(model.rows.size()) + " rows (limit 50). " + location +
            "\n\nProvider unconfigured; no request sent. Draft is unsaved.";
        set_text_utf8(handles.status, msg);
    } else {
        set_text_utf8(handles.title, "");
        set_text_utf8(handles.model, "");
        SendMessageW(handles.effort, CB_SETCURSEL, static_cast<WPARAM>(-1), 0);
        set_text_utf8(
            handles.status,
            "No active session.\nCreate or select a session. Draft below is a separate, unsaved scratch buffer.");
    }

    if (active_exists) {
        model.baseline = read_form(handles);
    } else {
        model.baseline.reset();
    }
}

void restore_selection(const PanelHandles& handles, const PanelModel& model) {
    WPARAM selection = static_cast<WPARAM>(-1);
    if (model.active.has_value()) {
        for (size_t i = 0; i < model.rows.size(); ++i) {
            if (model.rows[i].id == model.active->id) {
                selection = static_cast<WPARAM>(i);
                break;
            }
        }
    }
    SendMessageW(handles.list, LB_SETCURSEL, selection, 0);
}

bool confirm_discard(const PanelHandles& handles, const PanelModel& model) {
    const SessionForm current = read_form(handles);
    const bool dirty = current.changed_from(model.baseline);
    if (!dirty) {
        return true;
    }
    const int choice = uia::modal_message_box(
        GetAncestor(handles.list, GA_ROOT),
        L"Session settings have unsaved changes. Discard them?\n\nChoose No to keep editing, or save the settings before navigating.",
        L"Omnia \u2014 unsaved session settings",
        MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2);
    return choice == IDYES;
}

void handle_worker_completed(const PanelHandles& handles, const std::shared_ptr<PanelModel>& model) {
    if (!model || !model->worker) {
        return;
    }
    auto polled = model->worker->poll();
    if (!polled.has_value()) {
        return;
    }
    if (polled->is_ok()) {
        auto snap = std::move(polled->value());
        model->rows = std::move(snap.rows);
        model->active = std::move(snap.active);
        model->nav_revision = snap.navigation_revision;
        model->cursor = std::move(snap.cursor);
        model->next_cursor = std::move(snap.next_cursor);
        if (model->pending_history.has_value()) {
            model->history = std::move(*model->pending_history);
        } else {
            model->history.clear();
        }
        model->pending = false;
        model->pending_history.reset();
        set_busy(handles, false);
        render_panel(handles, *model);
    } else {
        const NativeError err = polled->error();
        model->pending = false;
        model->pending_history.reset();
        restore_selection(handles, *model);
        set_busy(handles, false);

        const BOOL active_exists = model->active.has_value() ? TRUE : FALSE;
        const BOOL has_previous = !model->history.empty() ? TRUE : FALSE;
        const BOOL has_next = model->next_cursor.has_value() ? TRUE : FALSE;
        EnableWindow(handles.apply, active_exists);
        for (HWND input : {handles.title, handles.model, handles.effort}) {
            EnableWindow(input, active_exists);
        }
        EnableWindow(handles.previous, has_previous);
        EnableWindow(handles.next, has_next);
        set_text_utf8(
            handles.status,
            err.code + ": " + err.message + "\nNo automatic retry. Select a session to reload.");
    }
}

void handle_panel_command(
    const PanelHandles& handles,
    const std::shared_ptr<PanelModel>& model,
    uint16_t id,
    uint16_t notification,
    HWND sender) {
    if (!model || !model->worker || model->pending) {
        return;
    }

    std::optional<std::vector<std::optional<AgentSessionPageCursor>>> paging_history;
    std::optional<SessionCommand> request;

    if (id == 129 && notification == BN_CLICKED && sender == handles.next) {
        if (model->next_cursor.has_value()) {
            auto history = model->history;
            if (history.size() >= 256) {
                history.erase(history.begin());
            }
            history.push_back(model->cursor);
            paging_history = std::move(history);
            request = SessionCommand::page(model->next_cursor);
        }
    } else if (id == 128 && notification == BN_CLICKED && sender == handles.previous) {
        if (!model->history.empty()) {
            auto history = model->history;
            auto prev_cursor = std::move(history.back());
            history.pop_back();
            paging_history = std::move(history);
            request = SessionCommand::page(std::move(prev_cursor));
        }
    } else if (id == 127 && notification == BN_CLICKED && sender == handles.refresh) {
        request = SessionCommand::refresh();
    } else if (id == 121 && notification == BN_CLICKED && sender == handles.new_btn) {
        request = SessionCommand::create(model->nav_revision);
    } else if (id == 120 && notification == LBN_SELCHANGE && sender == handles.list) {
        const LRESULT index = SendMessageW(handles.list, LB_GETCURSEL, 0, 0);
        if (index >= 0 && static_cast<size_t>(index) < model->rows.size()) {
            request = SessionCommand::select(
                model->rows[static_cast<size_t>(index)].id,
                model->nav_revision);
        }
    } else if (id == 125 && notification == BN_CLICKED && sender == handles.apply) {
        const std::string title_val = read_text_utf8(handles.title);
        const std::string model_val = read_text_utf8(handles.model);
        const LRESULT index = SendMessageW(handles.effort, CB_GETCURSEL, 0, 0);
        if (model->active.has_value() && index >= 0 &&
            static_cast<size_t>(index) < kEfforts.size()) {
            request = SessionCommand::update(
                model->active->id,
                model->active->settings_revision,
                title_val,
                model_val,
                std::string(kEfforts[static_cast<size_t>(index)]));
        }
    }

    if (!request.has_value()) {
        return;
    }

    if (!request->is_update() && !confirm_discard(handles, *model)) {
        restore_selection(handles, *model);
        return;
    }

    const Result<void> submitted = model->worker->submit(std::move(*request));
    if (submitted.is_ok()) {
        model->pending = true;
        model->pending_history = std::move(paging_history);
        set_busy(handles, true);
    } else {
        restore_selection(handles, *model);
        set_text_utf8(
            handles.status,
            submitted.error().code + ": " + submitted.error().message);
    }
}

Result<std::unique_ptr<SessionPanelState>> initialize_session_panel(HWND hwnd) {
    auto state = std::make_unique<SessionPanelState>();
    state->card_brush = CreateSolidBrush(kCardBgColor);
    state->input_brush = CreateSolidBrush(kInputBgColor);

    auto header = create_ctrl(hwnd, L"STATIC", "Sessions \xC2\xB7 native SQLite", 0, 119, 0, 22);
    if (header.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(header.error());

    auto new_btn = create_ctrl(hwnd, L"BUTTON", "New projectless chat", WS_TABSTOP, 121, 25, 30);
    if (new_btn.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(new_btn.error());
    uia::attach_button(new_btn.value(), "121", "New projectless chat");
    SetWindowTheme(new_btn.value(), L"DarkMode_Explorer", nullptr);

    auto list = create_ctrl(
        hwnd,
        L"LISTBOX",
        "",
        WS_TABSTOP | WS_BORDER | WS_VSCROLL | LBS_NOTIFY,
        120,
        60,
        104);
    if (list.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(list.error());
    SetWindowTheme(list.value(), L"DarkMode_Explorer", nullptr);

    auto previous = create_ctrl(hwnd, L"BUTTON", "Previous page", WS_TABSTOP, 128, 170, 28);
    if (previous.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(previous.error());
    uia::attach_button(previous.value(), "128", "Previous page");
    SetWindowTheme(previous.value(), L"DarkMode_Explorer", nullptr);

    auto next = create_ctrl(hwnd, L"BUTTON", "Next page", WS_TABSTOP, 129, 170, 28);
    if (next.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(next.error());
    uia::attach_button(next.value(), "129", "Next page");
    SetWindowTheme(next.value(), L"DarkMode_Explorer", nullptr);

    auto title_label = create_ctrl(hwnd, L"STATIC", "Session title", 0, 130, 204, 20);
    if (title_label.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(title_label.error());

    auto title = create_ctrl(hwnd, L"EDIT", "", WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL, 122, 226, 26);
    if (title.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(title.error());
    SetWindowTheme(title.value(), L"DarkMode_Explorer", nullptr);

    auto model_label = create_ctrl(
        hwnd, L"STATIC", "Model ID (profile not connected)", 0, 131, 258, 20);
    if (model_label.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(model_label.error());

    auto model = create_ctrl(hwnd, L"EDIT", "", WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL, 123, 280, 26);
    if (model.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(model.error());
    SetWindowTheme(model.value(), L"DarkMode_Explorer", nullptr);

    auto effort_label = create_ctrl(hwnd, L"STATIC", "Effort", 0, 132, 312, 20);
    if (effort_label.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(effort_label.error());

    auto effort = create_ctrl(
        hwnd,
        L"COMBOBOX",
        "",
        WS_TABSTOP | CBS_DROPDOWNLIST | WS_VSCROLL,
        124,
        334,
        220);
    if (effort.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(effort.error());
    SetWindowTheme(effort.value(), L"DarkMode_CFD", nullptr);
    for (std::string_view name : kEfforts) {
        const std::wstring wname = utf8_to_wide(name);
        SendMessageW(effort.value(), CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(wname.c_str()));
    }

    auto apply = create_ctrl(hwnd, L"BUTTON", "Save session settings", WS_TABSTOP, 125, 368, 30);
    if (apply.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(apply.error());
    uia::attach_button(apply.value(), "125", "Save session settings");
    SetWindowTheme(apply.value(), L"DarkMode_Explorer", nullptr);

    auto status = create_ctrl(hwnd, L"STATIC", "", 0, 126, 406, 210);
    if (status.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(status.error());

    auto refresh = create_ctrl(hwnd, L"BUTTON", "Refresh sessions", WS_TABSTOP, 127, 622, 30);
    if (refresh.is_err()) return Result<std::unique_ptr<SessionPanelState>>::err(refresh.error());
    uia::attach_button(refresh.value(), "127", "Refresh sessions");
    SetWindowTheme(refresh.value(), L"DarkMode_Explorer", nullptr);

    SendMessageW(title.value(), EM_SETLIMITTEXT, 256, 0);
    SendMessageW(model.value(), EM_SETLIMITTEXT, 256, 0);

    state->handles = PanelHandles{
        header.value(),
        list.value(),
        new_btn.value(),
        title_label.value(),
        title.value(),
        model_label.value(),
        model.value(),
        effort_label.value(),
        effort.value(),
        apply.value(),
        status.value(),
        refresh.value(),
        previous.value(),
        next.value(),
    };
    layout_panel(hwnd, state->handles);

    auto db_arg = parse_session_db_args(current_process_args());
    if (db_arg.is_err()) {
        return Result<std::unique_ptr<SessionPanelState>>::err(db_arg.error());
    }

    if (db_arg.value().has_value()) {
        auto worker_res = SessionWorker::start(*db_arg.value(), [hwnd]() {
            PostMessageW(hwnd, kMsgWorkerCompleted, 0, 0);
        });
        if (worker_res.is_err()) {
            return Result<std::unique_ptr<SessionPanelState>>::err(worker_res.error());
        }
        auto model_ptr = std::make_shared<PanelModel>();
        model_ptr->worker = std::move(worker_res.value());
        model_ptr->pending = true;
        render_panel(state->handles, *model_ptr);
        set_busy(state->handles, true);
        state->model = std::move(model_ptr);
    } else {
        for (HWND item : {
                 state->handles.new_btn,
                 state->handles.list,
                 state->handles.title,
                 state->handles.model,
                 state->handles.effort,
                 state->handles.apply,
                 state->handles.refresh,
                 state->handles.previous,
                 state->handles.next,
             }) {
            EnableWindow(item, FALSE);
        }
        set_text_utf8(
            state->handles.status,
            "Storage disconnected.\n\nLaunch with --session-db <isolated absolute path> to evaluate durable sessions.\n\nNo personal database is opened automatically.");
    }

    return Result<std::unique_ptr<SessionPanelState>>::ok(std::move(state));
}

LRESULT CALLBACK session_panel_proc(HWND hwnd, UINT message, WPARAM wp, LPARAM lp) {
    switch (message) {
        case WM_CREATE: {
            auto initialized = initialize_session_panel(hwnd);
            if (initialized.is_err()) {
                show_startup_error(initialized.error().message);
                return -1;
            }
            auto* raw = initialized.value().release();
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(raw));
            layout_panel(hwnd, raw->handles);
            return 0;
        }
        case WM_SIZE: {
            if (auto* state = reinterpret_cast<SessionPanelState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                layout_panel(hwnd, state->handles);
            }
            return 0;
        }
        case WM_ERASEBKGND: {
            if (auto* state = reinterpret_cast<SessionPanelState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                RECT rc{};
                GetClientRect(hwnd, &rc);
                FillRect(reinterpret_cast<HDC>(wp), &rc, state->card_brush);
                return 1;
            }
            break;
        }
        case WM_CTLCOLORSTATIC: {
            if (auto* state = reinterpret_cast<SessionPanelState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                const HDC hdc = reinterpret_cast<HDC>(wp);
                const HWND ctrl = reinterpret_cast<HWND>(lp);
                SetBkMode(hdc, OPAQUE);
                SetBkColor(hdc, kCardBgColor);
                if (ctrl == state->handles.header_label) {
                    SetTextColor(hdc, kTextAccent);
                } else if (ctrl == state->handles.status) {
                    SetTextColor(hdc, kTextStatus);
                } else {
                    SetTextColor(hdc, kTextMuted);
                }
                return reinterpret_cast<LRESULT>(state->card_brush);
            }
            break;
        }
        case WM_CTLCOLOREDIT:
        case WM_CTLCOLORLISTBOX: {
            if (auto* state = reinterpret_cast<SessionPanelState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                const HDC hdc = reinterpret_cast<HDC>(wp);
                SetBkMode(hdc, OPAQUE);
                SetBkColor(hdc, kInputBgColor);
                SetTextColor(hdc, kTextPrimary);
                return reinterpret_cast<LRESULT>(state->input_brush);
            }
            break;
        }
        case kMsgWorkerCompleted: {
            if (auto* state = reinterpret_cast<SessionPanelState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                if (state->model) {
                    const PanelHandles handles = state->handles;
                    const auto model = state->model;
                    handle_worker_completed(handles, model);
                }
            }
            return 0;
        }
        case WM_COMMAND: {
            if (auto* state = reinterpret_cast<SessionPanelState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
                if (state->model) {
                    const PanelHandles handles = state->handles;
                    const auto model = state->model;
                    handle_panel_command(
                        handles,
                        model,
                        static_cast<uint16_t>(LOWORD(wp)),
                        static_cast<uint16_t>(HIWORD(wp)),
                        reinterpret_cast<HWND>(lp));
                }
            }
            return 0;
        }
        case WM_NCDESTROY: {
            auto* state = reinterpret_cast<SessionPanelState*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            delete state;
            return DefWindowProcW(hwnd, message, wp, lp);
        }
        default:
            break;
    }
    return DefWindowProcW(hwnd, message, wp, lp);
}

} // namespace

uint32_t window_dpi(HWND hwnd) noexcept {
    if (hwnd) {
        const UINT dpi = GetDpiForWindow(hwnd);
        if (dpi >= 72) {
            return static_cast<uint32_t>(dpi);
        }
    }
    return 96;
}

int32_t scale_px(int32_t px, uint32_t dpi) noexcept {
    return static_cast<int32_t>((static_cast<int64_t>(px) * static_cast<int64_t>(dpi) + 48) / 96);
}

Result<std::optional<std::filesystem::path>> parse_session_db_args(
    const std::vector<std::wstring>& args) {
    std::optional<std::filesystem::path> database;
    for (size_t i = 0; i < args.size(); ++i) {
        if (args[i] != L"--session-db" || database.has_value()) {
            return Result<std::optional<std::filesystem::path>>::err(NativeError::make(
                "invalid_cli_args",
                "Usage: omnia-native [--session-db <absolute isolated database path>]"));
        }
        if (i + 1 >= args.size()) {
            return Result<std::optional<std::filesystem::path>>::err(NativeError::make(
                "invalid_cli_args",
                "--session-db requires a path"));
        }
        std::filesystem::path path(args[++i]);
        std::error_code ec;
        if (!path.is_absolute() || !path.has_parent_path() ||
            !std::filesystem::is_directory(path.parent_path(), ec)) {
            return Result<std::optional<std::filesystem::path>>::err(NativeError::make(
                "invalid_cli_args",
                "Session database must be an absolute path with an existing parent directory"));
        }
        database = std::move(path);
    }
    return Result<std::optional<std::filesystem::path>>::ok(std::move(database));
}

Result<HWND> create_session_panel(HWND parent, HFONT font, HFONT bold_font) {
    const HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSW wc{};
    wc.lpfnWndProc = &session_panel_proc;
    wc.hInstance = instance;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.hbrBackground = nullptr;
    wc.lpszClassName = kSessionPanelClass;
    if (RegisterClassW(&wc) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        return Result<HWND>::err(NativeError::make(
            "win32_register_failed",
            "Register session panel class failed"));
    }

    const HWND panel = CreateWindowExW(
        WS_EX_CONTROLPARENT,
        kSessionPanelClass,
        L"Session metadata",
        WS_VISIBLE | WS_CHILD | WS_CLIPCHILDREN,
        30,
        84,
        282,
        650,
        parent,
        reinterpret_cast<HMENU>(static_cast<uintptr_t>(140)),
        instance,
        nullptr);
    if (!panel) {
        return Result<HWND>::err(NativeError::make(
            "win32_panel_failed",
            "Create session panel failed"));
    }
    session_panel_apply_fonts_and_relayout(panel, font, bold_font);
    return Result<HWND>::ok(panel);
}

void session_panel_apply_fonts_and_relayout(HWND panel, HFONT font, HFONT bold_font) {
    if (!panel) {
        return;
    }
    const auto* state = reinterpret_cast<const SessionPanelState*>(
        GetWindowLongPtrW(panel, GWLP_USERDATA));
    HWND child = GetWindow(panel, GW_CHILD);
    while (child) {
        const HFONT target_font = (state && child == state->handles.header_label && bold_font)
            ? bold_font
            : font;
        SendMessageW(child, WM_SETFONT, reinterpret_cast<WPARAM>(target_font), TRUE);
        child = GetWindow(child, GW_HWNDNEXT);
    }
    if (state) {
        layout_panel(panel, state->handles);
    }
}

bool session_panel_can_close(HWND panel) {
    if (!panel) {
        return true;
    }
    const auto* state = reinterpret_cast<const SessionPanelState*>(
        GetWindowLongPtrW(panel, GWLP_USERDATA));
    if (!state || !state->model) {
        return true;
    }
    const PanelHandles handles = state->handles;
    const auto model = state->model;
    if (model->pending) {
        uia::modal_message_box(
            GetAncestor(panel, GA_ROOT),
            L"A storage operation is still pending. Wait for its result before closing.",
            L"Omnia \u2014 storage pending",
            MB_OK | MB_ICONINFORMATION);
        return false;
    }
    return confirm_discard(handles, *model);
}

} // namespace omnia::native
