const { reviewSubscribeTmplId } = require('../config')

/**
 * 申请「朋友想法提醒」一次性订阅（须在用户点击回调里调用）
 * @returns {Promise<boolean>} 是否 accept
 */
function requestReviewSubscribe() {
  const tmplId = reviewSubscribeTmplId
  if (!tmplId || !wx.requestSubscribeMessage) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: [tmplId],
      success: (res) => resolve(res && res[tmplId] === 'accept'),
      fail: () => resolve(false)
    })
  })
}

module.exports = {
  requestReviewSubscribe
}
