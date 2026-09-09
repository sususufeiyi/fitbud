const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const CATEGORIES = ['数码', '美妆', '文娱', '食品', '服饰', '家居', '其他']

async function listMembers(groupId) {
  const res = await db.collection('group_members').where({ groupId }).limit(50).get()
  return res.data || []
}

function memberOpenid(m) {
  return m.openid || m._openid || ''
}

async function requireMember(groupId, openid) {
  if (!groupId || !openid) return null
  let res = await db.collection('group_members').where({ groupId, openid }).limit(1).get()
  if (res.data[0]) return res.data[0]
  res = await db.collection('group_members').where({ groupId, _openid: openid }).limit(1).get()
  return res.data[0] || null
}

function displayName(m, openid) {
  const nick = (m && m.nickName) || ''
  if (nick.trim()) return nick.trim()
  const oid = openid || (m && memberOpenid(m)) || ''
  return `Buddy ${String(oid).slice(-4) || '??'}`
}

function calcUnitPrice(price, usageCount) {
  const p = Number(price)
  const n = Number(usageCount)
  if (!(p >= 0) || !(n > 0)) return 0
  return Math.round((p / n) * 100) / 100
}

function finalizeStatus(item) {
  const required = item.requiredVoters || []
  const votes = item.votes || []
  if (!required.length) {
    // 群里只有发布人自己：无人可批，直接可购入
    return 'approved'
  }
  if (votes.length < required.length) return 'pending'
  const allPass = required.every((oid) => {
    const v = votes.find((x) => x.openid === oid)
    return v && v.pass === true
  })
  return allPass ? 'approved' : 'rejected'
}

