#!/usr/bin/env bash
# Only stop daemons started by this launcher. Never kill by port (another local service may own it).
set -eu
umask 077
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
export DESKTOP_SYNC=0
mode="${1:-}"
case "$mode" in
  ''|lan|pack) exec node start.mjs "$@" ;;
  help|--help|-h) echo '用法: ./start.sh [lan|start|daemon|status|stop|restart|log|pack]'; exit 0 ;;
  start|daemon|status|stop|restart|log|logs) ;;
  *) echo '未知命令，参见 ./start.sh help' >&2; exit 2 ;;
esac
state="${DATA_DIR:-$DIR}"
pidfile="$state/proxy.pid"
log="$state/proxy.out.log"
if [[ "$mode" == log || "$mode" == logs ]]; then exec tail -n 30 -f "$log"; fi
if [[ -z "${PORT:-}" ]]; then
  PORT=$(node --input-type=module -e 'import fs from "node:fs"; import {dataFile} from "./src/paths.mjs";const p=dataFile("config.json",process.env.CONFIG_FILE);try{console.log(fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")).server?.port||8787:8787)}catch{console.error("无效的配置文件");process.exit(1)}')
fi
export PORT
if [[ "$mode" == status ]]; then exec node src/doctor.mjs "$PORT"; fi
stop_managed() {
  if [[ ! -f "$pidfile" ]]; then echo '没有本启动器的后台 PID；不会停止端口上的其他进程。' >&2; return 1; fi
  local pid args
  pid=$(cat "$pidfile")
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || { echo '无效的 PID 文件' >&2; return 1; }
  if ! kill -0 "$pid" 2>/dev/null; then rm -f -- "$pidfile"; return 0; fi
  args=$(ps -ww -p "$pid" -o args=) || return 1
  if [[ "$args" != "node $DIR/src/openai-proxy.mjs" ]]; then echo 'PID 不属于本启动器，拒绝停止；请检查原启动窗口。' >&2; return 1; fi
  kill -TERM "$pid"
  for ((i=0;i<50;i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then rm -f -- "$pidfile"; return 0; fi
    sleep 0.1
  done
  echo '进程尚未退出，请手动确认；不会强制杀进程。' >&2; return 1
}
if [[ "$mode" == stop ]]; then stop_managed; exit; fi
if [[ "$mode" == restart && -f "$pidfile" ]]; then stop_managed; fi
if node src/doctor.mjs "$PORT" >/dev/null 2>&1; then
  echo "端口 $PORT 已有就绪网关；未更改现有进程。"; exit 0
fi
mkdir -p -- "$state"
nohup node "$DIR/src/openai-proxy.mjs" >>"$log" 2>>"$state/proxy.err.log" &
pid=$!
for ((i=0;i<40;i++)); do
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  if node src/doctor.mjs "$PORT" >/dev/null 2>&1 && kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "$pid" >"$pidfile"; echo "网关就绪：127.0.0.1:$PORT (PID $pid)"; exit 0
  fi
  sleep 0.1
done
echo "启动未确认就绪，请检查 $state/proxy.err.log；未终止任何进程。" >&2; exit 1
