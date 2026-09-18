Component({
  data: {
    selected: 0,
    list: []
  },

  lifetimes: {
    attached() {
      this.refresh()
    }
  },

  pageLifetimes: {
    show() {
      this.refresh()
    }
  },

  methods: {
    refresh() {
      let showWantTodo = false
      try {
        const { isWantTodoEnabled } = require('../utils/features')
        showWantTodo = isWantTodoEnabled()
      } catch (e) {
        showWantTodo = false
      }
      const list = showWantTodo
        ? [
            { pagePath: '/pages/checkin/checkin', text: '打卡', role: 'checkin' },
            { pagePath: '/pages/recommend/recommend', text: '想做什么', role: 'recommend' },
            { pagePath: '/pages/rewards/rewards', text: '奖励', role: 'rewards' }
          ]
        : [
            { pagePath: '/pages/checkin/checkin', text: '打卡', role: 'checkin' },
            { pagePath: '/pages/rewards/rewards', text: '奖励', role: 'rewards' }
          ]
      this.setData({ list })
    },

    setSelected(selected) {
      this.setData({ selected: Number(selected) || 0 })
    },

    setSelectedByRole(role) {
      const list = this.data.list || []
      const idx = list.findIndex((item) => item.role === role)
      this.setData({ selected: idx >= 0 ? idx : 0 })
    },

    onTap(e) {
      const path = e.currentTarget.dataset.path
      const index = Number(e.currentTarget.dataset.index)
      if (!path) return
      this.setData({ selected: index })
      wx.switchTab({ url: path })
    }
  }
})
