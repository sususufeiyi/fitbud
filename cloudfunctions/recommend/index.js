const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

async function requireMember(groupId, openid) {
  if (!groupId) return null
  let res = await db
    .collection('group_members')
    .where({ groupId, openid })
    .limit(1)
    .get()
  if (res.data[0]) return res.data[0]
  res = await db
    .collection('group_members')
    .where({ groupId, _openid: openid })
    .limit(1)
    .get()
  return res.data[0] || null
}

/**
 * event.action: 'list' | 'add' | 'like'
 * event.groupId 必填
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'
  const groupId = event.groupId
  const member = await requireMember(groupId, OPENID)
  if (!member) return { ok: false, error: 'not_in_group' }

  const recommends = db.collection('recommends')

  if (action === 'list') {
    const limit = Math.min(Number(event.limit) || 20, 50)
    const res = await recommends.where({ groupId }).limit(limit).get()
    const list = (res.data || []).sort((a, b) => {
      const ta = (a.createdAt && a.createdAt.getTime) ? a.createdAt.getTime() : 0
      const tb = (b.createdAt && b.createdAt.getTime) ? b.createdAt.getTime() : 0
      return tb - ta
    })
    return { ok: true, list }
  }

  if (action === 'add') {
    const title = String(event.title || '').trim().slice(0, 40)
    const content = String(event.content || '').trim().slice(0, 500)
    const link = String(event.link || '').trim().slice(0, 300)
    if (!title) return { ok: false, error: 'title_required' }

    const addRes = await recommends.add({
      data: {
        groupId,
        title,
        content,
        link,
        likes: 0,
        likedBy: [],
        createdAt: db.serverDate()
      }
    })
    const doc = await recommends.doc(addRes._id).get()
    return { ok: true, item: doc.data }
  }

  if (action === 'like') {
    const id = event.id
    if (!id) return { ok: false, error: 'id_required' }
    const docRes = await recommends.doc(id).get()
    const item = docRes.data
    if (!item || item.groupId !== groupId) return { ok: false, error: 'not_found' }

    const likedBy = item.likedBy || []
    if (likedBy.includes(OPENID)) {
      return { ok: true, already: true, item }
    }

    await recommends.doc(id).update({
      data: {
        likes: _.inc(1),
        likedBy: _.addToSet(OPENID)
      }
    })
    const updated = await recommends.doc(id).get()
    return { ok: true, already: false, item: updated.data }
  }

  return { ok: false, error: 'unknown_action' }
}