/**
 * action: list | create | detail | vote
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'
  const groupId = event.groupId
  const col = db.collection('shop_items')

  if (!groupId && action !== 'categories') {
    return { ok: false, error: 'group_required' }
  }

  if (action === 'categories') {
    return { ok: true, list: CATEGORIES }
  }

  const me = await requireMember(groupId, OPENID)
  if (!me) return { ok: false, error: 'not_in_group' }

  if (action === 'list') {
    const res = await col.where({ groupId }).limit(50).get()
    const members = await listMembers(groupId)
    const nameMap = {}
    members.forEach((m) => {
      nameMap[memberOpenid(m)] = displayName(m)
    })

    const list = (res.data || [])
      .map((item) => {
        const required = item.requiredVoters || []
        const votes = item.votes || []
        const myVote = votes.find((v) => v.openid === OPENID)
        const isAuthor = item.authorOpenid === OPENID
        return {
          _id: item._id,
          name: item.name,
          brand: item.brand,
          category: item.category,
          price: item.price,
          unitPrice: item.unitPrice,
          usageUnit: item.usageUnit,
          isExpensive: !!item.isExpensive,
          isLuxury: !!item.isLuxury,
          status: item.status,
          photoCount: (item.photos || []).length,
          cover: (item.photos && item.photos[0]) || '',
          authorOpenid: item.authorOpenid,
          authorName: nameMap[item.authorOpenid] || '成员',
          isAuthor,
          voteProgress: `${votes.length}/${required.length || 0}`,
          needMyVote: !isAuthor && required.includes(OPENID) && !myVote,
          createdAt: item.createdAt
        }
      })
      .sort((a, b) => {
        const ta = a.createdAt && a.createdAt.getTime ? a.createdAt.getTime() : 0
        const tb = b.createdAt && b.createdAt.getTime ? b.createdAt.getTime() : 0
        return tb - ta
      })

    return { ok: true, list }
  }

  if (action === 'create') {
    const name = String(event.name || '').trim().slice(0, 40)
    const brand = String(event.brand || '').trim().slice(0, 40)
    const category = String(event.category || '').trim()
    const price = Number(event.price)
    const usageCount = Number(event.usageCount)
    const usageUnit = event.usageUnit === 'times' ? 'times' : 'days'
    const manifesto = String(event.manifesto || '').trim().slice(0, 1000)
    const photos = Array.isArray(event.photos) ? event.photos.filter(Boolean).slice(0, 50) : []
    const isExpensive = !!event.isExpensive
    const isLuxury = !!event.isLuxury

    if (!name) return { ok: false, error: 'name_required' }
    if (!CATEGORIES.includes(category)) return { ok: false, error: 'category_invalid' }
    if (!(price >= 0)) return { ok: false, error: 'price_invalid' }
    if (!(usageCount > 0)) return { ok: false, error: 'usage_invalid' }

    const members = await listMembers(groupId)
    const requiredVoters = members
      .map(memberOpenid)
      .filter((oid) => oid && oid !== OPENID)

    const unitPrice = calcUnitPrice(price, usageCount)
    let status = 'pending'
    if (!requiredVoters.length) status = 'approved'

    const addRes = await col.add({
      data: {
        groupId,
        authorOpenid: OPENID,
        name,
        brand,
        category,
        price,
        usageCount,
        usageUnit,
        unitPrice,
        isExpensive,
        isLuxury,
        manifesto,
        photos,
        requiredVoters,
        votes: [],
        status,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })

    const doc = (await col.doc(addRes._id).get()).data
    return { ok: true, item: { ...doc, _id: addRes._id } }
  }

  if (action === 'detail') {
    const id = event.id
    if (!id) return { ok: false, error: 'id_required' }
    const doc = await col.doc(id).get()
    const item = doc.data
    if (!item || item.groupId !== groupId) return { ok: false, error: 'not_found' }

    const members = await listMembers(groupId)
    const nameMap = {}
    members.forEach((m) => {
      nameMap[memberOpenid(m)] = displayName(m)
    })

    const votes = (item.votes || []).map((v) => ({
      ...v,
      name: nameMap[v.openid] || '成员'
    }))

    const pendingVoters = (item.requiredVoters || [])
      .filter((oid) => !(item.votes || []).some((v) => v.openid === oid))
      .map((oid) => ({ openid: oid, name: nameMap[oid] || '成员' }))

    const isAuthor = item.authorOpenid === OPENID
    const myVote = (item.votes || []).find((v) => v.openid === OPENID)
    const canVote =
      !isAuthor &&
      (item.requiredVoters || []).includes(OPENID) &&
      !myVote &&
      item.status === 'pending'

    return {
      ok: true,
      item: {
        ...item,
        _id: id,
        authorName: nameMap[item.authorOpenid] || '成员',
        isAuthor,
        votes,
        pendingVoters,
        canVote,
        myVote: myVote || null,
        unitLabel: item.usageUnit === 'times' ? '次均价' : '日均价'
      }
    }
  }

  if (action === 'vote') {
    const id = event.id
    const pass = !!event.pass
    const reason = String(event.reason || '').trim().slice(0, 300)
    if (!id) return { ok: false, error: 'id_required' }
    if (!reason) return { ok: false, error: 'reason_required' }

    const doc = await col.doc(id).get()
    const item = doc.data
    if (!item || item.groupId !== groupId) return { ok: false, error: 'not_found' }
    if (item.status !== 'pending') return { ok: false, error: 'closed' }
    if (item.authorOpenid === OPENID) return { ok: false, error: 'author_cannot_vote' }
    if (!(item.requiredVoters || []).includes(OPENID)) {
      return { ok: false, error: 'not_voter' }
    }
    if ((item.votes || []).some((v) => v.openid === OPENID)) {
      return { ok: false, error: 'already_voted' }
    }

    const votes = (item.votes || []).concat([
      {
        openid: OPENID,
        pass,
        reason,
        at: Date.now()
      }
    ])

    const next = { ...item, votes }
    const status = finalizeStatus(next)

    await col.doc(id).update({
      data: {
        votes,
        status,
        updatedAt: db.serverDate()
      }
    })

    return { ok: true, status, votesCount: votes.length }
  }

  return { ok: false, error: 'unknown_action' }
}
