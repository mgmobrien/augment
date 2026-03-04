#!/usr/bin/env bash
# Augment tmux shim — intercepts Claude Code's tmux commands and redirects
# agent spawns to Augment sessions via a Unix domain socket.
#
# CC thinks it's in tmux. Instead of creating real tmux panes, this shim
# sends spawn requests to the Augment Electron app, which creates new
# terminal sessions for each agent.
#
# CC's actual tmux protocol:
#   tmux -V                                           → version check
#   tmux -L claude-swarm-{PID} new-session -d -s ...  → create session
#   tmux -L claude-swarm-{PID} split-window -t ...    → spawn teammate pane
#   tmux -L claude-swarm-{PID} send-keys -t ...       → write to pane
#   tmux -L claude-swarm-{PID} display-message -p ... → query pane info
#   tmux -L claude-swarm-{PID} select-pane -T ...     → rename pane
#   tmux -L claude-swarm-{PID} list-panes -F ...      → list panes
#   tmux -L claude-swarm-{PID} has-session -t ...     → check session
#   tmux -L claude-swarm-{PID} kill-pane -t ...       → kill pane

SOCKET="${AUGMENT_SOCKET:-$HOME/.augment/augment.sock}"

# Pane ID counter — each spawned pane gets an incrementing ID.
# Use a file to persist across shim invocations within a session.
PANE_COUNTER_FILE="/tmp/augment-shim-pane-counter-$$"

next_pane_id() {
  local counter=1
  if [ -f "$PANE_COUNTER_FILE" ]; then
    counter=$(cat "$PANE_COUNTER_FILE")
    counter=$((counter + 1))
  fi
  echo "$counter" > "$PANE_COUNTER_FILE"
  echo "$counter"
}

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

# ---- FIX 1: Handle -V flag (version check) ----
# CC runs `tmux -V` on startup to verify tmux is available.
# Must be checked before anything else since it has no subcommand.
if [ "${1:-}" = "-V" ]; then
  echo "tmux 3.4"
  exit 0
fi

# ---- FIX 2: Parse -L flag before subcommand ----
# CC sends ALL commands as: tmux -L claude-swarm-{PID} <subcommand> [args...]
# Strip -L and its argument so the subcommand lands in $cmd.
while [ $# -gt 0 ]; do
  case "$1" in
    -L)
      # Skip -L and its socket name argument
      shift  # skip -L
      shift  # skip socket name (e.g., "claude-swarm-12345")
      ;;
    -f)
      # Skip -f (config file) and its argument
      shift; shift
      ;;
    -S)
      # Skip -S (socket path) and its argument
      shift; shift
      ;;
    -*)
      # Skip any other top-level flags we don't know about
      shift
      ;;
    *)
      # First non-flag argument is the subcommand
      break
      ;;
  esac
done

cmd="${1:-}"
shift 2>/dev/null || true

