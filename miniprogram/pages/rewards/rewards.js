const { requireGroup, getCurrentGroup } = require('../../utils/group')

Page({
  data: {
    groupName: '',
    streak: 0,
    points: 0,
    totalCheckins: 0,
    milestones: [],
    locked: false
  },

  onShow() {
    const group = requireGroup()
    if (!group) {
      this.setData({ locked: true, milestones: [] })
      return
    }
    const { syncTabBar } = require('../../utils/group')
    syncTabBar(true)
    this.setData({ locked: false, groupName: group.name || '' })
    this.loadStatus()
  },

  loadStatus() {
    const group = getCurrentGroup()
    if (!group) return
    wx.cloud
      .callFunction({
        name: 'reward',
        data: { action: 'status', groupId: group._id }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) return
        this.setData({
          streak: r.streak || 0,
          points: r.points || 0,
          totalCheckins: r.totalCheckins || 0,
          milestones: r.milestones || []
        })
      })
      .catch(() => wx.showToast({ title: '请先部署 reward', icon: 'none' }))
  },

  claim(e) {
    if (this.data.locked) return
    const group = getCurrentGroup()
    if (!group) return
    const days = e.currentTarget.dataset.days
    const item = (this.data.milestones || []).find((m) => m.days === days)
    if (!item || !item.unlocked || item.claimed) return

    wx.cloud
      .callFunction({
        name: 'reward',
        data: { action: 'claim', groupId: group._id, days }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          wx.showToast({ title: '领取失败', icon: 'none' })
          return
        }
        wx.showToast({ title: `+${r.claimed.points} 分`, icon: 'success' })
        this.loadStatus()
      })
  }
})
