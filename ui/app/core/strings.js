// Omnia Studio UI — strings owned by the platform layer (shell, dialogs, errors).
// Feature views register their own namespaces in views/<view>/strings.js.

import { registerStrings } from './i18n.js';

registerStrings('common', {
  vi: {
    cancel: 'Huỷ',
    confirm: 'Xác nhận',
    close: 'Đóng',
    retry: 'Thử lại',
    save: 'Lưu',
    delete: 'Xoá',
    create: 'Tạo',
    loading: 'Đang tải…',
    copy: 'Sao chép',
    copied: 'Đã sao chép',
    refresh: 'Làm mới',
    send: 'Gửi',
    search: 'Tìm',
    clear: 'Xoá bộ lọc',
    none: 'Không có',
    unknown: 'Không rõ',
    yes: 'Có',
    no: 'Không',
    building: 'Màn hình này đang được dựng lại.'
  },
  en: {
    cancel: 'Cancel',
    confirm: 'Confirm',
    close: 'Close',
    retry: 'Retry',
    save: 'Save',
    delete: 'Delete',
    create: 'Create',
    loading: 'Loading…',
    copy: 'Copy',
    copied: 'Copied',
    refresh: 'Refresh',
    send: 'Send',
    search: 'Search',
    clear: 'Clear filter',
    none: 'None',
    unknown: 'Unknown',
    yes: 'Yes',
    no: 'No',
    building: 'This screen is being rebuilt.'
  }
});

registerStrings('nav', {
  vi: { main: 'Điều hướng chính', chat: 'Hội thoại', agents: 'Tác tử', routing: 'Định tuyến', knowledge: 'Tri thức', settings: 'Cài đặt' },
  en: { main: 'Main navigation', chat: 'Chat', agents: 'Agents', routing: 'Routing', knowledge: 'Knowledge', settings: 'Settings' }
});

registerStrings('shell', {
  vi: {
    sidebar: 'Thanh bên',
    skip: 'Bỏ qua tới nội dung',
    collapse: 'Thu gọn thanh bên (Ctrl+B)',
    expand: 'Mở rộng thanh bên (Ctrl+B)',
    newSession: 'Phiên mới',
    recent: 'Phiên gần đây',
    filter: 'Lọc phiên đã tải',
    noSessions: 'Chưa có phiên nào.',
    noMatch: 'Không có phiên khớp bộ lọc.',
    loadFailed: 'Không tải được danh sách phiên.',
    loadMore: 'Tải thêm phiên',
    connected: 'Đã kết nối',
    connecting: 'Đang kết nối…',
    offline: 'Mất kết nối',
    retryIn: 'thử lại sau {s} giây',
    reconnected: 'Đã kết nối lại với omnia-studio.exe',
    lostConnection: 'Mất kết nối tới omnia-studio.exe',
    themeDark: 'Giao diện: Tối',
    themeLight: 'Giao diện: Sáng',
    themeSystem: 'Giao diện: Theo hệ thống',
    themeCycle: 'Đổi giao diện (Alt+T)'
  },
  en: {
    sidebar: 'Sidebar',
    skip: 'Skip to content',
    collapse: 'Collapse sidebar (Ctrl+B)',
    expand: 'Expand sidebar (Ctrl+B)',
    newSession: 'New session',
    recent: 'Recent sessions',
    filter: 'Filter loaded sessions',
    noSessions: 'No sessions yet.',
    noMatch: 'No session matches the filter.',
    loadFailed: 'Could not load sessions.',
    loadMore: 'Load more sessions',
    connected: 'Connected',
    connecting: 'Connecting…',
    offline: 'Offline',
    retryIn: 'retrying in {s}s',
    reconnected: 'Reconnected to omnia-studio.exe',
    lostConnection: 'Lost connection to omnia-studio.exe',
    themeDark: 'Theme: Dark',
    themeLight: 'Theme: Light',
    themeSystem: 'Theme: System',
    themeCycle: 'Change theme (Alt+T)'
  }
});

registerStrings('session', {
  vi: {
    createTitle: 'Tạo phiên mới',
    createDesc: 'Phiên được lưu trong SQLite của server. Tin nhắn của phiên chỉ lưu trên máy này.',
    title: 'Tiêu đề',
    model: 'Model',
    modelHint: 'Nhập tự do; gợi ý lấy từ danh sách provider của bộ định tuyến.',
    effort: 'Mức suy luận',
    create: 'Tạo phiên',
    defaultTitle: 'Phiên mới · {time}',
    created: 'Đã tạo phiên “{title}”',
    titleRequired: 'Cần có tiêu đề.',
    modelRequired: 'Cần có model.'
  },
  en: {
    createTitle: 'Create a session',
    createDesc: 'Sessions are stored in the server’s SQLite. Messages stay on this machine.',
    title: 'Title',
    model: 'Model',
    modelHint: 'Free text; suggestions come from the router’s provider list.',
    effort: 'Reasoning effort',
    create: 'Create session',
    defaultTitle: 'New session · {time}',
    created: 'Created session “{title}”',
    titleRequired: 'A title is required.',
    modelRequired: 'A model is required.'
  }
});

