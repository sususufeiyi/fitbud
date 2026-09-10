const { getCurrentGroup } = require('../../utils/group')

const STATUS_MAP = {
  pending: '审批中',
  approved: '可以买',
  rejected: '不能买',
  bought: '已经买啦',
  redeemed: '已经买啦'
}

Page({
  data: {
    id: '',
    item: null,
    tip: '',
    pass: true,
    reason: '',
    voting: false
  },

  onLoad(query) {
    this.setData({ id: (query && query.id) || '' })
  },

  onShow() {
    this.loadDetail()
  },

  loadDetail() {
    const group = getCurrentGroup()
    const id = this.data.id
    if (!group || !id) {
      this.setData({ tip: '参数错误' })
      return
    }
    wx.cloud
      .callFunction({
        name: 'shop',
        data: { action: 'detail', groupId: group._id, id }
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
    if (!group || this.data.voting) return
    this.setData({ voting: true })

    wx.cloud
      .callFunction({
        name: 'shop',
        data: {
          action: 'vote',
          groupId: group._id,
          id: this.data.id,
          pass: this.data.pass,
          reason
        }
      })
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          const map = {
            reason_required: '请填写理由',
            already_voted: '你已审批过',
            author_cannot_vote: '发布人不能投票',
            closed: '已结束'
          }
          wx.showToast({ title: map[r.error] || '提交失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '已提交', icon: 'success' })
        this.setData({ reason: '' })
        this.loadDetail()
      })
      .catch(() => wx.showToast({ title: '提交失败', icon: 'none' }))
      .finally(() => this.setData({ voting: false }))
  }
})
