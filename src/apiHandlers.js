import { extractEmail, generateRandomId } from './commonUtils.js';
import { buildMockEmails, buildMockMailboxes, buildMockEmailDetail } from './mockData.js';
import { getOrCreateMailboxId, getMailboxIdByAddress, recordSentEmail, updateSentEmail,
  getTotalMailboxCount, checkMailboxExists } from './database.js';
import { parseEmailBody, extractVerificationCode } from './emailParser.js';
import { sendEmailWithResend, sendBatchWithResend, sendEmailWithAutoResend, sendBatchWithAutoResend, getEmailFromResend, updateEmailInResend, cancelEmailInResend } from './emailSender.js';

export async function handleApiRequest(request, db, mailDomains, options = { mockOnly: false, resendApiKey: '', adminName: '', r2: null, authPayload: null, mailboxOnly: false }) {
  const url = new URL(request.url);
  const path = url.pathname;
  const isMock = !!options.mockOnly;
  const isMailboxOnly = !!options.mailboxOnly;
  const MOCK_DOMAINS = ['exa.cc', 'exr.yp', 'duio.ty'];
  const RESEND_API_KEY = options.resendApiKey || '';

  // 邮箱用户只能访问特定的API端点和自己的数据
  if (isMailboxOnly) {
    const payload = getJwtPayload();
    const mailboxAddress = payload?.mailboxAddress;
    const mailboxId = payload?.mailboxId;
    
    // 允许的API端点
    const allowedPaths = ['/api/emails', '/api/email/', '/api/auth', '/api/quota', '/api/mailbox/password'];
    const isAllowedPath = allowedPaths.some(allowedPath => path.startsWith(allowedPath));
    
    if (!isAllowedPath) {
      return new Response('访问被拒绝', { status: 403 });
    }
    
    // 对于邮件相关API，限制只能访问自己的邮箱
    if (path === '/api/emails' && request.method === 'GET') {
      const requestedMailbox = url.searchParams.get('mailbox');
      if (requestedMailbox && requestedMailbox.toLowerCase() !== mailboxAddress?.toLowerCase()) {
        return new Response('只能访问自己的邮箱', { status: 403 });
      }
      // 如果没有指定邮箱，自动设置为用户自己的邮箱
      if (!requestedMailbox && mailboxAddress) {
        url.searchParams.set('mailbox', mailboxAddress);
      }
    }
    
    // 对于单个邮件操作，验证邮件是否属于该用户的邮箱
    if (path.startsWith('/api/email/') && mailboxId) {
      const emailId = path.split('/')[3];
      if (emailId && emailId !== 'batch') {
        try {
          const { results } = await db.prepare('SELECT mailbox_id FROM messages WHERE id = ? LIMIT 1').bind(emailId).all();
          if (!results || results.length === 0) {
            return new Response('邮件不存在', { status: 404 });
          }
          if (results[0].mailbox_id !== mailboxId) {
            return new Response('无权访问此邮件', { status: 403 });
          }
        } catch (e) {
          return new Response('验证失败', { status: 500 });
        }
      }
    }
  }

  function getJwtPayload(){
    // 优先使用服务端传入的已解析身份（支持 __root__ 超管）
    if (options && options.authPayload) return options.authPayload;
    try{
      const cookie = request.headers.get('Cookie') || '';
      const token = (cookie.split(';').find(s=>s.trim().startsWith('iding-session='))||'').split('=')[1] || '';
      const parts = token.split('.');
      if (parts.length === 3){
        const json = atob(parts[1].replace(/-/g,'+').replace(/_/g,'/'));
        return JSON.parse(json);
      }
    }catch(_){ }
    return null;
  }
  function isStrictAdmin(){
    const p = getJwtPayload();
    if (!p) return false;
    if (p.role !== 'admin') return false;
    // __root__（根管理员）视为严格管理员
    if (String(p.username || '') === '__root__') return true;
    if (options?.adminName){ return String(p.username || '').toLowerCase() === String(options.adminName || '').toLowerCase(); }
    return true;
  }
  
  async function sha256Hex(text){
    const enc = new TextEncoder();
    const data = enc.encode(String(text || ''));
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let out = '';
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  // 返回域名列表给前端
  if (path === '/api/domains' && request.method === 'GET') {
    if (isMock) return Response.json(MOCK_DOMAINS);
    const domains = Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')];
    return Response.json(domains);
  }

  // 返回受保护邮箱列表（管理员可见）
  if (path === '/api/protected-mailboxes' && request.method === 'GET') {
    // 检查是否为管理员（包括普通admin和strict_admin）
    const p = getJwtPayload();
    if (!p || p.role !== 'admin') return new Response('Forbidden', { status: 403 });
    const protectedMailboxes = options.protectedMailboxes || [];
    return Response.json(protectedMailboxes);
  }

  if (path === '/api/generate') {
    const lengthParam = Number(url.searchParams.get('length') || 0);
    const randomId = generateRandomId(lengthParam || undefined);
    const domains = isMock ? MOCK_DOMAINS : (Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')]);
    const domainIdx = Math.max(0, Math.min(domains.length - 1, Number(url.searchParams.get('domainIndex') || 0)));
    const chosenDomain = domains[domainIdx] || domains[0];
    const email = `${randomId}@${chosenDomain}`;
    // 访客模式不写入历史
    if (!isMock) {
      try {
        await getOrCreateMailboxId(db, email);
        return Response.json({ email, expires: Date.now() + 3600000 });
      } catch (e) {
        return new Response(String(e?.message || '创建失败'), { status: 400 });
      }
    }
    return Response.json({ email, expires: Date.now() + 3600000 });
  }

  // 自定义创建邮箱：{ local, domainIndex }
  if (path === '/api/create' && request.method === 'POST'){
    if (isMock){
      // demo 模式下使用模拟域名（仅内存，不写库）
      try{
        const body = await request.json();
        const local = String(body.local || '').trim().toLowerCase();
        const valid = /^[a-z0-9._-]{1,64}$/i.test(local);
        if (!valid) return new Response('非法用户名', { status: 400 });
        const domains = MOCK_DOMAINS;
        const domainIdx = Math.max(0, Math.min(domains.length - 1, Number(body.domainIndex || 0)));
        const chosenDomain = domains[domainIdx] || domains[0];
        const email = `${local}@${chosenDomain}`;
        return Response.json({ email, expires: Date.now() + 3600000 });
      }catch(_){ return new Response('Bad Request', { status: 400 }); }
    }
    try{
      const body = await request.json();
      const local = String(body.local || '').trim().toLowerCase();
      const valid = /^[a-z0-9._-]{1,64}$/i.test(local);
      if (!valid) return new Response('非法用户名', { status: 400 });
      const domains = Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')];
      const domainIdx = Math.max(0, Math.min(domains.length - 1, Number(body.domainIndex || 0)));
      const chosenDomain = domains[domainIdx] || domains[0];
      const email = `${local}@${chosenDomain}`;

      // 获取可选参数
      const customPassword = body.password ? String(body.password) : null;
      const canLogin = body.canLogin !== undefined ? (body.canLogin ? 1 : 0) : 1;

      try{
        // 检查邮箱是否已存在
        const exists = await checkMailboxExists(db, email);
        if (exists) {
          return new Response('邮箱地址已存在，使用其他地址', { status: 409 });
        }

        // 邮箱不存在，直接创建
        const mailboxId = await getOrCreateMailboxId(db, email);

        // 如果提供了自定义密码或登录权限设置，更新邮箱记录
        if (customPassword || canLogin !== 1) {
          let passwordHash = null;
          if (customPassword) {
            // 验证密码长度
            if (customPassword.length < 6) {
              return new Response('密码至少6位', { status: 400 });
            }
            const { hashPassword } = await import('./authentication.js');
            passwordHash = await hashPassword(customPassword);
          }

          // 更新邮箱记录
          if (passwordHash) {
            await db.prepare('UPDATE mailboxes SET password_hash = ?, can_login = ? WHERE id = ?')
              .bind(passwordHash, canLogin, mailboxId).run();
          } else {
            await db.prepare('UPDATE mailboxes SET can_login = ? WHERE id = ?')
              .bind(canLogin, mailboxId).run();
          }
        }

        return Response.json({ email, expires: Date.now() + 3600000 });
      }catch(e){
        return new Response(String(e?.message || '创建失败'), { status: 400 });
      }
    }catch(e){ return new Response('创建失败', { status: 500 }); }
  }

  // 当前系统配额
  if (path === '/api/user/quota' && request.method === 'GET'){
    if (isMock){
      return Response.json({ used: 0, limit: 999999, isAdmin: true });
    }
    try{
      const payload = getJwtPayload();
      const role = payload?.role || 'mailbox';

      // admin 和 mailbox 用户都可以查看系统邮箱总数
      const totalUsed = await getTotalMailboxCount(db);
      return Response.json({ used: totalUsed, limit: 999999, isAdmin: role === 'admin' });
    }catch(_){ return new Response('查询失败', { status: 500 }); }
  }

  // 发件记录列表（按发件人地址过滤）
  if (path === '/api/sent' && request.method === 'GET'){
    if (isMock){
      return Response.json([]);
    }
    const from = url.searchParams.get('from') || url.searchParams.get('mailbox') || '';
    if (!from){ return new Response('缺少 from 参数', { status: 400 }); }
    try{
      // 优化：减少默认查询数量
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      const { results } = await db.prepare(`
        SELECT id, resend_id, to_addrs as recipients, subject, created_at, status
        FROM sent_emails
        WHERE from_addr = ?
        ORDER BY datetime(created_at) DESC
        LIMIT ?
      `).bind(String(from).trim().toLowerCase(), limit).all();
      return Response.json(results || []);
    }catch(e){
      console.error('查询发件记录失败:', e);
      return new Response('查询发件记录失败', { status: 500 });
    }
  }

  // 发件详情
  if (request.method === 'GET' && path.startsWith('/api/sent/')){
    if (isMock){ return new Response('演示模式不可查询真实发送', { status: 403 }); }
    const id = path.split('/')[3];
    try{
      const { results } = await db.prepare(`
        SELECT id, resend_id, from_addr, to_addrs as recipients, subject,
               html_content, text_content, status, scheduled_at, created_at
        FROM sent_emails WHERE id = ?
      `).bind(id).all();
      if (!results || !results.length) return new Response('未找到发件', { status: 404 });
      return Response.json(results[0]);
    }catch(e){
      return new Response('查询失败', { status: 500 });
    }
  }

  // 检查发件权限的辅助函数（只有 admin 可以发件）
  function checkSendPermission() {
    const payload = getJwtPayload();
    if (!payload) return false;
    return payload.role === 'admin';
  }
  
  // 发送单封邮件
  if (path === '/api/send' && request.method === 'POST'){
    if (isMock) return new Response('演示模式不可发送', { status: 403 });
    try{
      if (!RESEND_API_KEY) return new Response('未配置 Resend API Key', { status: 500 });
      
      // 校验是否允许发件
      const allowed = checkSendPermission();
      if (!allowed) return new Response('未授权发件或该用户未被授予发件权限', { status: 403 });
      const sendPayload = await request.json();
      // 使用智能发送，根据发件人域名自动选择API密钥
      const result = await sendEmailWithAutoResend(RESEND_API_KEY, sendPayload);
      await recordSentEmail(db, {
        resendId: result.id || null,
        fromName: sendPayload.fromName || null,
        from: sendPayload.from,
        to: sendPayload.to,
        subject: sendPayload.subject,
        html: sendPayload.html,
        text: sendPayload.text,
        status: 'delivered',
        scheduledAt: sendPayload.scheduledAt || null
      });
      return Response.json({ success: true, id: result.id });
    }catch(e){
      return new Response('发送失败: ' + e.message, { status: 500 });
    }
  }

  // 批量发送
  if (path === '/api/send/batch' && request.method === 'POST'){
    if (isMock) return new Response('演示模式不可发送', { status: 403 });
    try{
      if (!RESEND_API_KEY) return new Response('未配置 Resend API Key', { status: 500 });
      
      // 校验是否允许发件
      const allowed = checkSendPermission();
      if (!allowed) return new Response('未授权发件或该用户未被授予发件权限', { status: 403 });
      const items = await request.json();
      // 使用智能批量发送，自动按域名分组并使用对应的API密钥
      const result = await sendBatchWithAutoResend(RESEND_API_KEY, items);
      try{
        // 尝试记录（如果返回结构包含 id 列表）
        const arr = Array.isArray(result) ? result : [];
        for (let i = 0; i < arr.length; i++){
          const id = arr[i]?.id;
          const payload = items[i] || {};
          await recordSentEmail(db, {
            resendId: id || null,
            fromName: payload.fromName || null,
            from: payload.from,
            to: payload.to,
            subject: payload.subject,
            html: payload.html,
            text: payload.text,
            status: 'delivered',
            scheduledAt: payload.scheduledAt || null
          });
        }
      }catch(_){/* ignore */}
      return Response.json({ success: true, result });
    }catch(e){
      return new Response('批量发送失败: ' + e.message, { status: 500 });
    }
  }

  // 查询发送结果
  if (path.startsWith('/api/send/') && request.method === 'GET'){
    if (isMock) return new Response('演示模式不可查询真实发送', { status: 403 });
    const id = path.split('/')[3];
    try{
      if (!RESEND_API_KEY) return new Response('未配置 Resend API Key', { status: 500 });
      const data = await getEmailFromResend(RESEND_API_KEY, id);
      return Response.json(data);
    }catch(e){
      return new Response('查询失败: ' + e.message, { status: 500 });
    }
  }

  // 更新（修改定时/状态等）
  if (path.startsWith('/api/send/') && request.method === 'PATCH'){
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    const id = path.split('/')[3];
    try{
      if (!RESEND_API_KEY) return new Response('未配置 Resend API Key', { status: 500 });
      const body = await request.json();
      let data = { ok: true };
      // 如果只是更新本地状态，不必请求 Resend
      if (body && typeof body.status === 'string'){
        await updateSentEmail(db, id, { status: body.status });
      }
      // 更新定时设置时需要触达 Resend
      if (body && body.scheduledAt){
        data = await updateEmailInResend(RESEND_API_KEY, { id, scheduledAt: body.scheduledAt });
        await updateSentEmail(db, id, { scheduled_at: body.scheduledAt });
      }
      return Response.json(data || { ok: true });
    }catch(e){
      return new Response('更新失败: ' + e.message, { status: 500 });
    }
  }

  // 取消发送
  if (path.startsWith('/api/send/') && path.endsWith('/cancel') && request.method === 'POST'){
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    const id = path.split('/')[3];
    try{
      if (!RESEND_API_KEY) return new Response('未配置 Resend API Key', { status: 500 });
      const data = await cancelEmailInResend(RESEND_API_KEY, id);
      await updateSentEmail(db, id, { status: 'canceled' });
      return Response.json(data);
    }catch(e){
      return new Response('取消失败: ' + e.message, { status: 500 });
    }
  }

  // 删除发件记录
  if (request.method === 'DELETE' && path.startsWith('/api/sent/')){
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    const id = path.split('/')[3];
    try{
      await db.prepare('DELETE FROM sent_emails WHERE id = ?').bind(id).run();
      return Response.json({ success: true });
    }catch(e){
      return new Response('删除发件记录失败: ' + e.message, { status: 500 });
    }
  }

  if (path === '/api/emails' && request.method === 'GET') {
    const mailbox = url.searchParams.get('mailbox');
    if (!mailbox) {
      return new Response('缺少 mailbox 参数', { status: 400 });
    }
    try {
      if (isMock) {
        return Response.json(buildMockEmails(6));
      }
      const normalized = extractEmail(mailbox).trim().toLowerCase();
      // 纯读：不存在则返回空数组，不创建
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      if (!mailboxId) return Response.json([]);
      
      // 邮箱用户只能查看近24小时的邮件
      let timeFilter = '';
      let timeParam = [];
      if (isMailboxOnly) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        timeFilter = ' AND received_at >= ?';
        timeParam = [twentyFourHoursAgo];
      }
      
      // 优化：减少默认查询数量，降低行读取
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      
      try{
        // 返回完整数据，让前端解析验证码和预览
        const { results } = await db.prepare(`
          SELECT id, sender, subject, received_at, is_read, raw_content
          FROM messages
          WHERE mailbox_id = ?${timeFilter}
          ORDER BY received_at DESC
          LIMIT ?
        `).bind(mailboxId, ...timeParam, limit).all();
        return Response.json(results);
      }catch(e){
        // 旧结构降级查询
        const { results } = await db.prepare(`
          SELECT id, sender, subject, received_at, is_read
          FROM messages
          WHERE mailbox_id = ?${timeFilter}
          ORDER BY received_at DESC
          LIMIT ?
        `).bind(mailboxId, ...timeParam, limit).all();
        return Response.json(results);
      }
    } catch (e) {
      console.error('查询邮件失败:', e);
      return new Response('查询邮件失败', { status: 500 });
    }
  }

  // 批量查询邮件详情，减少前端 N+1 请求
  if (path === '/api/emails/batch' && request.method === 'GET'){
    try{
      const idsParam = String(url.searchParams.get('ids') || '').trim();
      if (!idsParam) return Response.json([]);
      const ids = idsParam.split(',').map(s=>parseInt(s,10)).filter(n=>Number.isInteger(n) && n>0);
      if (!ids.length) return Response.json([]);
      
      // 优化：限制批量查询数量，避免单次查询过多行
      if (ids.length > 50) {
        return new Response('单次最多查询50封邮件', { status: 400 });
      }
      
      if (isMock){
        const arr = ids.map(id => buildMockEmailDetail(id));
        return Response.json(arr);
      }
      
      // 邮箱用户只能查看近24小时的邮件
      let timeFilter = '';
      let timeParam = [];
      if (isMailboxOnly) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        timeFilter = ' AND received_at >= ?';
        timeParam = [twentyFourHoursAgo];
      }
      
      const placeholders = ids.map(()=>'?').join(',');
      try{
        const { results } = await db.prepare(`
          SELECT id, sender, to_addrs, subject, verification_code, preview, raw_content, received_at, is_read
          FROM messages WHERE id IN (${placeholders})${timeFilter}
        `).bind(...ids, ...timeParam).all();
        return Response.json(results || []);
      }catch(e){
        const { results } = await db.prepare(`
          SELECT id, sender, subject, content, html_content, received_at, is_read
          FROM messages WHERE id IN (${placeholders})${timeFilter}
        `).bind(...ids, ...timeParam).all();
        return Response.json(results || []);
      }
    }catch(e){
      return new Response('批量查询失败', { status: 500 });
    }
  }

  // 历史邮箱列表（按创建时间倒序）支持分页
  if (path === '/api/mailboxes' && request.method === 'GET') {
    // 优化：默认查询更少的数据
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50);
    const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const domain = String(url.searchParams.get('domain') || '').trim().toLowerCase();
    const canLoginParam = String(url.searchParams.get('can_login') || '').trim();
    if (isMock) {
      return Response.json(buildMockMailboxes(limit, offset, mailDomains));
    }
    // 只有 admin 可以查看邮箱列表
    if (!isStrictAdmin()) {
      return new Response('仅管理员可用', { status: 403 });
    }
    try{
      const like = `%${q.replace(/%/g,'').replace(/_/g,'')}%`;

      // 构建筛选条件
      let whereConditions = [];
      let bindParams = [];

      // 搜索条件
      if (q) {
        whereConditions.push('LOWER(address) LIKE LOWER(?)');
        bindParams.push(like);
      }

      // 域名筛选
      if (domain) {
        whereConditions.push('LOWER(address) LIKE LOWER(?)');
        bindParams.push(`%@${domain}`);
      }

      // 登录权限筛选
      if (canLoginParam === 'true') {
        whereConditions.push('can_login = 1');
      } else if (canLoginParam === 'false') {
        whereConditions.push('can_login = 0');
      }

      const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
      bindParams.push(limit, offset);

      const { results } = await db.prepare(`
        SELECT address, created_at, 0 AS is_pinned,
               CASE WHEN (password_hash IS NULL OR password_hash = '') THEN 1 ELSE 0 END AS password_is_default,
               COALESCE(can_login, 0) AS can_login
        FROM mailboxes
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `).bind(...bindParams).all();
      return Response.json(results || []);
    }catch(_){
      return Response.json([]);
    }
  }

  // 重置某个邮箱的密码为默认（邮箱本身）——仅严格管理员
  if (path === '/api/mailboxes/reset-password' && request.method === 'POST') {
    if (isMock) return Response.json({ success: true, mock: true });
    try{
      if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
      const address = String(url.searchParams.get('address') || '').trim().toLowerCase();
      if (!address) return new Response('缺少 address 参数', { status: 400 });
      await db.prepare('UPDATE mailboxes SET password_hash = NULL WHERE address = ?').bind(address).run();
      return Response.json({ success: true });
    }catch(e){ return new Response('重置失败', { status: 500 }); }
  }

  // 切换邮箱登录权限（仅严格管理员可用）
  if (path === '/api/mailboxes/toggle-login' && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const body = await request.json();
      const address = String(body.address || '').trim().toLowerCase();
      const canLogin = Boolean(body.can_login);
      
      if (!address) return new Response('缺少 address 参数', { status: 400 });
      
      // 检查邮箱是否存在
      const mbRes = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(address).all();
      if (!mbRes.results || mbRes.results.length === 0) {
        return new Response('邮箱不存在', { status: 404 });
      }
      
      // 更新登录权限
      await db.prepare('UPDATE mailboxes SET can_login = ? WHERE address = ?')
        .bind(canLogin ? 1 : 0, address).run();
      
      return Response.json({ success: true, can_login: canLogin });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  // 修改邮箱密码（仅严格管理员可用）
  if (path === '/api/mailboxes/change-password' && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const body = await request.json();
      const address = String(body.address || '').trim().toLowerCase();
      const newPassword = String(body.new_password || '').trim();
      
      if (!address) return new Response('缺少 address 参数', { status: 400 });
      if (!newPassword || newPassword.length < 6) return new Response('密码长度至少6位', { status: 400 });
      
      // 检查邮箱是否存在
      const mbRes = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(address).all();
      if (!mbRes.results || mbRes.results.length === 0) {
        return new Response('邮箱不存在', { status: 404 });
      }
      
      // 生成密码哈希
      const newPasswordHash = await sha256Hex(newPassword);
      
      // 更新密码
      await db.prepare('UPDATE mailboxes SET password_hash = ? WHERE address = ?')
        .bind(newPasswordHash, address).run();
      
      return Response.json({ success: true });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  // 批量切换邮箱登录权限（仅严格管理员可用）
  if (path === '/api/mailboxes/batch-toggle-login' && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    try {
      const body = await request.json();
      const addresses = body.addresses || [];
      const canLogin = Boolean(body.can_login);
      
      if (!Array.isArray(addresses) || addresses.length === 0) {
        return new Response('缺少 addresses 参数或地址列表为空', { status: 400 });
      }
      
      // 限制批量操作数量，防止性能问题
      if (addresses.length > 100) {
        return new Response('单次最多处理100个邮箱', { status: 400 });
      }
      
      let successCount = 0;
      let failCount = 0;
      const results = [];
      
      // 规范化地址并过滤空地址
      const addressMap = new Map(); // 存储规范化后的地址映射
      
      for (const address of addresses) {
        const normalizedAddress = String(address || '').trim().toLowerCase();
        if (!normalizedAddress) {
          failCount++;
          results.push({ address, success: false, error: '地址为空' });
          continue;
        }
        addressMap.set(normalizedAddress, address);
      }
      
      // 优化：使用 IN 查询批量检查邮箱是否存在，减少数据库查询次数
      let existingMailboxes = new Set();
      if (addressMap.size > 0) {
        try {
          const addressList = Array.from(addressMap.keys());
          const placeholders = addressList.map(() => '?').join(',');
          const checkResult = await db.prepare(
            `SELECT address FROM mailboxes WHERE address IN (${placeholders})`
          ).bind(...addressList).all();
          
          for (const row of (checkResult.results || [])) {
            existingMailboxes.add(row.address);
          }
        } catch (e) {
          console.error('批量检查邮箱失败:', e);
        }
      }
      
      // 准备批量操作语句
      const batchStatements = [];
      
      for (const [normalizedAddress, originalAddress] of addressMap.entries()) {
        if (existingMailboxes.has(normalizedAddress)) {
          // 邮箱存在，更新登录权限
          batchStatements.push({
            stmt: db.prepare('UPDATE mailboxes SET can_login = ? WHERE address = ?')
              .bind(canLogin ? 1 : 0, normalizedAddress),
            address: normalizedAddress,
            type: 'update'
          });
        } else {
          // 邮箱不存在，创建新邮箱
          batchStatements.push({
            stmt: db.prepare('INSERT INTO mailboxes (address, can_login) VALUES (?, ?)')
              .bind(normalizedAddress, canLogin ? 1 : 0),
            address: normalizedAddress,
            type: 'insert'
          });
        }
      }
      
      // 使用 D1 的 batch API 批量执行
      if (batchStatements.length > 0) {
        try {
          const batchResults = await db.batch(batchStatements.map(s => s.stmt));
          
          // 处理每个操作的结果
          for (let i = 0; i < batchResults.length; i++) {
            const result = batchResults[i];
            const operation = batchStatements[i];
            
            if (result.success !== false) {
              successCount++;
              results.push({
                address: operation.address,
                success: true,
                [operation.type === 'insert' ? 'created' : 'updated']: true
              });
            } else {
              failCount++;
              results.push({
                address: operation.address,
                success: false,
                error: result.error || '操作失败'
              });
            }
          }
        } catch (e) {
          console.error('批量操作执行失败:', e);
          return new Response('批量操作失败: ' + e.message, { status: 500 });
        }
      }
      
      return Response.json({ 
        success: true, 
        success_count: successCount, 
        fail_count: failCount,
        total: addresses.length,
        results 
      });
    } catch (e) {
      return new Response('操作失败: ' + e.message, { status: 500 });
    }
  }

  // 删除邮箱（及其所有邮件）
  if (path === '/api/mailboxes' && request.method === 'DELETE') {
    if (isMock) return new Response('演示模式不可删除', { status: 403 });
    if (!isStrictAdmin()) return new Response('Forbidden', { status: 403 });
    const raw = url.searchParams.get('address');
    if (!raw) return new Response('缺少 address 参数', { status: 400 });
    const normalized = String(raw || '').trim().toLowerCase();

    // 检查是否是受保护的邮箱
    const protectedMailboxes = options.protectedMailboxes || [];
    if (protectedMailboxes.includes(normalized)) {
      return new Response('该邮箱受保护，无法删除', { status: 403 });
    }

    try {
      const { invalidateMailboxCache } = await import('./cacheHelper.js');

      const mailboxId = await getMailboxIdByAddress(db, normalized);
      // 未找到则明确返回 404，避免前端误判为成功
      if (!mailboxId) return new Response(JSON.stringify({ success: false, message: '邮箱不存在' }), { status: 404 });
      // 简易事务，降低并发插入导致的外键失败概率
      try { await db.exec('BEGIN'); } catch(_) {}
      await db.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(mailboxId).run();
      const deleteResult = await db.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mailboxId).run();
      try { await db.exec('COMMIT'); } catch(_) {}

      // 优化：通过 meta.changes 判断删除是否成功，减少 COUNT 查询
      const deleted = (deleteResult?.meta?.changes || 0) > 0;

      // 删除成功后使缓存失效
      if (deleted) {
        invalidateMailboxCache(normalized);
        // 使系统统计缓存失效
        const { invalidateSystemStatCache } = await import('./cacheHelper.js');
        invalidateSystemStatCache('total_mailboxes');
      }

      return Response.json({ success: deleted, deleted });
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch(_) {}
      return new Response('删除失败', { status: 500 });
    }
  }

  // 下载 EML（从数据库获取）- 必须在通用邮件详情处理器之前
  if (request.method === 'GET' && path.startsWith('/api/email/') && path.endsWith('/download')){
    if (options.mockOnly) return new Response('演示模式不可下载', { status: 403 });
    const id = path.split('/')[3];
    const { results } = await db.prepare('SELECT raw_content FROM messages WHERE id = ?').bind(id).all();
    const row = (results||[])[0];
    if (!row || !row.raw_content) return new Response('未找到邮件内容', { status: 404 });
    try{
      const headers = new Headers({ 'Content-Type': 'message/rfc822' });
      headers.set('Content-Disposition', `attachment; filename="email-${id}.eml"`);
      return new Response(row.raw_content, { headers });
    }catch(e){
      return new Response('下载失败', { status: 500 });
    }
  }

  if (request.method === 'GET' && path.startsWith('/api/email/')) {
    const emailId = path.split('/')[3];
    if (isMock) {
      return Response.json(buildMockEmailDetail(emailId));
    }
    try{
      // 邮箱用户需要验证邮件是否在24小时内
      let timeFilter = '';
      let timeParam = [];
      if (isMailboxOnly) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        timeFilter = ' AND received_at >= ?';
        timeParam = [twentyFourHoursAgo];
      }
      
      const { results } = await db.prepare(`
        SELECT id, sender, to_addrs, subject, verification_code, preview, raw_content, received_at, is_read
        FROM messages WHERE id = ?${timeFilter}
      `).bind(emailId, ...timeParam).all();
      if (results.length === 0) {
        if (isMailboxOnly) {
          return new Response('邮件不存在或已超过24小时访问期限', { status: 404 });
        }
        return new Response('未找到邮件', { status: 404 });
      }
      await db.prepare(`UPDATE messages SET is_read = 1 WHERE id = ?`).bind(emailId).run();
      const row = results[0];
      let content = '';
      let html_content = '';
      // 从数据库 raw_content 字段解析邮件正文
      try{
        if (row.raw_content){
          console.log('[DEBUG] 解析邮件:', emailId, 'raw_content长度:', row.raw_content.length);
          const parsed = parseEmailBody(row.raw_content || '');
          content = parsed.text || '';
          html_content = parsed.html || '';
          console.log('[DEBUG] 解析结果:', { textLen: content.length, htmlLen: html_content.length });
        }
      }catch(e){
        console.error('[DEBUG] 解析邮件失败:', emailId, e.message);
      }

      // 当解析结果为空时，回退读取数据库中的 content/html_content（兼容旧数据）
      if ((!content && !html_content)){
        try{
          const fallback = await db.prepare('SELECT content, html_content FROM messages WHERE id = ?').bind(emailId).all();
          const fr = (fallback?.results || [])[0] || {};
          content = content || fr.content || '';
          html_content = html_content || fr.html_content || '';
        }catch(_){ /* 忽略：旧表可能缺少字段 */ }
      }

      return Response.json({ ...row, content, html_content, download: row.raw_content ? `/api/email/${emailId}/download` : '' });
    }catch(e){
      const { results } = await db.prepare(`
        SELECT id, sender, subject, content, html_content, received_at, is_read
        FROM messages WHERE id = ?
      `).bind(emailId).all();
      if (!results || !results.length) return new Response('未找到邮件', { status: 404 });
      await db.prepare(`UPDATE messages SET is_read = 1 WHERE id = ?`).bind(emailId).run();
      return Response.json(results[0]);
    }
  }

  if (request.method === 'DELETE' && path.startsWith('/api/email/')) {
    if (isMock) return new Response('演示模式不可删除', { status: 403 });
    const emailId = path.split('/')[3];
    
    if (!emailId || !Number.isInteger(parseInt(emailId))) {
      return new Response('无效的邮件ID', { status: 400 });
    }
    
    try {
      // 优化：直接删除，通过 D1 的 changes 判断是否成功，减少 COUNT 查询
      const result = await db.prepare(`DELETE FROM messages WHERE id = ?`).bind(emailId).run();
      
      // D1 的 run() 返回对象中包含 meta.changes 表示受影响的行数
      const deleted = (result?.meta?.changes || 0) > 0;
      
      return Response.json({ 
        success: true, 
        deleted,
        message: deleted ? '邮件已删除' : '邮件不存在或已被删除'
      });
    } catch (e) {
      console.error('删除邮件失败:', e);
      return new Response('删除邮件时发生错误: ' + e.message, { status: 500 });
    }
  }

  if (request.method === 'DELETE' && path === '/api/emails') {
    if (isMock) return new Response('演示模式不可清空', { status: 403 });
    const mailbox = url.searchParams.get('mailbox');
    if (!mailbox) {
      return new Response('缺少 mailbox 参数', { status: 400 });
    }
    try {
      const normalized = extractEmail(mailbox).trim().toLowerCase();
      // 仅当邮箱已存在时才执行清空操作；不存在则直接返回 0 删除
      const mailboxId = await getMailboxIdByAddress(db, normalized);
      if (!mailboxId) {
        return Response.json({ success: true, deletedCount: 0 });
      }
      
      // 优化：直接删除，通过 meta.changes 获取删除数量，减少 COUNT 查询
      const result = await db.prepare(`DELETE FROM messages WHERE mailbox_id = ?`).bind(mailboxId).run();
      const deletedCount = result?.meta?.changes || 0;
      
      return Response.json({ 
        success: true, 
        deletedCount
      });
    } catch (e) {
      console.error('清空邮件失败:', e);
      return new Response('清空邮件失败', { status: 500 });
    }
  }

  // ================= 管理员统计数据 =================
  if (path === '/api/admin/stats' && request.method === 'GET') {
    if (isMock) {
      // 演示模式返回模拟数据
      return Response.json({
        totalMailboxes: 128,
        totalMessages: 1567,
        todayMailboxes: 12,
        todayMessages: 89,
        trend: [
          { date: '01-11', mailboxes: 15, messages: 120 },
          { date: '01-12', mailboxes: 18, messages: 145 },
          { date: '01-13', mailboxes: 12, messages: 98 },
          { date: '01-14', mailboxes: 20, messages: 167 },
          { date: '01-15', mailboxes: 8, messages: 76 },
          { date: '01-16', mailboxes: 14, messages: 112 },
          { date: '01-17', mailboxes: 12, messages: 89 }
        ],
        activeMailboxes: [
          { address: 'test@example.com', count: 156 },
          { address: 'demo@example.com', count: 134 },
          { address: 'user@example.com', count: 98 }
        ],
        sourceDomains: [
          { domain: 'gmail.com', count: 456 },
          { domain: 'outlook.com', count: 234 },
          { domain: 'qq.com', count: 189 }
        ],
        mailboxDomains: [
          { domain: 'temp.example.com', count: 89, percentage: 69.5 },
          { domain: 'mail.example.com', count: 39, percentage: 30.5 }
        ],
        permissionStats: {
          canLogin: 98,
          cannotLogin: 30,
          defaultPassword: 85,
          customPassword: 43
        }
      });
    }

    // 仅管理员可访问
    if (!isStrictAdmin()) {
      return new Response('仅管理员可用', { status: 403 });
    }

    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

      // 并行执行多个查询以提高性能
      const [
        totalMailboxesRes,
        totalMessagesRes,
        todayMailboxesRes,
        todayMessagesRes,
        trendRes,
        activeMailboxesRes,
        sourceDomainsRes,
        mailboxDomainsRes,
        permissionRes
      ] = await Promise.all([
        // 邮箱总数
        db.prepare('SELECT COUNT(*) as count FROM mailboxes').all(),
        // 邮件总数
        db.prepare('SELECT COUNT(*) as count FROM messages').all(),
        // 今日新邮箱
        db.prepare('SELECT COUNT(*) as count FROM mailboxes WHERE created_at >= ?').bind(todayStart).all(),
        // 今日新邮件
        db.prepare('SELECT COUNT(*) as count FROM messages WHERE received_at >= ?').bind(todayStart).all(),
        // 7天趋势数据
        db.prepare(`
          WITH RECURSIVE dates(date) AS (
            SELECT date('now', '-6 days')
            UNION ALL
            SELECT date(date, '+1 day') FROM dates WHERE date < date('now')
          )
          SELECT
            strftime('%m-%d', d.date) as date,
            COALESCE(mb.mailbox_count, 0) as mailboxes,
            COALESCE(msg.message_count, 0) as messages
          FROM dates d
          LEFT JOIN (
            SELECT date(created_at) as dt, COUNT(*) as mailbox_count
            FROM mailboxes
            WHERE created_at >= date('now', '-6 days')
            GROUP BY date(created_at)
          ) mb ON d.date = mb.dt
          LEFT JOIN (
            SELECT date(received_at) as dt, COUNT(*) as message_count
            FROM messages
            WHERE received_at >= date('now', '-6 days')
            GROUP BY date(received_at)
          ) msg ON d.date = msg.dt
          ORDER BY d.date
        `).all(),
        // 活跃邮箱TOP10（按邮件数）
        db.prepare(`
          SELECT m.address, COUNT(msg.id) as count
          FROM mailboxes m
          LEFT JOIN messages msg ON m.id = msg.mailbox_id
          GROUP BY m.id
          HAVING COUNT(msg.id) > 0
          ORDER BY count DESC
          LIMIT 10
        `).all(),
        // 邮件来源域名TOP10
        db.prepare(`
          SELECT
            LOWER(SUBSTR(sender, INSTR(sender, '@') + 1)) as domain,
            COUNT(*) as count
          FROM messages
          WHERE sender LIKE '%@%'
          GROUP BY domain
          ORDER BY count DESC
          LIMIT 10
        `).all(),
        // 邮箱域名分布
        db.prepare(`
          SELECT
            LOWER(SUBSTR(address, INSTR(address, '@') + 1)) as domain,
            COUNT(*) as count
          FROM mailboxes
          WHERE address LIKE '%@%'
          GROUP BY domain
          ORDER BY count DESC
        `).all(),
        // 权限统计
        db.prepare(`
          SELECT
            SUM(CASE WHEN can_login = 1 THEN 1 ELSE 0 END) as can_login,
            SUM(CASE WHEN can_login = 0 OR can_login IS NULL THEN 1 ELSE 0 END) as cannot_login,
            SUM(CASE WHEN password_hash IS NULL OR password_hash = '' THEN 1 ELSE 0 END) as default_password,
            SUM(CASE WHEN password_hash IS NOT NULL AND password_hash != '' THEN 1 ELSE 0 END) as custom_password
          FROM mailboxes
        `).all()
      ]);

      // 处理邮箱域名分布，计算百分比
      const totalMailboxCount = totalMailboxesRes.results?.[0]?.count || 0;
      const mailboxDomains = (mailboxDomainsRes.results || []).map(item => ({
        domain: item.domain,
        count: item.count,
        percentage: totalMailboxCount > 0 ? Math.round(item.count / totalMailboxCount * 1000) / 10 : 0
      }));

      const permissionData = permissionRes.results?.[0] || {};

      return Response.json({
        totalMailboxes: totalMailboxesRes.results?.[0]?.count || 0,
        totalMessages: totalMessagesRes.results?.[0]?.count || 0,
        todayMailboxes: todayMailboxesRes.results?.[0]?.count || 0,
        todayMessages: todayMessagesRes.results?.[0]?.count || 0,
        trend: trendRes.results || [],
        activeMailboxes: (activeMailboxesRes.results || []).map(item => ({
          address: item.address,
          count: item.count
        })),
        sourceDomains: (sourceDomainsRes.results || []).map(item => ({
          domain: item.domain,
          count: item.count
        })),
        mailboxDomains,
        permissionStats: {
          canLogin: permissionData.can_login || 0,
          cannotLogin: permissionData.cannot_login || 0,
          defaultPassword: permissionData.default_password || 0,
          customPassword: permissionData.custom_password || 0
        }
      });
    } catch (e) {
      console.error('获取统计数据失败:', e);
      return new Response('获取统计数据失败: ' + e.message, { status: 500 });
    }
  }

  // ================= 邮箱密码管理 =================
  if (path === '/api/mailbox/password' && request.method === 'PUT') {
    if (isMock) return new Response('演示模式不可修改密码', { status: 403 });
    
    try {
      const body = await request.json();
      const { currentPassword, newPassword } = body;
      
      if (!currentPassword || !newPassword) {
        return new Response('当前密码和新密码不能为空', { status: 400 });
      }
      
      if (newPassword.length < 6) {
        return new Response('新密码长度至少6位', { status: 400 });
      }
      
      const payload = getJwtPayload();
      const mailboxAddress = payload?.mailboxAddress;
      const mailboxId = payload?.mailboxId;
      
      if (!mailboxAddress || !mailboxId) {
        return new Response('未找到邮箱信息', { status: 401 });
      }
      
      // 验证当前密码
      const { results } = await db.prepare('SELECT password_hash FROM mailboxes WHERE id = ? AND address = ?')
        .bind(mailboxId, mailboxAddress).all();
      
      if (!results || results.length === 0) {
        return new Response('邮箱不存在', { status: 404 });
      }
      
      const mailbox = results[0];
      let currentPasswordValid = false;
      
      if (mailbox.password_hash) {
        // 如果有存储的密码哈希，验证哈希密码
        const { verifyPassword } = await import('./authentication.js');
        currentPasswordValid = await verifyPassword(currentPassword, mailbox.password_hash);
      } else {
        // 兼容性：如果没有密码哈希，使用邮箱地址作为默认密码
        currentPasswordValid = (currentPassword === mailboxAddress);
      }
      
      if (!currentPasswordValid) {
        return new Response('当前密码错误', { status: 400 });
      }
      
      // 生成新密码哈希
      const { hashPassword } = await import('./authentication.js');
      const newPasswordHash = await hashPassword(newPassword);
      
      // 更新密码
      await db.prepare('UPDATE mailboxes SET password_hash = ? WHERE id = ?')
        .bind(newPasswordHash, mailboxId).run();
      
      return Response.json({ success: true, message: '密码修改成功' });
      
    } catch (error) {
      console.error('修改密码失败:', error);
      return new Response('修改密码失败', { status: 500 });
    }
  }

  // ================= 用户注册申请 =================
  // 提交注册申请（公开接口）
  if (path === '/api/register' && request.method === 'POST') {
    try {
      const body = await request.json();
      const localPart = String(body.local_part || '').trim().toLowerCase();
      const domain = String(body.domain || '').trim().toLowerCase();
      const password = String(body.password || '').trim();

      // 验证参数
      if (!localPart || !domain || !password) {
        return new Response('用户名、域名和密码不能为空', { status: 400 });
      }

      // 验证用户名格式
      if (!/^[a-z0-9._-]{1,64}$/i.test(localPart)) {
        return new Response('用户名格式不正确（只能包含字母、数字、点、下划线、横线）', { status: 400 });
      }

      // 验证密码长度
      if (password.length < 6) {
        return new Response('密码长度至少6位', { status: 400 });
      }

      // 验证域名是否在允许列表中
      const domains = isMock ? MOCK_DOMAINS : (Array.isArray(mailDomains) ? mailDomains : [(mailDomains || 'temp.example.com')]);
      if (!domains.map(d => d.toLowerCase()).includes(domain)) {
        return new Response('不支持的域名', { status: 400 });
      }

      const fullAddress = `${localPart}@${domain}`;

      // 检查邮箱是否已存在
      const exists = await checkMailboxExists(db, fullAddress);
      if (exists) {
        return new Response('该邮箱地址已被使用', { status: 409 });
      }

      // 检查是否已有待审核的申请
      const { results: pendingResults } = await db.prepare(
        'SELECT id FROM mailbox_registrations WHERE local_part = ? AND domain = ? AND status = ?'
      ).bind(localPart, domain, 'pending').all();
      if (pendingResults && pendingResults.length > 0) {
        return new Response('该邮箱已有待审核的申请，请等待管理员审核', { status: 409 });
      }

      // 生成密码哈希
      const passwordHash = await sha256Hex(password);

      // 创建注册申请
      await db.prepare(
        'INSERT INTO mailbox_registrations (local_part, domain, password_hash, status) VALUES (?, ?, ?, ?)'
      ).bind(localPart, domain, passwordHash, 'pending').run();

      return Response.json({ success: true, message: '注册申请已提交，请等待管理员审核' });
    } catch (e) {
      console.error('提交注册申请失败:', e);
      if (e.message && e.message.includes('UNIQUE constraint failed')) {
        return new Response('该邮箱已有注册申请', { status: 409 });
      }
      return new Response('提交申请失败: ' + e.message, { status: 500 });
    }
  }

  // 获取注册申请列表（仅管理员）
  if (path === '/api/registrations' && request.method === 'GET') {
    if (isMock) {
      return Response.json([
        { id: 1, local_part: 'demo', domain: 'exa.cc', status: 'pending', created_at: new Date().toISOString() },
        { id: 2, local_part: 'test', domain: 'exr.yp', status: 'approved', created_at: new Date().toISOString() }
      ]);
    }
    if (!isStrictAdmin()) {
      return new Response('仅管理员可用', { status: 403 });
    }
    try {
      const status = url.searchParams.get('status') || '';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10), 0);

      let query = 'SELECT id, local_part, domain, status, created_at, reviewed_at, rejection_reason FROM mailbox_registrations';
      let params = [];

      if (status) {
        query += ' WHERE status = ?';
        params.push(status);
      }

      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const { results } = await db.prepare(query).bind(...params).all();

      // 获取待审核数量
      const { results: countResults } = await db.prepare(
        'SELECT COUNT(*) as count FROM mailbox_registrations WHERE status = ?'
      ).bind('pending').all();
      const pendingCount = countResults?.[0]?.count || 0;

      return Response.json({
        registrations: results || [],
        pendingCount
      });
    } catch (e) {
      console.error('获取注册申请列表失败:', e);
      return new Response('获取申请列表失败', { status: 500 });
    }
  }

  // 批准注册申请（仅管理员）
  if (path.match(/^\/api\/registrations\/\d+\/approve$/) && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!isStrictAdmin()) return new Response('仅管理员可用', { status: 403 });

    const id = path.split('/')[3];
    try {
      // 获取申请信息
      const { results } = await db.prepare(
        'SELECT id, local_part, domain, password_hash, status FROM mailbox_registrations WHERE id = ?'
      ).bind(id).all();

      if (!results || results.length === 0) {
        return new Response('申请不存在', { status: 404 });
      }

      const registration = results[0];
      if (registration.status !== 'pending') {
        return new Response('该申请已处理过', { status: 400 });
      }

      const fullAddress = `${registration.local_part}@${registration.domain}`;

      // 检查邮箱是否已存在
      const exists = await checkMailboxExists(db, fullAddress);
      if (exists) {
        // 邮箱已存在，标记申请为已拒绝
        await db.prepare(
          'UPDATE mailbox_registrations SET status = ?, reviewed_at = ?, rejection_reason = ? WHERE id = ?'
        ).bind('rejected', new Date().toISOString(), '邮箱地址已被占用', id).run();
        return new Response('邮箱地址已被占用', { status: 409 });
      }

      // 创建邮箱
      const mailboxId = await getOrCreateMailboxId(db, fullAddress);

      // 设置密码和登录权限
      await db.prepare(
        'UPDATE mailboxes SET password_hash = ?, can_login = 1 WHERE id = ?'
      ).bind(registration.password_hash, mailboxId).run();

      // 更新申请状态
      await db.prepare(
        'UPDATE mailbox_registrations SET status = ?, reviewed_at = ? WHERE id = ?'
      ).bind('approved', new Date().toISOString(), id).run();

      return Response.json({ success: true, address: fullAddress });
    } catch (e) {
      console.error('批准注册申请失败:', e);
      return new Response('批准申请失败: ' + e.message, { status: 500 });
    }
  }

  // 拒绝注册申请（仅管理员）
  if (path.match(/^\/api\/registrations\/\d+\/reject$/) && request.method === 'POST') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!isStrictAdmin()) return new Response('仅管理员可用', { status: 403 });

    const id = path.split('/')[3];
    try {
      const body = await request.json();
      const reason = String(body.reason || '').trim() || '申请被拒绝';

      // 获取申请信息
      const { results } = await db.prepare(
        'SELECT id, status FROM mailbox_registrations WHERE id = ?'
      ).bind(id).all();

      if (!results || results.length === 0) {
        return new Response('申请不存在', { status: 404 });
      }

      if (results[0].status !== 'pending') {
        return new Response('该申请已处理过', { status: 400 });
      }

      // 更新申请状态
      await db.prepare(
        'UPDATE mailbox_registrations SET status = ?, reviewed_at = ?, rejection_reason = ? WHERE id = ?'
      ).bind('rejected', new Date().toISOString(), reason, id).run();

      return Response.json({ success: true });
    } catch (e) {
      console.error('拒绝注册申请失败:', e);
      return new Response('拒绝申请失败: ' + e.message, { status: 500 });
    }
  }

  // 删除注册申请（仅管理员）
  if (path.match(/^\/api\/registrations\/\d+$/) && request.method === 'DELETE') {
    if (isMock) return new Response('演示模式不可操作', { status: 403 });
    if (!isStrictAdmin()) return new Response('仅管理员可用', { status: 403 });

    const id = path.split('/')[3];
    try {
      const result = await db.prepare('DELETE FROM mailbox_registrations WHERE id = ?').bind(id).run();
      const deleted = (result?.meta?.changes || 0) > 0;
      return Response.json({ success: deleted });
    } catch (e) {
      console.error('删除注册申请失败:', e);
      return new Response('删除申请失败: ' + e.message, { status: 500 });
    }
  }

  // ================= 邮箱导出功能 =================
  if (path === '/api/mailboxes/export' && request.method === 'GET') {
    if (isMock) return new Response('演示模式不可导出', { status: 403 });
    if (!isStrictAdmin()) return new Response('仅管理员可用', { status: 403 });

    try {
      const { results } = await db.prepare(`
        SELECT
          address,
          created_at,
          CASE WHEN can_login = 1 THEN '允许' ELSE '禁止' END as login_permission,
          CASE WHEN password_hash IS NULL OR password_hash = '' THEN '默认' ELSE '自定义' END as password_type
        FROM mailboxes
        ORDER BY created_at DESC
      `).all();

      // 生成CSV内容
      const headers = ['邮箱地址', '创建时间', '登录权限', '密码类型'];
      const csvLines = [headers.join(',')];

      for (const row of (results || [])) {
        const line = [
          `"${row.address}"`,
          `"${row.created_at || ''}"`,
          `"${row.login_permission}"`,
          `"${row.password_type}"`
        ].join(',');
        csvLines.push(line);
      }

      const csvContent = '\uFEFF' + csvLines.join('\r\n'); // 添加BOM以支持Excel中文显示
      const responseHeaders = new Headers({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="mailboxes_${new Date().toISOString().split('T')[0]}.csv"`
      });

      return new Response(csvContent, { headers: responseHeaders });
    } catch (e) {
      console.error('导出邮箱列表失败:', e);
      return new Response('导出失败: ' + e.message, { status: 500 });
    }
  }

  return new Response('未找到 API 路径', { status: 404 });
}

export async function handleEmailReceive(request, db, env) {
  try {
    const emailData = await request.json();
    const to = String(emailData?.to || '');
    const from = String(emailData?.from || '');
    const subject = String(emailData?.subject || '(无主题)');
    const text = String(emailData?.text || '');
    const html = String(emailData?.html || '');

    const mailbox = extractEmail(to);
    const sender = extractEmail(from);
    const mailboxId = await getOrCreateMailboxId(db, mailbox);

    // 构造简易 EML 存入数据库
    const now = new Date();
    const dateStr = now.toUTCString();
    const boundary = 'mf-' + (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
    let eml = '';
    if (html) {
      eml = [
        `From: <${sender}>`,
        `To: <${mailbox}>`,
        `Subject: ${subject}`,
        `Date: ${dateStr}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        text || '',
        `--${boundary}`,
        'Content-Type: text/html; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        html,
        `--${boundary}--`,
        ''
      ].join('\r\n');
    } else {
      eml = [
        `From: <${sender}>`,
        `To: <${mailbox}>`,
        `Subject: ${subject}`,
        `Date: ${dateStr}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="utf-8"',
        'Content-Transfer-Encoding: 8bit',
        '',
        text || '',
        ''
      ].join('\r\n');
    }

    const previewBase = (text || html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const preview = String(previewBase || '').slice(0, 120);
    let verificationCode = '';
    try {
      verificationCode = extractVerificationCode({ subject, text, html });
    } catch (_) {}

    // 直接使用标准列名插入（表结构已在初始化时固定）
    await db.prepare(`
      INSERT INTO messages (mailbox_id, sender, to_addrs, subject, verification_code, preview, raw_content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      mailboxId,
      sender,
      String(to || ''),
      subject || '(无主题)',
      verificationCode || null,
      preview || null,
      eml || ''
    ).run();

    return Response.json({ success: true });
  } catch (error) {
    console.error('处理邮件时出错:', error);
    return new Response('处理邮件失败', { status: 500 });
  }
}

