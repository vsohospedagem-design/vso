function isGoalkeeper(player) {
  const position = player.position.trim().toLocaleUpperCase('pt-BR');
  return position === 'GK' || position === 'GOL';
}

function validateStartingLineup(players) {
  if (players.length !== 7) {
    return { valid: false, reason: 'exactly_seven' };
  }

  if (players.filter(isGoalkeeper).length !== 1) {
    return { valid: false, reason: 'one_goalkeeper' };
  }

  if (players.some((player) => !Number.isFinite(player.overall))) {
    return { valid: false, reason: 'invalid_overall' };
  }

  return { valid: true };
}

function averageOverall(players) {
  return players.reduce((total, player) => total + player.overall, 0) / players.length;
}

function createTeam(name, acronym, players) {
  const goalkeeper = players.find(isGoalkeeper);
  const fieldPlayers = players.filter((player) => !isGoalkeeper(player));
  return {
    name,
    acronym,
    goalkeeper,
    fieldPlayers,
    attackRating: averageOverall(fieldPlayers),
    defenseRating: averageOverall(fieldPlayers) * 0.65 + goalkeeper.overall * 0.35,
  };
}

function createOpponent(players) {
  const rivalPlayers = players.map((player) => ({
    name: `Rival ${player.name}`,
    position: player.position,
    overall: player.overall * 0.985,
  }));
  return createTeam('Desafio do Guru', 'CPU', rivalPlayers);
}

function createMatchState(home, away, totalTicks = 12) {
  return {
    home,
    away,
    homeScore: 0,
    awayScore: 0,
    minute: 0,
    tick: 0,
    totalTicks,
    events: [],
    goals: [],
  };
}

function goalProbability(attacking, defending) {
  const ratio = attacking.attackRating / defending.defenseRating;
  return Math.max(0.035, Math.min(0.25, 0.12 * ratio));
}

function pickScorer(team, random, excludedPlayer) {
  const candidates = team.fieldPlayers.filter((player) => player !== excludedPlayer);
  const totalWeight = candidates.reduce(
    (total, player) => total + Math.max(1, player.overall - 49),
    0,
  );
  let selection = random() * totalWeight;
  for (const player of candidates) {
    selection -= Math.max(1, player.overall - 49);
    if (selection < 0) return player;
  }
  return candidates[candidates.length - 1];
}

function attack(attacking, defending, minute, random) {
  if (random() < goalProbability(attacking, defending)) {
    const scorer = pickScorer(attacking, random);
    const assist =
      attacking.fieldPlayers.length > 1 && random() < 0.65
        ? pickScorer(attacking, random, scorer)
        : null;
    const assistText = assist ? ` · Assistência: **${assist.name}**` : ' · Sem assistência';
    return {
      goal: true,
      scorer,
      assist,
      event: `⚽ **${minute}'** Gol de **${scorer.name}** (${scorer.overall} OVR)${assistText}!`,
    };
  }

  if (random() < 0.45) {
    return {
      goal: false,
      event: `🧤 **${minute}'** ${defending.goalkeeper.name} (${defending.goalkeeper.overall} OVR) defendeu!`,
    };
  }

  return { goal: false, event: `↗️ **${minute}'** Finalização para fora de ${attacking.name}.` };
}

function simulateMatchTick(state, random = Math.random) {
  if (state.tick >= state.totalTicks) return state;

  const minute = Math.min(90, Math.round(((state.tick + 1) * 90) / state.totalTicks));
  const homeAttack = attack(state.home, state.away, minute, random);
  const awayAttack = attack(state.away, state.home, minute, random);
  const events = [homeAttack.event, awayAttack.event];
  const homeScore = state.homeScore + Number(homeAttack.goal);
  const awayScore = state.awayScore + Number(awayAttack.goal);
  const goals = [
    ...(homeAttack.goal
      ? [{ minute, side: 'home', teamName: state.home.name, scorer: homeAttack.scorer, assist: homeAttack.assist }]
      : []),
    ...(awayAttack.goal
      ? [{ minute, side: 'away', teamName: state.away.name, scorer: awayAttack.scorer, assist: awayAttack.assist }]
      : []),
  ];

  return {
    ...state,
    homeScore,
    awayScore,
    minute,
    tick: state.tick + 1,
    events: [...state.events, ...events].slice(-6),
    goals: [...state.goals, ...goals],
  };
}

module.exports = {
  createMatchState,
  createOpponent,
  createTeam,
  goalProbability,
  isGoalkeeper,
  simulateMatchTick,
  validateStartingLineup,
};
