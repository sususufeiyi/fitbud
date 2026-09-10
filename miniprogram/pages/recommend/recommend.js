const { requireGroup, getCurrentGroup, syncTabBar } = require('../../utils/group')

const STATUS_MAP = {
  pending: '审批中',
  approved: '可以买',
  rejected: '不能买',
  bought: '已经买啦',
  redeemed: '已经买啦' // 旧数据兼容
}

const FILTERS = [
  { key: 'pending', label: '现在想买' },
  { key: 'approved', label: '可以买' },
  { key: 'rejected', label: '不能买' },
  { key: 'bought', label: '已经买啦' }
]

const EMPTY_TIP = {
  pending: '还没有审批中的想买',
  approved: '还没有可以买的',
  rejected: '还没有不能买的',
  bought: '还没有已经买的'
}

function matchFilter(status, filterKey) {
  if (filterKey === 'bought') return status === 'bought' || status === 'redeemed'
  return status === filterKey
}

Page({
  data: {
    locked: false,
    loading: false,
    list: [],
    filteredList: [],
    filters: FILTERS,
    filterKey: 'pending',
    filterCounts: {
      pending: 0,
      approved: 0,
      rejected: 0,
      bought: 0
    },
    emptyTip: EMPTY_TIP.pending,
    myPoints: 0,
    tip: ''
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
      tip: ''
    })
    this.loadList()
  },

  applyFilter(list, filterKey) {
    const key = filterKey || this.data.filterKey || 'pending'
    const filteredList = (list || []).filter((item) => matchFilter(item.status, key))
    const filterCounts = {
      pending: 0,
      approved: 0,
      rejected: 0,
      bought: 0
    }
    ;(list || []).forEach((item) => {
      if (item.status === 'bought' || item.status === 'redeemed') filterCounts.bought += 1
      else if (filterCounts[item.status] != null) filterCounts[item.status] += 1
    })
    return {
      filterKey: key,
      filteredList,
      filterCounts,
      emptyTip: EMPTY_TIP[key] || '暂无内容'
    }
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
          statusClass: item.status === 'redeemed' ? 'bought' : item.status
        }))
        this.setData({
          list,
          myPoints: r.myPoints || 0,
          loading: false,
          ...this.applyFilter(list, this.data.filterKey)
        })
      })
      .catch((err) => {
        this.setData({
          tip: ((err && err.errMsg) || '请先部署 shop 云函数').slice(0, 60),
          loading: false
        })
      })
  },

  onFilterTap(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key === this.data.filterKey) return
    this.setData(this.applyFilter(this.data.list, key))
  },

  goPublish() {
    wx.navigateTo({ url: '/pages/recommend/publish' })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/recommend/detail?id=${id}` })
  },

  onRedeem(e) {
    const id = e.currentTarget.dataset.id
    const can = !!e.currentTarget.dataset.can
    const cost = Number(e.currentTarget.dataset.cost) || 0
    if (!id) return
    if (!can) {
      wx.showToast({
        title: `还差 ${Math.max(0, cost - (this.data.myPoints || 0))} 积分`,
        icon: 'none'
      })
      return
    }

    const group = getCurrentGroup()
    if (!group) return

    wx.showModal({
      title: '积分兑换',
      content: `将消耗 ${cost} 积分（约抵 ¥${cost * 10}），兑换后进入「可以买」，确认？`,
      confirmText: '兑换',
      success: (res) => {
        if (!res.confirm) return
        wx.cloud
          .callFunction({
            name: 'shop',
            data: { action: 'redeem', groupId: group._id, id }
          })
          .then((r) => {
            const result = r.result || {}
            if (!result.ok) {
              const map = {
                not_enough_points: '积分不足',
                forbidden: '只能兑换自己的',
                not_redeemable: '当前状态不可兑',
                already_redeemed: '已兑换过'
              }
              wx.showToast({ title: map[result.error] || '兑换失败', icon: 'none' })
              return
            }
            wx.showToast({ title: `已兑换 -${result.cost}`, icon: 'success' })
            this.setData({ filterKey: 'approved' })
            this.loadList()
          })
          .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }))
      }
    })
  },

  onMarkBought(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const group = getCurrentGroup()
    if (!group) return

    wx.showModal({
      title: '确认购买',
      content: '标记为已经买啦？',
      confirmText: '买！',
      success: (res) => {
        if (!res.confirm) return
        wx.cloud
          .callFunction({
            name: 'shop',
            data: { action: 'markBought', groupId: group._id, id }
          })
          .then((r) => {
            const result = r.result || {}
            if (!result.ok) {
              const map = {
                forbidden: '只能操作自己的',
                not_buyable: '当前还不能买'
              }
              wx.showToast({ title: map[result.error] || '操作失败', icon: 'none' })
              return
            }
            wx.showToast({ title: '已经买啦', icon: 'success' })
            this.setData({ filterKey: 'bought' })
            this.loadList()
          })
          .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }))
      }
    })
  }
})
