#!/usr/bin/env bash
# Augment tmux shim — intercepts Claude Code's tmux commands and redirects
# agent spawns to Augment sessions via a Unix domain socket.
#
# CC thinks it's in tmux. Instead of creating real tmux panes, this shim
# sends spawn requests to the Augment Electron app, which creates new
# terminal sessions for each agent.
#
# Commands intercepted:
#   new-window -n <name> <cmd...>  → spawn request to Augment
#   send-keys -t <target> <keys>   → write to session via Augment
#   display-message -p <fmt>        → return fake pane info
#   select-pane -T <title>          → no-op (name is set at spawn)
#   list-panes                      → return fake pane list
#   has-session                     → return success (we're "in tmux")

SOCKET="${AUGMENT_SOCKET:-$HOME/.augment/augment.sock}"

# Send a JSON command to the Augment socket and read the response.
# Uses Python for Unix domain socket since socat may not be available.
augment_cmd() {
  local json="$1"
  if [ ! -S "$SOCKET" ]; then
    echo ""
    return 1
  fi
  python3 -c "
import socket, sys, json
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    s.settimeout(2)
    s.connect('$SOCKET')
    s.sendall(sys.argv[1].encode() + b'\n')
    resp = b''
    while True:
        try:
            chunk = s.recv(4096)
            if not chunk:
                break
            resp += chunk
            if b'\n' in resp:
                break
        except socket.timeout:
            break
    print(resp.decode().strip())
except Exception:
    pass
finally:
    s.close()
" "$json" 2>/dev/null
}

cmd="${1:-}"
shift 2>/dev/null || true

case "$cmd" in
  new-window)
    # Parse: tmux new-window -n <name> [cmd...]
    # CC calls: tmux new-window -n "agent-name" bash -c "claude --agent-id ..."
    local_name=""
    local_cmd=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -n)
          shift
          local_name="$1"
          shift
          ;;
        --)
          shift
          local_cmd="$*"
          break
          ;;
        *)
          # Remaining args are the command
          local_cmd="$*"
          break
          ;;
      esac
    done

    # Send spawn request to Augment
    # Escape the command and name for JSON
    json_name=$(printf '%s' "$local_name" | sed 's/\\/\\\\/g; s/"/\\"/g')
    json_cmd=$(printf '%s' "$local_cmd" | sed 's/\\/\\\\/g; s/"/\\"/g')
    json="{\"type\":\"spawn\",\"name\":\"$json_name\",\"cmd\":\"$json_cmd\"}"
    augment_cmd "$json" >/dev/null

    exit 0
    ;;

  send-keys)
    # Parse: tmux send-keys -t <target> <keys...>
    # CC uses this to send input to agent panes
    target=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t)
          shift
          target="$1"
          shift
          ;;
        *)
          break
          ;;
      esac
    done
    keys="$*"

    json_target=$(printf '%s' "$target" | sed 's/\\/\\\\/g; s/"/\\"/g')
    json_keys=$(printf '%s' "$keys" | sed 's/\\/\\\\/g; s/"/\\"/g')
    json="{\"type\":\"send-keys\",\"target\":\"$json_target\",\"keys\":\"$json_keys\"}"
    augment_cmd "$json" >/dev/null
    exit 0
    ;;

  display-message)
    # Parse: tmux display-message -p <format>
    # CC calls: tmux display-message -p '#{pane_id}'
    #           tmux display-message -p '#{window_id}'
    fmt=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -p)
          shift
          fmt="$1"
          shift
          ;;
        -t)
          # Skip target
          shift; shift
          ;;
        *)
          shift
          ;;
      esac
    done

    case "$fmt" in
      *pane_id*|*pane_index*)
        echo "%0"
        ;;
      *window_id*|*window_index*)
        echo "@0"
        ;;
      *session_name*)
        echo "augment"
        ;;
      *pane_pid*)
        echo "$$"
        ;;
      *)
        echo ""
        ;;
    esac
    exit 0
    ;;

  select-pane)
    # tmux select-pane -T <title>
    # CC uses this to name panes. We handle naming at spawn time.
    # Extract the title and notify Augment so it can rename the session.
    title=""
    target=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -T)
          shift
          title="$1"
          shift
          ;;
        -t)
          shift
          target="$1"
          shift
          ;;
        *)
          shift
          ;;
      esac
    done

    if [ -n "$title" ]; then
      json_title=$(printf '%s' "$title" | sed 's/\\/\\\\/g; s/"/\\"/g')
      json_target=$(printf '%s' "$target" | sed 's/\\/\\\\/g; s/"/\\"/g')
      json="{\"type\":\"rename\",\"target\":\"$json_target\",\"title\":\"$json_title\"}"
      augment_cmd "$json" >/dev/null
    fi
    exit 0
    ;;

  list-panes)
    # CC calls: tmux list-panes -F '#{pane_id} #{pane_title}'
    # Return the parent pane. Agent panes are managed by Augment.
    json="{\"type\":\"list-panes\"}"
    resp=$(augment_cmd "$json")
    if [ -n "$resp" ] && [ "$resp" != "null" ]; then
      echo "$resp"
    else
      echo "%0 augment"
    fi
    exit 0
    ;;

  has-session)
    # CC checks: tmux has-session -t <name>
    # Always return success — we're "in tmux"
    exit 0
    ;;

  kill-pane|kill-window)
    # CC may try to kill panes on shutdown
    # Forward to Augment so it can clean up
    target=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t)
          shift
          target="$1"
          shift
          ;;
        *)
          shift
          ;;
      esac
    done
    json_target=$(printf '%s' "$target" | sed 's/\\/\\\\/g; s/"/\\"/g')
    json="{\"type\":\"kill\",\"target\":\"$json_target\"}"
    augment_cmd "$json" >/dev/null
    exit 0
    ;;

  *)
    # Unknown command — exit 0 to not break CC
    exit 0
    ;;
esac
