const STORAGE_KEY = 'fitbud_features'

function getAppSafe() {
  try {
    return getApp()
  } catch (e) {
    return null
  }
}

function defaultFeatures() {
  return { showWantTodo: false }
}

function getFeatures() {
  const app = getAppSafe()
  if (app && app.globalData && app.globalData.features) {
    return {
      showWantTodo: !!app.globalData.features.showWantTodo
    }
  }
  try {
    const cached = wx.getStorageSync(STORAGE_KEY)
    if (cached && typeof cached === 'object') {
      return { showWantTodo: !!cached.showWantTodo }
    }
  } catch (e) {
    // ignore
  }
  return defaultFeatures()
}

function isWantTodoEnabled() {
  return !!getFeatures().showWantTodo
}

function setFeatures(features) {
  const next = {
    showWantTodo: !!(features && features.showWantTodo)
  }
  const app = getAppSafe()
  if (app && app.globalData) {
    app.globalData.features = next
  }
  try {
    wx.setStorageSync(STORAGE_KEY, next)
  } catch (e) {
    // ignore
  }
  try {
    const { refreshCustomTabBar } = require('./group')
    refreshCustomTabBar()
  } catch (e) {
    // ignore
  }
  return next
}

/** 从云端拉取开关；失败则保留本地/默认（默认隐藏） */
function fetchFeatures() {
  return wx.cloud
    .callFunction({ name: 'config', data: { action: 'get' } })
    .then((res) => {
      const r = (res && res.result) || {}
      if (r.ok && r.features) {
        return setFeatures(r.features)
      }
      return getFeatures()
    })
    .catch(() => getFeatures())
}

/** 未开启时从想做什么相关页跳走 */
function guardWantTodoOrLeave() {
  if (isWantTodoEnabled()) return true
  wx.switchTab({ url: '/pages/checkin/checkin' })
  return false
}

module.exports = {
  getFeatures,
  setFeatures,
  fetchFeatures,
  isWantTodoEnabled,
  guardWantTodoOrLeave
}
