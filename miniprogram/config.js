/**
 * 云开发环境 ID
 * 微信开发者工具 → 云开发 → 设置 · 环境 ID
 * 填好后保存，重新编译即可
 *
 * 「想做什么」开关：部署 cloudfunctions/config 后，在云开发控制台测云函数：
 * 开启 { "action":"setWantTodo", "enabled":true,  "token":"fitbud-switch-9f3a" }
 * 关闭 { "action":"setWantTodo", "enabled":false, "token":"fitbud-switch-9f3a" }
 * 查询 { "action":"get" }
 * 默认关闭（Tab 只有打卡/奖励）；开启后打卡页、奖励页会出现入口。
 * 改完后重新打开小程序生效。
 */
module.exports = {
  cloudEnvId: 'cloudbase-d5gmmsjn963c9718d',
  /** 朋友想法提醒订阅消息模板 */
  reviewSubscribeTmplId: 'T3fYlBrSptEuKAUE1mEdhDyMQh0WKi7OHAV8I7LXbSs'
}
