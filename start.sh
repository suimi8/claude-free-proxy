#!/bin/bash
# ========================================================
# Claude Free Proxy - Linux 启动与管理脚本
# ========================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Linux 环境跳过 Windows 桌面端 sessionKey 同步
export DESKTOP_SYNC=0

PID_FILE="$DIR/proxy.pid"
LOG_FILE="$DIR/proxy.out.log"
ERR_FILE="$DIR/proxy.err.log"

# 解析配置端口 (默认 8787)
PORT=${PORT:-8787}
if [ -f "$DIR/config.json" ]; then
    CFG_PORT=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$DIR/config.json','utf8'));console.log(c.server?.port||'')}catch{}" 2>/dev/null)
    if [ -n "$CFG_PORT" ]; then
        PORT="$CFG_PORT"
    fi
fi

# 获取监听端口的 PID
get_listen_pid() {
    local target_port="${1:-$PORT}"
    local p=""

    # 1. fuser
    if command -v fuser >/dev/null 2>&1; then
        p=$(fuser "${target_port}/tcp" 2>/dev/null | tr -d ' ' | tr -d '\n' | sed 's/[^0-9]//g')
        if [ -n "$p" ] && ps -p "$p" >/dev/null 2>&1; then
            echo "$p"
            return 0
        fi
    fi

    # 2. ss
    if command -v ss >/dev/null 2>&1; then
        p=$(ss -tulpn 2>/dev/null | grep ":${target_port} " | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2)
        if [ -n "$p" ] && ps -p "$p" >/dev/null 2>&1; then
            echo "$p"
            return 0
        fi
    fi

    # 3. lsof
    if command -v lsof >/dev/null 2>&1; then
        p=$(lsof -ti:"${target_port}" 2>/dev/null | head -n 1)
        if [ -n "$p" ] && ps -p "$p" >/dev/null 2>&1; then
            echo "$p"
            return 0
        fi
    fi

    # 4. PID 文件
    if [ -f "$PID_FILE" ]; then
        local pid_f
        pid_f=$(cat "$PID_FILE" 2>/dev/null | tr -d ' \r\n')
        if [ -n "$pid_f" ] && ps -p "$pid_f" >/dev/null 2>&1; then
            echo "$pid_f"
            return 0
        fi
    fi

    return 1
}

CURRENT_PID=""
check_running() {
    local p
    p=$(get_listen_pid "$PORT")
    if [ -n "$p" ]; then
        echo "$p" > "$PID_FILE"
        CURRENT_PID="$p"
        return 0
    fi
    rm -f "$PID_FILE" 2>/dev/null
    return 1
}

stop_service() {
    local target_port="${PORT:-8787}"
    local p
    p=$(get_listen_pid "$target_port")

    if [ -n "$p" ]; then
        echo "[INFO] 正在终止已有服务进程 (PID: $p)..."
        kill "$p" 2>/dev/null
        for i in 1 2 3 4 5 6 7 8 9 10; do
            if ! ps -p "$p" >/dev/null 2>&1; then
                break
            fi
            sleep 0.2
        done
        if ps -p "$p" >/dev/null 2>&1; then
            echo "[WARN] 进程未退出，强制终止 (kill -9 $p)..."
            kill -9 "$p" 2>/dev/null
            sleep 0.3
        fi
    fi

    # 双重保险：检查端口是否仍被占用
    if command -v fuser >/dev/null 2>&1; then
        if fuser "${target_port}/tcp" >/dev/null 2>&1; then
            echo "[WARN] 端口 $target_port 仍被占用，正在强行释放..."
            fuser -k -9 "${target_port}/tcp" 2>/dev/null
            sleep 0.3
        fi
    fi

    rm -f "$PID_FILE"
    echo "[SUCCESS] 已有服务已关闭，端口 $target_port 已释放。"
}

start_daemon() {
    echo "[INFO] 正在后台启动反代服务..."
    nohup node src/openai-proxy.mjs > "$LOG_FILE" 2> "$ERR_FILE" &
    local new_pid=$!
    echo $new_pid > "$PID_FILE"
    sleep 1
    if ps -p "$new_pid" > /dev/null 2>&1; then
        echo "[SUCCESS] 服务已在后台成功启动 (PID: $new_pid)"
        echo "          访问地址: http://127.0.0.1:$PORT"
        echo "          查看日志: ./start.sh log"
    else
        echo "[ERROR] 服务启动失败，请查看日志: cat $ERR_FILE"
        exit 1
    fi
}

