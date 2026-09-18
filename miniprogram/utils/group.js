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

/** 有群显示 Tab，无群隐藏 */
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
  refreshCustomTabBar()
}

function refreshCustomTabBar() {
  try {
    const pages = getCurrentPages()
    const page = pages && pages[pages.length - 1]
    if (!page || typeof page.getTabBar !== 'function') return
    const bar = page.getTabBar()
    if (bar && typeof bar.refresh === 'function') bar.refresh()
  } catch (e) {
    // ignore
  }
}

/** role: checkin | recommend | rewards */
function setTabSelected(page, role) {
  try {
    if (!page || typeof page.getTabBar !== 'function') return
    const bar = page.getTabBar()
    if (!bar) return
    if (typeof bar.refresh === 'function') bar.refresh()
    if (typeof bar.setSelectedByRole === 'function') {
      bar.setSelectedByRole(role)
    }
  } catch (e) {
    // ignore
  }
}

function hasGroup() {
  const g = getCurrentGroup()
  return !!(g && g._id)
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

/** 无群时自动创建个人打卡群 */
function ensureMineGroup() {
  return wx.cloud
    .callFunction({ name: 'group', data: { action: 'ensureMine' } })
    .then((res) => {
      const r = (res && res.result) || {}
      if (r.ok && r.group && r.group._id) {
        setCurrentGroup(r.group)
        syncTabBar(true)
        return r.group
      }
      return null
    })
    .catch(() => null)
}

/** 未选群返回 null；页面应等 whenReady / ensureMine，不再跳引导页 */
function requireGroup() {
  const group = getCurrentGroup()
  if (group && group._id) {
    syncTabBar(true)
    return group
  }
  syncTabBar(false)
  return null
}

module.exports = {
  getCurrentGroup,
  setCurrentGroup,
  clearCurrentGroup,
  syncTabBar,
  refreshCustomTabBar,
  setTabSelected,
  hasGroup,
  requireGroup,
  enterGroup,
  ensureMineGroup
}
