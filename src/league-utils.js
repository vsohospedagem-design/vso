const crypto = require('node:crypto');

function normalizeName(name) {
  return name.trim().toLocaleLowerCase('pt-BR');
}

function cooldownRemaining(cooldowns, userId, now = Date.now()) {
  const cooldownUntil = Number(cooldowns[userId] || 0);
  return Number.isFinite(cooldownUntil) ? Math.max(0, cooldownUntil - now) : 0;
}

function setCooldown(cooldowns, userId, cooldownUntil) {
  cooldowns[userId] = cooldownUntil;
}

function claimDaily(dailies, userId, now = Date.now(), cooldownMs = 24 * 60 * 60 * 1000) {
  const remaining = cooldownRemaining(dailies, userId, now);
  if (remaining > 0) return { claimed: false, cooldownUntil: now + remaining };

  setCooldown(dailies, userId, now + cooldownMs);
  return { claimed: true };
}

function addOwnedPlayer(member, player) {
  if (member.starters.length === 0) {
    member.starters.push(player);
    return 'starter';
  }
  member.reserves.push(player);
  return 'reserve';
}

function promoteReserve(member, name) {
  const reserveIndex = member.reserves.findIndex(
    (player) => normalizeName(player.name) === normalizeName(name),
  );
  if (reserveIndex === -1) return { error: 'reserve_not_found' };

  const reserve = member.reserves[reserveIndex];
  const starterIndex = member.starters.findIndex(
    (player) => normalizeName(player.position) === normalizeName(reserve.position),
  );
  const [promoted] = member.reserves.splice(reserveIndex, 1);
  if (starterIndex === -1) {
    member.starters.push(promoted);
    return { promoted, replaced: null };
  }

  const [replaced] = member.starters.splice(starterIndex, 1, promoted);
  member.reserves.push(replaced);
  return { promoted, replaced };
}

function moveStarterToReserve(member, name) {
  const starterIndex = member.starters.findIndex(
    (player) => normalizeName(player.name) === normalizeName(name),
  );
  if (starterIndex === -1) return null;
  const [player] = member.starters.splice(starterIndex, 1);
  member.reserves.push(player);
  return player;
}

function buyPlayer(member, player, priceCents) {
  if (!member?.team) return { error: 'team_required' };

  const balanceCents = BigInt(member.balanceCents || '0');
  const costCents = BigInt(priceCents);
  if (balanceCents < costCents) {
    return { error: 'insufficient_funds', balanceCents: balanceCents.toString() };
  }

  member.balanceCents = (balanceCents - costCents).toString();
  const ownedPlayer = { ...player, instanceId: crypto.randomUUID() };
  const destination = addOwnedPlayer(member, ownedPlayer);
  return {
    balanceCents: member.balanceCents,
    destination,
    player: ownedPlayer,
  };
}

function sellReservePlayer(member, instanceId, salePriceCents) {
  const reserveIndex = member.reserves.findIndex(
    (player) => player.instanceId === instanceId,
  );
  if (reserveIndex === -1) return { error: 'reserve_not_found' };

  const [player] = member.reserves.splice(reserveIndex, 1);
  member.balanceCents = (
    BigInt(member.balanceCents || '0') + BigInt(salePriceCents)
  ).toString();
  return { balanceCents: member.balanceCents, player };
}

module.exports = {
  addOwnedPlayer,
  buyPlayer,
  claimDaily,
  cooldownRemaining,
  moveStarterToReserve,
  normalizeName,
  promoteReserve,
  sellReservePlayer,
  setCooldown,
};
