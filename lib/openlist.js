'use strict';
/* ============================================================
 * 网盘快捷入口 —— OpenList 管理端客户端
 * ------------------------------------------------------------
 * 背景：OpenList 把 90+ 家网盘桥接成标准 WebDAV。它的「添加存储」
 * 本来要用户自己打开管理页、翻驱动列表、挨个填 Cookie/Token —— 对
 * 家里用户门槛太高。本模块把这件事收进影视库设置页：
 *   「设置 › 网盘与本地目录 › 挂载网盘」点一下网盘名，弹窗里授权，
 *   授权成功后自动添加存储、自动回填 WebDAV 地址并挂载。
 *
 * OpenList 管理 API（v4.x，端口 LOCALHOST:<port>）：
 *   POST /api/auth/login          {username,password} → {token}
 *   GET  /api/admin/driver/list   驱动全量定义
 *   GET  /api/admin/driver/info?driver=<name>
 *   GET  /api/admin/storage/list  已添加存储
 *   POST /api/admin/storage/create
 *   POST /api/admin/storage/update
 *   POST /api/admin/storage/delete {id}
 *   POST /api/admin/storage/enable|disable {id}
 *
 * ★ 安全：本模块只在 127.0.0.1 上访问 OpenList，账号密码取自
 *   同级 openlist/.env（不落库、不外发、日志不打）。
 * ============================================================ */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const webdav = require('./webdav');

const BRIDGE_DIR = path.join(__dirname, '..', '..', 'openlist');

/* ---------------- .env 读取（每次现读，用户改了端口能立刻生效） ---------------- */
function readEnv() {
  const kv = {};
  try {
    const txt = fs.readFileSync(path.join(BRIDGE_DIR, '.env'), 'utf8');
    String(txt).split(/\r?\n/).forEach((l) => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(l);
      if (m) kv[m[1]] = m[2].replace(/^"+|"+$/g, '').trim();
    });
  } catch { /* 没装桥接 */ }
  return kv;
}

