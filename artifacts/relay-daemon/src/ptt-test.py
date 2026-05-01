#!/usr/bin/env python3
"""
Script de prueba interactiva para PTT serial.
Prueba combinaciones de RTS/DTR con y sin inversion para
encontrar la configuracion correcta del adaptador QinHeng CH343.

Uso:  python3 ptt-test.py [device]
      python3 ptt-test.py /dev/eqso-ptt
"""
import sys
import os
import fcntl
import time

TIOCM_DTR = 0x002
TIOCM_RTS = 0x004
TIOCM_CTS = 0x020
TIOCM_DSR = 0x100
TIOCM_CAR = 0x040
TIOCMGET  = 0x5415
TIOCMSET  = 0x5418

def get_mctrl(fd):
    buf = bytearray(4)
    fcntl.ioctl(fd, TIOCMGET, buf, True)
    return int.from_bytes(buf, sys.byteorder)

def set_mctrl(fd, value):
    fcntl.ioctl(fd, TIOCMSET, value.to_bytes(4, sys.byteorder))

def show_state(fd, label=""):
    mctl = get_mctrl(fd)
    rts = "HIGH(set)" if mctl & TIOCM_RTS else "LOW(clear)"
    dtr = "HIGH(set)" if mctl & TIOCM_DTR else "LOW(clear)"
    print(f"  {label}  RTS={rts}  DTR={dtr}")

def wait(msg=""):
    input(f"  {msg}  [Enter para continuar]")

def run_test(fd, method, inverted, label):
    mask = TIOCM_RTS if method == "rts" else TIOCM_DTR
    inv_str = "inverted=true" if inverted else "inverted=false"
    print()
    print(f"{'='*60}")
    print(f"  TEST: method={method}  {inv_str}  [{label}]")
    print(f"{'='*60}")

    # Estado inicial OFF (respetando inversion)
    mctl = get_mctrl(fd)
    if inverted:
        mctl |= mask
    else:
        mctl &= ~mask
    set_mctrl(fd, mctl)
    time.sleep(0.1)
    show_state(fd, "INICIO(PTT OFF):")
    print("  >>> Observa el LED ahora. Deberia estar APAGADO.")
    wait()

    # Activar PTT
    activate = True ^ inverted
    mctl = get_mctrl(fd)
    if activate:
        mctl |= mask
    else:
        mctl &= ~mask
    set_mctrl(fd, mctl)
    time.sleep(0.1)
    show_state(fd, "PTT ON:        ")
    print("  >>> Observa el LED ahora. Deberia estar ENCENDIDO.")
    print("  >>> La aguja TX de la radio deberia subir.")
    answer = input("  ¿El LED se ENCENDIO? (s/n): ").strip().lower()
    led_on = answer in ("s", "si", "y", "yes", "1")

    # Desactivar PTT
    activate = False ^ inverted
    mctl = get_mctrl(fd)
    if activate:
        mctl |= mask
    else:
        mctl &= ~mask
    set_mctrl(fd, mctl)
    time.sleep(0.1)
    show_state(fd, "PTT OFF:       ")
    print("  >>> El LED deberia estar APAGADO ahora.")
    answer2 = input("  ¿El LED se APAGO?    (s/n): ").strip().lower()
    led_off = answer2 in ("s", "si", "y", "yes", "1")

    result = "OK ✓" if (led_on and led_off) else "MAL ✗"
    print(f"\n  Resultado: LED ON={led_on}  LED OFF={led_off}  → {result}")
    if led_on and led_off:
        print(f"\n  *** CONFIGURACION CORRECTA ***")
        print(f'  Pon en /etc/eqso-relay/CB.json:')
        print(f'    "ptt": {{ "device": "/dev/eqso-ptt", "method": "{method}", "inverted": {"true" if inverted else "false"} }}')
    return led_on and led_off

def main():
    device = sys.argv[1] if len(sys.argv) > 1 else "/dev/eqso-ptt"
    print(f"\nDiagnostico PTT para {device}")
    print("Conecta el cable al adaptador QinHeng y a la radio Sun CB.")
    print("Observa el LED de PTT en el adaptador USB.")
    print()

    try:
        fd = os.open(device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        print(f"Error abriendo {device}: {e}")
        sys.exit(1)

    print(f"Estado inicial del puerto:")
    show_state(fd)

    tests = [
        ("rts", False, "rts sin inversion"),
        ("rts", True,  "rts con inversion"),
        ("dtr", False, "dtr sin inversion"),
        ("dtr", True,  "dtr con inversion"),
    ]

    found = []
    for method, inverted, label in tests:
        ok = run_test(fd, method, inverted, label)
        if ok:
            found.append((method, inverted))

    # Dejar PTT en OFF al terminar
    mctl = get_mctrl(fd)
    mctl &= ~(TIOCM_RTS | TIOCM_DTR)
    set_mctrl(fd, mctl)
    os.close(fd)

    print()
    print("="*60)
    if found:
        print("CONFIGURACIONES QUE FUNCIONAN:")
        for method, inverted in found:
            print(f'  method="{method}" inverted={"true" if inverted else "false"}')
    else:
        print("Ninguna combinacion funciono.")
        print("Verifica el cableado: GND del DB9 (pin 5) al pin 2 del DIN.")

if __name__ == "__main__":
    main()
