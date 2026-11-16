"""
desktop_session.py —— 从 Claude Desktop profile 解密会话凭据，供反代使用

产出 upstream.json 的 web_* 字段：
  web_cookie     完整 cookie 串（sessionKey + cf_clearance 等，UA 必须配套）
  web_ua         与 cf_clearance 绑定的浏览器 UA（Electron 45.2.1 -> Chrome 140）
  web_org        当前组织 uuid
  web_account    账号 uuid
  web_cookie_at  写入时间戳（代理按 mtime 决定是否重刷）

解密链：Local State.os_crypt.encrypted_key -> DPAPI -> AES-256-GCM key
        Cookies.encrypted_value = "v10" + nonce(12) + GCM(ct||tag)
        明文前有 32 字节固定前缀，真值 = plaintext[32:]
"""
import base64
import ctypes
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..')) if os.path.exists(os.path.join(HERE, '..', 'start.cmd')) else HERE
PROFILE = os.path.join(os.environ['LOCALAPPDATA'], 'Claude-Data', 'claude_pzs8sxrjxfjjc')
OUT = os.path.join(ROOT, 'upstream.json')

# Electron 45.2.1 对应的 Chrome 主版本；cf_clearance 与 UA 绑定，改 UA 会触发 CF 挑战
DEFAULT_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')


class _BLOB(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> _BLOB:
    b = _BLOB()
    b.cbData = len(data)
    b.pbData = ctypes.cast(ctypes.create_string_buffer(data, len(data)),
                           ctypes.POINTER(ctypes.c_char))
    return b


def _dpapi(data: bytes) -> bytes:
    out = _BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(_blob(data)), None, None, None, None, 0x1, ctypes.byref(out)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


def _master_key() -> bytes:
    st = json.load(open(os.path.join(PROFILE, 'Local State'), encoding='utf-8'))
    raw = base64.b64decode(st['os_crypt']['encrypted_key'])
    if raw[:5] == b'DPAPI':
        raw = raw[5:]
    return _dpapi(raw)


def _copy_db(src: str, dst: str) -> None:
    """复制 Cookies 库。

    桌面端（Electron）运行时该文件常被独占，shutil.copy2(CopyFile2) 会直接
    WinError 32。改用共享读打开 + 退避重试；顺带把 WAL/SHM 一并复制，
    免得丢掉还没 checkpoint 的新 cookie。
    """
    last = None
    for i in range(6):                        # 最多重试 ~7s（Desktop 长期持锁时别拖时间）
        try:
            with open(src, 'rb') as f:        # CRT open 默认共享读，能穿透独占写锁
                data = f.read()
            with open(dst, 'wb') as f:
                f.write(data)
            for suffix in ('-wal', '-shm'):   # WAL 模式下新写入在 wal 文件里
                try:
                    with open(src + suffix, 'rb') as f:
                        w = f.read()
                    with open(dst + suffix, 'wb') as f:
                        f.write(w)
                except OSError:
                    pass
            return
        except OSError as e:
            last = e
            time.sleep(0.5 + i * 0.25)        # 等 Electron 的写锁释放
    raise PermissionError(f'cannot copy cookie db: {last}')


def read_cookies() -> dict:
    """返回 {name: value}，只取 claude.ai / anthropic 相关域名。"""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = _master_key()
    gcm = AESGCM(key)
    src = os.path.join(PROFILE, 'Network', 'Cookies')
    tmp = os.path.join(tempfile.gettempdir(), 'claude_proxy_cookies.db')
    _copy_db(src, tmp)
    con = sqlite3.connect(tmp)
    out = {}
    try:
        rows = con.execute(
            "select host_key, name, encrypted_value, value from cookies "
            "where host_key like '%claude%' or host_key like '%anthropic%'").fetchall()
    finally:
        con.close()
    for _host, name, enc, plain in rows:
        if enc:
            b = bytes(enc)
            if b[:3] in (b'v10', b'v11'):
                try:
                    pt = gcm.decrypt(b[3:15], b[15:], None)
                except Exception:
                    continue
                # 明文前 32 字节为固定前缀，跳过它取可打印值
                val = pt[32:].decode('utf-8', 'replace')
                out[name] = val
        elif plain:
            out[name] = plain
    return out


def read_identity() -> dict:
    """从 config.json 取 org / account uuid。"""
    try:
        cfg = json.load(open(os.path.join(PROFILE, 'config.json'), encoding='utf-8'))
    except Exception:
        return {}
    return {
        'web_org': cfg.get('lastKnownAccountUuid') and None or None,
        'web_account': cfg.get('lastKnownAccountUuid'),
    }


ACCOUNTS_FILE = os.path.join(HERE, 'accounts.json')


def upsert_account(session_key: str, jar: str, org: str, account: str, ua: str, base: str) -> str:
    """把 Desktop 账号写进 accounts.json（以 sessionKey 为幂等键）。

    账号池由 accounts.mjs 管理，这里只做 upsert，不动别人的账号。
    """
    try:
        data = json.load(open(ACCOUNTS_FILE, encoding='utf-8'))
        if not isinstance(data, dict) or not isinstance(data.get('accounts'), list):
            data = {'version': 1, 'strategy': 'round-robin',
                    'perAccountConcurrency': 3, 'accounts': []}
    except FileNotFoundError:
        data = {'version': 1, 'strategy': 'round-robin',
                'perAccountConcurrency': 3, 'accounts': []}
    except Exception:
        data = {'version': 1, 'strategy': 'round-robin',
                'perAccountConcurrency': 3, 'accounts': []}

    accs = data['accounts']
    a = next((x for x in accs if x.get('sessionKey') == session_key), None)
    if a is None:
        a = {
            'id': 'a' + os.urandom(4).hex(),
            'label': 'desktop',
            'createdAt': int(time.time() * 1000),
        }
        accs.append(a)

    a.update({
        'label': a.get('label') or 'desktop',
        'sessionKey': session_key,
        'cookie': jar,
        'org': org,
        'base': base,
        'ua': ua,
        'enabled': a.get('enabled', True),
        'source': 'desktop',
    })

    tmp = ACCOUNTS_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, ACCOUNTS_FILE)
    return a['id']


