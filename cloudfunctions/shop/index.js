const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const CATEGORIES = ['吃喝', '玩乐', '学习', '运动', '居家', '数码', '其他']

/** 与 config 云函数同一开关：showWantTodo !== true 则功能关闭 */
async function isWantTodoEnabled() {
  try {
    const res = await db.collection('app_config').doc('main').get()
    return !!(res.data && res.data.showWantTodo === true)
  } catch (e) {
    return false
  }
}

/** 朋友想法提醒 · thing1 + time2 */
const REVIEW_TMPL_ID = 'T3fYlBrSptEuKAUE1mEdhDyMQh0WKi7OHAV8I7LXbSs'

function clipThing(s) {
  const t = String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
  if (!t) return '朋友想听听你的想法'
  return t.slice(0, 20)
}

/** 订阅消息 time 类型：yyyy年MM月dd日 HH:mm */
function formatSubscribeTime(date) {
  const d = date instanceof Date ? date : new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(d)
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '00'
  return `${get('year')}年${Number(get('month'))}月${Number(get('day'))}日 ${get('hour')}:${get('minute')}`
}

async function notifyReviewers({ openids, itemId, groupId, thing, when }) {
  const list = (openids || []).filter(Boolean)
  if (!list.length || !itemId || !REVIEW_TMPL_ID) return
  const page = `pages/recommend/detail?id=${itemId}&groupId=${groupId || ''}`
  const data = {
    thing1: { value: clipThing(thing) },
    time2: { value: when || formatSubscribeTime() }
  }
  await Promise.all(
    list.map((touser) =>
      cloud.openapi.subscribeMessage
        .send({
          touser,
          templateId: REVIEW_TMPL_ID,
          page,
          data,
          miniprogramState: 'formal'
        })
        .catch((err) => {
          console.warn('[shop] subscribe send fail', touser.slice(-4), err && err.errMsg)
        })
    )
  )
}

/** 云文件转临时 HTTPS，群友才能看到别人上传的图 */
async function resolvePhotoUrls(photos) {
  const list = (photos || []).filter(Boolean).map(String)
  if (!list.length) return []
  const cloudIds = list.filter((p) => p.startsWith('cloud://'))
  if (!cloudIds.length) return list
  try {
    const res = await cloud.getTempFileURL({ fileList: cloudIds.slice(0, 50) })
    const map = {}
    ;(res.fileList || []).forEach((f) => {
      if (f && f.fileID && f.tempFileURL && (f.status === 0 || f.status == null)) {
        map[f.fileID] = f.tempFileURL
      }
    })
    return list.map((p) => map[p] || p)
  } catch (e) {
    console.warn('[shop] getTempFileURL', e && e.message)
    return list
  }
}

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

/** 1 积分抵 10 元 */
function pointsNeeded(price) {
  const p = Number(price)
  if (!(p > 0)) return 0
  return Math.ceil(p / 10)
}

