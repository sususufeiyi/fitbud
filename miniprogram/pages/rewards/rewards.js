const { requireGroup, getCurrentGroup, syncTabBar, setTabSelected } = require('../../utils/group')
const { isWantTodoEnabled } = require('../../utils/features')

function hasClaimable(list) {
  return (list || []).some((m) => m.unlocked && !m.claimed)
}

Page({
  data: {
    groupName: '',
    streak: 0,
    points: 0,
    totalCheckins: 0,
    streakMilestones: [],
    totalMilestones: [],
    streakHasClaim: false,
    totalHasClaim: false,
    locked: false,
    showRewards: false,
    rewardType: 'streak',
    sheetTitle: '',
    sheetDesc: '',
    sheetList: [],
    showPointLogs: false,
    pointLogs: [],
    logsLoading: false,
    titles: [],
    showWantTodo: false
  },

  onShow() {
    const app = getApp()
    const apply = (group) => {
      if (!group || !group._id) {
        this.setData({
          locked: true,
          streakMilestones: [],
          totalMilestones: [],
          streakHasClaim: false,
          totalHasClaim: false,
          showRewards: false,
          showPointLogs: false,
          titles: [],
          showWantTodo: false
        })
        return
      }
      syncTabBar(true)
      setTabSelected(this, 'rewards')
      this.setData({
        locked: false,
        groupName: group.name || '',
        showWantTodo: isWantTodoEnabled()
      })
      this.loadStatus()
      this.loadTitles()
    }

    const local = requireGroup()
    if (local) {
      apply(local)
      const ready = (app && app.whenReady) || (() => Promise.resolve({}))
      ready.call(app).then(() => {
        setTabSelected(this, 'rewards')
        this.setData({ showWantTodo: isWantTodoEnabled() })
      })
      return
    }

    const ready = (app && app.whenReady) || (() => Promise.resolve({ group: null }))
    ready
      .call(app)
      .then((r) => apply((r && r.group) || getCurrentGroup()))
      .catch(() => apply(getCurrentGroup()))
  },

  goWantTodo() {
    if (!isWantTodoEnabled()) return
    wx.switchTab({ url: '/pages/recommend/recommend' })
  },

  loadTitles() {
    const group = getCurrentGroup()
    if (!group) return
    wx.cloud
      .callFunction({
        name: 'checkin',
        data: { action: 'titles', groupId: group._id }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) return
        this.setData({ titles: r.titles || [] })
      })
      .catch(() => {})
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
        const streakMilestones = r.streakMilestones || r.milestones || []
        const totalMilestones = r.totalMilestones || []
        const patch = {
          streak: r.streak || 0,
          points: r.points || 0,
          totalCheckins: r.totalCheckins || 0,
          streakMilestones,
          totalMilestones,
          streakHasClaim: hasClaimable(streakMilestones),
          totalHasClaim: hasClaimable(totalMilestones)
        }
        if (this.data.showRewards) {
          Object.assign(patch, this.buildSheet(this.data.rewardType, patch))
        }
        this.setData(patch)
      })
      .catch(() => wx.showToast({ title: '请先部署 reward', icon: 'none' }))
  },

  buildSheet(type, source) {
    const data = source || this.data
    if (type === 'total') {
      return {
        rewardType: 'total',
        sheetTitle: '总打卡奖励',
        sheetDesc: `当前累计 ${data.totalCheckins || 0} 次 · 达标后可领取`,
        sheetList: data.totalMilestones || []
      }
    }
    return {
      rewardType: 'streak',
      sheetTitle: '连续奖励',
      sheetDesc: `当前连续 ${data.streak || 0} 天 · 达标后可领取`,
      sheetList: data.streakMilestones || []
    }
  },

  noop() {},

  openRewards(e) {
    if (this.data.locked) return
    const type = (e.currentTarget.dataset.type || 'streak') === 'total' ? 'total' : 'streak'
    this.setData({
      showRewards: true,
      ...this.buildSheet(type)
    })
  },

  closeRewards() {
    this.setData({ showRewards: false })
  },

  openPointLogs() {
    if (this.data.locked) return
    const group = getCurrentGroup()
    if (!group) return
    this.setData({ showPointLogs: true, logsLoading: true, pointLogs: [] })
    wx.cloud
      .callFunction({
        name: 'reward',
        data: { action: 'pointLogs', groupId: group._id }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          this.setData({ logsLoading: false })
          wx.showToast({ title: '加载失败', icon: 'none' })
          return
        }
        this.setData({
          pointLogs: r.list || [],
          points: r.points != null ? r.points : this.data.points,
          logsLoading: false
        })
      })
      .catch(() => {
        this.setData({ logsLoading: false })
        wx.showToast({ title: '请先部署 reward', icon: 'none' })
      })
  },

  closePointLogs() {
    this.setData({ showPointLogs: false })
  },

  claim(e) {
    if (this.data.locked) return
    const group = getCurrentGroup()
    if (!group) return
    const type = this.data.rewardType === 'total' ? 'total' : 'streak'
    const threshold = Number(e.currentTarget.dataset.threshold)
    const list = type === 'total' ? this.data.totalMilestones : this.data.streakMilestones
    const item = (list || []).find((m) => m.threshold === threshold)
    if (!item || !item.unlocked || item.claimed) return

    wx.cloud
      .callFunction({
        name: 'reward',
        data: { action: 'claim', groupId: group._id, type, threshold }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          const map = {
            already_claimed: '已领取过',
            not_unlocked: '尚未解锁'
          }
          wx.showToast({ title: map[r.error] || '领取失败', icon: 'none' })
          if (r.error === 'already_claimed') {
            this.markClaimedLocal(type, threshold)
            this.loadStatus()
          }
          return
        }
        wx.showToast({ title: `+${r.claimed.points} 分`, icon: 'success' })
        this.markClaimedLocal(type, threshold)
        this.loadStatus()
      })
  },

  markClaimedLocal(type, threshold) {
    const key = type === 'total' ? 'totalMilestones' : 'streakMilestones'
    const list = (this.data[key] || []).map((m) =>
      m.threshold === threshold ? { ...m, claimed: true } : m
    )
    const patch = {
      [key]: list,
      streakHasClaim:
        type === 'streak' ? hasClaimable(list) : hasClaimable(this.data.streakMilestones),
      totalHasClaim:
        type === 'total' ? hasClaimable(list) : hasClaimable(this.data.totalMilestones)
    }
    if (this.data.showRewards && this.data.rewardType === type) {
      Object.assign(patch, this.buildSheet(type, { ...this.data, [key]: list }))
    }
    this.setData(patch)
  }
})