registerStrings('palette', {
  vi: {
    label: 'Bảng lệnh',
    placeholder: 'Gõ lệnh hoặc tên màn hình…',
    empty: 'Không có lệnh khớp.',
    move: 'chọn',
    run: 'chạy',
    close: 'đóng',
    groupNav: 'Điều hướng',
    groupApp: 'Ứng dụng',
    open: 'Mở {name}',
    toggleSidebar: 'Ẩn/hiện thanh bên',
    switchLang: 'Chuyển sang English',
    toggleMotion: 'Bật/tắt giảm chuyển động'
  },
  en: {
    label: 'Command palette',
    placeholder: 'Type a command or screen name…',
    empty: 'No matching command.',
    move: 'move',
    run: 'run',
    close: 'close',
    groupNav: 'Navigation',
    groupApp: 'App',
    open: 'Open {name}',
    toggleSidebar: 'Toggle sidebar',
    switchLang: 'Chuyển sang tiếng Việt',
    toggleMotion: 'Toggle reduced motion'
  }
});

registerStrings('api', {
  vi: {
    network: 'Không kết nối được omnia-studio.exe.',
    timeout: 'Máy chủ không phản hồi kịp.',
    aborted: 'Yêu cầu đã bị huỷ.',
    forbidden_origin: 'Máy chủ từ chối yêu cầu (Origin không hợp lệ).',
    forbidden_host: 'Máy chủ từ chối yêu cầu (Host không hợp lệ).',
    forbidden_path: 'Đường dẫn không hợp lệ.',
    invalid_json: 'Yêu cầu không hợp lệ hoặc quá lớn (giới hạn khoảng 1 MB).',
    invalid_response: 'Không đọc được phản hồi của máy chủ.',
    invalid_memory_namespace_or_key: 'Namespace hoặc key không hợp lệ.',
    invalid_memory_target: 'Namespace hoặc key không hợp lệ.',
    memory_entry_not_found: 'Mục bộ nhớ không còn tồn tại.',
    memory_not_found: 'Mục bộ nhớ không còn tồn tại.',
    memory_empty_content: 'Nội dung bộ nhớ không được để trống.',
    empty_steer_text: 'Chỉ dẫn không được để trống.',
    steer_text_required: 'Chỉ dẫn không được để trống.',
    empty_message: 'Tin nhắn không được để trống.',
    invalid_peer_message: 'Tin nhắn peer không hợp lệ: {message}',
    graph_send_rejected: 'Server từ chối tin nhắn: {message}',
    peer_policy_rejected: 'Server từ chối tin nhắn: {message}',
    entity_not_found: 'Không tìm thấy thực thể đồ thị: {message}',
    invalid_session_params: 'Thông số phiên không hợp lệ: {message}',
    session_create_failed: 'Không tạo được phiên: {message}',
    router_decision_failed: 'Định tuyến thất bại: {message}',
    internal_error: 'Lỗi nội bộ của máy chủ.',
    not_found: 'Không tìm thấy endpoint.',
    asset_not_found: 'Không tìm thấy endpoint.',
    unknown: 'Lỗi không xác định ({code}).'
  },
  en: {
    network: 'Cannot reach omnia-studio.exe.',
    timeout: 'The server did not answer in time.',
    aborted: 'The request was cancelled.',
    forbidden_origin: 'The server refused the request (bad Origin).',
    forbidden_host: 'The server refused the request (bad Host).',
    forbidden_path: 'Invalid path.',
    invalid_json: 'Invalid or too large request (about 1 MB limit).',
    invalid_response: 'Could not read the server response.',
    invalid_memory_namespace_or_key: 'Invalid namespace or key.',
    invalid_memory_target: 'Invalid namespace or key.',
    memory_entry_not_found: 'The memory entry no longer exists.',
    memory_not_found: 'The memory entry no longer exists.',
    memory_empty_content: 'Memory content cannot be empty.',
    empty_steer_text: 'The instruction cannot be empty.',
    steer_text_required: 'The instruction cannot be empty.',
    empty_message: 'The message cannot be empty.',
    invalid_peer_message: 'Invalid peer message: {message}',
    graph_send_rejected: 'The server rejected the message: {message}',
    peer_policy_rejected: 'The server rejected the message: {message}',
    entity_not_found: 'Graph entity not found: {message}',
    invalid_session_params: 'Invalid session parameters: {message}',
    session_create_failed: 'Could not create session: {message}',
    router_decision_failed: 'Routing decision failed: {message}',
    internal_error: 'Internal server error.',
    not_found: 'Endpoint not found.',
    asset_not_found: 'Endpoint not found.',
    unknown: 'Unknown error ({code}).'
  }
});
