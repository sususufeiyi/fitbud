const { requireGroup, getCurrentGroup, syncTabBar, setTabSelected } = require('../../utils/group')
const { requestReviewSubscribe } = require('../../utils/subscribe')
const { guardWantTodoOrLeave } = require('../../utils/features')

const STATUS_MAP = {
  pending: '等回复',
  approved: '可以做',
  rejected: '先缓缓',
  bought: '做过了',
  ready: '积分已兑',
  redeemed: '做过了'
}

const FILTERS = [
  { key: 'pending', label: '等回复' },
  { key: 'approved', label: '可以做' },
  { key: 'rejected', label: '先缓缓' },
  { key: 'bought', label: '做过了' }
]

const EMPTY_TIP = {
  pending: '还没有人说说想做什么',
  approved: '还没有可以去做的',
  rejected: '还没有先缓缓的',
  bought: '还没有做过的记录'
}

/** 四分类：可以买=群审通过；积分兑换直接进已经买啦 */
function bucketOf(item) {
  const s = item.status
  if (s === 'bought' || s === 'redeemed') return 'bought'
  // 旧 ready（积分已兑未点买）仍归可以买，方便点「买！」
  if (s === 'ready') return 'approved'
  if (s === 'rejected') return 'rejected'
  if (s === 'approved') return 'approved'
  return 'pending'
}

Page({
  data: {
    locked: false,
    loading: true,
    list: [],
    filteredList: [],
    skeletonRows: [1, 2, 3],
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
    if (!guardWantTodoOrLeave()) return
    const app = getApp()
    const apply = (group) => {
      if (!group || !group._id) {
        this.setData({ locked: true, tip: '正在准备…' })
        return
      }
      syncTabBar(true)
      setTabSelected(this, 'recommend')
      this.setData({
        locked: false,
        tip: '',
        loading: !(this.data.filteredList || []).length
      })
      this.loadList()
    }

    const local = requireGroup()
    if (local) {
      apply(local)
      return
    }

    const ready = (app && app.whenReady) || (() => Promise.resolve({ group: null }))
    ready
      .call(app)
      .then((r) => apply((r && r.group) || getCurrentGroup()))
      .catch(() => apply(getCurrentGroup()))
  },

  applyFilter(list, filterKey) {
    const key = filterKey || this.data.filterKey || 'pending'
    const filteredList = (list || []).filter((item) => bucketOf(item) === key)
    const filterCounts = {
      pending: 0,
      approved: 0,
      rejected: 0,
      bought: 0
    }
    ;(list || []).forEach((item) => {
      const b = bucketOf(item)
      if (filterCounts[b] != null) filterCounts[b] += 1
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
        const list = (r.list || []).map((item) => {
          const status = item.status
          let statusClass = status
          if (status === 'redeemed' || status === 'ready') {
            statusClass = status === 'ready' ? 'approved' : 'bought'
          }
          return {
            ...item,
            statusText: STATUS_MAP[status] || status,
            statusClass,
            // 旧 ready 仍可点买
            showBuy: item.showBuy || (item.isAuthor && status === 'ready')
          }
        })
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
    requestReviewSubscribe().finally(() => {
      wx.navigateTo({ url: '/pages/recommend/publish' })
    })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    requestReviewSubscribe().finally(() => {
      wx.navigateTo({ url: `/pages/recommend/detail?id=${id}` })
    })
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
      title: '积分兑现',
      content: `将消耗 ${cost} 积分（约抵 ¥${cost * 10}），兑现后记入「做过了」，确认？`,
      confirmText: '兑现',
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
                forbidden: '只能兑现自己的',
                not_redeemable: '当前还不能兑现',
                already_redeemed: '已兑现过'
              }
              wx.showToast({ title: map[result.error] || '兑现失败', icon: 'none' })
              return
            }
            wx.showToast({ title: `已兑现 -${result.cost}`, icon: 'success' })
            this.setData({ filterKey: 'bought' })
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
      title: '确认完成？',
      confirmText: '完成',
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
                not_buyable: '当前还不能完成'
              }
              wx.showToast({ title: map[result.error] || '操作失败', icon: 'none' })
              return
            }
            wx.showToast({ title: '已完成', icon: 'success' })
            this.setData({ filterKey: 'bought' })
            this.loadList()
          })
          .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }))
      }
    })
  },

  onDeleteItem(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const item = (this.data.list || []).find((x) => x._id === id)
    if (item && !item.isAuthor) {
      wx.showToast({ title: '只能删自己的', icon: 'none' })
      return
    }
    const group = getCurrentGroup()
    if (!group) return
    wx.showModal({
      title: '删掉这条',
      content: '确定删掉这条想做的事吗？',
      confirmColor: '#c45c5c',
      success: (res) => {
        if (!res.confirm) return
        wx.cloud
          .callFunction({
            name: 'shop',
            data: { action: 'remove', groupId: group._id, id }
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
            this.loadList()
          })
          .catch(() => wx.showToast({ title: '网络错误', icon: 'none' }))
      }
    })
  }
})
