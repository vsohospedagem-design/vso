const realFormatter = new Intl.NumberFormat('pt-BR');

function parseMoneyCents(value) {
  const normalized = value.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
  const match = normalized.match(/^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/);
  if (!match) {
    throw new Error('Informe o valor em reais, por exemplo 10000 ou 10.000,50.');
  }

  const reais = BigInt(match[1].replace(/\./g, ''));
  const cents = (match[2] || '0').padEnd(2, '0');
  return reais * 100n + BigInt(cents);
}

function formatCents(cents) {
  const value = BigInt(cents);
  const reais = value / 100n;
  const remainder = (value % 100n).toString().padStart(2, '0');
  return `R$ ${realFormatter.format(reais)},${remainder}`;
}

function formatMarketValue(value) {
  return formatCents(parseMoneyCents(value));
}

function calculateSalePriceCents(marketValue, discountPercent = 10) {
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new Error('O desconto de venda precisa estar entre 0% e 100%.');
  }

  const marketValueCents = parseMoneyCents(marketValue);
  const salePrice = marketValueCents * BigInt(100 - discountPercent);
  return (salePrice + 50n) / 100n;
}

function sortPlayersByOverall(players) {
  return [...players].sort((left, right) => right.overall - left.overall);
}

function hasCompleteCollection(catalog, ownedPlayers) {
  if (catalog.length === 0) return false;

  const ownedCardIds = new Set(ownedPlayers.map((player) => player.id));
  return catalog.every((player) => ownedCardIds.has(player.id));
}

function sortMembersByBalance(members) {
  return Object.entries(members)
    .map(([userId, member]) => ({
      userId,
      member,
      balanceCents: BigInt(member.balanceCents || '0'),
    }))
    .sort((left, right) => {
      if (left.balanceCents === right.balanceCents) return 0;
      return left.balanceCents > right.balanceCents ? -1 : 1;
    });
}

function pickWeightedPlayer(players, random = Math.random) {
  if (!players.length) return null;

  const weights = players.map((player) => 100 - player.overall);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  let selection = random() * totalWeight;

  for (let index = 0; index < players.length; index += 1) {
    selection -= weights[index];
    if (selection < 0) return players[index];
  }

  return players[players.length - 1];
}

module.exports = {
  calculateSalePriceCents,
  formatCents,
  formatMarketValue,
  hasCompleteCollection,
  parseMoneyCents,
  pickWeightedPlayer,
  sortMembersByBalance,
  sortPlayersByOverall,
};
