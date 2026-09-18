const { getCurrentGroup, setCurrentGroup, syncTabBar, enterGroup, ensureMineGroup } = require('./utils/group')
const { fetchFeatures, setFeatures } = require('./utils/features')

App({
  globalData: {
    userInfo: null,
    openid: null,
    currentGroup: null,
    hasGroup: false,
    cloudReady: false,
    bootPromise: null,
    launchInvite: '',
    features: { showWantTodo: false }
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

    // 默认隐藏「想做什么」；有本地缓存先用，云端再刷新
    try {
      const cachedFeatures = wx.getStorageSync('fitbud_features')
      if (cachedFeatures && typeof cachedFeatures === 'object') {
        setFeatures(cachedFeatures)
      } else {
        setFeatures({ showWantTodo: false })
      }
    } catch (e) {
      setFeatures({ showWantTodo: false })
    }

    const query = (options && options.query) || {}
    this.globalData.launchInvite = String(query.invite || query.inviteCode || '').trim()

    // 有本地群缓存时先展示 Tab
    let cached = null
    try {
      cached = wx.getStorageSync('fitbud_current_group')
      if (cached && cached._id) {
        this.globalData.currentGroup = cached
        syncTabBar(true)
      } else {
        syncTabBar(false)
      }
    } catch (e) {
      syncTabBar(false)
    }

    // 带邀请码进入：去群组页处理加入
    if (this.globalData.launchInvite) {
      const code = encodeURIComponent(this.globalData.launchInvite)
      wx.reLaunch({ url: `/pages/index/index?invite=${code}` })
    }

    this.globalData.bootPromise = this.bootstrap()
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
   * 启动：登录 + 无群则自动建个人群 + 功能开关
   */
  bootstrap() {
    const cached = getCurrentGroup()

    const featuresReady = fetchFeatures().then((features) => {
      this.globalData.features = features
      return features
    })

    return Promise.all([this.ensureLogin(), featuresReady])
      .then(([data]) => {
        const serverGroupId =
          (data && data.user && data.user.currentGroupId) || (cached && cached._id) || ''

        if (!serverGroupId) {
          return ensureMineGroup().then((group) => {
            if (group && group._id) {
              syncTabBar(true)
              return { group }
            }
            setCurrentGroup(null)
            syncTabBar(false)
            return { group: null }
          })
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
          // 旧 currentGroupId 失效 → 自动建/找回个人群
          return ensureMineGroup().then((g) => {
            if (g && g._id) {
              syncTabBar(true)
              return { group: g }
            }
            setCurrentGroup(null)
            syncTabBar(false)
            return { group: null }
          })
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
