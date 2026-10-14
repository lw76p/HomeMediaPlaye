'use strict';
/* 忘记管理密码时的重置入口。
   网页端刻意**不提供**重置功能 —— 否则拿到网页的人就能绕开这道锁。

   NAS / Linux（路径按实例名替换 HMP-APP / HMP-TEST）：
     cd /share/CACHEDEV2_DATA/Multimediea/HMP-APP/app
     HMP_DATA_DIR=/share/CACHEDEV2_DATA/Multimediea/HMP-APP/data \
       ../runtime/node tools/reset-admin-pwd.js

   Windows 桌面版（数据目录换成你本机的实际路径）：
     set HMP_DATA_DIR=C:\Users\<你>\AppData\Local\HomeMediaPlayer\data
     "<安装目录>\runtime\node.exe" tools\reset-admin-pwd.js

   只清空「管理密码」这一项：媒体库目录、网盘账号、TMDB Key、儿童模式配置
   等数据一律不动。重置后打开网页即可重新进「设置」并设新密码。 */
const fs = require('node:fs');
const paths = require('../lib/paths.js');

const dbFile = paths.files.db();
console.log('数据目录：' + paths.dataRoot());
console.log('数据库：  ' + dbFile);

if (!fs.existsSync(dbFile)) {
  console.error('\n[×] 这个路径下没有 media.db —— 多半是 HMP_DATA_DIR 没指对（指到了空目录）。');
  console.error('    NAS 上应指向 <实例>/data（该目录里有 media.db），不是 <实例>/app/data。');
  process.exit(1);
}

const adminlock = require('../lib/adminlock.js');
if (!adminlock.isSet()) {
  console.log('\n[i] 当前本来就没有设过管理密码，无需重置。');
  process.exit(0);
}

adminlock.reset();
console.log('\n[√] 管理密码已清除。现在打开网页进入「设置」即可重新设置。');
