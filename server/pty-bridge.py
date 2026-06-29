#!/usr/bin/env python3
"""Minimal PTY bridge.

Runs `CMD [ARGS...]` attached to a real pseudo-terminal, relaying the parent's
stdin/stdout to it. Used so the relay can drive Claude Code's raw-mode TUI
sign-in (`claude setup-token`) from the server, which has no controlling tty of
its own (the system `script` util refuses a non-tty stdin on some platforms).

A wide window size is set so long output (the OAuth URL) is not wrapped.
"""
import os
import sys
import pty
import select
import struct
import fcntl
import termios


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        sys.stderr.write("usage: pty-bridge.py CMD [ARGS...]\n")
        return 2

    pid, fd = pty.fork()
    if pid == 0:
        # Child: become the target program inside the new pty.
        try:
            os.execvp(argv[0], argv)
        except Exception as exc:  # pragma: no cover - exec failure path
            sys.stderr.write("exec failed: %s\n" % exc)
            os._exit(127)

    # Parent: make the pty wide so the CLI doesn't wrap the URL across lines.
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 60, 1000, 0, 0))
    except Exception:
        pass

    stdin_fd = sys.stdin.fileno()
    watch = [fd, stdin_fd]
    try:
        while True:
            rlist, _, _ = select.select(watch, [], [])
            if fd in rlist:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
            if stdin_fd in rlist:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    # Parent closed our stdin: stop relaying it, keep the pty.
                    watch = [fd]
                    continue
                try:
                    os.write(fd, data)
                except OSError:
                    pass
    finally:
        try:
            _, status = os.waitpid(pid, 0)
        except Exception:
            status = 0

    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return 1


if __name__ == "__main__":
    sys.exit(main())
