const { getCurrentGroup, enterGroup, syncTabBar } = require('../../utils/group')
const { requestReviewSubscribe } = require('../../utils/subscribe')
const { guardWantTodoOrLeave } = require('../../utils/features')

const STATUS_MAP = {
  pending: '等回复',
  ready: '积分已兑',
  approved: '可以做',
  rejected: '先缓缓',
  bought: '做过了',
  redeemed: '做过了'
}

const ROAST_PRESETS = [
  '先缓一缓吧',
  '感觉还不是时候',
  '最近已经够忙了',
  '过两天再看',
  '群友替你把把关'
]

const PASS_PRESETS = [
  '支持',
  '听起来不错',
  '去做吧'
]

Page({
  data: {
    id: '',
    groupId: '',
    item: null,
    tip: '',
    pass: true,
    reason: '',
    voting: false,
    deleting: false,
    roastPresets: ROAST_PRESETS,
    passPresets: PASS_PRESETS
  },

  onLoad(query) {
    this.setData({
      id: (query && query.id) || '',
      groupId: (query && query.groupId) || ''
    })
  },

  onShow() {
    if (!guardWantTodoOrLeave()) return
    const app = getApp()
    const ready = (app && app.whenReady) || (() => Promise.resolve({}))
    ready
      .call(app)
      .then(() => {
        const gid = this.data.groupId
        const cached = getCurrentGroup()
        if (gid && (!cached || cached._id !== gid)) {
          return enterGroup({ _id: gid }).then(() => {
            syncTabBar(true)
          })
        }
        return null
      })
      .catch(() => {})
      .then(() => this.loadDetail())
  },

  loadDetail() {
    const group = getCurrentGroup()
    const id = this.data.id
    const groupId = (group && group._id) || this.data.groupId
    if (!groupId || !id) {
      this.setData({ tip: '参数错误' })
      return
    }
    wx.cloud
      .callFunction({
        name: 'shop',
        data: { action: 'detail', groupId, id }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok || !r.item) {
          this.setData({ tip: '加载失败', item: null })
          return
        }
        const item = r.item
        item.statusText = STATUS_MAP[item.status] || item.status
        this.setData({ item, tip: '' })
      })
      .catch((err) => {
        this.setData({ tip: ((err && err.errMsg) || '请部署 shop').slice(0, 60) })
      })
  },

  preview(e) {
    const url = e.currentTarget.dataset.url
    const item = this.data.item
    if (!item || !item.photos || !item.photos.length) return
    wx.previewImage({ current: url, urls: item.photos })
  },

  setPass() {
    this.setData({ pass: true })
  },
  setReject() {
    this.setData({ pass: false })
  },
  pickPreset(e) {
    const text = e.currentTarget.dataset.text || ''
    if (!text) return
    this.setData({ reason: text })
  },
  onReason(e) {
    this.setData({ reason: e.detail.value })
  },

  submitVote() {
    const reason = (this.data.reason || '').trim()
    if (!reason) {
      wx.showToast({ title: '请填写理由', icon: 'none' })
      return
    }
    const group = getCurrentGroup()
    const groupId = (group && group._id) || this.data.groupId
    if (!groupId || this.data.voting) return

    const doVote = () => {
      this.setData({ voting: true })
      wx.cloud
        .callFunction({
          name: 'shop',
          data: {
            action: 'vote',
            groupId,
            id: this.data.id,
            pass: this.data.pass,
            reason
          }
        })
        .then((res) => {
          const r = res.result || {}
          if (!r.ok) {
            const map = {
              reason_required: '写两句想法再发',
              already_voted: '你已经回过了',
              author_cannot_vote: '发起人不用回自己',
              closed: '已经结束了'
            }
            wx.showToast({ title: map[r.error] || '没发出去', icon: 'none' })
            return
          }
          wx.showToast({ title: '已告诉 TA', icon: 'success' })
          this.setData({ reason: '' })
          this.loadDetail()
        })
        .catch(() => wx.showToast({ title: '提交失败', icon: 'none' }))
        .finally(() => this.setData({ voting: false }))
    }

    requestReviewSubscribe().finally(doVote)
  },

  deleteItem() {
    const item = this.data.item
    if (!item || !item.isAuthor || this.data.deleting) return
    const group = getCurrentGroup()
    const groupId = (group && group._id) || this.data.groupId
    if (!groupId) return
    wx.showModal({
      title: '删掉这条',
      content: '确定删掉这条想做的事吗？',
      confirmColor: '#c45c5c',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ deleting: true })
        wx.cloud
          .callFunction({
            name: 'shop',
            data: { action: 'remove', groupId, id: this.data.id }
          })
          .then((r) => {
            const result = r.result || {}
            if (!result.ok) {
              wx.showToast({
                title: result.error === 'forbidden' ? '只能删自己的' : '删除失败',
                icon: 'none'
              })
              return
            }
            wx.showToast({ title: '已删除', icon: 'none' })
            wx.navigateBack()
          })
          .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }))
          .finally(() => this.setData({ deleting: false }))
      }
    })
  }
})
