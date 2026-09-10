const { requireGroup, getCurrentGroup, syncTabBar } = require('../../utils/group')

const EMOJI_PRESETS = [
  '🏃', '💪', '🏋️', '🚴', '🧘', '🤸', '🏊', '⚽',
  '🥗', '🍎', '💧', '☕', '💊', '🌡️',
  '📚', '✍️', '🎧', '💻', '🎯',
  '😴', '🛏️', '🌅', '🌙',
  '🧴', '🧼', '💇', '✨',
  '🚶', '🐶', '🧹', '📝', '🎵', '🧠', '❤️', '🔥'
]


function shiftWeekStart(weekStart, deltaWeeks) {
  const [y, m, d] = weekStart.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + deltaWeeks * 7)
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

Page({
  data: {
    locked: false,
    loading: false,
    groupName: '',
    weekStart: '',
    rangeLabel: '',
    days: [],
    grid: [],
    isMe: true,
    targetOpenid: '',
    targetName: '',
    streak: 0,
    points: 0,
    today: '',
    isCurrentWeek: true,
    weekProgress: [],
    members: [],
    memberIndex: 0,
    showAdd: false,
    newName: '',
    newEmoji: '🏃',
    emojiPresets: EMOJI_PRESETS,
    tip: '',
    showRename: false,
    nickDraft: '',
    savingNick: false
  },

  onShow() {
    const group = requireGroup()
    if (!group) {
      this.setData({ locked: true, tip: '请先创建或加入群组' })
      return
    }
    syncTabBar(true)
    this.setData({
      locked: false,
      groupName: group.name || '',
      tip: ''
    })
    this.loadMembers().then(() => this.loadWeek())
  },

  loadMembers() {
    const group = getCurrentGroup()
    if (!group) return Promise.resolve()
    return wx.cloud
      .callFunction({
        name: 'checkin',
        data: { action: 'listMembers', groupId: group._id }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) return
        const members = r.list || []
        let memberIndex = 0
        const cur = this.data.targetOpenid
        if (cur) {
          const i = members.findIndex((m) => m.openid === cur)
          if (i >= 0) memberIndex = i
        } else {
          const i = members.findIndex((m) => m.isMe)
          if (i >= 0) memberIndex = i
        }
        this.setData({ members, memberIndex })
      })
      .catch(() => {})
  },

  loadWeek(weekStart) {
    const group = getCurrentGroup()
    if (!group) return
    const members = this.data.members || []
    const target =
      members[this.data.memberIndex] || members.find((m) => m.isMe) || members[0]
    const targetOpenid = (target && target.openid) || ''

    // 显式传 '' 表示回到本周；未传则沿用当前 weekStart
    const nextWeekStart =
      weekStart === '' ? '' : weekStart || this.data.weekStart || ''

    this.setData({ loading: true })
    return wx.cloud
      .callFunction({
        name: 'checkin',
        data: {
          action: 'week',
          groupId: group._id,
          weekStart: nextWeekStart,
          targetOpenid
        }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          this.setData({
            tip: r.error === 'not_in_group' ? '请回群组页重新进入' : '加载失败',
            loading: false
          })
          return
        }
        this.setData({
          weekStart: r.weekStart,
          rangeLabel: r.rangeLabel,
          days: r.days || [],
          grid: r.grid || [],
          weekProgress: r.weekProgress || [],
          isMe: !!r.isMe,
          targetOpenid: r.targetOpenid,
          targetName: r.targetName,
          streak: r.streak || 0,
          points: r.points || 0,
          today: r.today,
          isCurrentWeek: (r.days || []).some((d) => d.key === r.today),
          tip: '',
          loading: false
        })
      })
      .catch((err) => {
        this.setData({
          tip: ((err && err.errMsg) || '请先部署 checkin 云函数').slice(0, 60),
          loading: false
        })
      })
  },

  prevWeek() {
    if (!this.data.weekStart) return
    this.loadWeek(shiftWeekStart(this.data.weekStart, -1))
  },

  nextWeek() {
    if (!this.data.weekStart) return
    this.loadWeek(shiftWeekStart(this.data.weekStart, 1))
  },

  goToToday() {
    if (this.data.isCurrentWeek || this.data.loading) return
    this.loadWeek('')
  },

  onMemberChange(e) {
    const memberIndex = Number(e.detail.value)
    this.setData({ memberIndex })
    this.loadWeek(this.data.weekStart)
  },

  toggleCell(e) {
    if (!this.data.isMe || this.data.locked) return
    const habitId = e.currentTarget.dataset.habitid
    const day = e.currentTarget.dataset.day
    const group = getCurrentGroup()
    if (!group || !habitId || !day) return

    const row = (this.data.grid || []).find((r) => r.habitId === habitId)
    const cell = row && (row.cells || []).find((c) => c.day === day)
    if (!cell) return

    if (cell.future) {
      wx.showToast({ title: '不能打未来的卡', icon: 'none' })
      return
    }

    const today = this.data.today || ''
    // 未打过的过去日期：补卡确认（积分减半）
    if (!cell.checked && today && day < today) {
      this.doToggle(group._id, habitId, day)
      return
    }

    this.doToggle(group._id, habitId, day)
  },

  /** 根据当前格子刷新「我」的周进度条 */
  refreshMyProgress(grid) {
    const rows = grid || this.data.grid || []
    let done = 0
    let total = 0
    rows.forEach((row) => {
      ;(row.cells || []).forEach((c) => {
        if (c.future) return
        total += 1
        if (c.checked) done += 1
      })
    })
    const percent = total > 0 ? Math.round((done / total) * 100) : 0
    const weekProgress = (this.data.weekProgress || []).map((p) =>
      p.isMe
        ? {
            ...p,
            done,
            total,
            habitCount: rows.length,
            percent
          }
        : p
    )
    this.setData({ weekProgress })
  },

  doToggle(groupId, habitId, day) {
    wx.cloud
      .callFunction({
        name: 'checkin',
        data: { action: 'toggle', groupId, habitId, day }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          const msg =
            r.error === 'future_not_allowed'
              ? '不能打未来的卡'
              : r.error === 'forbidden'
                ? '只能改自己的'
                : '操作失败'
          wx.showToast({ title: msg, icon: 'none' })
          return
        }
        const grid = (this.data.grid || []).map((row) => {
          if (row.habitId !== habitId) return row
          return {
            ...row,
            cells: row.cells.map((c) =>
              c.day === day
                ? {
                    ...c,
                    checked: !!r.checked,
                    isMakeup: r.checked ? !!r.isMakeup : false
                  }
                : c
            )
          }
        })
        this.setData({
          grid,
          streak: r.streak != null ? r.streak : this.data.streak,
          points: r.points != null ? r.points : this.data.points
        })
        if (this.data.isMe) this.refreshMyProgress(grid)
        if (r.checked && r.isMakeup && r.pointsGain > 0) {
          wx.showToast({ title: `补卡 +${r.pointsGain}`, icon: 'none' })
        } else if (r.checked && r.pointsGain > 0) {
          wx.showToast({ title: `+${r.pointsGain} 分`, icon: 'none' })
        }
      })
      .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }))
  },

  openAdd() {
    if (!this.data.isMe) {
      wx.showToast({ title: '只能给自己添加', icon: 'none' })
      return
    }
    this.setData({ showAdd: true, newName: '', newEmoji: '🏃' })
  },

  closeAdd() {
    this.setData({ showAdd: false })
  },

  onNewName(e) {
    this.setData({ newName: e.detail.value })
  },

  pickEmoji(e) {
    this.setData({ newEmoji: e.currentTarget.dataset.emoji })
  },

  addHabit() {
    const name = (this.data.newName || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入名称', icon: 'none' })
      return
    }
    const group = getCurrentGroup()
    if (!group) return
    wx.cloud
      .callFunction({
        name: 'checkin',
        data: {
          action: 'addHabit',
          groupId: group._id,
          name,
          emoji: this.data.newEmoji
        }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          wx.showToast({ title: '添加失败', icon: 'none' })
          return
        }
        this.setData({ showAdd: false })
        wx.showToast({ title: '已添加', icon: 'success' })
        this.loadWeek(this.data.weekStart)
      })
      .catch(() => wx.showToast({ title: '添加失败', icon: 'none' }))
  },

  removeHabit(e) {
    if (!this.data.isMe) return
    const habitId = e.currentTarget.dataset.habitid
    const group = getCurrentGroup()
    if (!group || !habitId) return
    wx.showModal({
      title: '删除打卡项',
      content: '确定删除这个打卡项吗？',
      success: (res) => {
        if (!res.confirm) return
        wx.cloud
          .callFunction({
            name: 'checkin',
            data: { action: 'removeHabit', groupId: group._id, habitId }
          })
          .then((r) => {
            if (r.result && r.result.ok) {
              this.loadWeek(this.data.weekStart)
            }
          })
      }
    })
  },

  noop() {},

  openRename() {
    if (!this.data.isMe) return
    const app = getApp()
    const nick =
      (app.globalData && app.globalData.userInfo && app.globalData.userInfo.nickName) ||
      this.data.targetName ||
      ''
    this.setData({
      showRename: true,
      nickDraft: nick === 'Buddy' || /^Buddy\s/.test(nick) ? '' : nick
    })
  },

  closeRename() {
    this.setData({ showRename: false })
  },

  onNickBlur(e) {
    const v = ((e && e.detail && e.detail.value) || '').trim()
    if (v) this.setData({ nickDraft: v })
  },

  onNickInput(e) {
    this.setData({ nickDraft: e.detail.value })
  },

  saveNick() {
    const nickName = (this.data.nickDraft || '').trim()
    if (!nickName) {
      wx.showToast({ title: '请输入名字', icon: 'none' })
      return
    }
    if (this.data.savingNick) return
    this.setData({ savingNick: true })

    wx.cloud
      .callFunction({
        name: 'login',
        data: { action: 'updateProfile', nickName }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          wx.showToast({ title: '保存失败', icon: 'none' })
          return
        }
        const app = getApp()
        if (app.globalData) app.globalData.userInfo = r.user

        // 更新本页成员列表里的「我」
        const members = (this.data.members || []).map((m) =>
          m.isMe ? { ...m, displayName: nickName } : m
        )
        this.setData({
          showRename: false,
          targetName: nickName,
          members
        })
        wx.showToast({ title: '已更新', icon: 'success' })
      })
      .catch(() => wx.showToast({ title: '请先部署 login', icon: 'none' }))
      .finally(() => this.setData({ savingNick: false }))
  }
})
