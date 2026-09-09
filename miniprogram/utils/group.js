const STORAGE_KEY = 'fitbud_current_group'

function getAppSafe() {
  try {
    return getApp()
  } catch (e) {
    return null
  }
}

function getCurrentGroup() {
  const app = getAppSafe()
  if (app && app.globalData && app.globalData.currentGroup) {
    return app.globalData.currentGroup
  }
  try {
    return wx.getStorageSync(STORAGE_KEY) || null
  } catch (e) {
    return null
  }
}

function setCurrentGroup(group) {
  const app = getAppSafe()
  if (app && app.globalData) {
    app.globalData.currentGroup = group || null
  }
  try {
    if (group) {
      wx.setStorageSync(STORAGE_KEY, group)
    } else {
      wx.removeStorageSync(STORAGE_KEY)
    }
  } catch (e) {
    // ignore
  }
  syncTabBar(!!(group && group._id))
}

function clearCurrentGroup() {
  setCurrentGroup(null)
}

/** 有群显示 Tab，无群隐藏（首次只看创建/加入） */
function syncTabBar(hasGroup) {
  try {
    if (hasGroup) {
      wx.showTabBar({ animation: false })
    } else {
      wx.hideTabBar({ animation: false })
    }
  } catch (e) {
    // ignore
  }
  const app = getAppSafe()
  if (app && app.globalData) {
    app.globalData.hasGroup = !!hasGroup
  }
}

function hasGroup() {
  const g = getCurrentGroup()
  return !!(g && g._id)
}

/** 未选群则回首页引导，返回 null */
function requireGroup() {
  const group = getCurrentGroup()
  if (group && group._id) {
    syncTabBar(true)
    return group
  }
  syncTabBar(false)
  wx.showToast({ title: '请先创建或加入群组', icon: 'none' })
  setTimeout(() => {
    wx.switchTab({ url: '/pages/index/index' })
  }, 400)
  return null
}

/** 进入群：写本地 + 调 select（可补成员）+ 显示 Tab */
function enterGroup(group) {
  if (!group || !group._id) return Promise.resolve(null)
  setCurrentGroup(group)
  return wx.cloud
    .callFunction({ name: 'group', data: { action: 'select', groupId: group._id } })
    .then((res) => {
      const r = (res && res.result) || {}
      if (r.ok && r.group) {
        setCurrentGroup(r.group)
        return r.group
      }
      return group
    })
    .catch(() => group)
}

module.exports = {
  getCurrentGroup,
  setCurrentGroup,
  clearCurrentGroup,
  syncTabBar,
  hasGroup,
  requireGroup,
  enterGroup
}
