#!/bin/bash
# ========================================================
# Claude Free Proxy - Linux 启动与管理脚本
# ========================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PID_FILE="$DIR/proxy.pid"
LOG_FILE="$DIR/proxy.out.log"
ERR_FILE="$DIR/proxy.err.log"

check_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            return 0
        fi
        rm -f "$PID_FILE"
    fi
    # 辅助检查 8787 端口
    P=$(lsof -ti:8787 2>/dev/null || ss -tulpn 2>/dev/null | grep ':8787' | awk '{print $NF}' | sed -E 's/.*pid=([0-9]+).*/\1/')
    if [ -n "$P" ]; then
        echo "$P" > "$PID_FILE"
        return 0
    fi
    return 1
}

case "$1" in
    start|daemon)
        if check_running; then
            echo "[INFO] 服务已经在运行中 (PID: $(cat "$PID_FILE"))"
            exit 0
        fi
        echo "[INFO] 正在后台启动反代服务..."
        nohup node src/openai-proxy.mjs > "$LOG_FILE" 2> "$ERR_FILE" &
        PID=$!
        echo $PID > "$PID_FILE"
        sleep 1
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "[SUCCESS] 服务已在后台成功启动 (PID: $PID)"
            echo "          访问地址: http://127.0.0.1:8787"
            echo "          查看日志: ./start.sh log"
        else
            echo "[ERROR] 服务启动失败，请查看日志: cat $ERR_FILE"
            exit 1
        fi
        ;;

    lan)
        echo "[INFO] 正在以局域网/全局监听模式启动 (0.0.0.0)..."
        HOST=0.0.0.0 node src/openai-proxy.mjs
        ;;

    stop)
        if check_running; then
            PID=$(cat "$PID_FILE")
            echo "[INFO] 正在停止服务 (PID: $PID)..."
            kill "$PID" 2>/dev/null
            sleep 1
            if ps -p "$PID" > /dev/null 2>&1; then
                kill -9 "$PID" 2>/dev/null
            fi
            rm -f "$PID_FILE"
            echo "[SUCCESS] 服务已停止。"
        else
            echo "[INFO] 服务当前未运行。"
        fi
        ;;

    restart)
        "$0" stop
        sleep 1
        "$0" start
        ;;

    status)
        if check_running; then
            echo "[STATUS] 服务运行中"
            echo "         PID: $(cat "$PID_FILE")"
            echo "         端口: 8787"
            echo "         地址: http://127.0.0.1:8787"
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
        echo "  (无参数)      前台交互运行 (Ctrl+C 停止)"
        echo "  daemon|start  后台常驻运行"
        echo "  stop          停止后台服务"
        echo "  restart       重启后台服务"
        echo "  status        查看运行状态与 PID"
        echo "  lan           全局监听模式 (0.0.0.0)，允许局域网外部访问"
        echo "  log           实时查看运行日志"
        ;;

    *)
        # 默认前台运行
        node src/openai-proxy.mjs
        ;;
esac
