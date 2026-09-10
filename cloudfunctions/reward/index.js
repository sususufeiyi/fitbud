const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const STREAK_MILESTONES = [
  { threshold: 3, title: '起步 Buddy', points: 30 },
  { threshold: 7, title: '一周坚持', points: 70 },
  { threshold: 14, title: '两周达人', points: 140 },
  { threshold: 30, title: '月度王者', points: 300 }
]

const TOTAL_MILESTONES = [
  { threshold: 10, title: '小试牛刀', points: 20 },
  { threshold: 30, title: '勤快打卡', points: 50 },
  { threshold: 50, title: '习惯养成', points: 80 },
  { threshold: 100, title: '百次达人', points: 150 }
]

function claimKey(c) {
  if (!c) return ''
  if (c.type === 'total') return `total_${Number(c.threshold)}`
  if (c.type === 'streak') {
    const t = c.threshold != null ? c.threshold : c.days
    return `streak_${Number(t)}`
  }
  // 旧数据无 type
  if (c.days != null) return `streak_${Number(c.days)}`
  if (c.threshold != null) {
    const title = c.title || ''
    if (/小试|勤快|习惯|百次/.test(title) || c.reason === 'reward_total') {
      return `total_${Number(c.threshold)}`
    }
    return `streak_${Number(c.threshold)}`
  }
  // 积分流水 refId：total_10 / streak_7
  if (c.refId && /^(total|streak)_\d+$/.test(c.refId)) return c.refId
  if (c.reason === 'reward_total' && c.refId) return c.refId
  if (c.reason === 'reward_streak' && c.refId) return c.refId
  return ''
}

async function listClaims(groupId, openid) {
  const claims = db.collection('reward_claims')
  let rows = []
  try {
    const byOpenid = await claims.where({ groupId, openid }).limit(100).get()
    rows = byOpenid.data || []
  } catch (e) {
    rows = []
  }
  try {
    const byCloudOpenid = await claims.where({ groupId, _openid: openid }).limit(100).get()
    const seen = new Set(rows.map((r) => r._id))
    ;(byCloudOpenid.data || []).forEach((r) => {
      if (!seen.has(r._id)) rows.push(r)
    })
  } catch (e) {
    // ignore
  }
  return rows
}

/** 是否已领过该档（含早期无 openid 的脏数据） */
async function findExistingClaim(groupId, openid, type, threshold) {
  const claims = db.collection('reward_claims')
  const rows = await listClaims(groupId, openid)
  const key = `${type}_${threshold}`
  const hit = rows.find((c) => claimKey(c) === key)
  if (hit) return hit

  // 按档位再查，认领无归属旧记录
  try {
    let res
    if (type === 'total') {
      res = await claims.where({ groupId, type: 'total', threshold }).limit(20).get()
    } else {
      res = await claims
        .where({ groupId, days: threshold })
        .limit(20)
        .get()
      const also = await claims.where({ groupId, type: 'streak', threshold }).limit(20).get()
      res = { data: [...(res.data || []), ...(also.data || [])] }
    }
    const list = res.data || []
    const mine = list.find((c) => (c.openid || c._openid || '') === openid)
    if (mine) return mine
    const orphan = list.find((c) => !(c.openid || c._openid))
    if (orphan) {
      try {
        await claims.doc(orphan._id).update({ data: { openid, type, threshold } })
      } catch (e) {
        // ignore
      }
      return orphan
    }
  } catch (e) {
    // ignore
  }
  return null
}