handle_already_running() {
    local next_action="$1" # 'foreground' / 'daemon' / 'lan'
    local p="$CURRENT_PID"

    echo ""
    echo "============================================================"
    echo "  Claude Free Proxy 服务已经在运行中！"
    echo "  PID: $p"
    echo "  端口: $PORT"
    echo "  访问地址: http://127.0.0.1:$PORT"
    echo "============================================================"
    echo ""

    echo "  请选择操作："
    echo "    [1] 使用已启动的服务 (保持现有服务运行并退出)"
    echo "    [2] 关闭已启动服务并重启服务"
    echo "    [3] 仅关闭已启动服务并退出"
    echo "    [4] 取消退出"
    echo ""

    local choice=""
    if [ -t 0 ]; then
        read -r -p "  请输入选项 [1-4] (默认 1): " choice
    else
        # 非终端交互环境（如管道输入），尝试读取一行；若无输入则提示并安全退出
        if read -r -t 1 choice 2>/dev/null; then
            echo "  已接收选项: $choice"
        else
            echo "[INFO] 当前处于非交互环境或未检测到输入，保持现有服务运行 (端口: $PORT)。"
            exit 0
        fi
    fi
    choice="${choice:-1}"

    case "$choice" in
        1)
            echo ""
            echo "[SUCCESS] 已选择继续使用当前运行中的服务："
            echo "          访问地址: http://127.0.0.1:$PORT"
            echo "          查看日志: ./start.sh log"
            exit 0
            ;;
        2)
            echo ""
            stop_service
            echo ""
            if [ "$next_action" = "daemon" ]; then
                start_daemon
            elif [ "$next_action" = "lan" ]; then
                echo "[INFO] 正在以局域网/全局模式启动 (0.0.0.0:$PORT)..."
                HOST=0.0.0.0 exec node src/openai-proxy.mjs
            else
                echo "[INFO] 正在重新启动服务 (前台模式，Ctrl+C 可停止)..."
                exec node src/openai-proxy.mjs
            fi
            ;;
        3)
            echo ""
            stop_service
            exit 0
            ;;
        *)
            echo ""
            echo "[INFO] 操作已取消，现有服务继续运行。"
            exit 0
            ;;
    esac
}

case "$1" in
    start|daemon)
        if check_running; then
            handle_already_running "daemon"
        else
            start_daemon
        fi
        ;;

    lan)
        if check_running; then
            handle_already_running "lan"
        else
            echo "[INFO] 正在以局域网/全局监听模式启动 (0.0.0.0:$PORT)..."
            HOST=0.0.0.0 exec node src/openai-proxy.mjs
        fi
        ;;

    stop)
        if check_running; then
            stop_service
        else
            echo "[INFO] 服务当前未运行。"
        fi
        ;;

    restart)
        if check_running; then
            stop_service
            sleep 1
        fi
        start_daemon
        ;;

    status)
        if check_running; then
            echo "[STATUS] 服务运行中"
            echo "         PID: $CURRENT_PID"
            echo "         端口: $PORT"
            echo "         地址: http://127.0.0.1:$PORT"
        else
            echo "[STATUS] 服务未运行。"
        fi
        ;;

    log|logs)
        tail -n 30 -f "$LOG_FILE"
        ;;

    help|--help|-h)
        echo "用法: ./start.sh [命令]"
        echo ""
        echo "命令列表:"
        echo "  (无参数)      前台交互运行 (若已在运行则弹出管理选项)"
        echo "  daemon|start  后台常驻运行"
        echo "  stop          停止服务"
        echo "  restart       重启后台服务"
        echo "  status        查看运行状态与 PID"
        echo "  lan           全局监听模式 (0.0.0.0)，允许局域网外部访问"
        echo "  log           实时查看运行日志"
        ;;

    *)
        # 默认前台运行
        if check_running; then
            handle_already_running "foreground"
        else
            echo "[INFO] 正在启动反代服务 (端口: $PORT)..."
            exec node src/openai-proxy.mjs
        fi
        ;;
esac