async function addPointLog({ groupId, openid, delta, balance, reason, title, refId }) {
  if (!groupId || !openid || !delta) return
  await db.collection('point_logs').add({
    data: {
      groupId,
      openid,
      delta,
      balance: balance != null ? balance : 0,
      reason: reason || '',
      title: String(title || '').slice(0, 40),
      refId: refId || '',
      createdAt: db.serverDate()
    }
  })
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
 * action: list | create | detail | vote | redeem | markBought | remove
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

  if (!(await isWantTodoEnabled())) {
    return { ok: false, error: 'feature_disabled' }
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
    const myPoints = me.points || 0

    const list = (res.data || [])
      .map((item) => {
        const required = item.requiredVoters || []
        const votes = item.votes || []
        const myVote = votes.find((v) => v.openid === OPENID)
        const isAuthor = item.authorOpenid === OPENID
        const cost = pointsNeeded(item.price)
        const showRedeem =
          isAuthor && (item.status === 'pending' || item.status === 'rejected') && cost > 0
        // 「可以买」仅群审通过，可点「买！」
        const showBuy = isAuthor && item.status === 'approved'
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
          filterStatus: item.status,
          photoCount: (item.photos || []).length,
          cover: (item.photos && item.photos[0]) || '',
          authorOpenid: item.authorOpenid,
          authorName: nameMap[item.authorOpenid] || '成员',
          isAuthor,
          voteProgress: `${votes.length}/${required.length || 0}`,
          needMyVote: !isAuthor && required.includes(OPENID) && !myVote && item.status === 'pending',
          createdAt: item.createdAt,
          showRedeem,
          redeemCost: cost,
          canRedeem: showRedeem && myPoints >= cost,
          showBuy,
          viaPoints: !!item.viaPoints
        }
      })
      .sort((a, b) => {
        const ta = a.createdAt && a.createdAt.getTime ? a.createdAt.getTime() : 0
        const tb = b.createdAt && b.createdAt.getTime ? b.createdAt.getTime() : 0
        return tb - ta
      })

    return { ok: true, list, myPoints }
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

    if (requiredVoters.length) {
      const authorLabel = displayName(me, OPENID)
      const thing = `${authorLabel}想做${name}`
      try {
        await notifyReviewers({
          openids: requiredVoters,
          itemId: addRes._id,
          groupId,
          thing,
          when: formatSubscribeTime()
        })
      } catch (e) {
        console.warn('[shop] notifyReviewers', e && e.message)
      }
    }

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

    const photos = await resolvePhotoUrls(item.photos)

    return {
      ok: true,
      item: {
        ...item,
        _id: id,
        photos,
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

  if (action === 'remove') {
    const id = event.id
    if (!id) return { ok: false, error: 'id_required' }
    const doc = await col.doc(id).get()
    const item = doc.data
    if (!item || item.groupId !== groupId) return { ok: false, error: 'not_found' }
    if (item.authorOpenid !== OPENID) return { ok: false, error: 'forbidden' }
    await col.doc(id).remove()
    return { ok: true }
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

  if (action === 'redeem') {
    const id = event.id
    if (!id) return { ok: false, error: 'id_required' }

    const doc = await col.doc(id).get()
    const item = doc.data
    if (!item || item.groupId !== groupId) return { ok: false, error: 'not_found' }
    if (item.authorOpenid !== OPENID) return { ok: false, error: 'forbidden' }
    if (item.status !== 'pending' && item.status !== 'rejected') {
      return { ok: false, error: 'not_redeemable' }
    }
    if (item.pointsRedeemedAt || item.status === 'bought' || item.status === 'redeemed') {
      return { ok: false, error: 'already_redeemed' }
    }

    const cost = pointsNeeded(item.price)
    if (!(cost > 0)) return { ok: false, error: 'price_invalid' }

    const points = me.points || 0
    if (points < cost) return { ok: false, error: 'not_enough_points', points, cost }

    const nextPoints = points - cost
    await db.collection('group_members').doc(me._id).update({
      data: { points: _.inc(-cost) }
    })
    // 积分兑换成功 → 直接「已经买啦」
    await col.doc(id).update({
      data: {
        status: 'bought',
        viaPoints: true,
        pointsRedeemedAt: db.serverDate(),
        boughtAt: db.serverDate(),
        redeemCost: cost,
        updatedAt: db.serverDate()
      }
    })
    await addPointLog({
      groupId,
      openid: OPENID,
      delta: -cost,
      balance: nextPoints,
      reason: 'shop_redeem',
      title: `兑现「${item.name || '想做的事'}」`,
      refId: id
    })

    return { ok: true, cost, points: nextPoints, status: 'bought' }
  }

  if (action === 'markBought') {
    const id = event.id
    if (!id) return { ok: false, error: 'id_required' }

    const doc = await col.doc(id).get()
    const item = doc.data
    if (!item || item.groupId !== groupId) return { ok: false, error: 'not_found' }
    if (item.authorOpenid !== OPENID) return { ok: false, error: 'forbidden' }
    if (item.status !== 'approved' && item.status !== 'ready') {
      return { ok: false, error: 'not_buyable' }
    }

    await col.doc(id).update({
      data: {
        status: 'bought',
        boughtAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })

    return { ok: true, status: 'bought' }
  }

  return { ok: false, error: 'unknown_action' }
}