function formatLogTime(v) {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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
 * event.action: 'status' | 'claim' | 'pointLogs'
 * event.groupId 必填
 * claim: type 'streak'|'total', threshold
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'status'
  const groupId = event.groupId
  const member = await requireMember(groupId, OPENID)
  if (!member) return { ok: false, error: 'not_in_group' }

  const claimedRows = await listClaims(groupId, OPENID)
  const claimedSet = new Set(claimedRows.map(claimKey).filter(Boolean))

  // 总打卡/连续：再扫一遍同群记录（含无 openid 旧数据）
  try {
    const all = await db.collection('reward_claims').where({ groupId }).limit(200).get()
    ;(all.data || []).forEach((c) => {
      const oid = c.openid || c._openid || ''
      if (oid && oid !== OPENID) return
      const key = claimKey(c)
      if (key) claimedSet.add(key)
    })
  } catch (e) {
    // ignore
  }

  // 再用积分流水兜底（领取成功但 claims 查不到时）
  try {
    let logs = (
      await db.collection('point_logs').where({ groupId, openid: OPENID }).limit(100).get()
    ).data || []
    if (!logs.length) {
      logs =
        (
          await db.collection('point_logs').where({ groupId, _openid: OPENID }).limit(100).get()
        ).data || []
    }
    logs.forEach((l) => {
      if (l.reason !== 'reward_total' && l.reason !== 'reward_streak') return
      const key = claimKey(l)
      if (key) claimedSet.add(key)
    })
  } catch (e) {
    // ignore
  }

  const streak = member.streak || 0
  const totalCheckins = member.totalCheckins || 0

  const streakMilestones = STREAK_MILESTONES.map((m) => ({
    ...m,
    days: m.threshold,
    unlocked: streak >= m.threshold,
    claimed: claimedSet.has(`streak_${m.threshold}`)
  }))

  const totalMilestones = TOTAL_MILESTONES.map((m) => ({
    ...m,
    unlocked: totalCheckins >= m.threshold,
    claimed: claimedSet.has(`total_${m.threshold}`)
  }))

  if (action === 'status') {
    return {
      ok: true,
      streak,
      points: member.points || 0,
      totalCheckins,
      milestones: streakMilestones,
      streakMilestones,
      totalMilestones
    }
  }

  if (action === 'pointLogs') {
    let logs = []
    try {
      const res = await db
        .collection('point_logs')
        .where({ groupId, openid: OPENID })
        .limit(100)
        .get()
      logs = res.data || []
      if (!logs.length) {
        const res2 = await db
          .collection('point_logs')
          .where({ groupId, _openid: OPENID })
          .limit(100)
          .get()
        logs = res2.data || []
      }
    } catch (e) {
      logs = []
    }

    logs = logs
      .slice()
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return tb - ta
      })
      .slice(0, 50)

    return {
      ok: true,
      points: member.points || 0,
      list: logs.map((l) => ({
        _id: l._id,
        delta: l.delta || 0,
        balance: l.balance,
        title: l.title || '',
        reason: l.reason || '',
        timeText: formatLogTime(l.createdAt)
      }))
    }
  }

  if (action === 'claim') {
    // 兼容旧前端只传 days
    let type = event.type === 'total' ? 'total' : 'streak'
    let threshold = Number(event.threshold)
    if (!threshold && event.days != null) {
      type = 'streak'
      threshold = Number(event.days)
    }

    const list = type === 'total' ? TOTAL_MILESTONES : STREAK_MILESTONES
    const target = list.find((m) => m.threshold === threshold)
    if (!target) return { ok: false, error: 'invalid_milestone' }

    const current = type === 'total' ? totalCheckins : streak
    if (current < threshold) return { ok: false, error: 'not_unlocked' }

    const existing = await findExistingClaim(groupId, OPENID, type, threshold)
    if (existing) return { ok: false, error: 'already_claimed' }

    const claimData = {
      groupId,
      openid: OPENID,
      type,
      threshold,
      title: target.title,
      points: target.points,
      createdAt: db.serverDate()
    }
    if (type === 'streak') claimData.days = threshold

    await db.collection('reward_claims').add({ data: claimData })
    const nextPoints = (member.points || 0) + target.points
    await db
      .collection('group_members')
      .doc(member._id)
      .update({
        data: { points: _.inc(target.points) }
      })

    await db.collection('point_logs').add({
      data: {
        groupId,
        openid: OPENID,
        delta: target.points,
        balance: nextPoints,
        reason: type === 'total' ? 'reward_total' : 'reward_streak',
        title: `领取「${target.title}」 +${target.points}`,
        refId: `${type}_${threshold}`,
        createdAt: db.serverDate()
      }
    })

    return {
      ok: true,
      claimed: { ...target, type },
      points: nextPoints
    }
  }

  return { ok: false, error: 'unknown_action' }
}
