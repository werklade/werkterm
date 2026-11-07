#!/usr/bin/env python3
"""Minimal Telnet test server for manual Werkterm tests (loopback only).

Usage (WSL or Linux):  python3 tests/manual/telnet_test_server.py [port]
Then connect Werkterm to telnet://localhost:<port> (default 2323).
It negotiates ECHO, SGA, TTYPE and NAWS, reports what the client sent,
and echoes typed lines back. Type "quit" to disconnect.
"""
import socket
import sys
import threading

IAC, DONT, DO, WONT, WILL, SB, SE = 255, 254, 253, 252, 251, 250, 240
ECHO, SGA, TTYPE, NAWS = 1, 3, 24, 31
NAMES = {ECHO: "ECHO", SGA: "SGA", TTYPE: "TTYPE", NAWS: "NAWS", 0: "BINARY"}
VERBS = {DO: "DO", DONT: "DONT", WILL: "WILL", WONT: "WONT"}


def handle(conn: socket.socket, addr) -> None:
    def send(data: bytes) -> None:
        conn.sendall(data)

    def say(text: str) -> None:
        send(text.replace("\n", "\r\n").encode())

    send(bytes([IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, SGA, IAC, DO, TTYPE, IAC, DO, NAWS]))
    say("Werkterm Telnet-Testserver\nNegotiation laeuft ...\n")
    line = bytearray()
    state, verb, sb = "data", 0, bytearray()
    while True:
        chunk = conn.recv(4096)
        if not chunk:
            break
        for b in chunk:
            if state == "data":
                if b == IAC:
                    state = "iac"
                elif b in (13,):
                    say("\n")
                    text = line.decode(errors="replace")
                    line.clear()
                    if text.strip() == "quit":
                        say("Tschuess\n")
                        conn.close()
                        return
                    say(f"Echo: {text}\n> ")
                elif b in (10, 0):
                    pass
                elif b in (8, 127):
                    if line:
                        line.pop()
                        send(b"\b \b")
                else:
                    line.append(b)
                    send(bytes([b]))
            elif state == "iac":
                if b in VERBS:
                    verb, state = b, "opt"
                elif b == SB:
                    sb.clear()
                    state = "sb"
                elif b == IAC:
                    line.append(IAC)
                    state = "data"
                else:
                    state = "data"
            elif state == "opt":
                say(f"[Client: {VERBS[verb]} {NAMES.get(b, b)}]\n")
                if verb == WILL and b == TTYPE:
                    send(bytes([IAC, SB, TTYPE, 1, IAC, SE]))
                state = "data"
            elif state == "sb":
                if b == IAC:
                    state = "sb_iac"
                else:
                    sb.append(b)
            elif state == "sb_iac":
                if b == SE:
                    if sb[:1] == bytes([NAWS]) and len(sb) >= 5:
                        say(f"[Fenstergroesse: {sb[1] * 256 + sb[2]} x {sb[3] * 256 + sb[4]}]\n")
                    elif sb[:2] == bytes([TTYPE, 0]):
                        say(f"[Terminaltyp: {sb[2:].decode(errors='replace')}]\n> ")
                    state = "data"
                else:
                    sb.append(b)
                    state = "sb"
    conn.close()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 2323
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", port))
    server.listen()
    print(f"Telnet-Testserver auf 127.0.0.1:{port} (Strg+C beendet)")
    while True:
        conn, addr = server.accept()
        threading.Thread(target=handle, args=(conn, addr), daemon=True).start()


if __name__ == "__main__":
    main()
