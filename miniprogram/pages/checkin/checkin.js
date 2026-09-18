const { getCurrentGroup, setCurrentGroup, syncTabBar, ensureMineGroup, setTabSelected } = require('../../utils/group')
const { isWantTodoEnabled } = require('../../utils/features')

const EMOJI_PRESETS = [
  '🏃', '🚶', '🥾', '💪', '🏋️', '🚴', '🧘', '🤸', '🏊', '⚽', '🏀', '🎾', '🏸', '🥊', '⛷️', '🏄',
  '🥗', '🍎', '🍌', '🥦', '🥕', '💧', '☕', '🍵', '🥛', '💊', '🌡️', '💉',
  '📚', '✍️', '📝', '🎧', '💻', '⌨️', '🎯', '🧠', '📖', '🧪', '🎨', '🎬',
  '😴', '🛏️', '🌅', '🌙', '⏰', '☀️', '🌤️', '⭐',
  '🧴', '🧼', '💇', '💇‍♀️', '✨', '🪥', '🚿', '💅', '🪞', '👁️', '👀',
  '🐶', '🐱', '🧹', '🧺', '🏠', '🪴', '🎵', '❤️', '🔥', '✅', '📌', '💡'
]

const FREQ_OPTIONS = [
  { value: 7, label: '每天' },
  { value: 6, label: '每周 6 次' },
  { value: 5, label: '每周 5 次' },
  { value: 4, label: '每周 4 次' },
  { value: 3, label: '每周 3 次' },
  { value: 2, label: '每周 2 次' },
  { value: 1, label: '每周 1 次' }
]

const DIFF_OPTIONS = [
  { value: 'sport', label: '运动 · +10' },
  { value: 'other', label: '日常 · +2' },
  { value: 'record', label: '只做记录 · 不加分' }
]

