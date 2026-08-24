import tls from 'node:tls';

function b64(value) { return Buffer.from(String(value), 'utf8').toString('base64'); }
function headerB64(value) { return `=?UTF-8?B?${b64(value)}?=`; }
function smtpError(code, message) { const error = new Error(message); error.code = code; return error; }

function smtpSession({ host = 'smtp.qq.com', port = 465, timeoutMs = 20000 } = {}) {
  const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
  socket.setEncoding('utf8');
  let buffer = '';
  let closed = false;
  const waiters = [];

  const failAll = error => {
    while (waiters.length) waiters.shift().reject(error);
  };
  const readReply = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(smtpError('SMTP_TIMEOUT', 'QQ SMTP 响应超时。')), timeoutMs);
    waiters.push({ resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    consume();
  });
  const consume = () => {
    while (true) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
      buffer = buffer.slice(lineEnd + 1);
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match || match[2] !== ' ') continue;
      const waiter = waiters.shift();
      if (waiter) waiter.resolve({ code: Number(match[1]), text: match[3] });
    }
  };
  socket.on('data', chunk => { buffer += chunk; consume(); });
  socket.once('error', error => failAll(smtpError('SMTP_CONNECTION_FAILED', `QQ SMTP 连接失败：${error.message}`)));
  socket.once('close', () => { closed = true; failAll(smtpError('SMTP_CONNECTION_FAILED', 'QQ SMTP 连接已关闭。')); });
  const command = async (text, expected, errorCode = 'SMTP_COMMAND_FAILED') => {
    if (closed) throw smtpError('SMTP_CONNECTION_FAILED', 'QQ SMTP 连接已关闭。');
    socket.write(`${text}\r\n`);
    const reply = await readReply();
    if (!expected.includes(reply.code)) throw smtpError(errorCode, `QQ SMTP 返回错误 ${reply.code}。`);
    return reply;
  };
  return { socket, readReply, command, close: () => { if (!closed) socket.end(); } };
}

export async function sendEmail({ sender, authCode, recipient, subject, text, host = 'smtp.qq.com', port = 465 }) {
  if (!sender || !authCode || !recipient) throw Object.assign(new Error('邮件发送信息不完整。'), { code: 400 });
  const session = smtpSession({ host, port });
  try {
    const greeting = await session.readReply();
    if (greeting.code !== 220) throw smtpError('SMTP_CONNECTION_FAILED', `QQ SMTP 返回错误 ${greeting.code}。`);
    await session.command('EHLO careerpilot.local', [250], 'SMTP_CONNECTION_FAILED');
    await session.command('AUTH LOGIN', [334], 'SMTP_AUTH_FAILED');
    await session.command(b64(sender), [334], 'SMTP_AUTH_FAILED');
    await session.command(b64(authCode), [235], 'SMTP_AUTH_FAILED');
    await session.command(`MAIL FROM:<${sender}>`, [250], 'SMTP_SENDER_REJECTED');
    await session.command(`RCPT TO:<${recipient}>`, [250, 251], 'SMTP_RECIPIENT_REJECTED');
    await session.command('DATA', [354], 'SMTP_SEND_FAILED');
    const body = String(text || '').replace(/\r?\n/g, '\r\n').split('\r\n').map(line => line.startsWith('.') ? `.${line}` : line).join('\r\n');
    session.socket.write(`From: CareerPilot <${sender}>\r\nTo: ${recipient}\r\nSubject: ${headerB64(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n.\r\n`);
    const accepted = await session.readReply();
    if (![250].includes(accepted.code)) throw smtpError('SMTP_SEND_FAILED', `QQ SMTP 返回错误 ${accepted.code}。`);
    try { await session.command('QUIT', [221, 250]); } catch (_) { /* message is already accepted */ }
    return { ok: true, smtp_code: accepted.code };
  } finally {
    session.close();
  }
}
