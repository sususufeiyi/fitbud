const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const MILESTONES = [
  { days: 3, title: '起步 Buddy', points: 30 },
  { days: 7, title: '一周坚持', points: 70 },
  { days: 14, title: '两周达人', points: 140 },
  { days: 30, title: '月度王者', points: 300 }
]

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
 * event.action: 'status' | 'claim'
 * event.groupId 必填
 */
exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'status'
  const groupId = event.groupId
  const member = await requireMember(groupId, OPENID)
  if (!member) return { ok: false, error: 'not_in_group' }

  const claims = db.collection('reward_claims')
  const claimedRes = await claims.where({ _openid: OPENID, groupId }).get()
  const claimedDays = claimedRes.data.map((c) => c.days)

  const milestones = MILESTONES.map((m) => ({
    ...m,
    unlocked: (member.streak || 0) >= m.days,
    claimed: claimedDays.includes(m.days)
  }))

  if (action === 'status') {
    return {
      ok: true,
      streak: member.streak || 0,
      points: member.points || 0,
      totalCheckins: member.totalCheckins || 0,
      milestones
    }
  }

  if (action === 'claim') {
    const days = Number(event.days)
    const target = MILESTONES.find((m) => m.days === days)
    if (!target) return { ok: false, error: 'invalid_milestone' }
    if ((member.streak || 0) < days) return { ok: false, error: 'not_unlocked' }
    if (claimedDays.includes(days)) return { ok: false, error: 'already_claimed' }

    await claims.add({
      data: {
        groupId,
        days,
        title: target.title,
        points: target.points,
        createdAt: db.serverDate()
      }
    })
    await db
      .collection('group_members')
      .doc(member._id)
      .update({
        data: { points: _.inc(target.points) }
      })

    return {
      ok: true,
      claimed: target,
      points: (member.points || 0) + target.points
    }
  }

  return { ok: false, error: 'unknown_action' }
}
