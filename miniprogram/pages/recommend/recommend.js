const { requireGroup, getCurrentGroup, syncTabBar } = require('../../utils/group')

const STATUS_MAP = {
  pending: '审批中',
  approved: '可以购入',
  rejected: '暂不建议'
}

Page({
  data: {
    locked: false,
    loading: false,
    list: [],
    tip: ''
  },

  onShow() {
    const group = requireGroup()
    if (!group) {
      this.setData({ locked: true, tip: '请先创建或加入群组' })
      return
    }
    syncTabBar(true)
    this.setData({ locked: false, tip: '' })
    this.loadList()
  },

  loadList() {
    const group = getCurrentGroup()
    if (!group) return
    this.setData({ loading: true })
    wx.cloud
      .callFunction({
        name: 'shop',
        data: { action: 'list', groupId: group._id }
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
        const list = (r.list || []).map((item) => ({
          ...item,
          statusText: STATUS_MAP[item.status] || item.status,
          statusClass: item.status
        }))
        this.setData({ list, loading: false })
      })
      .catch((err) => {
        this.setData({
          tip: ((err && err.errMsg) || '请先部署 shop 云函数').slice(0, 60),
          loading: false
        })
      })
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/recommend/publish' })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/recommend/detail?id=${id}` })
  }
})