/* ---------------- 低层 HTTP（只走 127.0.0.1，带超时） ---------------- */
function request(port, method, apiPath, { body, token, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    if (token) headers.Authorization = token;
    let req;
    try {
      req = http.request(
        { host: '127.0.0.1', port, path: apiPath, method, headers, timeout: timeoutMs },
        (res) => {
          let b = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { b += c; if (b.length > 4 * 1024 * 1024) { res.destroy(); } });
          res.on('end', () => {
            let json = null;
            try { json = JSON.parse(b); } catch { /* 非 JSON（如 404 页面） */ }
            resolve({ status: res.statusCode, body: b, json });
          });
          res.on('error', reject);
        }
      );
    } catch (e) { reject(e); return; }
    req.on('timeout', () => { req.destroy(new Error('OpenList 接口超时')); });
    req.on('error', (e) => reject(new Error('连接网盘桥接失败：' + e.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------------- 登录（token 缓存，进程内） ---------------- */
/* ★ OpenList 的响应统一是 {code, message, data} —— 真正的业务数据在 data 下。
 * ★ 更关键：**服务一重启，旧 token 立刻失效**（签名密钥每次启动重新生成，
 *   返回 401 "token is invalidated"）。所以 401 必须无脑重登一次，且不能
 *   把 token 缓存太久 —— 家里 NAS 经常重启/更新，缓存久了第一次操作必然失败。 */
const AUTH = { port: 0, token: '', at: 0 };
const TOKEN_TTL = 10 * 60 * 1000;   // 保守 10 分钟；401 会立刻重登兜底

class BridgeOffline extends Error {
  constructor(msg) { super(msg || '网盘桥接未在运行'); this.code = 'BRIDGE_OFFLINE'; }
}

/** 取得正在运行的桥接端口（只认本目录实例） */
async function activePort() {
  const b = await webdav.probeBridge();
  if (!b || !b.running || !b.own) throw new BridgeOffline();
  return { port: b.port, user: b.user, pass: b.pass };
}

async function login(force) {
  const { port, user, pass } = await activePort();
  if (!force && AUTH.token && AUTH.port === port && Date.now() - AUTH.at < TOKEN_TTL) {
    return AUTH.token;
  }
  if (!pass) throw new Error('网盘桥接缺少管理员密码（openlist/.env 不完整，请重跑 install-openlist.sh）');
  const r = await request(port, 'POST', '/api/auth/login', { body: { username: user || 'admin', password: pass } });
  const token = r.json && r.json.data && r.json.data.token;
  if (r.status !== 200 || !token) {
    const msg = (r.json && r.json.message) || ('HTTP ' + r.status);
    // 密码不对是最常见的一种：.env 里的密码和数据库里没对齐
    throw new Error(r.status === 200 || r.status === 401
      ? '网盘桥接登录失败：账号密码不匹配 —— 在 NAS 上重跑 sh openlist/install-openlist.sh 可自动校准'
      : '网盘桥接登录失败：' + msg);
  }
  AUTH.port = port; AUTH.token = token; AUTH.at = Date.now();
  return token;
}

/** 带自动续期的管理接口调用（token 失效 → 重登一次；服务重启后旧 token 必失效） */
async function admin(method, apiPath, body) {
  const { port } = await activePort();
  let token = await login();
  let r = await request(port, method, apiPath, { body, token });
  const expired = r.json && (r.json.code === 401 || /invalidated|token is/i.test(String(r.json.message || '')));
  if (r.status === 401 || expired) {
    token = await login(true);                    // 强制重登
    r = await request(port, method, apiPath, { body, token });
  }
  if (r.status !== 200 || (r.json && r.json.code && r.json.code !== 200)) {
    const msg = (r.json && r.json.message) || ('HTTP ' + r.status);
    throw new Error('网盘桥接接口错误：' + msg);
  }
  return r.json ? r.json.data : null;
}

/* ============================================================
 * 网盘目录（给前端渲染一排快捷按钮）
 * ------------------------------------------------------------
 * auth 取值说明：
 *   'form'  纯表单：用户在弹窗里填几项就能加（账号密码 / Token）
 *   'qrcode'扫码：调 OpenList 拿二维码 → 用户手机扫 → 轮询拿结果
 *   'oauth' OAuth：给一个授权链接 → 用户点开授权 → 轮询拿 token
 *   'cookie'手抓：网盘没开放接口，只能引导用户从浏览器复制 Cookie
 *   'guide' 变通：OpenList 无专用驱动，走通用协议（如 WebDAV/Alias）
 *
 * fields 里每一项：
 *   key        写入 OpenList storage 的字段名
 *   label      界面显示名
 *   type       text | password | url | select | number
 *   required   是否必填
 *   placeholder/help  提示
 *   options    select 用
 * ============================================================ */
const DRIVES = [
  {
    id: 'aliyun',
    name: '阿里云盘',
    icon: '🟠',
    color: '#ff6a00',
    driver: 'AliyundriveOpen',
    auth: 'oauth',
    blurb: '扫码或点链接授权，自动获取 refresh_token',
    help: '点「开始授权」后会打开阿里云盘官方授权页；登录并同意后把拿到的 refresh_token 粘回来即可。'
      + '若你已在别处拿过 token，也可以直接粘贴。',
    fields: [
      { key: 'refresh_token', label: 'refresh_token', type: 'password', required: true,
        placeholder: '授权后得到的 refresh_token', help: '阿里云盘 Open API 的长期令牌，形如一串字母数字' },
      { key: 'root_folder_id', label: '根目录 ID', type: 'text', required: false, placeholder: '留空 = 网盘根目录' },
      { key: 'drive_type', label: '空间类型', type: 'select', required: false, def: 'default',
        options: [['default', '个人云盘（默认）'], ['resource', '资源库'], ['backup', '备份盘']] },
    ],
    /* 2026-09-27 恢复入口（曾因缺在线续期参数禁用）：根因有两个——
     * ① OpenList API 直建存储不填 schema 默认值，缺 use_online_api/api_url_address
     *    时驱动掉进本地刷新分支，报 "empty ClientID or ClientSecret"；
     * ② 这些布尔参数必须是**真 JSON 布尔**：写 'true' 字符串会报
     *    "UseOnlineAPI: ReadBool: expect t or f, but found \""（8096 实测）。
     * 修法对照 8090/5245 id=7（status=work）的 addition 逐字段校准。 */
    extra: {
      use_online_api: true,          // ★ 布尔，非字符串
      api_url_address: 'https://api.oplist.org/alicloud/renewapi',
      alipan_type: 'default',
      client_id: '',
      client_secret: '',
      rapid_upload: false,           // ★ 布尔
      internal_upload: false,        // ★ 布尔
      livp_download_format: 'jpeg',
      remove_way: 'delete',
    },
    oauth: {
      url: 'https://openapi.alipan.com/oauth/authorize?client_id=76917ccccd4441c39457a04f6084fb2f&redirect_uri=https://alist.nn.ci/tool/aliyundrive/callback&scope=user:base,file:all:read,file:all:write&response_type=code',
      tip: '授权后把回调页显示的 refresh_token 复制粘贴到下面',
    },
  },
  {
    id: 'baidu',
    name: '百度网盘',
    icon: '🔵',
    color: '#2b6cff',
    driver: 'BaiduNetdisk',
    auth: 'form',
    blurb: '填 refresh_token 即可（Open API）',
    help: '百度网盘需要一个 refresh_token。点下方「打开授权页」进入 OpenList 官方工具，'
      + '选择「百度网盘」、勾选「使用 OpenList 提供的参数」，点「获取 Token」后把 refresh_token 粘回来。',
    fields: [
      { key: 'refresh_token', label: 'refresh_token', type: 'password', required: true, placeholder: '百度网盘 refresh_token' },
      { key: 'root_folder_path', label: '根目录', type: 'text', required: false, placeholder: '留空 = / （网盘根目录）' },
      { key: 'order_by', label: '排序', type: 'select', required: false, def: 'name',
        options: [['name', '按文件名'], ['time', '按修改时间'], ['size', '按大小']] },
      { key: 'use_online_api', label: '使用在线 API', type: 'select', required: false, def: 'true',
        options: [['true', '是（推荐，免下载）'], ['false', '否']] },
    ],
    /* 2026-09-27 修复：旧 URL 的 client_id 是 YOUR_APP_KEY 占位符，点开百度页必报 client_id 无效；
     * 改走 OpenList 官方工具站（与阿里云盘令牌同一拿法），storage 侧走在线续期（client_id/secret 留空） */
    oauth: {
      url: 'https://api.oplist.org/',
      tip: '选「百度网盘」→ 勾选「使用 OpenList 提供的参数」→ 获取 Token → 复制 refresh_token 粘回来',
    },
    extra: {
      api_url_address: 'https://api.oplist.org/baiduyun/renewapi',
    },
  },
  {
    id: '115',
    name: '115 网盘',
    icon: '🟩',
    color: '#1aad19',
    driver: '115 Cloud',
    auth: 'qrcode',
    blurb: '手机扫码登录，最省事',
    help: '点「获取二维码」后用手机 115 App 扫码，授权完成会自动填入。',
    fields: [
      { key: 'qrcode_token', label: '扫码令牌', type: 'password', required: true, placeholder: '扫码后自动填入' },
      { key: 'qrcode_source', label: '扫码来源', type: 'text', required: false, def: 'android' },
      { key: 'root_folder_id', label: '根目录 ID', type: 'text', required: false, placeholder: '留空 = 根目录' },
    ],
  },
  {
    id: 'quark',
    name: '夸克网盘',
    icon: '🟦',
    color: '#2f6bff',
    driver: 'Quark',
    auth: 'cookie',
    blurb: '需从浏览器复制 Cookie',
    help: '夸克没有开放接口。请在浏览器登录 pan.quark.cn，按 F12 打开开发者工具 → '
      + 'Network → 任一请求 → 复制 Request Headers 里的 Cookie 整串，粘贴到下面。',
    fields: [
      { key: 'cookie', label: 'Cookie', type: 'password', required: true, placeholder: '粘贴完整 Cookie 串',
        help: '必须包含 __puus 字段；有效期约一个月，失效后重新复制即可' },
      { key: 'root_folder_id', label: '根目录 ID', type: 'text', required: false, placeholder: '留空 = 根目录' },
    ],
  },
  {
    id: '189',
    name: '天翼云盘',
    icon: '🟨',
    color: '#f5a623',
    driver: '189CloudPC',
    auth: 'form',
    blurb: '直接填手机号 + 密码',
    help: '天翼云盘支持账号密码直接登录，填完就能用。若账号开了二次验证，'
      + '把收到的短信验证码填到「验证码」一栏。',
    fields: [
      { key: 'username', label: '手机号 / 账号', type: 'text', required: true, placeholder: '天翼云盘登录手机号' },
      { key: 'password', label: '密码', type: 'password', required: true },
      { key: 'validate_code', label: '验证码', type: 'text', required: false, placeholder: '开了二次验证才需要填' },
      { key: 'root_folder_id', label: '根目录 ID', type: 'text', required: false, placeholder: '留空 = 根目录' },
    ],
  },
  {
    id: 'thunder',
    name: '迅雷云盘',
    icon: '🔷',
    color: '#3b82f6',
    driver: 'Thunder',
    auth: 'form',
    blurb: '填迅雷账号密码',
    help: '迅雷云盘支持账号密码登录；若账号有图形验证码，把验证码一并填入。',
    fields: [
      { key: 'username', label: '迅雷账号', type: 'text', required: true, placeholder: '手机号 / 邮箱 / 迅雷号' },
      { key: 'password', label: '密码', type: 'password', required: true },
      { key: 'captcha_token', label: '验证码', type: 'text', required: false, placeholder: '有图形验证码时才填' },
      { key: 'root_folder_id', label: '根目录 ID', type: 'text', required: false, placeholder: '留空 = 根目录' },
    ],
  },
  {
    id: '123',
    name: '123 云盘',
    icon: '🟣',
    color: '#8b5cf6',
    driver: '123Pan',
    auth: 'form',
    blurb: '填 123 云盘账号密码',
    help: '123 云盘支持账号密码直接登录，填完即可。',
    fields: [
      { key: 'username', label: '账号', type: 'text', required: true, placeholder: '123 云盘手机号 / 邮箱' },
      { key: 'password', label: '密码', type: 'password', required: true },
      { key: 'root_folder_id', label: '根目录 ID', type: 'text', required: false, placeholder: '留空 = 根目录' },
    ],
  },
  {
    id: '139',
    name: '移动云盘',
    icon: '🟢',
    color: '#0ea5a4',
    driver: '139Yun',
    auth: 'form',
    blurb: '手机号 + 密码（可加短信码）',
    help: '中国移动云盘，填手机号与密码；若要求短信验证，把收到的验证码填进「短信验证码」。',
    fields: [
      { key: 'username', label: '手机号', type: 'text', required: true, placeholder: '移动云盘手机号' },
      { key: 'password', label: '密码', type: 'password', required: true },
      { key: 'sms_code', label: '短信验证码', type: 'text', required: false, placeholder: '需要时才填' },
      { key: 'root_folder_id', label: '根目录 ID', type: 'text', required: false, placeholder: '留空 = 根目录' },
    ],
  },
  {
    id: 'unicom',
    name: '联通云盘',
    icon: '🟥',
    color: '#d62828',
    driver: 'WebDav',
    auth: 'guide',
    blurb: '联通官方没开放接口 —— 走 WebDAV 变通接入',
    help: 'OpenList 目前没有联通云盘专用驱动（联通官方未开放第三方接口）。'
      + '如果你的联通云盘能拿到 WebDAV 地址（部分套餐赠送的「联通云盘 WebDAV 服务」或通过中转服务），'
      + '填在下面即可当作标准网盘挂载，用法和别的网盘完全一样。\n\n'
      + '没有 WebDAV 也没关系：也可以用「本地目录」把已同步到 NAS 上的联通云盘文件夹直接加进来。',
    fields: [
      { key: 'vendor', label: '服务商', type: 'select', required: false, def: 'other',
        options: [['other', '其他（通用 WebDAV）'], ['custom', '自定义']] },
      { key: 'address', label: 'WebDAV 地址', type: 'url', required: true,
        placeholder: 'https://dav.example.com/联通云盘', help: '联通云盘（或其提供的 WebDAV 中转）的 WebDAV 完整地址' },
      { key: 'username', label: '用户名', type: 'text', required: false },
      { key: 'password', label: '密码', type: 'password', required: false },
      { key: 'root_folder_path', label: '根目录', type: 'text', required: false, placeholder: '留空 = /' },
    ],
  },
];

function driveById(id) {
  return DRIVES.find((d) => d.id === id) || null;
}

/** 对外清单（不含任何凭据；fields 去掉内部字段） */
function catalog() {
  return DRIVES.map((d) => ({
    id: d.id, name: d.name, icon: d.icon, color: d.color,
    driver: d.driver, auth: d.auth, blurb: d.blurb, help: d.help,
    disabled: !!d.disabled, disabledReason: d.disabledReason || '',
    fields: (d.fields || []).map((f) => ({
      key: f.key, label: f.label, type: f.type || 'text',
      required: !!f.required, placeholder: f.placeholder || '',
      help: f.help || '', def: f.def != null ? f.def : '',
      options: f.options || null,
    })),
    oauth: d.oauth ? { url: d.oauth.url, tip: d.oauth.tip } : null,
  }));
}

/* ============================================================
 * 存储管理
 * ============================================================ */

/** 已添加的存储列表（精简字段，不返回凭据）
 *  OpenList 返回 {content:[...], total:n}（不是裸数组），必须兼容两种形态 */
async function listStorages() {
  const data = await admin('GET', '/api/admin/storage/list');
  const arr = Array.isArray(data) ? data : (data && data.content) || [];
  return arr.map((s) => ({
    id: s.id,
    mountPath: s.mount_path,
    driver: s.driver,
    order: s.order,
    status: s.status,
    disabled: !!s.disabled,
    remark: s.remark || '',
  }));
}

const DRIVER_FOR = {
  aliyun: 'AliyundriveOpen', baidu: 'BaiduNetdisk', '115': '115 Cloud',
  quark: 'Quark', '189': '189CloudPC', thunder: 'Thunder', '123': '123Pan',
  '139': '139Yun', unicom: 'WebDav',
};

/** 挂载路径去重：/电影 已存在 → /电影-2 */
async function uniqueMount(dir) {
  const base = String(dir || '').replace(/^\/+|\/+$/g, '') || '网盘';
  let existing = [];
  try { existing = (await listStorages()).map((s) => s.mountPath); } catch { /* 首次添加 */ }
  const taken = new Set(existing);
  if (!taken.has('/' + base)) return '/' + base;
  for (let i = 2; i < 100; i++) {
    if (!taken.has('/' + base + '-' + i)) return '/' + base + '-' + i;
  }
  return '/' + base + '-' + Date.now();
}

/**
 * 添加一个网盘存储。
 * @param {string} driveId  DRIVES 里的 id
 * @param {object} values   用户填的字段（key → value）
 * @param {object} opt      { mountPath }
 */
async function addStorage(driveId, values, opt = {}) {
  const d = driveById(driveId);
  if (!d) throw new Error('未知的网盘类型：' + driveId);
  const driver = (opt.driver || DRIVER_FOR[driveId] || d.driver);

  // 组装 OpenList 的 addition 字段（值统一转字符串，去掉空值）
  const addition = {};
  for (const f of d.fields || []) {
    const raw = values ? values[f.key] : undefined;
    let v = raw == null ? '' : String(raw).trim();
    if (!v && f.def != null && f.def !== '') v = String(f.def);
    if (f.required && !v) throw new Error('「' + f.label + '」不能为空');
    if (v) addition[f.key] = v;
  }
  /* 驱动级固定参数：OpenList API 直建不填 schema 默认值（只在 Web UI 表单预填），
   * 缺了这些字段驱动初始化必失败（如 AliyundriveOpen 报 empty ClientID） */
  if (d.extra) Object.assign(addition, d.extra);

  const mountPath = await uniqueMount(opt.mountPath || d.name);
  const payload = {
    mount_path: mountPath,
    order: 0,
    driver,
    cache_expiration: 30,
    status: 'work',
    addition: JSON.stringify(addition),
    remark: '由家庭影音库添加 · ' + d.name,
    webdav_policy: '302_redirect',
    web_proxy: false,
    enable_sign: false,
    order_by: 'name',
    order_direction: 'asc',
    extract_folder: 'front',
  };
  const created = await admin('POST', '/api/admin/storage/create', payload);
  const newId = created && created.id ? created.id : null;
  return { id: newId, mountPath, driver, name: d.name };
}

/** 把 OpenList 的原始报错翻译成人话（它经常把上游网盘的错直接抛回来）
 *  实测：添加存储时 OpenList 会**真的连一次网盘**，账号/验证码不对会当场报错。 */
function humanizeStorageError(msg) {
  const s = String(msg || '');
  if (/img validate code|<img/i.test(s)) {
    return '该网盘要求图形验证码 —— 请在添加时把验证码一栏填上（OpenList 会返回验证码图片）';
  }
  if (/请输入正确的手机号码|phone/i.test(s)) return '手机号格式不对，请检查后重填';
  if (/username or password|密码错误|invalid.*password|账号或密码/i.test(s)) return '账号或密码不对，请检查后重填';
  if (/already created/i.test(s)) return '该网盘已经添加过了（同名挂载已存在）';
  if (/refresh_token/i.test(s) && /invalid|expired|错误/i.test(s)) return 'refresh_token 无效或已过期，请重新授权获取';
  if (/cookie/i.test(s) && /invalid|expired|错误|失效/i.test(s)) return 'Cookie 已失效，请重新从浏览器复制一份';
  if (/captcha|验证码/i.test(s)) return '需要验证码，请填写后重试';
  if (/timeout|timed out|deadline/i.test(s)) return '连接网盘超时，请检查 NAS 的网络能否访问该网盘';
  return s;
}

/** 启用 / 停用 / 删除
 *  ★ 这三个接口的参数走 **query 字符串**（?id=1），不是 JSON body ——
 *    传 body 会得到 400 `strconv.Atoi: parsing "": invalid syntax`。 */
async function setStorageEnabled(id, on) {
  const p = (on ? '/api/admin/storage/enable' : '/api/admin/storage/disable') + '?id=' + Number(id);
  await admin('POST', p);
  return { ok: true };
}
async function deleteStorage(id) {
  await admin('POST', '/api/admin/storage/delete?id=' + Number(id));
  return { ok: true };
}

/* ============================================================
 * 扫码登录（115 等）：代理到 OpenList 的扫码接口
 * ------------------------------------------------------------
 * 不同版本接口名不一，这里做多路兜底；拿不到就返回 null，
 * 前端会退化成「手动粘贴」引导（不会白屏）。
 * ============================================================ */
async function qrcodeStart(driveId) {
  const d = driveById(driveId);
  if (!d) throw new Error('未知的网盘类型：' + driveId);
  const tries = [
    '/api/admin/driver/qrcode/generate?driver=' + encodeURIComponent(DRIVER_FOR[driveId] || d.driver),
    '/api/admin/driver/qrcode?driver=' + encodeURIComponent(DRIVER_FOR[driveId] || d.driver),
  ];
  for (const p of tries) {
    try {
      const r = await admin('GET', p);
      if (r && (r.qrcode || r.code || r.qr)) return r;
    } catch { /* 换下一个 */ }
  }
  return null;
}

async function qrcodePoll(driveId, token) {
  const tries = [
    '/api/admin/driver/qrcode/check?driver=' + encodeURIComponent(DRIVER_FOR[driveId] || '') + '&token=' + encodeURIComponent(token),
    '/api/admin/driver/qrcode/status?token=' + encodeURIComponent(token),
  ];
  for (const p of tries) {
    try {
      const r = await admin('GET', p);
      if (r) return r;
    } catch { /* 换下一个 */ }
  }
  return null;
}

/* ------------- 把管理页地址 + 账号密码交给前端展示（用户要手登管理页时用） -------------
 * 密码是安装时随机生成的、不再显示给用户，导致「打开网盘管理页」后不知道输什么。
 * 这里只在本目录实例（own:true）下回传凭据；同机别的实例一律不回传。 */
/* 挑一个「用户真能访问到」的局域网地址：
 * NAS 上通常有 docker0/lxcbr0/lxdbr0/br-xxxx/tailscale0 等一堆虚拟网卡，
 * 直接取第一个非内网地址很容易拿到 10.0.5.1（docker0）这种用户根本连不上的地址。
 * 策略：排除 loopback 与已知虚拟网卡名前缀 → 剩下的取第一个。
 * 常见真实网卡：eth0 / ens* / enp* / qvs*（威联通）/ bond* / br0（黑群）/ wlan* */
const VIF = /^(docker|lxcbr|lxdbr|virbr|veth|br-|tailscale|zt|tun|tap|wg|utun|awdl|vmnet|vboxnet|ham)/i;
function lanIp() {
  try {
    const nis = os.networkInterfaces();
    const cands = [];
    for (const name of Object.keys(nis)) {
      if (VIF.test(name)) continue;
      for (const a of nis[name] || []) {
        if (a.family === 'IPv4' && !a.internal) cands.push({ name, ip: a.address });
      }
    }
    if (!cands.length) return '';
    // 家庭/办公常见私网段优先（192.168 > 10. > 172.16-31）
    const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
    cands.sort((a, b) => rank(a.ip) - rank(b.ip));
    return cands[0].ip;
  } catch { /* 拿不到就算了 */ }
  return '';
}

/* 管理页根地址（不含 /dav）—— 网盘管理页在根路径，WebDAV 端点在 /dav。
   并统一出口：前端「打开网盘管理页」与「一键填入」都从这里取，避免两处不一致。 */
function baseUrl(port) {
  const ip = lanIp();
  return (ip ? 'http://' + ip : 'http://127.0.0.1') + ':' + port;
}

async function creds() {
  const b = await webdav.probeBridge();
  if (!b || !b.running) return { running: false, own: false };
  if (!b.own) return { running: true, own: false, port: b.port, url: baseUrl(b.port) };
  const env = readEnv();
  return {
    running: true,
    own: true,
    port: b.port,
    user: b.user || env.OPENLIST_ADMIN_USER || 'admin',
    pass: b.pass || env.OPENLIST_ADMIN_PASS || '',
    // 管理页地址：用 NAS 的局域网 IP（勿用 location.hostname —— 走域名/反代访问
    // 时会拿到域名，而 OpenList 端口是直连的，域名解析不到那个端口）
    url: baseUrl(b.port),
  };
}

/* ============================================================
 * 文件上传（字幕写回网盘用）
 * ------------------------------------------------------------
 * 走 OpenList HTTP API /api/fs/put，不是 WebDAV PUT——
 * 实测 WebDAV 层（/dav）PUT 对普通用户与管理员均返回 403，
 * 而 /api/fs/put 返回 200（见 Temp/hb-dav-put.js vs hb-ol-api-put.js）。
 * @param {string} remotePath 含挂载点的完整路径，如 /阿里云盘/电视剧/最后生还者/xx.chs.srt
 * @param {Buffer} buf        字幕文本（utf8）
 * ★ File-Path 必须整串 encodeURIComponent（/ → %2F，与 OpenList 行为一致）；
 *   Authorization 直传 token（无 Bearer 前缀，与 admin() 一致）；As-Task:false 直接落盘。 */
async function fsPut(remotePath, buf) {
  const { port } = await activePort();
  const token = await login();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/api/fs/put', method: 'PUT',
        headers: {
          'File-Path': encodeURIComponent(remotePath),
          'As-Task': 'false',
          'Authorization': token,
          'Content-Length': String(buf.length),
        },
        timeout: 120000,
      },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { b += c; if (b.length > 1 * 1024 * 1024) res.destroy(); });
        res.on('end', () => {
          let json = null; try { json = JSON.parse(b); } catch { /* 非 JSON（如 404 页） */ }
          if (res.statusCode !== 200 || (json && json.code && json.code !== 200)) {
            return reject(new Error('网盘上传失败：HTTP ' + res.statusCode + ' ' + ((json && json.message) || b.slice(0, 160))));
          }
          resolve(true);
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('网盘上传超时')));
    req.on('error', (e) => reject(new Error('连接网盘桥接失败：' + e.message)));
    req.write(buf);
    req.end();
  });
}

module.exports = {
  catalog, driveById, listStorages, addStorage, setStorageEnabled, deleteStorage,
  qrcodeStart, qrcodePoll, humanizeStorageError,
  activePort, creds, BridgeOffline, fsPut,
};
