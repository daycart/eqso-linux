#!/usr/bin/env python3
"""Helper persistente de PTT serial para Linux y Windows."""
import sys
import os

TIOCM_DTR = 0x002
TIOCM_RTS = 0x004
TIOCMGET  = 0x5415
TIOCMSET  = 0x5418

def open_serial(device):
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateFileW.argtypes = (
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
            wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE,
        )
        kernel32.CreateFileW.restype = wintypes.HANDLE
        path = device if device.startswith("\\\\.\\") else f"\\\\.\\{device}"
        handle = kernel32.CreateFileW(
            path, 0xC0000000, 0, None, 3, 0, None
        )
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        return handle

    return os.open(device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)

def set_line(serial, method, active):
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.EscapeCommFunction.argtypes = (ctypes.c_void_p, ctypes.c_uint)
        kernel32.EscapeCommFunction.restype = ctypes.c_int
        function = (
            3 if active and method == "rts"
            else 4 if method == "rts"
            else 5 if active
            else 6
        )
        if not kernel32.EscapeCommFunction(serial, function):
            raise ctypes.WinError(ctypes.get_last_error())
        return

    import fcntl

    mask = TIOCM_RTS if method == "rts" else TIOCM_DTR
    buf = bytearray(4)
    fcntl.ioctl(serial, TIOCMGET, buf, True)
    value = int.from_bytes(buf, sys.byteorder)
    value = (value | mask) if active else (value & ~mask)
    fcntl.ioctl(serial, TIOCMSET, value.to_bytes(4, sys.byteorder))

def close_serial(serial):
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel32.CloseHandle.restype = ctypes.c_int
        kernel32.CloseHandle(serial)
    else:
        os.close(serial)

def main():
    if len(sys.argv) < 2:
        print("uso: ptt-helper.py <device> [rts|dtr] [true|false]", file=sys.stderr)
        sys.exit(1)

    device   = sys.argv[1]
    method   = sys.argv[2].lower() if len(sys.argv) > 2 else "rts"
    inverted = (len(sys.argv) > 3 and sys.argv[3].lower() == "true")
    try:
        serial = open_serial(device)
    except OSError as e:
        print(f"error abriendo {device}: {e}", file=sys.stderr)
        sys.exit(1)

    # Aseguramos que PTT empieza en OFF
    try:
        set_line(serial, method, inverted)
    except OSError as e:
        print(f"error PTT inicial: {e}", file=sys.stderr)
        close_serial(serial)
        sys.exit(1)

    sys.stdout.write("ready\n")
    sys.stdout.flush()

    for line in sys.stdin:
        cmd = line.strip()
        if cmd not in ("0", "1"):
            continue
        activate = (cmd == "1") ^ inverted
        try:
            set_line(serial, method, activate)
        except OSError as e:
            print(f"error PTT: {e}", file=sys.stderr)

    # Apagar PTT al salir
    try:
        set_line(serial, method, inverted)
    except OSError:
        pass
    close_serial(serial)

if __name__ == "__main__":
    main()
