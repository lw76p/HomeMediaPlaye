'use strict';
/* 纯 Node 零依赖 FunASR WebSocket 离线转写客户端
 *
 * 对接 FunASR 官方 funasr_wss_server.py 的 offline 模式：
 *   1) 首帧 JSON 配置（mode=offline / chunk_size / language / use_itn）
 *   2) 二进制帧发整段 wav（16k 单声道）
 *   3) 末帧 JSON 触发 flush（is_speaking=false + backend/mode）
 *   4) 收到含 result 的 JSON 即出字
 *
 * 为什么不用 ws 库：HMP 是纯 Node 内置零依赖（NAS 上 app/node_modules 都不存在），
 * 引第三方包要往交付包塞 node_modules，膨胀安装程序。故自实现 RFC6455 握手 + 帧编解码。
 *
 * 仅客户端→服务端帧加掩码（RFC6455 强制）；服务端→客户端帧不掩码。
 */
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_TIMEOUT = 120000;

function buildKey() { return crypto.randomBytes(16).toString('base64'); }
function acceptKey(key) { return crypto.createHash('sha1').update(key + GUID).digest('base64'); }

// 编码一帧（客户端发送必须 mask）
function encodeFrame(opcode, payload, mask) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.alloc(2);
  else if (len < 65536) header = Buffer.alloc(4);
  else header = Buffer.alloc(10);
  header[0] = 0x80 | (opcode & 0x0f); // FIN=1
  let pos = 2;
  if (len < 126) header[1] = (mask ? 0x80 : 0) | len;
  else if (len < 65536) { header[1] = (mask ? 0x80 : 0) | 126; header.writeUInt16BE(len, 2); pos = 4; }
  else { header[1] = (mask ? 0x80 : 0) | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); pos = 10; }
  if (!mask) return Buffer.concat([header.subarray(0, pos), payload]);
  const m = crypto.randomBytes(4);
  const out = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ m[i & 3];
  return Buffer.concat([header.subarray(0, pos), m, out]);
}

// 解析服务端帧（可能分片、可能粘包），剩余不足一帧时返回未消费缓冲
function parseFrames(buf, onFrame) {
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = off + 2;
    if (len === 126) { if (buf.length - pos < 2) break; len = buf.readUInt16BE(pos); pos += 2; }
    else if (len === 127) { if (buf.length - pos < 8) break; len = Number(buf.readBigUInt64BE(pos)); pos += 8; }
    let maskKey = null;
    if (masked) { if (buf.length - pos < 4) break; maskKey = buf.subarray(pos, pos + 4); pos += 4; }
    if (buf.length - pos < len) break;
    let payload = buf.subarray(pos, pos + len);
    if (masked) { const o = Buffer.alloc(len); for (let i = 0; i < len; i++) o[i] = payload[i] ^ maskKey[i & 3]; payload = o; }
    buf = buf.subarray(pos + len); off = 0;
    onFrame(opcode, payload, fin);
  }
  return buf;
}

