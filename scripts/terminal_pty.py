#!/usr/bin/env python3
"""PTY bridge for Augment terminal plugin.

Spawns a shell in a pseudoterminal and bridges I/O via stdin/stdout.
Control messages arrive on fd 3 (separate from terminal data):
  R{rows},{cols}\n  — resize the PTY
"""

import pty
import os
import sys
import select
import signal
import struct
import fcntl
import termios
import errno


CONTROL_FD = 3


def set_pty_size(fd, rows, cols):
    """Set the PTY window size."""
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def main():
    # If extra args provided, run that command instead of the default shell
    # Usage: terminal_pty.py [cmd arg1 arg2 ...]
    custom_cmd = sys.argv[1:] if len(sys.argv) > 1 else None
    shell = os.environ.get("SHELL", "/bin/zsh")

    # Verify control fd is available
    try:
        os.fstat(CONTROL_FD)
    except OSError:
        print("Error: control fd 3 not available", file=sys.stderr)
        sys.exit(1)

    # Create PTY pair
    master_fd, slave_fd = pty.openpty()

    # Default size
    set_pty_size(master_fd, 24, 80)

    pid = os.fork()

    if pid == 0:
        # Child process — becomes the shell
        os.close(master_fd)
        os.close(CONTROL_FD)
        os.setsid()

        # Set slave as controlling terminal
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)

        if slave_fd > 2:
            os.close(slave_fd)

        # Set TERM for color support
        os.environ["TERM"] = "xterm-256color"

        if custom_cmd:
            os.execvp(custom_cmd[0], custom_cmd)
        else:
            os.execvp(shell, [shell, "-l"])

    else:
        # Parent process — bridges I/O
        os.close(slave_fd)

        stdin_fd = sys.stdin.fileno()
        stdout_fd = sys.stdout.fileno()

        # Buffer for partial control messages on fd 3
        ctrl_buf = b""

        try:
            while True:
                try:
                    rlist, _, _ = select.select(
                        [master_fd, stdin_fd, CONTROL_FD], [], [], 0.1
                    )
                except select.error as e:
                    if e.args[0] == errno.EINTR:
                        continue
                    raise

                if master_fd in rlist:
                    try:
                        data = os.read(master_fd, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    os.write(stdout_fd, data)

                if stdin_fd in rlist:
                    try:
                        data = os.read(stdin_fd, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    # stdin is clean passthrough — write directly to PTY
                    os.write(master_fd, data)

                if CONTROL_FD in rlist:
                    try:
                        data = os.read(CONTROL_FD, 4096)
                    except OSError:
                        break
                    if not data:
                        # Control channel closed — parent is done
                        break
                    ctrl_buf += data
                    # Process complete lines
                    while b"\n" in ctrl_buf:
                        line, ctrl_buf = ctrl_buf.split(b"\n", 1)
                        msg = line.decode("utf-8", errors="replace")
                        if msg.startswith("R"):
                            try:
                                parts = msg[1:].strip().split(",")
                                rows = int(parts[0])
                                cols = int(parts[1])
                                set_pty_size(master_fd, rows, cols)
                                os.kill(pid, signal.SIGWINCH)
                            except (ValueError, IndexError):
                                pass

                # Check if child is still alive
                result = os.waitpid(pid, os.WNOHANG)
                if result[0] != 0:
                    break

        except KeyboardInterrupt:
            pass
        finally:
            try:
                os.close(master_fd)
            except OSError:
                pass
            try:
                os.close(CONTROL_FD)
            except OSError:
                pass
            try:
                os.kill(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
            except (OSError, ChildProcessError):
                pass


if __name__ == "__main__":
    main()
