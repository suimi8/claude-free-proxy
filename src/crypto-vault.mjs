/**
 * crypto-vault.mjs —— 敏感凭据透明字段级安全保险库
 *
 * 职责：
 *   - 提供基于 AES-256-GCM 的敏感字段（sessionKey、cookie 等）透明加解密
 *   - 密文格式：enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 *   - 100% 向后兼容：明文字符串无感知直读；未配置加密时平滑透传
 *   - 密钥策略：优先使用 DATA_ENCRYPTION_KEY / CREDENTIAL_SECRET 环境变量；
 *               若显式开启 ENCRYPT_CREDENTIALS=1 则自动生成并持久化本地受保护密钥
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from './paths.mjs';

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_LENGTH = 12; // 96-bit IV 推荐用于 GCM

let cachedKey = undefined;

/**
 * 获取或派生 32 字节 AES 密钥
 * @returns {Buffer|null}
 */
export function getVaultKey() {
  if (cachedKey !== undefined) return cachedKey;

  const envKey = process.env.DATA_ENCRYPTION_KEY || process.env.CREDENTIAL_SECRET;
  if (envKey && typeof envKey === 'string' && envKey.trim()) {
    cachedKey = crypto.createHash('sha256').update(envKey.trim()).digest();
    return cachedKey;
  }

  const shouldAutoEncrypt = process.env.ENCRYPT_CREDENTIALS === '1' ||
    process.env.ENCRYPT_CREDENTIALS === 'true';

  if (shouldAutoEncrypt) {
    const keyFile = path.join(DATA, '.credential_secret');
    try {
      if (fs.existsSync(keyFile)) {
        const raw = fs.readFileSync(keyFile, 'utf8').trim();
        if (raw) {
          cachedKey = crypto.createHash('sha256').update(raw).digest();
          return cachedKey;
        }
      }
      // 自动生成高熵密钥并锁定 0o600 权限
      const secret = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
      fs.writeFileSync(keyFile, secret, { mode: 0o600, encoding: 'utf8' });
      cachedKey = crypto.createHash('sha256').update(secret).digest();
      return cachedKey;
    } catch (err) {
      console.warn('[crypto-vault] 自动生成本地凭据密钥失败:', err?.message || err);
    }
  }

  cachedKey = null;
  return null;
}

/**
 * 强制重置/重载密钥缓存（用于测试或动态切换密钥）
 */
export function resetVaultKey() {
  cachedKey = undefined;
}

/**
 * 是否已激活凭据加密
 * @returns {boolean}
 */
export function isVaultActive() {
  return getVaultKey() !== null;
}

/**
 * 加密敏感字段
 * @param {string} plaintext
 * @param {Buffer} [customKey]
 * @returns {string}
 */
export function encryptField(plaintext, customKey = null) {
  if (typeof plaintext !== 'string' || !plaintext) return plaintext;
  if (plaintext.startsWith(PREFIX)) return plaintext; // 已加密则跳过

  const key = customKey || getVaultKey();
  if (!key) return plaintext; // 未配置密钥时保持明文透传

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');
    const tag = cipher.getAuthTag();

    return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext}`;
  } catch (err) {
    console.error('[crypto-vault] 字段加密失败，降级保持原样:', err?.message || err);
    return plaintext;
  }
}

/**
 * 解密敏感字段
 * @param {string} ciphertext
 * @param {Buffer} [customKey]
 * @returns {string}
 */
export function decryptField(ciphertext, customKey = null) {
  if (typeof ciphertext !== 'string' || !ciphertext) return ciphertext;
  if (!ciphertext.startsWith(PREFIX)) return ciphertext; // 明文字符串直接兼容返回

  const key = customKey || getVaultKey();
  if (!key) {
    console.warn('[crypto-vault] 侦测到加密凭据但未配置解密密钥，无法还原明文');
    return ciphertext;
  }

  try {
    const parts = ciphertext.slice(PREFIX.length).split(':');
    if (parts.length !== 3) {
      console.warn('[crypto-vault] 密文格式无效');
      return ciphertext;
    }
    const [ivHex, tagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let plaintext = decipher.update(dataHex, 'hex', 'utf8');
    plaintext += decipher.final('utf8');
    return plaintext;
  } catch (err) {
    console.error('[crypto-vault] 凭据解密失败（可能密钥错误或密文损坏）:', err?.message || err);
    return ciphertext;
  }
}
