"""
desktop_login.py —— 将指定 sessionKey 写入官方 Claude Desktop 并自动拉起
"""
import os
import sys
import json
import time
import base64
import ctypes
import hashlib
import sqlite3
import subprocess
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))

if sys.platform != 'win32' or 'LOCALAPPDATA' not in os.environ:
    print(json.dumps({'ok': False, 'error': '仅支持 Windows 平台'}))
    sys.exit(1)

PROFILE_BASE = os.path.join(os.environ['LOCALAPPDATA'], 'Claude-Data')
PROFILE = None
if os.path.exists(PROFILE_BASE):
    for entry in os.listdir(PROFILE_BASE):
        cand = os.path.join(PROFILE_BASE, entry)
        if os.path.isdir(cand) and entry.startswith('claude_'):
            if os.path.exists(os.path.join(cand, 'Local State')):
                PROFILE = cand
                break

if not PROFILE:
    print(json.dumps({'ok': False, 'error': f'未找到 Claude Desktop 配置目录 (路径: {PROFILE_BASE})，请确认已安装 Claude 官方桌面端'}))
    sys.exit(1)


class _BLOB(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> _BLOB:
    b = _BLOB()
    b.cbData = len(data)
    b.pbData = ctypes.cast(ctypes.create_string_buffer(data, len(data)), ctypes.POINTER(ctypes.c_char))
    return b


def _dpapi(data: bytes) -> bytes:
    out = _BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(_blob(data)), None, None, None, None, 0x1, ctypes.byref(out)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


def _master_key() -> bytes:
    st_path = os.path.join(PROFILE, 'Local State')
    st = json.load(open(st_path, encoding='utf-8'))
    raw = base64.b64decode(st['os_crypt']['encrypted_key'])
    if raw[:5] == b'DPAPI':
        raw = raw[5:]
    return _dpapi(raw)


def encrypt_cookie(key: bytes, host: str, value: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    gcm = AESGCM(key)
    prefix = hashlib.sha256(host.encode('utf-8')).digest()
    pt = prefix + value.encode('utf-8')
    nonce = os.urandom(12)
    ct = gcm.encrypt(nonce, pt, None)
    return b'v10' + nonce + ct


def kill_claude_desktop():
    """杀掉正在运行的 Claude Desktop 进程以释放 SQLite 锁"""
    for im in ['claude.exe', 'Claude.exe', 'claude-desktop.exe']:
        try:
            subprocess.run(['taskkill', '/F', '/IM', im], capture_output=True)
        except Exception:
            pass
    time.sleep(0.6)


def activate_claude_window():
    """将已启动的 Claude 桌面端窗口带到最前台激活显示"""
    if sys.platform != 'win32':
        return
    ps_cmd = (
        "$p = Get-Process claude, claude-desktop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; "
        "if ($p) { "
        "$w = $p.MainWindowHandle; "
        "$sig = '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'; "
        "$type = Add-Type -MemberDefinition $sig -Name Win32 -Namespace Native -PassThru; "
        "[Native.Win32]::ShowWindowAsync($w, 9); "
        "[Native.Win32]::SetForegroundWindow($w); "
        "}"
    )
    try:
        subprocess.Popen(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps_cmd],
                         creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
    except Exception:
        pass


def launch_claude_desktop():
    """在 Windows 交互桌面安全拉起 Claude Desktop"""
    if sys.platform != 'win32':
        return False, 'unsupported platform'
    # 1. 优先通过 Windows AppsFolder 协议拉起（对 MSIX 商店安装版 100% 稳定）
    launched = False
    target = ''
    try:
        subprocess.Popen(['cmd.exe', '/c', 'start', '', 'shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude'], shell=False)
        launched = True
        target = 'shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude'
    except Exception:
        pass

    if not launched:
        # 2. 尝试 os.startfile 直接由系统 Explorer 唤起
        exe = find_desktop_exe()
        try:
            os.startfile(exe)
            launched = True
            target = exe
        except Exception:
            pass

    if not launched:
        # 3. 尝试 cmd /c start
        try:
            subprocess.Popen(['cmd.exe', '/c', 'start', '', exe], shell=False)
            launched = True
            target = exe
        except Exception as e:
            return False, str(e)

    # 稍后激活窗口到前台
    try:
        time.sleep(1.2)
        activate_claude_window()
    except Exception:
        pass

    return True, target


def find_desktop_exe():
    candidates = [
        os.path.join(os.environ['LOCALAPPDATA'], 'Microsoft', 'WindowsApps', 'Claude_pzs8sxrjxfjjc', 'claude-desktop.exe'),
        os.path.join(os.environ['LOCALAPPDATA'], 'Microsoft', 'WindowsApps', 'claude-desktop.exe'),
    ]
    # 动态扫描 WindowsApps 目录下的 claude-desktop.exe
    winapps = os.path.join(os.environ['LOCALAPPDATA'], 'Microsoft', 'WindowsApps')
    if os.path.exists(winapps):
        try:
            for item in os.listdir(winapps):
                if 'claude' in item.lower():
                    sub = os.path.join(winapps, item)
                    if os.path.isdir(sub):
                        cand = os.path.join(sub, 'claude-desktop.exe')
                        if os.path.exists(cand):
                            candidates.append(cand)
        except Exception:
            pass
    for c in candidates:
        if os.path.exists(c):
            return c
    return 'claude-desktop.exe'


def inject_session(session_key: str, org: str = '', launch: bool = True):
    if not session_key or not session_key.startswith('sk-ant-'):
        return {'ok': False, 'error': '无效的 sessionKey'}

    key = _master_key()
    kill_claude_desktop()

    db_path = os.path.join(PROFILE, 'Network', 'Cookies')
    if not os.path.exists(db_path):
        return {'ok': False, 'error': f'未找到 Cookies 数据库: {db_path}'}

    host = '.claude.ai'
    enc_session = encrypt_cookie(key, host, session_key)

    now_ts = time.time()
    creation_utc = int((now_ts + 11644473600) * 1000000)
    expires_utc = creation_utc + int(365 * 86400 * 1000000)

    con = sqlite3.connect(db_path, timeout=10.0)
    try:
        cur = con.cursor()
        # 1. 删除旧的 sessionKey
        cur.execute("DELETE FROM cookies WHERE host_key = ? AND name = 'sessionKey'", (host,))
        # 2. 插入新的 sessionKey
        cur.execute("""
            INSERT INTO cookies (
                creation_utc, host_key, top_frame_site_key, name, value, encrypted_value,
                path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires,
                is_persistent, priority, samesite, source_scheme, source_port, last_update_utc,
                source_type, has_cross_site_ancestor
            ) VALUES (
                ?, ?, '', 'sessionKey', '', ?,
                '/', ?, 1, 1, ?, 1,
                1, 1, -1, 2, 443, ?,
                2, 0
            )
        """, (creation_utc, host, enc_session, expires_utc, creation_utc, creation_utc))

        # 3. 如果提供了 org，更新 lastActiveOrg cookie
        if org:
            enc_org = encrypt_cookie(key, host, org)
            cur.execute("DELETE FROM cookies WHERE host_key = ? AND name = 'lastActiveOrg'", (host,))
            cur.execute("""
                INSERT INTO cookies (
                    creation_utc, host_key, top_frame_site_key, name, value, encrypted_value,
                    path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires,
                    is_persistent, priority, samesite, source_scheme, source_port, last_update_utc,
                    source_type, has_cross_site_ancestor
                ) VALUES (
                    ?, ?, '', 'lastActiveOrg', '', ?,
                    '/', ?, 1, 0, ?, 1,
                    1, 1, -1, 2, 443, ?,
                    2, 0
                )
            """, (creation_utc, host, enc_org, expires_utc, creation_utc, creation_utc))

        con.commit()
    finally:
        con.close()

    # 4. 更新 config.json 中的 lastKnownAccountUuid
    if org:
        cfg_path = os.path.join(PROFILE, 'config.json')
        try:
            cfg = {}
            if os.path.exists(cfg_path):
                cfg = json.load(open(cfg_path, encoding='utf-8'))
            cfg['lastKnownAccountUuid'] = org
            with open(cfg_path, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"WARN update config.json: {e}", file=sys.stderr)

    launched = False
    launch_target = ''
    if launch:
        ok_launch, launch_target = launch_claude_desktop()
        if not ok_launch:
            return {'ok': True, 'launched': False, 'message': f'登录凭据已成功写入，但自动拉起桌面端失败 ({launch_target})，请手动打开 Claude 桌面端'}
        launched = True

    return {'ok': True, 'launched': launched, 'exe': launch_target, 'message': '已成功将 sessionKey 写入 Claude 官方桌面端并启动！'}


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python desktop_login.py <sessionKey> [org] [--no-launch]")
        sys.exit(1)
    sk = sys.argv[1]
    org_arg = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else ''
    do_launch = '--no-launch' not in sys.argv
    res = inject_session(sk, org_arg, launch=do_launch)
    print(json.dumps(res, ensure_ascii=False, indent=2))
