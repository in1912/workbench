// 「智能家居」独立应用（WB_MODE=smarthome）的身份常量——**唯一来源**。
//
// 为什么单独一个模块：空库首次启动时 /api/system-info 回的是 settings 里的 current_version，
// 而全新安装的库里没有这个键，会回退到硬编码值——那值是「全能工作台」的版本兜底，
// 独立应用显示成 v1.9.8 会让人以为装错了包。这里给它自己的名字与版本。
//
// `version` 必须与 fnos-sh/manifest 的 version 一致——fnos-sh/build-fpk.mjs 装配时会断言，
// 对不上直接报错退出，不会打出一个「应用内自称 1.0.0、应用中心显示别的」的包。
module.exports = {
  appname: 'qgsmarthome',
  displayName: '智能家居',
  displayNameEn: 'Smart Home',
  version: '1.0.0',
  // 本应用没有登录页：内置本地账号由 db.ensureLocalUser() 建（见 server/db.js）
  noLogin: true,
};