function transcribe(url, wavBuf, { lang = 'auto', timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('ASR 地址格式错误：' + url)); }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return reject(new Error('ASR 地址必须是 ws:// 或 wss://'));
    const host = u.hostname;
    const port = u.port || (u.protocol === 'wss:' ? 443 : 80);
    const reqPath = (u.pathname || '/') + (u.search || '');
    const key = buildKey();
    const reqHeaders = [
      `GET ${reqPath} HTTP/1.1`, `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Protocol: binary', '\r\n',
    ].join('\r\n');
    const sock = (u.protocol === 'wss:' ? tls : net).connect(Number(port), host, () => { sock.write(reqHeaders); });

    let settled = false;
    let handshaken = false;
    let buf = Buffer.alloc(0);
    let result = null;
    let fragBuf = null;
    let fragOpcode = null;
    let timer = setTimeout(() => cleanup(new Error('ASR 超时')), timeout);

    function cleanup(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      if (err) reject(err); else resolve(result);
    }
    function sendText(obj) { sock.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'), true)); }
    function sendBin(b) { sock.write(encodeFrame(0x2, b, true)); }

    sock.on('error', (e) => cleanup(e));
    sock.on('close', () => { cleanup(handshaken ? null : new Error('ASR 连接关闭（未握手）')); });
    sock.on('data', (d) => {
      if (settled) return;
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString('latin1');
        if (!/ 101 /.test(head)) return cleanup(new Error('ASR 握手失败：' + head.slice(0, 80)));
        // 校验 accept（防御）
        const ak = head.match(/sec-websocket-accept:\s*([^\r\n]+)/i);
        if (ak && acceptKey(key) !== ak[1].trim()) return cleanup(new Error('ASR 握手 accept 校验失败'));
        buf = buf.subarray(idx + 4);
        handshaken = true;
        // 发送：配置 → 音频 → flush（官方 offline 客户端只发这三帧；
        // 额外发 {backend,mode} 会让服务端不回 result，已删除）。language 空串=服务端自动判定。
        sendText({ mode: 'offline', wav_name: 'hmp-seg.wav', wav_format: 'wav', is_speaking: true, chunk_size: [5, 10, 5], language: (lang && lang !== 'auto') ? lang : '', use_itn: true });
        // 关键：必须按 60ms 切片逐帧发，不能把整段 wav 塞成一个巨帧。
        // 服务端 async_vad 每收到一个二进制帧就跑一次 VAD，且仅当 len(segments_result)==1
        // 才返回起止点；一次喂几十秒音频会返回多段/空段 → speech_start 永假 →
        // frames_asr 恒空 → 最终只回空 text。60ms = 16kHz/16bit 单声道 1920 字节，
        // 与服务端 duration_ms = len//32 的假设一致。
        const CHUNK = 1920;
        const total = wavBuf.length;
        let off = 0;
        do {
          const end = Math.min(off + CHUNK, total);
          sendBin(wavBuf.subarray(off, end));
          off = end;
        } while (off < total);
        sendText({ is_speaking: false });
      }
      buf = parseFrames(buf, (opcode, payload, fin) => {
        if (opcode === 0x8) return cleanup(null); // close
        if (opcode === 0x1 || opcode === 0x2) {
          if (!fin) { if (fragOpcode === null) fragOpcode = opcode; fragBuf = fragBuf ? Buffer.concat([fragBuf, payload]) : payload; return; }
          const data = fragBuf ? Buffer.concat([fragBuf, payload]) : payload;
          fragBuf = null; fragOpcode = null;
          if (opcode === 0x1) {
            let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
            // FunASR 官方 funasr_wss_server.py 返回 {mode,text,wav_name,is_final}；
            // 部分云端服务返回 {result}。两者都要认，否则永远不出字。
            const raw = msg && (msg.text != null ? msg.text : msg.result);
            if (raw != null && raw !== '') {
              const r = Array.isArray(raw) ? raw.join(' ') : String(raw);
              if (r && r.trim()) { result = r; cleanup(null); }
            }
          }
        }
      });
    });
  });
}

// 连通性探测：仅做 TCP + WebSocket 握手，不发送音频。用于设置页「测试连接」按钮，
// 从服务端（NAS）侧真连，告诉用户地址到底通不通。握手 101 即视为可达。
function ping(url, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: 'ASR 地址格式错误' }); }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return resolve({ ok: false, error: 'ASR 地址必须是 ws:// 或 wss://' });
    const host = u.hostname;
    const port = u.port || (u.protocol === 'wss:' ? 443 : 80);
    const reqPath = (u.pathname || '/') + (u.search || '');
    const key = buildKey();
    const reqHeaders = [
      `GET ${reqPath} HTTP/1.1`, `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Protocol: binary', '\r\n',
    ].join('\r\n');
    const sock = (u.protocol === 'wss:' ? tls : net).connect(Number(port), host, () => { sock.write(reqHeaders); });
    let done = false, buf = Buffer.alloc(0), handshaken = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve({ ok: false, error: `连接超时（${timeout / 1000}s 内无响应，服务可能未启动 / 端口未开放 / 防火墙拦截）` });
    }, timeout);
    function fin(r) {
      if (done) return;
      done = true; clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(r);
    }
    sock.on('error', (e) => fin({ ok: false, error: '连接失败：' + e.message }));
    sock.on('close', () => { if (!handshaken) fin({ ok: false, error: '连接被关闭（未握手，服务可能不在 10095 监听）' }); else fin({ ok: true }); });
    sock.on('data', (d) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString('latin1');
        if (!/ 101 /.test(head)) return fin({ ok: false, error: 'WebSocket 握手失败：' + head.slice(0, 80) });
        handshaken = true;
        fin({ ok: true });
      }
    });
  });
}

module.exports = { transcribe, ping, encodeFrame, parseFrames, acceptKey, buildKey };