case "$cmd" in
  # ---- FIX 3: new-session handler ----
  # CC creates the initial tmux session:
  #   tmux -L claude-swarm-{PID} new-session -d -s <session-name> -x <cols> -y <rows>
  # We acknowledge it — the "session" is the Augment app itself.
  new-session)
    # Parse flags but don't need to do anything — the session is Augment
    session_name=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -d) shift ;;              # detached — ignore
        -s) shift; session_name="$1"; shift ;;  # session name
        -x) shift; shift ;;       # width — ignore
        -y) shift; shift ;;       # height — ignore
        -P) shift ;;              # print info
        -F) shift; shift ;;       # format string
        *) shift ;;
      esac
    done
    # CC may use -P -F to get the pane ID of the new session
    # Return the initial pane ID
    echo "%0"
    exit 0
    ;;

  new-window)
    # Parse: tmux new-window -n <name> [cmd...]
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

    json_name=$(printf '%s' "$local_name" | sed 's/\\/\\\\/g; s/"/\\"/g')
    json_cmd=$(printf '%s' "$local_cmd" | sed 's/\\/\\\\/g; s/"/\\"/g')
    json="{\"type\":\"spawn\",\"name\":\"$json_name\",\"cmd\":\"$json_cmd\",\"method\":\"new-window\"}"
    resp=$(augment_cmd "$json")

    # ---- FIX 5 (partial): Return pane ID from server response ----
    # Extract pane ID from response if available
    pane_id=$(echo "$resp" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('pane','%1'))" 2>/dev/null || echo "%1")
    echo "$pane_id"
    exit 0
    ;;

  # ---- FIX 4: split-window handler ----
  # CC uses split-window for inline teammate panes:
  #   tmux -L claude-swarm-{PID} split-window -t %0 -v -l 50% -P -F '#{pane_id}' bash -c "claude ..."
  # The -P -F flags mean CC expects the new pane ID on stdout.
  split-window)
    local_target=""
    local_name=""
    local_cmd=""
    print_pane_id=false
    pane_format=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t)
          shift
          local_target="$1"
          shift
          ;;
        -v|-h)
          # Vertical/horizontal split — ignore (we create a new session)
          shift
          ;;
        -l)
          # Size — ignore
          shift; shift
          ;;
        -d)
          # Don't switch focus — ignore
          shift
          ;;
        -P)
          # Print pane info after creation
          print_pane_id=true
          shift
          ;;
        -F)
          # Format string for -P output
          shift
          pane_format="$1"
          shift
          ;;
        -n)
          shift
          local_name="$1"
          shift
          ;;
        bash|claude|sh|zsh)
          # Start of command — consume rest as command
          local_cmd="$*"
          break
          ;;
        *)
          # Could be start of command
          local_cmd="$*"
          break
          ;;
      esac
    done

    # Send spawn request to Augment
    json_name=$(printf '%s' "$local_name" | sed 's/\\/\\\\/g; s/"/\\"/g')
    json_cmd=$(printf '%s' "$local_cmd" | sed 's/\\/\\\\/g; s/"/\\"/g')
    json_target=$(printf '%s' "$local_target" | sed 's/\\/\\\\/g; s/"/\\"/g')
    json="{\"type\":\"spawn\",\"name\":\"$json_name\",\"cmd\":\"$json_cmd\",\"method\":\"split-window\",\"target\":\"$json_target\"}"
    resp=$(augment_cmd "$json")

    # ---- FIX 5: Return pane ID in correct format ----
    # CC expects the pane ID on stdout when -P is used.
    # Extract from server response, fall back to incrementing counter.
    if [ "$print_pane_id" = true ]; then
      pane_id=$(echo "$resp" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('pane','%1'))" 2>/dev/null)
      if [ -z "$pane_id" ]; then
        id=$(next_pane_id)
        pane_id="%${id}"
      fi
      echo "$pane_id"
    fi
    exit 0
    ;;

  send-keys)
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
    fmt=""
    target=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -p)
          shift
          fmt="$1"
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

    # ---- FIX 5: Return proper pane IDs ----
    # Query the server for the actual pane ID if we have a target,
    # otherwise return defaults.
    case "$fmt" in
      *pane_id*)
        if [ -n "$target" ]; then
          echo "$target"
        else
          echo "%0"
        fi
        ;;
      *pane_index*)
        echo "0"
        ;;
      *window_id*)
        echo "@0"
        ;;
      *window_index*)
        echo "0"
        ;;
      *session_name*)
        echo "augment"
        ;;
      *pane_pid*)
        echo "$$"
        ;;
      *pane_width*)
        echo "200"
        ;;
      *pane_height*)
        echo "50"
        ;;
      *)
        echo ""
        ;;
    esac
    exit 0
    ;;

  select-pane)
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
    # Parse -F format flag and -t target
    fmt=""
    target=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -F) shift; fmt="$1"; shift ;;
        -t) shift; target="$1"; shift ;;
        -a) shift ;;
        *) shift ;;
      esac
    done

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
    # Always return success — we're "in tmux"
    exit 0
    ;;

  kill-pane|kill-window|kill-session)
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

  # Additional commands CC may use
  set-option|set-window-option|setw)
    # CC may set tmux options — acknowledge silently
    exit 0
    ;;

  resize-pane)
    # CC may resize panes — ignore since we handle sizing ourselves
    exit 0
    ;;

  "")
    # No subcommand (shouldn't happen after flag stripping, but be safe)
    exit 0
    ;;

  *)
    # Unknown command — exit 0 to not break CC
    exit 0
    ;;
esac
