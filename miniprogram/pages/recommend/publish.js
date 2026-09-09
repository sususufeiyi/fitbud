const { getCurrentGroup } = require('../../utils/group')

const CATEGORIES = ['数码', '美妆', '文娱', '食品', '服饰', '家居', '其他']

Page({
  data: {
    name: '',
    brand: '',
    categories: CATEGORIES,
    categoryIndex: 0,
    price: '',
    usageCount: '',
    usageUnit: 'days', // days | times
    unitPriceText: '—',
    isExpensive: false,
    isLuxury: false,
    manifesto: '',
    photos: [],
    submitting: false
  },

  onUnitDays() {
    this.setData({ usageUnit: 'days' }, () => this.recalc())
  },

  onUnitTimes() {
    this.setData({ usageUnit: 'times' }, () => this.recalc())
  },

  onName(e) {
    this.setData({ name: e.detail.value })
  },
  onBrand(e) {
    this.setData({ brand: e.detail.value })
  },
  onCategory(e) {
    this.setData({ categoryIndex: Number(e.detail.value) })
  },
  onPrice(e) {
    this.setData({ price: e.detail.value }, () => this.recalc())
  },
  onUsage(e) {
    this.setData({ usageCount: e.detail.value }, () => this.recalc())
  },
  onManifesto(e) {
    this.setData({ manifesto: e.detail.value })
  },
  toggleExpensive() {
    this.setData({ isExpensive: !this.data.isExpensive })
  },
  toggleLuxury() {
    this.setData({ isLuxury: !this.data.isLuxury })
  },

  recalc() {
    const price = Number(this.data.price)
    const n = Number(this.data.usageCount)
    if (!(price >= 0) || !(n > 0)) {
      this.setData({ unitPriceText: '—' })
      return
    }
    const v = Math.round((price / n) * 100) / 100
    const label = this.data.usageUnit === 'times' ? '次均价' : '日均价'
    this.setData({ unitPriceText: `${label} ¥${v}` })
  },

  choosePhotos() {
    const remain = 50 - (this.data.photos || []).length
    if (remain <= 0) {
      wx.showToast({ title: '已达上限', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: Math.min(9, remain),
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res.tempFiles || []).map((f) => f.tempFilePath)
        this.setData({ photos: (this.data.photos || []).concat(files) })
      }
    })
  },

  removePhoto(e) {
    const i = Number(e.currentTarget.dataset.index)
    const photos = (this.data.photos || []).slice()
    photos.splice(i, 1)
    this.setData({ photos })
  },

  uploadAll(localPaths) {
    const tasks = localPaths.map((path, index) => {
      const ext = (path.match(/\.[^.]+$/) || ['.jpg'])[0]
      const cloudPath = `shop/${Date.now()}_${index}_${Math.random().toString(36).slice(2)}${ext}`
      return wx.cloud.uploadFile({ cloudPath, filePath: path }).then((r) => r.fileID)
    })
    return Promise.all(tasks)
  },

  submit() {
    const group = getCurrentGroup()
    if (!group) {
      wx.showToast({ title: '请先进入群组', icon: 'none' })
      return
    }
    const name = (this.data.name || '').trim()
    const price = Number(this.data.price)
    const usageCount = Number(this.data.usageCount)
    if (!name) {
      wx.showToast({ title: '请填写物品名', icon: 'none' })
      return
    }
    if (!(price >= 0) || Number.isNaN(price)) {
      wx.showToast({ title: '请填写价格', icon: 'none' })
      return
    }
    if (!(usageCount > 0) || Number.isNaN(usageCount)) {
      wx.showToast({ title: '请填写使用周期/次数', icon: 'none' })
      return
    }
    if (this.data.submitting) return
    this.setData({ submitting: true })

    const locals = this.data.photos || []
    const needUpload = locals.filter((p) => p && !String(p).startsWith('cloud://'))

    const afterUpload = (fileIDs) =>
      wx.cloud.callFunction({
        name: 'shop',
        data: {
          action: 'create',
          groupId: group._id,
          name,
          brand: (this.data.brand || '').trim(),
          category: this.data.categories[this.data.categoryIndex],
          price,
          usageCount,
          usageUnit: this.data.usageUnit,
          isExpensive: this.data.isExpensive,
          isLuxury: this.data.isLuxury,
          manifesto: (this.data.manifesto || '').trim(),
          photos: fileIDs
        }
      })

    const run = needUpload.length
      ? this.uploadAll(needUpload).then((ids) => {
          const kept = locals.filter((p) => String(p).startsWith('cloud://'))
          return afterUpload(kept.concat(ids))
        })
      : afterUpload(locals.filter((p) => String(p).startsWith('cloud://')))

    run
      .then((res) => {
        const r = res.result || {}
        if (!r.ok) {
          wx.showToast({ title: '发布失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '已提交审批', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 500)
      })
      .catch((err) => {
        wx.showToast({
          title: ((err && err.errMsg) || '发布失败').slice(0, 40),
          icon: 'none'
        })
      })
      .finally(() => this.setData({ submitting: false }))
  }
})
