// @ts-check
/**
 * 肥猫猫临时邮箱服务（zjkdongao.cn）客户端
 * 提供邮箱列表获取、邮件自动轮询与 Claude 魔法链接/验证码提取能力。
 */

export class MaoMailClient {
  /**
   * @param {{ token: string, baseUrl?: string }} opts
   */
  constructor(opts) {
    let t = opts.token || '';
    if (t && !t.startsWith('Bearer ')) t = `Bearer ${t}`;
    this.token = t;
    this.baseUrl = (opts.baseUrl || 'https://zjkdongao.cn').replace(/\/+$/, '');
  }

  headers() {
    return {
      'Authorization': this.token,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0',
      'Referer': `${this.baseUrl}/`,
      'X-Client-Type': 'web',
      'Accept': 'application/json, text/plain, */*',
    };
  }

  /**
   * 获取用户的系统邮箱列表
   * @param {number} [pageSize=100]
   * @returns {Promise<Array<{ id: number, email: string, createdAt: number }>>}
   */
  async listMailboxes(pageSize = 100) {
    if (!this.token) throw new Error('未配置肥猫猫 Token (maomailToken)');
    const url = `${this.baseUrl}/mail-api/v1/mailboxes/?page=1&page_size=${pageSize}`;
    const r = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.code !== 0) throw new Error(`肥猫猫接口返回错误 (${j.code}): ${j.message}`);
    const list = j.data?.mailboxes || [];
    return list.map(m => ({
      id: m.id,
      email: m.email || m.email_address,
      createdAt: m.created_at,
    }));
  }

  /**
   * 根据邮箱地址查找 mailbox_id
   * @param {string} email
   * @returns {Promise<{ id: number, email: string } | null>}
   */
  async findMailboxByEmail(email) {
    const list = await this.listMailboxes(100);
    const target = email.trim().toLowerCase();
    const found = list.find(m => m.email.toLowerCase() === target);
    return found || null;
  }

  /**
   * 读取指定邮箱的最新邮件列表
   * @param {number} mailboxId
   * @param {number} [pageSize=10]
   */
  async getEmails(mailboxId, pageSize = 10) {
    const url = `${this.baseUrl}/mail-api/v1/unified-emails/user/emails?type=system&mailbox_id=${mailboxId}&page=1&page_size=${pageSize}`;
    const r = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.code !== 0) throw new Error(`读取收件箱失败 (${j.code}): ${j.message}`);
    return j.data?.emails || [];
  }

  /**
   * 读取邮件正文并提取 Claude 魔法链接与验证码
   * @param {number} emailId
   */
  async getEmailDetail(emailId) {
    const url = `${this.baseUrl}/mail-api/v1/unified-emails/emails/${emailId}?type=system`;
    const r = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j.code !== 0) throw new Error(`读取邮件详情失败 (${j.code}): ${j.message}`);
    const email = j.data;
    const content = email?.content || '';

    // 提取魔法链接 https://claude.ai/magic-link#<token>:<base64Email>
    const linkMatch = content.match(/https?:\/\/claude\.ai\/magic-link#[^\s"'<>]+/i);
    const magicLink = linkMatch ? linkMatch[0] : null;

    // 提取 6 位纯数字验证码
    let code = null;
    const codeMatch = content.match(/verification\s*code\s*is:?\s*(\d{6})/i)
      || content.match(/\b(\d{6})\b/);
    if (codeMatch && codeMatch[1]) {
      // 过滤掉 '000000' 或样式里的假匹配
      if (codeMatch[1] !== '000000') code = codeMatch[1];
    }

    return {
      id: email.id,
      subject: email.subject,
      from: email.from_addr,
      to: email.to_addr,
      magicLink,
      code,
      content,
    };
  }

  /**
   * 轮询等待 Claude 验证邮件到达，提取魔法链接或验证码
   * @param {{
   *   email: string,
   *   mailboxId?: number,
   *   sinceTimestamp?: number,
   *   timeoutMs?: number,
   *   onProgress?: (msg: string) => void
   * }} opts
   */
  async waitForVerification(opts) {
    const {
      email,
      sinceTimestamp = Date.now() - 30000,
      timeoutMs = 90000,
      onProgress = () => {},
    } = opts;

    let mailboxId = opts.mailboxId;
    if (!mailboxId) {
      onProgress('正在查询邮箱 mailbox ID…');
      const mb = await this.findMailboxByEmail(email);
      if (!mb) throw new Error(`在肥猫猫中未找到邮箱 ${email}，请先在该平台添加该邮箱`);
      mailboxId = mb.id;
    }

    onProgress(`已锁定邮箱 (ID: ${mailboxId})，正在等待 Claude 验证邮件到达…`);
    const deadline = Date.now() + timeoutMs;
    const seenEmailIds = new Set();

    while (Date.now() < deadline) {
      if (typeof opts.isAborted === 'function' && opts.isAborted()) {
        throw new Error('流程已结束或已被取消');
      }
      try {
        const emails = await this.getEmails(mailboxId, 5);
        for (const e of emails) {
          if (seenEmailIds.has(e.id)) continue;
          seenEmailIds.add(e.id);

          const isAnthropic = /anthropic\.com/i.test(e.from_addr || '') || /claude/i.test(e.subject || '');
          const isRecent = (e.received_at || e.email_date || Date.now()) >= sinceTimestamp - 20000;

          if (isAnthropic && isRecent) {
            onProgress(`收到 Claude 邮件: 「${e.subject}」，正在提取验证凭证…`);
            const detail = await this.getEmailDetail(e.id);
            if (detail.magicLink || detail.code) {
              return detail;
            }
          }
        }
      } catch (err) {
        onProgress(`轮询邮件异常: ${err.message}，2 秒后重试…`);
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    throw new Error(`等待 Claude 验证邮件超时 (${Math.round(timeoutMs / 1000)} 秒未收到邮件)`);
  }
}
