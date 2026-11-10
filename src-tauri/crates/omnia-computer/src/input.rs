//! Synthetic mouse and keyboard input through `SendInput`.

use std::thread::sleep;
use std::time::Duration;

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
    KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
    VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

use crate::geometry::{normalize_abs, smooth_path};
use crate::keys::{chord_events, KeyChord, KeyStep, VK_MENU};
use crate::types::{InputTiming, MouseButton, Rect, ScrollDir};
use crate::ComputerError;

fn ms(n: u64) {
    if n > 0 {
        sleep(Duration::from_millis(n));
    }
}

fn send(inputs: &[INPUT]) -> Result<(), ComputerError> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(ComputerError::Failed(
            "SendInput was blocked (the target window may be elevated / running as admin)".into(),
        ));
    }
    Ok(())
}

fn mouse_input(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn virtual_screen() -> Rect {
    unsafe {
        Rect::new(
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

pub fn cursor_pos() -> (i32, i32) {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

fn move_abs(x: i32, y: i32) -> Result<(), ComputerError> {
    let (nx, ny) = normalize_abs(x, y, virtual_screen());
    send(&[mouse_input(
        nx,
        ny,
        0,
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
    )])
}

pub fn move_to(x: i32, y: i32, t: &InputTiming) -> Result<(), ComputerError> {
    for (px, py) in smooth_path(cursor_pos(), (x, y), t.move_steps) {
        move_abs(px, py)?;
        ms(t.move_step_ms);
    }
    // Make sure we land exactly (rounding of the normalised coordinates).
    move_abs(x, y)
}

fn button_flags(b: MouseButton) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
    match b {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    }
}

fn modifiers(mods: &[KeyStep], down: bool, t: &InputTiming) -> Result<(), ComputerError> {
    let order: Vec<&KeyStep> = if down {
        mods.iter().collect()
    } else {
        mods.iter().rev().collect()
    };
    for m in order {
        key_event(*m, down)?;
        ms(t.key_delay_ms);
    }
    Ok(())
}

pub fn click(
    x: i32,
    y: i32,
    button: MouseButton,
    count: u32,
    mods: &[KeyStep],
    t: &InputTiming,
) -> Result<(), ComputerError> {
    move_to(x, y, t)?;
    modifiers(mods, true, t)?;
    let (down, up) = button_flags(button);
    let result = (|| {
        for i in 0..count.max(1) {
            send(&[mouse_input(0, 0, 0, down)])?;
            ms(t.click_delay_ms);
            send(&[mouse_input(0, 0, 0, up)])?;
            if i + 1 < count {
                ms(t.click_delay_ms);
            }
        }
        Ok(())
    })();
    modifiers(mods, false, t)?;
    result
}

pub fn drag(
    from: (i32, i32),
    to: (i32, i32),
    button: MouseButton,
    t: &InputTiming,
) -> Result<(), ComputerError> {
    let (down, up) = button_flags(button);
    move_to(from.0, from.1, t)?;
    ms(t.click_delay_ms);
    send(&[mouse_input(0, 0, 0, down)])?;
    ms(t.click_delay_ms);
    let steps = t.move_steps.max(8);
    let result = (|| {
        for (px, py) in smooth_path(from, to, steps) {
            move_abs(px, py)?;
            ms(t.move_step_ms.max(6));
        }
        ms(t.click_delay_ms);
        Ok(())
    })();
    send(&[mouse_input(0, 0, 0, up)])?;
    result
}

pub fn scroll(
    at: Option<(i32, i32)>,
    dir: ScrollDir,
    notches: u32,
    t: &InputTiming,
) -> Result<(), ComputerError> {
    if let Some((x, y)) = at {
        move_to(x, y, t)?;
    }
    let (flag, sign) = match dir {
        ScrollDir::Up => (MOUSEEVENTF_WHEEL, 1),
        ScrollDir::Down => (MOUSEEVENTF_WHEEL, -1),
        ScrollDir::Right => (MOUSEEVENTF_HWHEEL, 1),
        ScrollDir::Left => (MOUSEEVENTF_HWHEEL, -1),
    };
    for _ in 0..notches.clamp(1, 100) {
        send(&[mouse_input(0, 0, sign * 120, flag)])?;
        ms(8);
    }
    Ok(())
}

fn key_event(step: KeyStep, down: bool) -> Result<(), ComputerError> {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if step.extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    let scan = unsafe { MapVirtualKeyW(step.vk as u32, MAPVK_VK_TO_VSC) } as u16;
    send(&[key_input(step.vk, scan, flags)])
}

pub fn press_keys(chords: &[KeyChord], t: &InputTiming) -> Result<(), ComputerError> {
    for chord in chords {
        for (step, down) in chord_events(chord) {
            key_event(step, down)?;
            ms(t.key_delay_ms);
        }
        ms(t.click_delay_ms);
    }
    Ok(())
}

pub fn tap_alt() {
    let step = KeyStep {
        vk: VK_MENU,
        extended: false,
    };
    let _ = key_event(step, true);
    let _ = key_event(step, false);
}

/// Type text as Unicode key events (layout independent). `\n` presses Enter, `\t` Tab.
pub fn type_text(text: &str, t: &InputTiming) -> Result<(), ComputerError> {
    for unit in text.encode_utf16() {
        match unit {
            0x0D => continue,
            0x0A => {
                key_event(
                    KeyStep {
                        vk: 0x0D,
                        extended: false,
                    },
                    true,
                )?;
                key_event(
                    KeyStep {
                        vk: 0x0D,
                        extended: false,
                    },
                    false,
                )?;
            }
            0x09 => {
                key_event(
                    KeyStep {
                        vk: 0x09,
                        extended: false,
                    },
                    true,
                )?;
                key_event(
                    KeyStep {
                        vk: 0x09,
                        extended: false,
                    },
                    false,
                )?;
            }
            u => {
                send(&[key_input(0, u, KEYEVENTF_UNICODE)])?;
                send(&[key_input(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])?;
            }
        }
        ms(t.key_delay_ms);
    }
    Ok(())
}
