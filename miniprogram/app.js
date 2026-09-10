const { getCurrentGroup, setCurrentGroup, syncTabBar, enterGroup } = require('./utils/group')

App({
  globalData: {
    userInfo: null,
    openid: null,
    currentGroup: null,
    hasGroup: false,
    cloudReady: false,
    bootPromise: null,
    launchInvite: '',
    openedCheckinOnce: false
  },

  onLaunch(options) {
    if (!wx.cloud) {
      console.error('请使用支持云开发的基础库')
      return
    }

    const { cloudEnvId } = require('./config')
    if (!cloudEnvId) {
      console.warn('[坚持有奖乱买要批] 请先在 miniprogram/config.js 填写 cloudEnvId')
    }

    wx.cloud.init({
      env: cloudEnvId || undefined,
      traceUser: true
    })
    this.globalData.cloudReady = true

    const query = (options && options.query) || {}
    this.globalData.launchInvite = String(query.invite || query.inviteCode || '').trim()

    // 有本地群缓存时先展示 Tab，并尽快进打卡（不等云返回）
    let cached = null
    try {
      cached = wx.getStorageSync('fitbud_current_group')
      if (cached && cached._id) {
        this.globalData.currentGroup = cached
        syncTabBar(true)
        if (!this.globalData.launchInvite) {
          this.maybeOpenCheckinTab(cached)
        }
      } else {
        syncTabBar(false)
      }
    } catch (e) {
      syncTabBar(false)
    }

    this.globalData.bootPromise = this.bootstrap().then((result) => {
      // 无缓存时，等云确认有群再进打卡
      if (!this.globalData.openedCheckinOnce) {
        this.maybeOpenCheckinTab(result && result.group)
      }
      return result
    })
  },

  /** 老用户（已有群）默认进打卡；带邀请码进小程序时不跳 */
  maybeOpenCheckinTab(group) {
    if (this.globalData.openedCheckinOnce) return
    if (this.globalData.launchInvite) return
    if (!(group && group._id)) return
    this.globalData.openedCheckinOnce = true
    setTimeout(() => {
      wx.switchTab({ url: '/pages/checkin/checkin' })
    }, 30)
  },

  ensureLogin() {
    return wx.cloud
      .callFunction({ name: 'login' })
      .then((res) => {
        const data = (res && res.result) || {}
        this.globalData.openid = data.openid || null
        this.globalData.userInfo = data.user || null
        return data
      })
      .catch((err) => {
        console.error('[坚持有奖乱买要批] login 失败', err)
        return null
      })
  },

  /**
   * 启动：登录 + 校验群
   * 有本地缓存时先返回缓存，云端 select 后台刷新，不阻塞首屏
   */
  bootstrap() {
    const cached = getCurrentGroup()

    return this.ensureLogin()
      .then((data) => {
        const serverGroupId =
          (data && data.user && data.user.currentGroupId) || (cached && cached._id) || ''

        if (!serverGroupId) {
          setCurrentGroup(null)
          syncTabBar(false)
          return { group: null }
        }

        const seed = {
          _id: serverGroupId,
          name: (cached && cached.name) || '',
          inviteCode: (cached && cached.inviteCode) || ''
        }

        // 缓存命中：立刻用本地群，后台静默刷新
        if (cached && cached._id === serverGroupId) {
          syncTabBar(true)
          enterGroup(seed).catch(() => {})
          return { group: cached }
        }

        return enterGroup(seed).then((group) => {
          if (group && group._id) {
            syncTabBar(true)
            return { group }
          }
          setCurrentGroup(null)
          syncTabBar(false)
          return { group: null }
        })
      })
      .catch(() => {
        syncTabBar(!!getCurrentGroup())
        return { group: getCurrentGroup() }
      })
  },

  whenReady() {
    return this.globalData.bootPromise || Promise.resolve({ group: getCurrentGroup() })
  }
})
