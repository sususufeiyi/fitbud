# 坚持有奖乱买要批

和好朋友一起用的微信小程序：群组 · 想买（购物审批）· 每日打卡 · 坚持奖励。

## 本地打开

1. 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 导入本仓库目录，AppID：`wxae4a7679e4dabdb8`
3. 开通云开发（若尚未开通）

## 云开发接入（必做）

### 1. 填写环境 ID

已写入 `miniprogram/config.js`（当前：`cloudbase-d5gmmsjn963c9718d`）

### 2. 创建数据库集合

云开发控制台 → 数据库 → 新建集合（名称必须一致）：

| 集合 | 用途 |
|------|------|
| `users` | 用户资料、当前选中群 |
| `groups` | 群组（名称、邀请码） |
| `group_members` | 群成员与群内连续天数/积分 |
| `habits` | 每人自定义打卡项（按群隔离） |
| `checkins` | 打卡记录（习惯 × 日期） |
| `shop_items` | 想买购物审批 |
| `reward_claims` | 已领取里程碑（按群隔离） |
| `point_logs` | 积分流水（打卡 / 奖励 / 兑换） |

### 3. 上传云函数

对 `cloudfunctions` 下每个文件夹右键 → **上传并部署：云端安装依赖**

- `login`
- `group`
- `checkin`
- `shop`（想买，必传）
- `reward`

### 4. 使用流程

1. **首次进入**：只看到「创建群组 / 加入群组」（底部 Tab 隐藏）
2. **创建群后**：点「分享给微信好友入群」发卡片；好友点卡片会**自动加入**该群
3. **入群后**：显示底部 Tab（群组 / 打卡 / 想买 / 奖励）
4. **再次打开**：自动进入**上一次**使用的群组，默认打开打卡页

## 安全说明

- **AppID** 可放在 `project.config.json`
- **AppSecret** 只放本机 `.env` / 服务端，禁止进小程序前端与公开仓库

## 仓库

https://github.com/sususufeiyi/fitbud
