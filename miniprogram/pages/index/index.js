const {
  getCurrentGroup,
  clearCurrentGroup,
  syncTabBar,
  enterGroup
} = require('../../utils/group')
const app = getApp()

Page({
  data: {
    ready: false,
    mode: 'onboarding', // onboarding | group
    groups: [],
    currentGroup: null,
    members: [],
    membersLoading: false,
    createName: '',
    joinCode: '',
    nickName: '',
    nickDraft: '',
    loading: false,
    savingNick: false,
    tip: ''
  },

  onLoad(query) {
    const invite = (query && (query.invite || query.inviteCode)) || ''
    if (invite) {
      this._pendingInvite = String(invite).trim().toUpperCase()
      this.setData({ joinCode: this._pendingInvite })
    }
  },

  onShow() {
    syncTabBar(!!(getCurrentGroup() && getCurrentGroup()._id))
    const run = () => {
      this.refreshProfile()
      return this.bootstrapPage()
    }
    if (app.whenReady) {
      app.whenReady().then(run).catch(run)
    } else {
      run()
    }
  },

  onShareAppMessage() {
    const g = this.data.currentGroup || getCurrentGroup()
    if (g && g.inviteCode) {
      return {
        title: `邀请你加入 FitBud「${g.name}」一起打卡`,
        path: `/pages/index/index?invite=${g.inviteCode}`
      }
    }
    return {
      title: 'FitBud — 和好朋友一起健身打卡',
      path: '/pages/index/index'
    }
  },

  refreshProfile() {
    const user = (app.globalData && app.globalData.userInfo) || {}
    const nick = user.nickName || ''
    this.setData({
      nickName: nick,
      nickDraft: nick || this.data.nickDraft || ''
    })
  },

  bootstrapPage() {
    // 分享卡片带邀请码 → 自动加入
    if (this._pendingInvite && !this._inviteHandled) {
      this._inviteHandled = true
      const code = this._pendingInvite
      this._pendingInvite = ''
      return this.autoJoin(code)
    }

    const current = getCurrentGroup()
    if (current && current._id) {
      return this.enterGroupMode(current)
    }

    // 无当前群：拉列表，有则进最近一个；没有则引导页
    return this.loadGroups().then((list) => {
      if (list && list.length) {
        return this.enterGroupMode(list[0])
      }
      this.showOnboarding()
    })
  },

  showOnboarding() {
    clearCurrentGroup()
    syncTabBar(false)
    this.setData({
      ready: true,
      mode: 'onboarding',
      currentGroup: null,
      members: [],
      tip: ''
    })
  },

  enterGroupMode(group) {
    return enterGroup(group).then((g) => {
      const finalGroup = g || group
      syncTabBar(true)
      this.setData({
        ready: true,
        mode: 'group',
        currentGroup: finalGroup
      })
      return this.loadGroups().then(() => this.loadMembers(finalGroup._id))
    })
  },

  autoJoin(inviteCode) {
    this.setData({ loading: true, tip: '正在加入群组…', ready: true, mode: 'onboarding' })
    return wx.cloud
      .callFunction({ name: 'group', data: { action: 'join', inviteCode } })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok || !r.group) {
          this.setData({
            tip: r.error === 'group_not_found' ? '邀请码无效或群不存在' : '加入失败，可手动输入邀请码',
            joinCode: inviteCode,
            loading: false
          })
          this.showOnboarding()
          return
        }
        wx.showToast({ title: r.already ? '已在群内' : '已加入群组', icon: 'success' })
        return this.enterGroupMode(r.group).then(() => {
          // 通过分享卡片入群后，进入打卡
          setTimeout(() => {
            wx.switchTab({ url: '/pages/checkin/checkin' })
          }, 300)
        })
      })
      .catch((err) => {
        this.setData({
          tip: ((err && err.errMsg) || '加入失败').slice(0, 80),
          loading: false
        })
        this.showOnboarding()
      })
      .finally(() => this.setData({ loading: false }))
  },

  loadGroups() {
    return wx.cloud
      .callFunction({ name: 'group', data: { action: 'list' } })
      .then((res) => {
        const list = ((res.result || {}).list) || []
        this.setData({ groups: list })
        return list
      })
      .catch((err) => {
        this.setData({ tip: (err && err.errMsg) || '加载群组失败' })
        return []
      })
  },

  loadMembers(groupId) {
    if (!groupId) {
      this.setData({ members: [] })
      return Promise.resolve()
    }
    this.setData({ membersLoading: true })
    return wx.cloud
      .callFunction({ name: 'group', data: { action: 'members', groupId } })
      .then((res) => {
        const r = res.result || {}
        this.setData({
          members: r.ok ? r.list || [] : [],
          membersLoading: false
        })
      })
      .catch(() => this.setData({ members: [], membersLoading: false }))
  },

  onCreateName(e) {
    this.setData({ createName: e.detail.value })
  },

  onJoinCode(e) {
    this.setData({ joinCode: String(e.detail.value || '').toUpperCase() })
  },

  createGroup() {
    const name = (this.data.createName || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入群名称', icon: 'none' })
      return
    }
    if (this.data.loading) return
    this.setData({ loading: true })
    wx.cloud
      .callFunction({ name: 'group', data: { action: 'create', name } })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok || !r.group || !r.group._id) {
          wx.showToast({ title: '创建失败', icon: 'none' })
          return
        }
        this.setData({ createName: '' })
        wx.showToast({ title: '创建成功', icon: 'success' })
        return this.enterGroupMode(r.group)
      })
      .catch((err) => {
        wx.showToast({ title: ((err && err.errMsg) || '创建失败').slice(0, 40), icon: 'none' })
      })
      .finally(() => this.setData({ loading: false }))
  },

  joinGroup() {
    const inviteCode = (this.data.joinCode || '').trim()
    if (!inviteCode) {
      wx.showToast({ title: '请输入邀请码', icon: 'none' })
      return
    }
    if (this.data.loading) return
    this.autoJoin(inviteCode)
  },

  switchGroup(e) {
    const id = e.currentTarget.dataset.id
    const group = (this.data.groups || []).find((g) => g._id === id)
    if (!group || (this.data.currentGroup && this.data.currentGroup._id === id)) return
    this.enterGroupMode(group).then(() => {
      wx.showToast({ title: `已切换到「${group.name}」`, icon: 'success' })
    })
  },

  goCheckin() {
    wx.switchTab({ url: '/pages/checkin/checkin' })
  },

  copyInvite() {
    const code = this.data.currentGroup && this.data.currentGroup.inviteCode
    if (!code) return
    wx.setClipboardData({
      data: code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' })
    })
  },

  onWechatNickname(e) {
    const v = ((e && e.detail && e.detail.value) || '').trim()
    if (v) this.setData({ nickDraft: v })
  },

  onNickInput(e) {
    this.setData({ nickDraft: e.detail.value })
  },

  saveNick() {
    const nickName = (this.data.nickDraft || '').trim()
    if (!nickName) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }
    if (this.data.savingNick) return
    this.setData({ savingNick: true })
    wx.cloud
      .callFunction({ name: 'login', data: { action: 'updateProfile', nickName } })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          wx.showToast({ title: '保存失败', icon: 'none' })
          return
        }
        if (app.globalData) app.globalData.userInfo = r.user
        this.setData({ nickName, nickDraft: nickName })
        wx.showToast({ title: '昵称已保存', icon: 'success' })
        const g = getCurrentGroup()
        if (g && g._id) this.loadMembers(g._id)
      })
      .catch(() => wx.showToast({ title: '请先部署 login', icon: 'none' }))
      .finally(() => this.setData({ savingNick: false }))
  },

  leaveToOnboarding() {
    // 仅切换 UI 到可建/加其他群，不清空当前群数据；用「切换/新建」
    this.setData({ showMoreGroups: !this.data.showMoreGroups })
  }
})