def main() -> int:
    cookies = read_cookies()
    if 'sessionKey' not in cookies:
        print('FAIL: sessionKey cookie 不存在 —— Claude Desktop 尚未登录', file=sys.stderr)
        return 1

    session_key = cookies['sessionKey']
    jar = '; '.join(f'{k}={v}' for k, v in cookies.items() if v)

    # org uuid：从 lastActiveOrg cookie 拿（最准），退回 config.json
    org = cookies.get('lastActiveOrg', '')
    if not org:
        try:
            cfg = json.load(open(os.path.join(PROFILE, 'config.json'), encoding='utf-8'))
            org = cfg.get('lastKnownAccountUuid') or ''
        except Exception:
            org = ''

    try:
        cfg = json.load(open(os.path.join(PROFILE, 'config.json'), encoding='utf-8'))
        account = cfg.get('lastKnownAccountUuid') or ''
    except Exception:
        account = ''

    up = {}
    if os.path.exists(OUT):
        try:
            up = json.load(open(OUT, encoding='utf-8'))
        except Exception:
            up = {}

    up.update({
        'web_cookie': jar,
        'web_session_key': session_key,
        'web_ua': DEFAULT_UA,
        'web_org': org,
        'web_account': account,
        'web_account_label': 'desktop',
        'web_cookie_at': int(time.time() * 1000),
        'web_base': 'https://claude.ai',
        'plan': 'free',
        'source': 'claude-desktop profile (os_crypt v10 + DPAPI)',
    })
    # 模型清单来自实测：free 档可用 Sonnet 5.5 / Haiku 5.5
    if not up.get('models'):
        up['models'] = ['claude-sonnet-5-5', 'claude-haiku-5-5']

    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(up, f, indent=2, ensure_ascii=False)
    os.replace(tmp, OUT)

    # 同步进多账号池（幂等，以 sessionKey 为键）
    try:
        acct_id = upsert_account(session_key, jar, org, account, DEFAULT_UA, 'https://claude.ai')
    except Exception as e:
        acct_id = None
        print(f'WARN: upsert accounts.json failed: {e}', file=sys.stderr)

    print(f'OK org={org} account={account} cookies={len(cookies)} '
          f'pool_id={acct_id} -> {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
