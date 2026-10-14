'use strict';
/* IP 白名单 / 访问限制（防 offset2scan 那类扫描器摸到管理接口）
 * 支持三种写法混用：
 *   192.168.1.20        单个 IPv4
 *   192.168.1.0/24     CIDR 网段（IPv4）
 *   2001:db8::1        单个 IPv6
 *   ::1                 loopback（永远放行，不给用户锁死自己）
 * 反代说明：默认只认 socket 真实对端地址；只有显式设置 HMP_TRUST_PROXY=1 时才采信
 *   X-Forwarded-For 的第一段（Cloudflare/NGINX 反代后不设置这项会把所有人认成反代 IP）。
 */

function parseIp(s) {
  const str = String(s || '').trim().replace(/^\[|\]$/g, '');
  if (!str) return null;
  if (str.includes(':')) {
    // IPv6 → 展开为 16 字节（处理 :: 压缩与内嵌 IPv4）
    let head = str, tail = '';
    const v4m = str.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (v4m) {
      const b = v4m[1].split('.').map(Number);
      if (b.length !== 4 || b.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
      tail = b.map((x) => ((x >> 8) & 255).toString(16).padStart(2, '0') + (x & 255).toString(16).padStart(2, '0')).join('');
      head = str.slice(0, str.length - v4m[1].length).replace(/:$/, '') || '::';
    }
    const dbl = head.indexOf('::');
    const conv = (x) => x.split(':').filter(Boolean).map((g) => parseInt(g, 16));
    let groups;
    if (dbl >= 0) {
      const l = conv(head.slice(0, dbl));
      const r = conv(head.slice(dbl + 2));
      const fill = new Array(8 - l.length - r.length).fill(0);
      groups = [...l, ...fill, ...r];
    } else {
      groups = conv(head);
    }
    if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
    if (tail) groups.splice(6, 2, parseInt(tail.slice(0, 4), 16), parseInt(tail.slice(4), 16));
    return { v: 6, n: groups };
  }
  const b = str.split('.');
  if (b.length !== 4) return null;
  const n = b.map((x) => Number(x));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return { v: 4, n };
}

function toBits(ip) {
  /* IPv4 每段就是一个字节（0~255）→ 每段 8 位、总 32 位；
     切勿再拆高低字节（会得到 64 位串，前缀比较必然错位） */
  if (ip.v === 4) return ip.n.map((x) => (x & 255).toString(2).padStart(8, '0')).join('');
  return ip.n.map((g) => g.toString(2).padStart(16, '0')).join('');
}

function isLoopback(s) {
  const ip = parseIp(s);
  if (!ip) return false;
  if (ip.v === 4) return ip.n[0] === 127;
  return ip.n.every((g, i) => (i < 7 ? g === 0 : g <= 1));
}

/** listText：逗号/空格/换行分隔的条目；返回规范化后的条目数组 */
function parseList(listText) {
  return String(listText || '')
    .split(/[\s,;，、]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^([^/]+)\/(\d{1,3})$/);
      if (!m) return { raw: s, ip: s, bits: null };
      const bits = Math.max(0, Math.min(m[1].includes(':') ? 128 : 32, parseInt(m[2], 10)));
      return { raw: s, ip: m[1], bits };
    })
    .filter((e) => !!parseIp(e.ip));
}

function match(ipStr, listText) {
  const ip = parseIp(ipStr);
  if (!ip) return false;
  const myBits = toBits(ip);
  for (const e of parseList(listText)) {
    const t = parseIp(e.ip);
    if (!t || t.v !== ip.v) continue;
    const len = e.bits == null ? (t.v === 4 ? 32 : 128) : e.bits;
    if (myBits.slice(0, len) === toBits(t).slice(0, len)) return true;
  }
  return false;
}

module.exports = { parseIp, isLoopback, parseList, match };
