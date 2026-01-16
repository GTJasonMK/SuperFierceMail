import { initDatabase } from './database.js';
import { extractEmail } from './commonUtils.js';
import { forwardByLocalPart } from './emailForwarder.js';
import { createRouter, authMiddleware } from './routes.js';
import { createAssetManager } from './assetManager.js';
import { getDatabaseWithValidation } from './dbConnectionHelper.js';


export default {
  /**
   * HTTP请求处理器，处理所有到达Worker的HTTP请求
   * @param {Request} request - HTTP请求对象
   * @param {object} env - 环境变量对象，包含数据库连接、配置等
   * @param {object} ctx - 上下文对象，包含执行上下文信息
   * @returns {Promise<Response>} HTTP响应对象
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let DB;
    try {
      DB = await getDatabaseWithValidation(env);
    } catch (error) {
      console.error('数据库连接失败:', error.message);
      return new Response('数据库连接失败，请检查配置', { status: 500 });
    }
    
    // 支持多个域名：使用逗号/空格分隔，创建地址时取第一个为默认显示
    const MAIL_DOMAINS = (env.MAIL_DOMAIN || 'temp.example.com')
      .split(/[,\s]+/)
      .map(d => d.trim())
      .filter(Boolean);

    // 缓存数据库初始化，避免每次请求重复执行
    if (!globalThis.__DB_INITED__) {
      await initDatabase(DB);
      globalThis.__DB_INITED__ = true;
    }

    // 创建路由器并添加认证中间件
    const router = createRouter();
    router.use(authMiddleware);

    // 尝试使用路由器处理请求
    const routeResponse = await router.handle(request, { request, env, ctx });
    if (routeResponse) {
      return routeResponse;
    }

    // 使用资源管理器处理静态资源请求
    const assetManager = createAssetManager();
    return await assetManager.handleAssetRequest(request, env, MAIL_DOMAINS);
  },

  /**
   * 邮件接收处理器，处理所有到达的邮件消息
   * 简化处理：只提取基本头部信息，存储原始邮件内容，查看时再解析
   * @param {object} message - 邮件消息对象
   * @param {object} env - 环境变量对象
   * @param {object} ctx - 上下文对象
   */
  async email(message, env, ctx) {
    let DB;
    try {
      DB = await getDatabaseWithValidation(env);
      await initDatabase(DB);
    } catch (error) {
      console.error('邮件处理时数据库连接失败:', error.message);
      return;
    }

    try {
      // 1. 提取基本头部信息（用于列表显示）
      const headers = message.headers;
      const toHeader = headers.get('to') || headers.get('To') || '';
      const fromHeader = headers.get('from') || headers.get('From') || '';
      const subject = headers.get('subject') || headers.get('Subject') || '(无主题)';

      // 获取收件人地址
      let envelopeTo = '';
      try {
        const toValue = message.to;
        if (Array.isArray(toValue) && toValue.length > 0) {
          envelopeTo = typeof toValue[0] === 'string' ? toValue[0] : (toValue[0].address || '');
        } else if (typeof toValue === 'string') {
          envelopeTo = toValue;
        }
      } catch (_) {}

      const resolvedRecipient = (envelopeTo || toHeader || '').toString();
      const mailbox = extractEmail(resolvedRecipient || toHeader);
      const sender = extractEmail(fromHeader);
      const localPart = (mailbox.split('@')[0] || '').toLowerCase();

      // 2. 触发转发规则（如果有配置）
      forwardByLocalPart(message, localPart, ctx, env);

      // 3. 读取原始邮件内容
      let rawContent = '';
      try {
        const resp = new Response(message.raw);
        rawContent = await resp.text();
      } catch (e) {
        console.error('读取原始邮件失败:', e);
      }

      // 4. 查找或创建邮箱记录
      const resMb = await DB.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(mailbox.toLowerCase()).all();
      let mailboxId;
      if (Array.isArray(resMb?.results) && resMb.results.length) {
        mailboxId = resMb.results[0].id;
      } else {
        const [lp, domain] = (mailbox || '').toLowerCase().split('@');
        if (lp && domain) {
          await DB.prepare('INSERT INTO mailboxes (address, local_part, domain, password_hash, last_accessed_at) VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)')
            .bind(mailbox.toLowerCase(), lp, domain).run();
          const created = await DB.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(mailbox.toLowerCase()).all();
          mailboxId = created?.results?.[0]?.id;
        }
      }
      if (!mailboxId) throw new Error('无法解析或创建邮箱记录');

      // 5. 收件人地址（逗号拼接）
      let toAddrs = '';
      try {
        const toValue = message.to;
        if (Array.isArray(toValue)) {
          toAddrs = toValue.map(v => (typeof v === 'string' ? v : (v?.address || ''))).filter(Boolean).join(',');
        } else if (typeof toValue === 'string') {
          toAddrs = toValue;
        } else {
          toAddrs = resolvedRecipient || toHeader || '';
        }
      } catch (_) {
        toAddrs = resolvedRecipient || toHeader || '';
      }

      // 6. 存入数据库（只存基本信息和原始内容）
      await DB.prepare(`
        INSERT INTO messages (mailbox_id, sender, to_addrs, subject, raw_content)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        mailboxId,
        sender,
        String(toAddrs || ''),
        subject || '(无主题)',
        rawContent || ''
      ).run();
    } catch (err) {
      console.error('邮件接收处理错误:', err);
    }
  }
};