function calendarDayFromCheckDay(day) {
  const s = String(day || '')
  const m = s.match(/^(\d{4}-\d{2}-\d{2})#(\d+)$/)
  if (m) {
    const [y, mo, d] = m[1].split('-').map(Number)
    const dt = new Date(y, mo - 1, d)
    dt.setDate(dt.getDate() + Number(m[2] || 0))
    const yy = dt.getFullYear()
    const mm = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    return `${yy}-${mm}-${dd}`
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

function countCalDayInGrid(grid, calDay) {
  if (!calDay) return 0
  let n = 0
  ;(grid || []).forEach((row) => {
    ;(row.cells || []).forEach((c) => {
      if (c.checked && calendarDayFromCheckDay(c.day) === calDay) n += 1
    })
  })
  return n
}

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
    loading: true,
    groupName: '',
    weekStart: '',
    rangeLabel: '',
    days: [],
    grid: [],
    pendingKey: '',
    skeletonRows: [1, 2, 3],
    skeletonDays: ['日', '一', '二', '三', '四', '五', '六'],
    isMe: true,
    targetOpenid: '',
    targetName: '',
    streak: 0,
    checkinDays: 0,
    points: 0,
    today: '',
    isCurrentWeek: true,
    weekProgress: [],
    dayProgress: [],
    monthProgress: [],
    rankProgress: [],
    progressTab: 'week',
    progressTitle: '周进度',
    members: [],
    memberIndex: 0,
    showAdd: false,
    editingHabitId: '',
    savingHabit: false,
    newName: '',
    newEmoji: '🏃',
    newFreqIndex: 0,
    newDiffIndex: 1,
    freqOptions: FREQ_OPTIONS,
    diffOptions: DIFF_OPTIONS,
    emojiPresets: EMOJI_PRESETS,
    tip: '',
    showRename: false,
    nickDraft: '',
    savingNick: false,
    showRenameGroup: false,
    groupNameDraft: '',
    savingGroupName: false,
    streakRisk: false,
    streakRiskBanner: false,
    weekChampionText: '',
    showSync: false,
    syncLoading: false,
    syncSaving: false,
    syncSources: [],
    showWantTodo: false
  },

  onShow() {
    const app = getApp()
    const applyGroup = (group) => {
      if (!group || !group._id) {
        this.setData({ locked: true, tip: '正在准备你的打卡空间…' })
        syncTabBar(false)
        ensureMineGroup().then((g) => {
          if (g && g._id) {
            applyGroup(g)
            return
          }
          this.setData({ tip: '准备失败，请稍后重试' })
        })
        return
      }
      syncTabBar(true)
      setTabSelected(this, 'checkin')
      this.setData({
        locked: false,
        loading: true,
        groupName: group.name || '',
        tip: '',
        showWantTodo: isWantTodoEnabled()
      })
      this.loadMembers().then(() => this.loadWeek())
    }

    const cached = getCurrentGroup()
    if (cached && cached._id) {
      applyGroup(cached)
      // 功能开关可能稍后从云端回来，再刷一次 Tab / 入口
      const ready = (app && app.whenReady) || (() => Promise.resolve({}))
      ready.call(app).then(() => {
        setTabSelected(this, 'checkin')
        this.setData({ showWantTodo: isWantTodoEnabled() })
      })
      return
    }

    // 无本地缓存：等启动完成（会自动建个人群）
    this.setData({ locked: true, tip: '加载中…' })
    const ready = (app && app.whenReady) || (() => Promise.resolve({ group: null }))
    ready
      .call(app)
      .then((r) => applyGroup((r && r.group) || getCurrentGroup()))
      .catch(() => applyGroup(getCurrentGroup()))
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
    this._weekReqId = (this._weekReqId || 0) + 1
    const reqId = this._weekReqId
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
        if (reqId !== this._weekReqId) return
        const r = res.result || {}
        if (!r.ok) {
          this.setData({
            tip: r.error === 'not_in_group' ? '请回群组页重新进入' : '加载失败',
            loading: false
          })
          return
        }
        const isCurrentWeek = (r.days || []).some((d) => d.key === r.today)
        const hour = new Date().getHours()
        const streakRisk = !!r.streakRisk && !!r.isMe
        const dayProgress = r.dayProgress || []
        const weekProgress = r.weekProgress || []
        const monthProgress = r.monthProgress || []
        const progressTab = this.data.progressTab || 'week'
        this.setData({
          weekStart: r.weekStart,
          rangeLabel: r.rangeLabel,
          days: r.days || [],
          grid: r.grid || [],
          dayProgress,
          weekProgress,
          monthProgress,
          isMe: !!r.isMe,
          targetOpenid: r.targetOpenid,
          targetName: r.targetName,
          streak: r.consecutiveStreak != null ? r.consecutiveStreak : r.streak || 0,
          checkinDays: r.checkinDays != null ? r.checkinDays : r.streak || 0,
          points: r.points || 0,
          today: r.today,
          isCurrentWeek,
          streakRisk,
          streakRiskBanner: streakRisk && hour >= 18,
          weekChampionText: '',
          tip: '',
          loading: false
        })
        this.applyProgressTab(progressTab)
        this.syncWeekChampionBanner()
        this.maybeShowPokes(r.pendingPokes || [], group._id)
      })
      .catch((err) => {
        if (reqId !== this._weekReqId) return
        this.setData({
          tip: ((err && err.errMsg) || '请先部署 checkin 云函数').slice(0, 60),
          loading: false
        })
      })
  },

  maybeShowPokes(pokes, groupId) {
    if (!pokes || !pokes.length || this._pokeOpen) return
    const names = pokes.map((p) => p.name || '群友').join('、')
    this._pokeOpen = true
    wx.showModal({
      title: '有人盯着你',
      content: `${names} 戳了你一下，催你打卡`,
      showCancel: false,
      confirmText: '收到',
      complete: () => {
        this._pokeOpen = false
        wx.cloud
          .callFunction({
            name: 'checkin',
            data: { action: 'ackPokes', groupId }
          })
          .catch(() => {})
      }
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

  goGroup() {
    wx.navigateTo({ url: '/pages/index/index' })
  },

  goWantTodo() {
    if (!isWantTodoEnabled()) return
    wx.switchTab({ url: '/pages/recommend/recommend' })
  },

  openRenameGroup() {
    const g = getCurrentGroup()
    if (!g || !g._id) return
    this.setData({
      showRenameGroup: true,
      groupNameDraft: g.name || this.data.groupName || ''
    })
  },

  closeRenameGroup() {
    this.setData({ showRenameGroup: false })
  },

  onGroupNameInput(e) {
    this.setData({ groupNameDraft: e.detail.value })
  },

  saveGroupName() {
    const name = (this.data.groupNameDraft || '').trim()
    const g = getCurrentGroup()
    if (!g || !g._id) return
    if (!name) {
      wx.showToast({ title: '请输入群名称', icon: 'none' })
      return
    }
    if (name === (g.name || this.data.groupName)) {
      this.setData({ showRenameGroup: false })
      return
    }
    if (this.data.savingGroupName) return
    this.setData({ savingGroupName: true })
    wx.cloud
      .callFunction({
        name: 'group',
        data: { action: 'rename', groupId: g._id, name }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok || !r.group) {
          wx.showToast({
            title: r.error === 'not_member' ? '你不在该群' : '改名失败',
            icon: 'none'
          })
          return
        }
        const next = { ...g, ...r.group, name: r.group.name || name }
        setCurrentGroup(next)
        this.setData({
          groupName: next.name,
          showRenameGroup: false
        })
        wx.showToast({ title: '已改名', icon: 'success' })
      })
      .catch(() => wx.showToast({ title: '请先部署 group', icon: 'none' }))
      .finally(() => this.setData({ savingGroupName: false }))
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

    this.doToggle(group._id, habitId, day, {
      prevChecked: !!cell.checked,
      prevMakeup: !!cell.isMakeup
    })
  },

  onPoke(e) {
    const openid = e.currentTarget.dataset.openid
    const name = e.currentTarget.dataset.name || '群友'
    if (!openid || Number(e.currentTarget.dataset.isme) === 1) return
    const group = getCurrentGroup()
    if (!group) return
    if (this._poking) return
    this._poking = true
    wx.cloud
      .callFunction({
        name: 'checkin',
        data: { action: 'poke', groupId: group._id, targetOpenid: openid }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          wx.showToast({ title: '戳失败', icon: 'none' })
          return
        }
        wx.showToast({ title: `已戳 ${name}`, icon: 'none' })
      })
      .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }))
      .finally(() => {
        this._poking = false
      })
  },

  applyProgressTab(tab) {
    const key = tab === 'day' || tab === 'month' ? tab : 'week'
    const titles = { day: '日进度', week: '周进度', month: '月进度' }
    const lists = {
      day: this.data.dayProgress || [],
      week: this.data.weekProgress || [],
      month: this.data.monthProgress || []
    }
    this.setData({
      progressTab: key,
      progressTitle: titles[key],
      rankProgress: lists[key]
    })
  },

  /** 本周积分第一为卷王 */
  syncWeekChampionBanner() {
    if (!this.data.isCurrentWeek) {
      this.setData({ weekChampionText: '' })
      return
    }
    const top = (this.data.weekProgress || []).find((p) => (p.points || 0) > 0)
    if (!top) {
      this.setData({ weekChampionText: '' })
      return
    }
    this.setData({
      weekChampionText: top.isMe
        ? `本周卷王是你！${top.points} 分`
        : `本周卷王：${top.displayName} · ${top.points} 分`
    })
  },

  onProgressTab(e) {
    const tab = (e.currentTarget.dataset && e.currentTarget.dataset.tab) || 'week'
    this.applyProgressTab(tab)
  },

  rerankProgressLists(dayProgress, weekProgress, monthProgress) {
    const sortRows = (rows) => {
      const list = (rows || []).map((r) => ({ ...r }))
      const max = list.reduce((acc, r) => Math.max(acc, r.points || 0), 0)
      list.forEach((r) => {
        r.percent = max > 0 ? Math.round(((r.points || 0) / max) * 100) : 0
      })
      list.sort((a, b) => {
        if ((b.points || 0) !== (a.points || 0)) return (b.points || 0) - (a.points || 0)
        if (a.isMe !== b.isMe) return a.isMe ? -1 : 1
        return String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh')
      })
      return list
    }
    this.setData({
      dayProgress: sortRows(dayProgress),
      weekProgress: sortRows(weekProgress),
      monthProgress: sortRows(monthProgress)
    })
    this.applyProgressTab(this.data.progressTab || 'week')
    this.syncWeekChampionBanner()
  },

  refreshMyProgress(pointsDelta, dayKey) {
    const delta = Number(pointsDelta) || 0
    if (!delta) return
    const today = this.data.today || ''
    const isToday = !dayKey || !String(dayKey).includes('#')
      ? String(dayKey || '') === String(today)
      : false
    const bump = (list, apply) =>
      (list || []).map((p) =>
        p.isMe && apply ? { ...p, points: Math.max(0, (p.points || 0) + delta) } : p
      )
    this.rerankProgressLists(
      bump(this.data.dayProgress, isToday),
      bump(this.data.weekProgress, true),
      bump(this.data.monthProgress, true)
    )
  },

  /** 10 秒内连打 3 次 → 诚实拷问 */
  maybeAskHonesty(groupId, habitId, day) {
    const now = Date.now()
    const windowMs = 10000
    this._recentCheckOns = (this._recentCheckOns || []).filter((t) => now - t < windowMs)
    this._recentCheckOns.push(now)
    if (this._recentCheckOns.length < 3 || this._honestyOpen) return

    this._honestyOpen = true
    this._recentCheckOns = []
    wx.showModal({
      title: '请你诚实',
      content: '10 秒内连续打卡 3 次，是认真的还是手滑？',
      confirmText: '我很诚实',
      cancelText: '好的',
      success: (res) => {
        this._honestyOpen = false
        if (res.confirm) {
          wx.cloud
            .callFunction({
              name: 'checkin',
              data: { action: 'ackHonest', groupId }
            })
            .catch(() => {})
          wx.showToast({ title: '那就继续加油', icon: 'none' })
          return
        }
        // 「好的」→ 取消上一次打卡
        this.doToggle(groupId, habitId, day, {
          skipHonesty: true,
          silentUndo: true,
          prevChecked: true,
          prevMakeup: true
        })
      },
      fail: () => {
        this._honestyOpen = false
      }
    })
  },

  patchCell(habitId, day, patch) {
    const grid = (this.data.grid || []).map((row) => {
      if (row.habitId !== habitId) return row
      return {
        ...row,
        cells: row.cells.map((c) => (c.day === day ? { ...c, ...patch } : c))
      }
    })
    this.setData({ grid })
    return grid
  },

  doToggle(groupId, habitId, day, opts = {}) {
    if (this._toggling) return
    this._toggling = true
    const prevChecked = !!opts.prevChecked
    const nextChecked = !prevChecked
    this.patchCell(habitId, day, {
      checked: nextChecked,
      isMakeup: nextChecked ? !!opts.prevMakeup : false
    })
    this.setData({ pendingKey: `${habitId}__${day}` })
    wx.cloud
      .callFunction({
        name: 'checkin',
        data: { action: 'toggle', groupId, habitId, day }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          this.patchCell(habitId, day, {
            checked: prevChecked,
            isMakeup: !!opts.prevMakeup
          })
          const msg =
            r.error === 'future_not_allowed'
              ? '不能打未来的卡'
              : r.error === 'forbidden'
                ? '只能改自己的'
                : '操作失败'
          wx.showToast({ title: msg, icon: 'none' })
          return
        }
        this._weekReqId = (this._weekReqId || 0) + 1
        this.patchCell(habitId, day, {
          checked: !!r.checked,
          isMakeup: r.checked ? !!r.isMakeup : false
        })
        const calDay = calendarDayFromCheckDay(day)
        const after = countCalDayInGrid(this.data.grid, calDay)
        let streak = this.data.streak || 0
        if (r.checked && !prevChecked && after === 1) streak += 1
        if (!r.checked && prevChecked && after === 0) streak = Math.max(0, streak - 1)
        this.setData({
          streak,
          points: r.points != null ? r.points : this.data.points
        })
        if (this.data.isMe) this.refreshMyProgress(r.pointsGain || 0, day)

        if (opts.silentUndo && !r.checked) {
          wx.showToast({ title: '已取消这次打卡', icon: 'none' })
          return
        }
        if (r.checked && r.nightOwl) {
          wx.showToast({ title: '夜猫子认证 +3 分', icon: 'none', duration: 2200 })
        } else if (r.checked && r.isMakeup && r.pointsGain > 0) {
          wx.showToast({ title: `补卡 +${r.pointsGain}`, icon: 'none' })
        } else if (r.checked && r.pointsGain > 0) {
          wx.showToast({ title: `+${r.pointsGain} 分`, icon: 'none' })
        }

        if (r.checked && this.data.streakRiskBanner) {
          this.setData({ streakRisk: false, streakRiskBanner: false })
        }

        // 仅「打上勾」计入连打；取消打卡不计入
        if (r.checked && !opts.skipHonesty) {
          this.maybeAskHonesty(groupId, habitId, day)
        }
      })
      .catch(() => {
        this.patchCell(habitId, day, {
          checked: prevChecked,
          isMakeup: !!opts.prevMakeup
        })
        wx.showToast({ title: '网络错误', icon: 'none' })
      })
      .finally(() => {
        this._toggling = false
        this.setData({ pendingKey: '' })
      })
  },

  openAdd() {
    if (!this.data.isMe) {
      wx.showToast({ title: '只能给自己添加', icon: 'none' })
      return
    }
    this.setData({
      showAdd: true,
      editingHabitId: '',
      savingHabit: false,
      newName: '',
      newEmoji: '🏃',
      newFreqIndex: 0,
      newDiffIndex: 1
    })
  },

  openSync() {
    if (!this.data.isMe || this.data.locked) return
    const group = getCurrentGroup()
    if (!group) return
    this.setData({
      showSync: true,
      syncLoading: true,
      syncSources: []
    })
    wx.cloud
      .callFunction({
        name: 'checkin',
        data: { action: 'listSyncSources', groupId: group._id }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          wx.showToast({ title: '加载失败', icon: 'none' })
          this.setData({ syncLoading: false })
          return
        }
        const sources = (r.sources || []).map((s) => ({
          ...s,
          habits: (s.habits || []).map((h) => ({ ...h, selected: true }))
        }))
        this.setData({
          syncSources: sources,
          syncLoading: false
        })
      })
      .catch(() => {
        wx.showToast({ title: '请先部署 checkin', icon: 'none' })
        this.setData({ syncLoading: false, showSync: false })
      })
  },

  closeSync() {
    this.setData({ showSync: false, syncSaving: false })
  },

  toggleSyncItem(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const syncSources = (this.data.syncSources || []).map((s) => ({
      ...s,
      habits: (s.habits || []).map((h) =>
        h._id === id ? { ...h, selected: !h.selected } : h
      )
    }))
    this.setData({ syncSources })
  },

  toggleSyncGroup(e) {
    const gid = e.currentTarget.dataset.gid
    const syncSources = (this.data.syncSources || []).map((s) => {
      if (s.groupId !== gid) return s
      const habits = s.habits || []
      const allOn = habits.length > 0 && habits.every((h) => h.selected)
      return {
        ...s,
        habits: habits.map((h) => ({ ...h, selected: !allOn }))
      }
    })
    this.setData({ syncSources })
  },

  confirmSync() {
    const group = getCurrentGroup()
    if (!group || this.data.syncSaving) return
    const habitIds = []
    ;(this.data.syncSources || []).forEach((s) => {
      ;(s.habits || []).forEach((h) => {
        if (h.selected) habitIds.push(h._id)
      })
    })
    if (!habitIds.length) {
      wx.showToast({ title: '请先勾选打卡项', icon: 'none' })
      return
    }
    this.setData({ syncSaving: true })
    wx.cloud
      .callFunction({
        name: 'checkin',
        data: { action: 'syncHabits', groupId: group._id, habitIds }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          const map = {
            empty: '请先勾选打卡项',
            too_many: '本群打卡项已满（最多 20 个）'
          }
          wx.showToast({ title: map[r.error] || '同步失败', icon: 'none' })
          return
        }
        this.setData({ showSync: false })
        const parts = []
        if (r.added > 0) parts.push(`新增 ${r.added} 项`)
        if (r.checkins > 0) parts.push(`同步 ${r.checkins} 次打卡`)
        if (!parts.length && r.skipped) parts.push('无需新增（可能已同步过）')
        if (!parts.length) parts.push('没有可同步的内容')
        wx.showToast({ title: parts.join('，'), icon: 'none', duration: 2500 })
        this.loadWeek(this.data.weekStart)
      })
      .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }))
      .finally(() => this.setData({ syncSaving: false }))
  },

  openEdit(e) {
    if (!this.data.isMe || this.data.locked) return
    const habitId = e.currentTarget.dataset.habitid
    if (!habitId) return
    const row = (this.data.grid || []).find((r) => r.habitId === habitId)
    if (!row) return

    const tpw = Number(row.timesPerWeek) || 7
    let newFreqIndex = FREQ_OPTIONS.findIndex((o) => o.value === tpw)
    if (newFreqIndex < 0) newFreqIndex = 0

    const diff = row.difficulty || 'other'
    let newDiffIndex = DIFF_OPTIONS.findIndex((o) => o.value === diff)
    if (newDiffIndex < 0) {
      // 旧版 easy/normal/hard → 日常
      newDiffIndex = DIFF_OPTIONS.findIndex((o) => o.value === 'other')
      if (newDiffIndex < 0) newDiffIndex = 1
    }

    this.setData({
      showAdd: true,
      editingHabitId: habitId,
      savingHabit: false,
      newName: row.name || '',
      newEmoji: row.emoji || '🏃',
      newFreqIndex,
      newDiffIndex
    })
  },

  closeAdd() {
    this.setData({ showAdd: false, editingHabitId: '', savingHabit: false })
  },

  onNewName(e) {
    this.setData({ newName: e.detail.value })
  },

  onFreqChange(e) {
    this.setData({ newFreqIndex: Number(e.detail.value) || 0 })
  },

  onDiffChange(e) {
    this.setData({ newDiffIndex: Number(e.detail.value) || 0 })
  },

  pickEmoji(e) {
    this.setData({ newEmoji: e.currentTarget.dataset.emoji })
  },

  saveHabit() {
    const name = (this.data.newName || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入名称', icon: 'none' })
      return
    }
    const group = getCurrentGroup()
    if (!group || this.data.savingHabit) return
    const freq = FREQ_OPTIONS[this.data.newFreqIndex] || FREQ_OPTIONS[0]
    const diff = DIFF_OPTIONS[this.data.newDiffIndex] || DIFF_OPTIONS[1]
    const editingHabitId = this.data.editingHabitId
    const isEdit = !!editingHabitId

    this.setData({ savingHabit: true })
    wx.cloud
      .callFunction({
        name: 'checkin',
        data: isEdit
          ? {
              action: 'updateHabit',
              groupId: group._id,
              habitId: editingHabitId,
              name,
              emoji: this.data.newEmoji,
              timesPerWeek: freq.value,
              difficulty: diff.value
            }
          : {
              action: 'addHabit',
              groupId: group._id,
              name,
              emoji: this.data.newEmoji,
              timesPerWeek: freq.value,
              difficulty: diff.value
            }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          wx.showToast({ title: isEdit ? '保存失败' : '添加失败', icon: 'none' })
          return
        }
        this.setData({ showAdd: false, editingHabitId: '' })
        wx.showToast({ title: isEdit ? '已保存' : '已添加', icon: 'success' })
        this.loadWeek(this.data.weekStart)
      })
      .catch(() => wx.showToast({ title: isEdit ? '保存失败' : '添加失败', icon: 'none' }))
      .finally(() => this.setData({ savingHabit: false }))
  },

  confirmDeleteHabit() {
    if (!this.data.isMe || !this.data.editingHabitId) return
    const habitId = this.data.editingHabitId
    const group = getCurrentGroup()
    if (!group) return
    wx.showModal({
      title: '删除打卡项',
      content: '确定删除这个打卡项吗？历史打卡记录会保留。',
      confirmColor: '#c45c5c',
      success: (res) => {
        if (!res.confirm) return
        wx.cloud
          .callFunction({
            name: 'checkin',
            data: { action: 'removeHabit', groupId: group._id, habitId }
          })
          .then((r) => {
            if (r.result && r.result.ok) {
              this.setData({ showAdd: false, editingHabitId: '' })
              wx.showToast({ title: '已删除', icon: 'none' })
              this.loadWeek(this.data.weekStart)
            } else {
              wx.showToast({ title: '删除失败', icon: 'none' })
            }
          })
          .catch(() => wx.showToast({ title: '删除失败', icon: 'none' }))
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
