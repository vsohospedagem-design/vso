require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
  escapeMarkdown,
  GatewayIntentBits,
} = require('discord.js');
const {
  calculateSalePriceCents,
  formatCents,
  formatMarketValue,
  hasCompleteCollection,
  parseMoneyCents,
  pickWeightedPlayer,
  sortMembersByBalance,
  sortPlayersByOverall,
} = require('./player-utils');
const {
  addOwnedPlayer,
  buyPlayer,
  claimDaily,
  cooldownRemaining,
  moveStarterToReserve,
  normalizeName,
  promoteReserve,
  sellReservePlayer,
  setCooldown,
} = require('./league-utils');
const {
  createMatchState,
  createOpponent,
  createTeam,
  simulateMatchTick,
  validateStartingLineup,
} = require('./match-utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.json');
const LEAGUE_FILE = path.join(DATA_DIR, 'league.json');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const OBTER_COOLDOWN_MS = 20 * 60 * 1000;
const MATCH_DURATION_MS = 60 * 1000;
const MATCH_TICK_MS = 5 * 1000;
const MATCH_TOTAL_TICKS = MATCH_DURATION_MS / MATCH_TICK_MS;
const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);
const COMPONENTS_V2 = MessageFlags.IsComponentsV2;
const EPHEMERAL_V2 = COMPONENTS_V2 | MessageFlags.Ephemeral;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let mutationQueue = Promise.resolve();

function safeText(value) {
  return escapeMarkdown(value).replace(/@/g, '@\u200b');
}

function shortText(value, maxLength) {
  return safeText(value.slice(0, maxLength));
}

function makePanel(title, body, imageFilename) {
  const panel = new ContainerBuilder()
    .setAccentColor(0x6c4cff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${title}`),
      new TextDisplayBuilder().setContent(body),
    );

  if (imageFilename) {
    const gallery = new MediaGalleryBuilder().addItems(
      new MediaGalleryItemBuilder().setURL(`attachment://${imageFilename}`),
    );
    panel.addMediaGalleryComponents(gallery);
  }

  return panel;
}

function imageLinkPanel(title, body, imageUrl) {
  const gallery = new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(imageUrl),
  );
  return new ContainerBuilder()
    .setAccentColor(0x6c4cff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${title}`),
      new TextDisplayBuilder().setContent(body),
    )
    .addMediaGalleryComponents(gallery);
}

function guildPanel(guildId, body) {
  if (guildId) {
    const panel = new ContainerBuilder().setAccentColor(0x6c4cff);
    for (const section of body) {
      panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(section));
    }
    return panel;
  }
  return makePanel('Liga do Guru', 'Este comando só pode ser usado dentro de um servidor.');
}

function makeDrawPanel(title, body, player, drawId, userId) {
  const panel = player.imageUrl
    ? imageLinkPanel(title, body, player.imageUrl)
    : makePanel(title, body, player.imageFilename);
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`draw:sell:${drawId}:${userId}`)
      .setLabel('Vender')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`draw:contract:${drawId}:${userId}`)
      .setLabel('Contratar')
      .setStyle(ButtonStyle.Success),
  );
  panel.addActionRowComponents(buttons);
  return panel;
}

function makeListPanel(players, page, userId) {
  const sortedPlayers = sortPlayersByOverall(players);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(sortedPlayers.length / pageSize));
  const entries = sortedPlayers.slice((page - 1) * pageSize, page * pageSize);
  const body = [
    `### Catálogo completo · ${sortedPlayers.length} ${sortedPlayers.length === 1 ? 'carta' : 'cartas'}`,
    entries.length
      ? entries
          .map(
            (player, index) =>
              `**${(page - 1) * pageSize + index + 1}. ${shortText(player.name, 35)}** · ${player.overall} OVR · ${shortText(player.position, 12)} · ${shortText(player.club, 30)} · ${shortText(formatMarketValue(player.marketValue), 25)}`,
          )
          .join('\n')
      : '_Nenhuma carta cadastrada._',
    `Página ${page}/${pageCount} · Use \`/carta nome:<jogador>\` para ver a foto.`,
  ].join('\n\n');
  const panel = makePanel('Cartas do Guru', body);

  if (pageCount > 1) {
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`catalog:${page - 1}:${userId}`)
        .setLabel('Anterior')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId(`catalog:${page + 1}:${userId}`)
        .setLabel('Próxima')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === pageCount),
    );
    panel.addActionRowComponents(buttons);
  }

  return panel;
}

function makeMarketPanel(players, page, userId, notice = '') {
  const sortedPlayers = sortPlayersByOverall(players);
  const pageSize = 3;
  const pageCount = Math.max(1, Math.ceil(sortedPlayers.length / pageSize));
  const entries = sortedPlayers.slice((page - 1) * pageSize, page * pageSize);
  const panel = new ContainerBuilder()
    .setAccentColor(0x6c4cff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('# Mercado do Guru'),
      new TextDisplayBuilder().setContent(
        [
          notice,
          `### Cartas disponíveis · ${sortedPlayers.length}`,
          entries.length
            ? entries
                .map(
                  (player, index) =>
                    `**${(page - 1) * pageSize + index + 1}. ${safeText(player.name)}** · ${player.overall} OVR · ${safeText(player.position)} · ${safeText(player.club)}\n> **Preço:** ${formatMarketValue(player.marketValue)}`,
                )
                .join('\n\n')
            : '_Nenhuma carta disponível no mercado._',
          `Página ${page}/${pageCount} · Comprar custa o valor de mercado e exige time e saldo suficiente.`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      ),
    );
  const images = [];
  const files = [];
    const purchaseRows = [];

    for (const player of entries) {
    if (player.imageUrl) {
      images.push(new MediaGalleryItemBuilder().setURL(player.imageUrl));
    } else if (player.imageFilename) {
      images.push(
        new MediaGalleryItemBuilder().setURL(`attachment://${player.imageFilename}`),
      );
      files.push(
        new AttachmentBuilder(path.join(IMAGES_DIR, player.imageFilename), {
          name: player.imageFilename,
        }),
      );
    }

    purchaseRows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`market-buy:${player.id}:${userId}`)
          .setLabel(`Comprar ${player.name.slice(0, 70)}`)
          .setStyle(ButtonStyle.Success),
      ),
    );
  }

  if (images.length) {
    panel.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(images));
  }
  panel.addActionRowComponents(...purchaseRows);

  if (pageCount > 1) {
    panel.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`market-page:${page - 1}:${userId}`)
          .setLabel('Anterior')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 1),
        new ButtonBuilder()
          .setCustomId(`market-page:${page + 1}:${userId}`)
          .setLabel('Próxima')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page === pageCount),
      ),
    );
  }

  return { components: [panel], files };
}

function makeSellPanel(reserves, page, userId, notice = '') {
  const sortedReserves = sortPlayersByOverall(reserves);
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(sortedReserves.length / pageSize));
  const entries = sortedReserves.slice((page - 1) * pageSize, page * pageSize);
  const body = [
    notice,
    `### Suas reservas · ${sortedReserves.length}`,
    entries.length
      ? entries
          .map((player, index) => {
            const salePrice = calculateSalePriceCents(player.marketValue);
            return `**${(page - 1) * pageSize + index + 1}. ${safeText(player.name)}** · ${player.overall} OVR · ${safeText(player.position)} · ${safeText(player.club)}\n> **Você recebe:** ${formatCents(salePrice)}`;
          })
          .join('\n\n')
      : '_Você não tem cartas na reserva para vender._',
    'A venda paga 90% do valor de mercado. Titulares não podem ser vendidos.',
    `Página ${page}/${pageCount}`,
  ].filter(Boolean);
  const panel = makePanel('Vender cartas', body.join('\n\n'));

  if (entries.length) {
    panel.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        ...entries.map((player) =>
          new ButtonBuilder()
            .setCustomId(`sell-card:${player.instanceId}:${userId}:${page}`)
            .setLabel(`Vender ${player.name.slice(0, 65)}`)
            .setStyle(ButtonStyle.Danger),
        ),
      ),
    );
  }

  if (pageCount > 1) {
    panel.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`sell-page:${page - 1}:${userId}`)
          .setLabel('Anterior')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 1),
        new ButtonBuilder()
          .setCustomId(`sell-page:${page + 1}:${userId}`)
          .setLabel('Próxima')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page === pageCount),
      ),
    );
  }

  return panel;
}

function makeRosterPanel(member, targetUserId, displayName, page, requesterId) {
  const starters = sortPlayersByOverall(member?.starters || []);
  const reserves = sortPlayersByOverall(member?.reserves || []);
  const pageSize = 5;
  const pageCount = Math.max(
    1,
    Math.ceil(Math.max(starters.length, reserves.length) / pageSize),
  );
  const startersPage = starters.slice((page - 1) * pageSize, page * pageSize);
  const reservesPage = reserves.slice((page - 1) * pageSize, page * pageSize);
  const body = [
    `## ${safeText(displayName)}${member?.team ? ` · ${safeText(member.team.acronym)} — ${safeText(member.team.name)}` : ''} · Página ${page}/${pageCount}`,
    `### Titulares (${starters.length})`,
    startersPage.length
      ? startersPage.map((player) => `• ${formatRosterEntry(player)}`).join('\n')
      : starters.length
        ? '_Sem mais titulares nesta página._'
        : '_Nenhum titular contratado._',
    `### Reservas (${reserves.length})`,
    reservesPage.length
      ? reservesPage.map((player) => `• ${formatRosterEntry(player)}`).join('\n')
      : reserves.length
        ? '_Sem mais reservas nesta página._'
        : '_Nenhuma reserva contratada._',
  ];
  const panel = guildPanel(targetUserId, body);

  if (pageCount > 1) {
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`roster:${targetUserId}:${page - 1}:${requesterId}`)
        .setLabel('Anterior')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),
      new ButtonBuilder()
        .setCustomId(`roster:${targetUserId}:${page + 1}:${requesterId}`)
        .setLabel('Próxima')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === pageCount),
    );
    panel.addActionRowComponents(buttons);
  }

  return panel;
}

function makeRichestPanel(members, page, requesterId) {
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(members.length / pageSize));
  const entries = members.slice((page - 1) * pageSize, page * pageSize);
  const lines = entries.length
    ? entries.map(({ userId, member, balanceCents }, index) => {
        const rank = (page - 1) * pageSize + index + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `**${rank}.**`;
        const team = member.team?.name ? ` · ${safeText(member.team.name.slice(0, 40))}` : '';
        return `${medal} <@${userId}>${team}\n> **${formatCents(balanceCents)}**`;
      })
    : ['_Ainda não há saldos registrados nesta liga._'];
  const panel = makePanel(
    'Ranking dos mais ricos',
    [
      `### Liga · ${members.length} ${members.length === 1 ? 'membro' : 'membros'}`,
      '',
      ...lines,
      '',
      `Página ${page}/${pageCount} · Ranking por saldo, do maior para o menor.`,
    ].join('\n'),
  );

  if (pageCount > 1) {
    panel.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`rank:${page - 1}:${requesterId}`)
          .setLabel('Anterior')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 1),
        new ButtonBuilder()
          .setCustomId(`rank:${page + 1}:${requesterId}`)
          .setLabel('Próxima')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page === pageCount),
      ),
    );
  }

  return panel;
}

function makeMatchPanel(state, status) {
  const homeName = safeText(state.home.name);
  const awayName = safeText(state.away.name);
  const events = state.events.length ? state.events.join('\n') : '_A partida vai começar..._';
  const isFinal = state.tick >= state.totalTicks;
  const panel = new ContainerBuilder()
    .setAccentColor(0x6c4cff)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('# Partida ao vivo'),
      new TextDisplayBuilder().setContent(
        [
          `### ${homeName} ${state.homeScore} — ${state.awayScore} ${awayName}`,
          `⏱️ **${state.minute}'** · ${status}`,
          '',
          '### Lances recentes',
          events,
          '',
          `**Nível dos times:** ${state.home.attackRating.toFixed(1)} ATQ · ${state.home.defenseRating.toFixed(1)} DEF | ${state.away.attackRating.toFixed(1)} ATQ · ${state.away.defenseRating.toFixed(1)} DEF`,
        ].join('\n'),
      ),
    );

  if (isFinal) {
    const goalLines = state.goals.length
      ? state.goals.map((goal) => {
          const scorer = safeText(goal.scorer.name.slice(0, 32));
          const assist = goal.assist
            ? ` · Assistência: **${safeText(goal.assist.name.slice(0, 32))}**`
            : ' · Sem assistência';
          return `⚽ **${goal.minute}' ${safeText(goal.teamName.slice(0, 60))}:** ${scorer}${assist}`;
        })
      : ['_Nenhum gol na partida._'];
    let chunk = '### Gols e assistências\n';

    for (const line of goalLines) {
      if (chunk.length + line.length + 1 > 3500) {
        panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(chunk));
        chunk = '';
      }
      chunk += `${chunk.endsWith('\n') ? '' : '\n'}${line}`;
    }

    if (chunk) {
      panel.addTextDisplayComponents(new TextDisplayBuilder().setContent(chunk));
    }
  }

  return panel;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function announceBestPack(interaction, player) {
  const channelId = process.env.BEST_PACKS_CHANNEL_ID?.trim();
  if (!channelId) {
    console.warn('Carta 90+ obtida, mas BEST_PACKS_CHANNEL_ID não está configurado.');
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || typeof channel.send !== 'function') {
      console.error(`BEST_PACKS_CHANNEL_ID ${channelId} não aponta para um canal de texto válido.`);
      return;
    }

    const displayName = interaction.member?.displayName
      || interaction.user.globalName
      || interaction.user.username;
    const body = `## ${safeText(displayName)} tirou um BEST PACK!\n\n${cardDescription(player)}`;
    const components = [
      player.imageUrl
        ? imageLinkPanel('BEST PACK · 90+', body, player.imageUrl)
        : makePanel('BEST PACK · 90+', body, player.imageFilename),
    ];
    const files = player.imageFilename
      ? [
          new AttachmentBuilder(path.join(IMAGES_DIR, player.imageFilename), {
            name: player.imageFilename,
          }),
        ]
      : [];

    await channel.send({
      components,
      files,
      flags: COMPONENTS_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível publicar o BEST PACK no canal configurado:', error);
  }
}

function initialMemberState() {
  return {
    balanceCents: '0',
    starters: [],
    reserves: [],
    team: null,
  };
}

function getMemberState(guild, userId) {
  guild.members ??= {};
  guild.pendingDraws ??= {};
  guild.members[userId] ??= initialMemberState();
  return guild.members[userId];
}

async function readLeague() {
  try {
    const contents = await fs.readFile(LEAGUE_FILE, 'utf8');
    const league = JSON.parse(contents);
    if (!league || typeof league !== 'object' || Array.isArray(league)) {
      throw new Error('O arquivo da liga precisa conter um objeto JSON.');
    }
    league.guilds ??= {};
    return league;
  } catch (error) {
    if (error.code === 'ENOENT') return { guilds: {} };
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch((cleanupError) => {
      if (cleanupError.code !== 'ENOENT') {
        console.error('Não foi possível remover um arquivo temporário:', cleanupError);
      }
    });
    throw error;
  }
}

function updateLeague(guildId, update) {
  const operation = mutationQueue.then(async () => {
    const league = await readLeague();
    const guild = (league.guilds[guildId] ??= { members: {}, pendingDraws: {} });
    guild.members ??= {};
    guild.pendingDraws ??= {};
    const result = await update(guild);
    await writeJson(LEAGUE_FILE, league);
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

function purchaseMarketPlayer(guildId, userId, playerId) {
  const operation = mutationQueue.then(async () => {
    const players = await readPlayers();
    const player = players.find((entry) => entry.id === playerId);
    if (!player) return { error: 'player_unavailable' };

    const league = await readLeague();
    const guild = (league.guilds[guildId] ??= { members: {}, pendingDraws: {} });
    guild.members ??= {};
    const member = guild.members[userId];
    const costCents = parseMoneyCents(player.marketValue);
    const result = buyPlayer(member, player, costCents);
    if (result.error) return { ...result, player };

    await writeJson(LEAGUE_FILE, league);
    return { ...result, costCents: costCents.toString() };
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

function sellReserveCard(guildId, userId, instanceId) {
  const operation = mutationQueue.then(async () => {
    const league = await readLeague();
    const member = league.guilds[guildId]?.members?.[userId];
    if (!member) return { error: 'reserve_not_found' };

    const player = member.reserves.find((entry) => entry.instanceId === instanceId);
    if (!player) return { error: 'reserve_not_found' };

    const salePriceCents = calculateSalePriceCents(player.marketValue);
    const result = sellReservePlayer(member, instanceId, salePriceCents);
    if (result.error) return result;

    await writeJson(LEAGUE_FILE, league);
    return { ...result, salePriceCents: salePriceCents.toString() };
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

async function requireGuild(interaction) {
  if (interaction.guildId) return true;
  await interaction.reply({
    components: [makePanel('Comando de servidor', 'Use este comando dentro do servidor da liga.')],
    flags: EPHEMERAL_V2,
  });
  return false;
}

function hasConfiguredAdminRole(interaction) {
  const allowedRoleIds = new Set(
    (process.env.GURU_ADMIN_ROLE_IDS || '')
      .split(',')
      .map((roleId) => roleId.trim())
      .filter(Boolean),
  );
  if (allowedRoleIds.size === 0) return false;

  const roles = interaction.member?.roles;
  const memberRoleIds = roles?.cache
    ? [...roles.cache.keys()]
    : Array.isArray(roles)
      ? roles
      : [];
  return memberRoleIds.some((roleId) => allowedRoleIds.has(roleId));
}

async function readPlayers() {
  try {
    const contents = await fs.readFile(PLAYERS_FILE, 'utf8');
    const players = JSON.parse(contents);
    if (!Array.isArray(players)) {
      throw new Error('O arquivo de jogadores precisa conter uma lista.');
    }
    return players;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function savePlayers(players) {
  await writeJson(PLAYERS_FILE, players);
}

function addPlayer(player) {
  const operation = mutationQueue.then(async () => {
    const players = await readPlayers();
    players.push(player);
    await savePlayers(players);
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

function validateImageLink(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('O link da foto não parece ser uma URL válida.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Use um link público começando com http:// ou https://.');
  }
  return parsed.toString();
}

async function saveUploadedImage(attachment) {
  const parsed = new URL(attachment.url);
  const trustedHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
  const isAttachmentPath =
    parsed.pathname.startsWith('/attachments/') ||
    parsed.pathname.startsWith('/ephemeral-attachments/');
  if (!trustedHosts.has(parsed.hostname) || !isAttachmentPath) {
    throw new Error('Não foi possível validar o anexo enviado pelo Discord.');
  }

  if (attachment.size > MAX_IMAGE_BYTES) {
    throw new Error('A foto precisa ter no máximo 8 MB.');
  }

  const response = await fetch(attachment.url, { redirect: 'error' });
  if (!response.ok) {
    throw new Error(`O Discord não disponibilizou a foto (HTTP ${response.status}).`);
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  const extension = IMAGE_TYPES.get(contentType);
  if (!extension) {
    throw new Error('O anexo precisa ser uma imagem JPEG, PNG, WEBP ou GIF.');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('A foto precisa ter no máximo 8 MB.');
  }

  await fs.mkdir(IMAGES_DIR, { recursive: true });
  const filename = `${crypto.randomUUID()}.${extension}`;
  await fs.writeFile(path.join(IMAGES_DIR, filename), buffer, { flag: 'wx' });
  return filename;
}

function cardDescription(player) {
  return [
    `**${safeText(player.name)}**  ·  **${player.overall} OVR**`,
    '',
    `> **Posição**  ${safeText(player.position)}`,
    `> **Clube**  ${safeText(player.club)}`,
    `> **Valor de mercado**  ${formatMarketValue(player.marketValue)}`,
  ].join('\n');
}

function drawCardDescription(player) {
  return [
    cardDescription(player),
    `> **Valor de venda (10% abaixo)**  ${formatCents(calculateSalePriceCents(player.marketValue))}`,
  ].join('\n');
}

async function handleAddPlayer(interaction) {
  if (!(await requireGuild(interaction))) return;
  if (!hasConfiguredAdminRole(interaction)) {
    await interaction.reply({
      components: [
        makePanel(
          'Acesso restrito',
          'Este comando exige um cargo listado em `GURU_ADMIN_ROLE_IDS` no arquivo `.env`.',
        ),
      ],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  const attachment = interaction.options.getAttachment('foto');
  const imageUrl = interaction.options.getString('link_foto');
  if (Boolean(attachment) === Boolean(imageUrl)) {
    await interaction.reply({
      components: [
        makePanel(
          'Foto necessária',
          'Envie **um anexo** no campo `foto` ou informe **um link** em `link_foto` — escolha apenas uma opção.',
        ),
      ],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  let marketValue;
  try {
    marketValue = formatMarketValue(
      interaction.options.getString('valor_de_mercado', true),
    );
  } catch (error) {
    await interaction.reply({
      components: [makePanel('Valor inválido', error.message)],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  const player = {
    id: crypto.randomUUID(),
    name: interaction.options.getString('nome', true).trim(),
    overall: interaction.options.getInteger('over', true),
    position: interaction.options.getString('posicao', true).trim(),
    club: interaction.options.getString('clube', true).trim(),
    marketValue,
    addedBy: interaction.user.id,
    createdAt: new Date().toISOString(),
  };

  if (!player.name || !player.position || !player.club || !player.marketValue) {
    await interaction.reply({
      components: [
        makePanel('Dados incompletos', 'Preencha todos os campos de texto antes de cadastrar a carta.'),
      ],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  let imageFilename;
  let remoteImageUrl;
  try {
    if (attachment) {
      imageFilename = await saveUploadedImage(attachment);
      player.imageFilename = imageFilename;
    } else {
      remoteImageUrl = validateImageLink(imageUrl);
      player.imageUrl = remoteImageUrl;
    }

    await addPlayer(player);
  } catch (error) {
    if (imageFilename) {
      await fs.unlink(path.join(IMAGES_DIR, imageFilename)).catch((cleanupError) => {
        console.error('Não foi possível remover a imagem após falha no cadastro:', cleanupError);
      });
    }
    console.error('Não foi possível cadastrar a carta:', error);
    const message =
      error.message.startsWith('O ') ||
      error.message.startsWith('Use ') ||
      error.message.startsWith('Não foi possível') ||
      error.message.startsWith('A foto') ||
      error.message.startsWith('O anexo')
        ? error.message
        : 'Ocorreu um erro ao salvar a carta. Tente novamente.';
    await interaction.reply({
      components: [makePanel('Não foi possível cadastrar', message)],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  const card = cardDescription(player);
  const components = [
    remoteImageUrl
      ? imageLinkPanel('Carta adicionada ao Guru', card, remoteImageUrl)
      : makePanel('Carta adicionada ao Guru', card, imageFilename),
  ];
  const files = imageFilename
    ? [new AttachmentBuilder(path.join(IMAGES_DIR, imageFilename), { name: imageFilename })]
    : [];

  await interaction.reply({
    components,
    files,
    flags: EPHEMERAL_V2,
    allowedMentions: { parse: [] },
  });
}

async function handlePlayers(interaction) {
  try {
    const players = sortPlayersByOverall(await readPlayers());
    const body = players.length
      ? [
          `### ${players.length} ${players.length === 1 ? 'carta cadastrada' : 'cartas cadastradas'}`,
          '',
          ...players
            .slice(0, 15)
              .map(
                (player, index) =>
                  `**${index + 1}. ${shortText(player.name, 25)}** · ${player.overall} OVR · ${shortText(player.position, 10)} · ${shortText(player.club, 25)} · ${shortText(formatMarketValue(player.marketValue), 20)}`,
              ),
          players.length > 15 ? '\n_Exibindo as 15 cartas com maior overall._' : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : 'Ainda não há cartas cadastradas. Use `/addplayer` para adicionar a primeira!';

    await interaction.reply({
      components: [makePanel('Elenco do Guru', body)],
      flags: EPHEMERAL_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível carregar as cartas:', error);
    await interaction.reply({
      components: [
        makePanel('Erro ao carregar o elenco', 'Os dados não puderam ser lidos. Verifique o arquivo local e tente novamente.'),
      ],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleObter(interaction) {
  if (!(await requireGuild(interaction))) return;

  try {
    const players = await readPlayers();
    const player = pickWeightedPlayer(players);
    if (!player) {
      await interaction.reply({
        components: [
          makePanel('Elenco vazio', 'Ainda não há cartas para sortear. Use `/addplayer` para cadastrar a primeira!'),
        ],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    const drawId = crypto.randomUUID();
    const bypassCooldown = hasConfiguredAdminRole(interaction);
    const drawResult = await updateLeague(interaction.guildId, (guild) => {
      const member = guild.members[interaction.user.id];
      const ownedPlayers = [...(member?.starters || []), ...(member?.reserves || [])];
      if (hasCompleteCollection(players, ownedPlayers)) {
        return { collectionComplete: true };
      }

      guild.drawCooldowns ??= {};
      const now = Date.now();
      if (!bypassCooldown) {
        const remaining = cooldownRemaining(guild.drawCooldowns, interaction.user.id, now);
        if (remaining > 0) return { cooldownUntil: now + remaining };
      }

      for (const [previousId, draw] of Object.entries(guild.pendingDraws)) {
        const isExpired = now - Date.parse(draw.createdAt) > 30 * 24 * 60 * 60 * 1000;
        if (draw.status !== 'pending' || isExpired) delete guild.pendingDraws[previousId];
      }
      guild.pendingDraws[drawId] = {
        userId: interaction.user.id,
        player,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      if (!bypassCooldown) {
        setCooldown(guild.drawCooldowns, interaction.user.id, now + OBTER_COOLDOWN_MS);
      }
      return {};
    });

    if (drawResult.collectionComplete) {
      await interaction.reply({
        components: [
          makePanel(
            'Coleção completa!',
            'Você já tem todas as cartas do Guru no seu elenco. Não é possível usar `/obter` enquanto a coleção estiver completa.',
          ),
        ],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    if (drawResult.cooldownUntil) {
      await interaction.reply({
        components: [
          makePanel(
            'Aguarde para obter outra carta',
            `Você poderá usar \`/obter\` novamente <t:${Math.ceil(drawResult.cooldownUntil / 1000)}:R>.`,
          ),
        ],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    const card = drawCardDescription(player);
    const displayName = interaction.member?.displayName
      || interaction.user.globalName
      || interaction.user.username;
    const title = `${safeText(displayName)} obteve uma carta!`;
    const components = [makeDrawPanel(title, card, player, drawId, interaction.user.id)];
    const files = player.imageFilename
      ? [
          new AttachmentBuilder(path.join(IMAGES_DIR, player.imageFilename), {
            name: player.imageFilename,
          }),
        ]
      : [];

    await interaction.reply({
      components,
      files,
      flags: COMPONENTS_V2,
      allowedMentions: { parse: [] },
    });

    if (player.overall >= 90) {
      await announceBestPack(interaction, player);
    }
  } catch (error) {
    console.error('Não foi possível sortear uma carta:', error);
    await interaction.reply({
      components: [
        makePanel('Erro ao obter carta', 'Não foi possível sortear uma carta agora. Tente novamente.'),
      ],
      flags: EPHEMERAL_V2,
    });
  }
}

function findPlayerByName(players, name) {
  const normalizedName = name.trim().toLocaleLowerCase('pt-BR');
  return players.find(
    (player) => player.name.trim().toLocaleLowerCase('pt-BR') === normalizedName,
  );
}

function formatRosterEntry(player) {
  return `**${safeText(player.name)}** · ${player.overall} OVR · ${safeText(player.position)} · ${safeText(player.club)} · ${formatMarketValue(player.marketValue)}`;
}

async function handleDrawButton(interaction) {
  const [, action, drawId, ownerId] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      components: [makePanel('Esse sorteio não é seu', 'Use `/obter` para abrir seu próprio pacote.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }
  if (!interaction.guildId || !['sell', 'contract'].includes(action)) {
    await interaction.reply({
      components: [makePanel('Ação indisponível', 'Essa ação só pode ser feita no servidor onde você obteve a carta.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  try {
    const result = await updateLeague(interaction.guildId, (guild) => {
      const draw = guild.pendingDraws[drawId];
      if (!draw || draw.status !== 'pending' || draw.userId !== interaction.user.id) {
        throw new Error('Este pacote já foi aberto ou não está mais disponível.');
      }

      const member = getMemberState(guild, interaction.user.id);
      let message;
      if (action === 'sell') {
        const valueCents = calculateSalePriceCents(draw.player.marketValue);
        member.balanceCents = (BigInt(member.balanceCents) + valueCents).toString();
        message = [
          '## VENDIDO',
          drawCardDescription(draw.player),
          `**Recebido:** ${formatCents(valueCents)} · **Saldo:** ${formatCents(member.balanceCents)}`,
        ].join('\n\n');
        draw.status = 'sold';
      } else {
        if (!member.team) {
          throw new Error('TEAM_REQUIRED');
        }
        const ownedCard = { ...draw.player, instanceId: crypto.randomUUID() };
        const destination = addOwnedPlayer(member, ownedCard);
        const rosterStatus = destination === 'starter'
          ? 'Adicionada como titular.'
          : 'Adicionada ao banco de reservas.';
        message = `## CONTRATADO\n\n${drawCardDescription(ownedCard)}\n\n${rosterStatus}`;
        draw.status = 'contracted';
      }

      draw.completedAt = new Date().toISOString();
      return { player: draw.player, message };
    });

    const imageFilename = result.player.imageFilename;
    const components = [
      result.player.imageUrl
        ? imageLinkPanel(
            action === 'sell' ? 'Carta vendida' : 'Carta contratada',
            result.message,
            result.player.imageUrl,
          )
        : makePanel(
            action === 'sell' ? 'Carta vendida' : 'Carta contratada',
            result.message,
            imageFilename,
          ),
    ];
    const files = imageFilename
      ? [new AttachmentBuilder(path.join(IMAGES_DIR, imageFilename), { name: imageFilename })]
      : [];

    await interaction.update({
      components,
      files,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await interaction.reply({
      components: [
        makePanel(
          error.message === 'TEAM_REQUIRED'
            ? 'Crie seu time primeiro'
            : 'Não foi possível concluir',
          error.message === 'TEAM_REQUIRED'
            ? 'Para contratar cartas, crie seu time com `/time nome sigla` e tente novamente.'
            : error.message.startsWith('Informe o valor')
              ? error.message
              : error.message.startsWith('Este pacote')
                ? error.message
                : 'Ocorreu um erro ao atualizar seu saldo ou elenco. Tente novamente.',
        ),
      ],
      flags: EPHEMERAL_V2,
    });
    if (
      error.message !== 'TEAM_REQUIRED'
      && !error.message.startsWith('Este pacote')
      && !error.message.startsWith('Informe o valor')
    ) {
      console.error('Não foi possível processar a carta obtida:', error);
    }
  }
}

async function handleElenco(interaction) {
  if (!(await requireGuild(interaction))) return;
  try {
    const user = interaction.options.getUser('membro', true);
    const league = await readLeague();
    const member = league.guilds[interaction.guildId]?.members?.[user.id];
    const page = interaction.options.getInteger('pagina') || 1;
    const pageCount = Math.max(
      1,
      Math.ceil(Math.max(member?.starters?.length || 0, member?.reserves?.length || 0) / 5),
    );
    if (page > pageCount) {
      await interaction.reply({
        components: [
          makePanel('Página não encontrada', `O elenco tem ${pageCount} ${pageCount === 1 ? 'página' : 'páginas'}.`),
        ],
        flags: EPHEMERAL_V2,
      });
      return;
    }
    const displayName = interaction.guild.members.cache.get(user.id)?.displayName
      || user.globalName
      || user.username;
    await interaction.reply({
      components: [
        makeRosterPanel(member, user.id, displayName, page, interaction.user.id),
      ],
      flags: COMPONENTS_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível carregar o elenco:', error);
    await interaction.reply({
      components: [makePanel('Erro ao carregar elenco', 'Não foi possível consultar esse elenco agora.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleRosterPageButton(interaction) {
  const [, targetUserId, pageValue, requesterId] = interaction.customId.split(':');
  if (interaction.user.id !== requesterId) {
    await interaction.reply({
      components: [makePanel('Esta navegação não é sua', 'Use `/elenco` para consultar um elenco e navegar pelas páginas.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }
  if (!interaction.guildId) {
    await interaction.reply({
      components: [makePanel('Servidor indisponível', 'A navegação do elenco só funciona no servidor onde foi aberta.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  try {
    const page = Number(pageValue);
    const league = await readLeague();
    const member = league.guilds[interaction.guildId]?.members?.[targetUserId];
    const pageCount = Math.max(
      1,
      Math.ceil(Math.max(member?.starters?.length || 0, member?.reserves?.length || 0) / 5),
    );
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      await interaction.reply({
        components: [makePanel('Página indisponível', 'Esta página não existe mais. Use `/elenco` para atualizar a consulta.')],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    const displayName = interaction.guild.members.cache.get(targetUserId)?.displayName
      || targetUserId;
    await interaction.update({
      components: [
        makeRosterPanel(member, targetUserId, displayName, page, requesterId),
      ],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível mudar a página do elenco:', error);
    await interaction.reply({
      components: [makePanel('Erro ao mudar página', 'Não foi possível carregar esta página do elenco.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleRemoverPlayer(interaction) {
  if (!(await requireGuild(interaction))) return;
  if (!hasConfiguredAdminRole(interaction)) {
    await interaction.reply({
      components: [
        makePanel(
          'Acesso restrito',
          'Este comando exige um cargo listado em `GURU_ADMIN_ROLE_IDS` no arquivo `.env`.',
        ),
      ],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  const name = interaction.options.getString('nome', true);
  try {
    const operation = mutationQueue.then(async () => {
      const players = await readPlayers();
      const index = players.findIndex(
        (player) => normalizeName(player.name) === normalizeName(name),
      );
      if (index === -1) return null;
      const [removed] = players.splice(index, 1);
      await savePlayers(players);
      return removed;
    });
    mutationQueue = operation.catch(() => {});
    const player = await operation;
    await interaction.reply({
      components: [
        makePanel(
          player ? 'Carta removida' : 'Carta não encontrada',
          player
            ? `**${safeText(player.name)}** foi removida do catálogo e não aparecerá em novos sorteios. Cartas já contratadas continuam nos elencos.`
            : `Não encontrei uma carta chamada **${safeText(name)}**.`,
        ),
      ],
      flags: EPHEMERAL_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível remover a carta:', error);
    await interaction.reply({
      components: [makePanel('Erro ao remover carta', 'Não foi possível atualizar o catálogo.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleCarta(interaction) {
  try {
    const name = interaction.options.getString('nome', true);
    const player = findPlayerByName(await readPlayers(), name);
    if (!player) {
      await interaction.reply({
        components: [makePanel('Carta não encontrada', `Não encontrei **${safeText(name)}** no catálogo.`)],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    await interaction.reply({
      components: [
        player.imageUrl
          ? imageLinkPanel('Carta do Guru', cardDescription(player), player.imageUrl)
          : makePanel('Carta do Guru', cardDescription(player), player.imageFilename),
      ],
      files: player.imageFilename
        ? [new AttachmentBuilder(path.join(IMAGES_DIR, player.imageFilename), { name: player.imageFilename })]
        : [],
      flags: COMPONENTS_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível consultar a carta:', error);
    await interaction.reply({
      components: [makePanel('Erro ao consultar carta', 'Não foi possível consultar o catálogo agora.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleLista(interaction) {
  try {
    const players = sortPlayersByOverall(await readPlayers());
    const page = interaction.options.getInteger('pagina') || 1;
    const pageCount = Math.max(1, Math.ceil(players.length / 10));
    if (page > pageCount) {
      await interaction.reply({
        components: [
          makePanel('Página não encontrada', `O catálogo tem ${pageCount} ${pageCount === 1 ? 'página' : 'páginas'}.`),
        ],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    await interaction.reply({
      components: [makeListPanel(players, page, interaction.user.id)],
      flags: COMPONENTS_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível listar as cartas:', error);
    await interaction.reply({
      components: [makePanel('Erro ao listar cartas', 'Não foi possível carregar o catálogo agora.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleListPageButton(interaction) {
  const [, pageValue, ownerId] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      components: [makePanel('Esta lista não é sua', 'Use `/lista` para abrir seu próprio catálogo com navegação.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  try {
    const players = sortPlayersByOverall(await readPlayers());
    const page = Number(pageValue);
    const pageCount = Math.max(1, Math.ceil(players.length / 10));
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      await interaction.reply({
        components: [makePanel('Página indisponível', 'Esta página não existe mais. Use `/lista` para atualizar o catálogo.')],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    await interaction.update({
      components: [makeListPanel(players, page, ownerId)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível mudar a página do catálogo:', error);
    await interaction.reply({
      components: [makePanel('Erro ao mudar página', 'Não foi possível carregar esta página do catálogo.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleMercado(interaction) {
  if (!(await requireGuild(interaction))) return;

  try {
    const players = await readPlayers();
    const market = makeMarketPanel(players, 1, interaction.user.id);
    await interaction.reply({
      ...market,
      flags: EPHEMERAL_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível abrir o mercado:', error);
    await interaction.reply({
      components: [makePanel('Erro ao abrir o mercado', 'Não foi possível carregar as cartas disponíveis.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleVender(interaction) {
  if (!(await requireGuild(interaction))) return;

  try {
    const reserves = await updateLeague(interaction.guildId, (guild) => {
      const member = guild.members[interaction.user.id];
      if (!member) return [];

      member.reserves ??= [];
      for (const player of member.reserves) {
        player.instanceId ??= crypto.randomUUID();
      }
      return sortPlayersByOverall(member.reserves);
    });
    await interaction.reply({
      components: [makeSellPanel(reserves, 1, interaction.user.id)],
      flags: EPHEMERAL_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível abrir a venda de cartas:', error);
    await interaction.reply({
      components: [makePanel('Erro ao abrir vendas', 'Não foi possível carregar suas reservas agora.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleSellPageButton(interaction) {
  const [, pageValue, ownerId] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      components: [makePanel('Esta venda não é sua', 'Use `/vender` para abrir suas próprias reservas.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }
  if (!(await requireGuild(interaction))) return;

  try {
    const league = await readLeague();
    const reserves = league.guilds[interaction.guildId]?.members?.[ownerId]?.reserves || [];
    const page = Number(pageValue);
    const pageCount = Math.max(1, Math.ceil(reserves.length / 5));
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      await interaction.reply({
        components: [makePanel('Página indisponível', 'Esta página não existe mais. Use `/vender` para atualizar suas reservas.')],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    await interaction.update({
      components: [makeSellPanel(reserves, page, ownerId)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível mudar a página de vendas:', error);
    await interaction.reply({
      components: [makePanel('Erro ao mudar página', 'Não foi possível carregar suas reservas.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleSellCardButton(interaction) {
  const [, instanceId, ownerId, pageValue] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      components: [makePanel('Esta venda não é sua', 'Use `/vender` para vender cartas da sua própria reserva.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }
  if (!(await requireGuild(interaction))) return;

  try {
    const result = await sellReserveCard(interaction.guildId, ownerId, instanceId);
    if (result.error) {
      await interaction.reply({
        components: [makePanel('Carta indisponível', 'Esta carta não está mais na sua reserva. Use `/vender` para atualizar a lista.')],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    const league = await readLeague();
    const reserves = league.guilds[interaction.guildId]?.members?.[ownerId]?.reserves || [];
    const page = Math.min(
      Number(pageValue) || 1,
      Math.max(1, Math.ceil(reserves.length / 5)),
    );
    await interaction.update({
      components: [
        makeSellPanel(
          reserves,
          page,
          ownerId,
          `✅ **${safeText(result.player.name)}** vendida por **${formatCents(result.salePriceCents)}**. Saldo: **${formatCents(result.balanceCents)}**.`,
        ),
      ],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível vender a carta da reserva:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        components: [makePanel('Erro na venda', 'Não foi possível concluir a venda agora. Tente novamente.')],
        flags: EPHEMERAL_V2,
      });
    }
  }
}

async function handleMarketPageButton(interaction) {
  const [, pageValue, ownerId] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      components: [makePanel('Este mercado não é seu', 'Use `/mercado` para abrir seu próprio mercado.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }
  if (!interaction.guildId) {
    await interaction.reply({
      components: [makePanel('Servidor indisponível', 'O mercado só funciona no servidor da liga.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  try {
    const players = await readPlayers();
    const page = Number(pageValue);
    const pageCount = Math.max(1, Math.ceil(players.length / 3));
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      await interaction.reply({
        components: [makePanel('Página indisponível', 'Esta página não existe mais. Use `/mercado` para atualizar a lista.')],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    await interaction.update({
      ...makeMarketPanel(players, page, ownerId),
      attachments: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível mudar a página do mercado:', error);
    await interaction.reply({
      components: [makePanel('Erro ao mudar página', 'Não foi possível carregar esta página do mercado.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleMarketPurchaseButton(interaction) {
  const [, playerId, ownerId] = interaction.customId.split(':');
  if (interaction.user.id !== ownerId) {
    await interaction.reply({
      components: [makePanel('Este mercado não é seu', 'Use `/mercado` para abrir seu próprio mercado e comprar cartas.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }
  if (!(await requireGuild(interaction))) return;

  try {
    const result = await purchaseMarketPlayer(
      interaction.guildId,
      interaction.user.id,
      playerId,
    );
    const players = await readPlayers();
    const sortedPlayers = sortPlayersByOverall(players);
    const playerIndex = sortedPlayers.findIndex((player) => player.id === playerId);
    const page = playerIndex === -1 ? 1 : Math.floor(playerIndex / 3) + 1;
    let notice;

    if (result.error === 'team_required') {
      notice = '⚠️ Crie seu time com `/time nome sigla` antes de comprar cartas.';
    } else if (result.error === 'insufficient_funds') {
      notice = `⚠️ Saldo insuficiente. Seu saldo: **${formatCents(result.balanceCents)}** · Preço: **${formatCents(parseMoneyCents(result.player.marketValue))}**.`;
    } else if (result.error === 'player_unavailable') {
      notice = '⚠️ Esta carta não está mais disponível no catálogo.';
    } else {
      const destination = result.destination === 'starter' ? 'titular' : 'reserva';
      notice = `✅ **${safeText(result.player.name)}** contratado por **${formatCents(result.costCents)}** e adicionado como ${destination}. Saldo restante: **${formatCents(result.balanceCents)}**.`;
    }

    const market = makeMarketPanel(players, page, interaction.user.id, notice);
    await interaction.update({
      ...market,
      attachments: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível comprar a carta do mercado:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        components: [makePanel('Erro na compra', 'Não foi possível concluir a compra. Confira seu saldo e tente novamente.')],
        flags: EPHEMERAL_V2,
      });
    }
  }
}

async function handleRosterMove(interaction, action) {
  if (!(await requireGuild(interaction))) return;
  const name = interaction.options.getString('nome', true).trim();
  try {
    const result = await updateLeague(interaction.guildId, (guild) => {
      const member = guild.members[interaction.user.id];
      if (!member?.team) return { error: 'team_required' };

      if (action === 'promote') {
        const promoted = promoteReserve(member, name);
        if (promoted.error) {
          return { error: `Não encontrei **${safeText(name)}** nas suas reservas.` };
        }
        const message = promoted.replaced
          ? `**${safeText(promoted.promoted.name)}** agora é titular; **${safeText(promoted.replaced.name)}** foi para a reserva.`
          : `**${safeText(promoted.promoted.name)}** agora ocupa a vaga titular da posição **${safeText(promoted.promoted.position)}**.`;
        return { message };
      }

      const demoted = moveStarterToReserve(member, name);
      if (!demoted) {
        return { error: `Não encontrei **${safeText(name)}** entre seus titulares.` };
      }
      return { message: `**${safeText(demoted.name)}** foi movido para a reserva.` };
    });

    await interaction.reply({
      components: [
        makePanel(
          result.error === 'team_required'
            ? 'Crie seu time primeiro'
            : result.error
              ? 'Movimentação não realizada'
              : 'Elenco atualizado',
          result.error === 'team_required'
            ? 'Crie seu time com `/time nome sigla` antes de organizar titulares e reservas.'
            : result.error || result.message,
        ),
      ],
      flags: EPHEMERAL_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível atualizar o elenco:', error);
    await interaction.reply({
      components: [makePanel('Erro ao atualizar elenco', 'Não foi possível atualizar seu elenco agora.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleSaldo(interaction) {
  if (!(await requireGuild(interaction))) return;
  try {
    const league = await readLeague();
    const member = league.guilds[interaction.guildId]?.members?.[interaction.user.id];
    const balance = member?.balanceCents || '0';
    await interaction.reply({
      components: [
        makePanel('Saldo da liga', `Seu saldo atual é **${formatCents(balance)}**.`),
      ],
      flags: EPHEMERAL_V2,
    });
  } catch (error) {
    console.error('Não foi possível consultar o saldo:', error);
    await interaction.reply({
      components: [makePanel('Erro ao consultar saldo', 'Não foi possível carregar seu saldo agora.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleRank(interaction) {
  if (!(await requireGuild(interaction))) return;
  try {
    const league = await readLeague();
    const members = sortMembersByBalance(
      league.guilds[interaction.guildId]?.members || {},
    );
    const page = interaction.options.getInteger('pagina') || 1;
    const pageCount = Math.max(1, Math.ceil(members.length / 10));
    if (page > pageCount) {
      await interaction.reply({
        components: [
          makePanel(
            'Página não encontrada',
            `O ranking tem ${pageCount} ${pageCount === 1 ? 'página' : 'páginas'}.`,
          ),
        ],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    await interaction.reply({
      components: [makeRichestPanel(members, page, interaction.user.id)],
      flags: COMPONENTS_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível carregar o ranking dos mais ricos:', error);
    await interaction.reply({
      components: [makePanel('Erro ao carregar ranking', 'Não foi possível consultar os saldos da liga.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleRichestPageButton(interaction) {
  const [, pageValue, requesterId] = interaction.customId.split(':');
  if (interaction.user.id !== requesterId) {
    await interaction.reply({
      components: [makePanel('Esta navegação não é sua', 'Use `/rank` para abrir seu próprio ranking.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }
  if (!(await requireGuild(interaction))) return;

  try {
    const league = await readLeague();
    const members = sortMembersByBalance(
      league.guilds[interaction.guildId]?.members || {},
    );
    const page = Number(pageValue);
    const pageCount = Math.max(1, Math.ceil(members.length / 10));
    if (!Number.isInteger(page) || page < 1 || page > pageCount) {
      await interaction.reply({
        components: [makePanel('Página indisponível', 'Esta página não existe mais. Use `/rank` para atualizar o ranking.')],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    await interaction.update({
      components: [makeRichestPanel(members, page, requesterId)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível mudar a página do ranking:', error);
    await interaction.reply({
      components: [makePanel('Erro ao mudar página', 'Não foi possível carregar esta página do ranking.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleDaily(interaction) {
  if (!(await requireGuild(interaction))) return;

  const rewardCents = 25000n * 100n;
  try {
    const result = await updateLeague(interaction.guildId, (guild) => {
      guild.dailyCooldowns ??= {};
      const claim = claimDaily(guild.dailyCooldowns, interaction.user.id);
      if (!claim.claimed) return claim;

      const member = getMemberState(guild, interaction.user.id);
      member.balanceCents = (BigInt(member.balanceCents) + rewardCents).toString();
      return { claimed: true, balanceCents: member.balanceCents };
    });

    if (!result.claimed) {
      await interaction.reply({
        components: [
          makePanel(
            'Daily já resgatado',
            `Você poderá resgatar novamente <t:${Math.ceil(result.cooldownUntil / 1000)}:R>.`,
          ),
        ],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    await interaction.reply({
      components: [
        makePanel(
          'Daily resgatado!',
          `Você recebeu **${formatCents(rewardCents)}**.\n\nSeu saldo agora é **${formatCents(result.balanceCents)}**.`,
        ),
      ],
      flags: EPHEMERAL_V2,
    });
  } catch (error) {
    console.error('Não foi possível resgatar o daily:', error);
    await interaction.reply({
      components: [makePanel('Erro ao resgatar daily', 'Não foi possível atualizar seu saldo agora.')],
      flags: EPHEMERAL_V2,
    });
  }
}

async function handleJogar(interaction) {
  if (!(await requireGuild(interaction))) return;

  let state;
  try {
    const opponentUser = interaction.options.getUser('membro');
    if (opponentUser?.id === interaction.user.id) {
      await interaction.reply({
        components: [makePanel('Adversário inválido', 'Você não pode jogar contra si mesmo.')],
        flags: EPHEMERAL_V2,
      });
      return;
    }
    if (opponentUser?.bot) {
      await interaction.reply({
        components: [makePanel('Adversário inválido', 'Escolha um membro real do servidor, não um bot.')],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    const league = await readLeague();
    const guild = league.guilds[interaction.guildId];
    const member = guild?.members?.[interaction.user.id];
    const opponent = opponentUser ? guild?.members?.[opponentUser.id] : null;
    if (!member?.team) {
      await interaction.reply({
        components: [makePanel('Crie seu time primeiro', 'Use `/time nome sigla` antes de jogar uma partida.')],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    if (opponentUser && !opponent?.team) {
      await interaction.reply({
        components: [
          makePanel(
            'O adversário precisa de um time',
            `${safeText(opponentUser.username)} precisa criar o time com \`/time nome sigla\` antes de jogar.`,
          ),
        ],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    const lineup = member.starters || [];
    const validation = validateStartingLineup(lineup);
    if (!validation.valid) {
      const reason = {
        exactly_seven: `Sua escalação tem **${lineup.length} titulares**. São necessários exatamente **7** para jogar.`,
        one_goalkeeper: 'Sua escalação titular precisa ter exatamente um goleiro com posição `GK` ou `GOL`.',
        invalid_overall: 'Algum titular está sem um overall válido. Confira as cartas do seu elenco.',
      }[validation.reason];
      await interaction.reply({
        components: [makePanel('Escalação inválida', `${reason}\n\nAjuste o time com \`/promover\` e \`/reserva\` e tente novamente.`)],
        flags: EPHEMERAL_V2,
      });
      return;
    }

    let away;
    if (opponentUser) {
      const opponentLineup = opponent.starters || [];
      const opponentValidation = validateStartingLineup(opponentLineup);
      if (!opponentValidation.valid) {
        const reason = {
          exactly_seven: `A escalação de **${safeText(opponentUser.username)}** tem **${opponentLineup.length} titulares**; são necessários exatamente 7.`,
          one_goalkeeper: `A escalação de **${safeText(opponentUser.username)}** precisa ter exatamente um goleiro \`GK\` ou \`GOL\`.`,
          invalid_overall: `A escalação de **${safeText(opponentUser.username)}** contém um overall inválido.`,
        }[opponentValidation.reason];
        await interaction.reply({
          components: [makePanel('Escalação do adversário inválida', reason)],
          flags: EPHEMERAL_V2,
        });
        return;
      }
      away = createTeam(opponent.team.name, opponent.team.acronym, opponentLineup);
    } else {
      away = createOpponent(lineup);
    }

    const home = createTeam(member.team.name, member.team.acronym, lineup);
    state = createMatchState(home, away);
  } catch (error) {
    console.error('Não foi possível preparar a partida:', error);
    await interaction.reply({
      components: [makePanel('Erro ao iniciar partida', 'Não foi possível carregar seu time. Tente novamente.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  await interaction.deferReply({ flags: COMPONENTS_V2 });
  try {
    await interaction.editReply({
      components: [makeMatchPanel(state, 'Aquecimento')],
      flags: COMPONENTS_V2,
      allowedMentions: { parse: [] },
    });

    for (let tick = 0; tick < MATCH_TOTAL_TICKS; tick += 1) {
      await wait(MATCH_TICK_MS);
      state = simulateMatchTick(state);
      const isFinal = state.tick === state.totalTicks;
      const status = isFinal
        ? `Fim de jogo · ${state.homeScore > state.awayScore
          ? `🏆 **${safeText(state.home.name)} venceu!**`
          : state.homeScore < state.awayScore
            ? `🏆 **${safeText(state.away.name)} venceu!**`
            : '**Empate!**'}`
        : 'Em andamento';
      await interaction.editReply({
        components: [makeMatchPanel(state, status)],
        flags: COMPONENTS_V2,
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    console.error('A partida foi interrompida durante a atualização ao vivo:', error);
    try {
      await interaction.editReply({
        components: [makePanel('Partida interrompida', `Não foi possível atualizar o placar ao vivo.\n\nÚltimo placar: **${safeText(state.home.name)} ${state.homeScore} — ${state.awayScore} ${safeText(state.away.name)}** aos **${state.minute}'**.`)],
        flags: COMPONENTS_V2,
        allowedMentions: { parse: [] },
      });
    } catch (updateError) {
      console.error('Não foi possível exibir o placar final da partida interrompida:', updateError);
    }
  }
}

async function handleTime(interaction) {
  if (!(await requireGuild(interaction))) return;
  const name = interaction.options.getString('nome', true).trim();
  const acronym = interaction.options.getString('sigla', true).trim().toLocaleUpperCase('pt-BR');
  if (!name || !acronym) {
    await interaction.reply({
      components: [makePanel('Dados incompletos', 'Informe um nome e uma sigla válidos para o time.')],
      flags: EPHEMERAL_V2,
    });
    return;
  }

  try {
    const result = await updateLeague(interaction.guildId, (guild) => {
      const member = getMemberState(guild, interaction.user.id);
      if (member.team) return { created: false, team: member.team };

      member.team = { name, acronym, updatedAt: new Date().toISOString() };
      return { created: true, team: member.team };
    });
    await interaction.reply({
      components: [
        result.created
          ? makePanel(
              'Time criado',
              `Seu time **${safeText(result.team.name)}** · **${safeText(result.team.acronym)}** foi criado. Você pode ter apenas um time.`,
            )
          : makePanel(
              'Você já tem um time',
              `Seu time **${safeText(result.team.name)}** · **${safeText(result.team.acronym)}** já está criado. Não é possível criar outro.`,
            ),
      ],
      flags: EPHEMERAL_V2,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Não foi possível salvar o time:', error);
    await interaction.reply({
      components: [makePanel('Erro ao salvar time', 'Não foi possível salvar os dados do seu time.')],
      flags: EPHEMERAL_V2,
    });
  }
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton() && interaction.customId.startsWith('rank:')) {
    await handleRichestPageButton(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('market-page:')) {
    await handleMarketPageButton(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('market-buy:')) {
    await handleMarketPurchaseButton(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('sell-page:')) {
    await handleSellPageButton(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('sell-card:')) {
    await handleSellCardButton(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('roster:')) {
    await handleRosterPageButton(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('catalog:')) {
    await handleListPageButton(interaction);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('draw:')) {
    try {
      await handleDrawButton(interaction);
    } catch (error) {
      console.error('Erro ao processar botão da carta:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          components: [makePanel('Erro ao processar carta', 'Não foi possível concluir essa ação.')],
          flags: EPHEMERAL_V2,
        });
      }
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === 'addplayer') {
      await handleAddPlayer(interaction);
    } else if (interaction.commandName === 'players') {
      await handlePlayers(interaction);
    } else if (interaction.commandName === 'obter') {
      await handleObter(interaction);
    } else if (interaction.commandName === 'elenco') {
      await handleElenco(interaction);
    } else if (interaction.commandName === 'remover-player') {
      await handleRemoverPlayer(interaction);
    } else if (interaction.commandName === 'carta') {
      await handleCarta(interaction);
    } else if (interaction.commandName === 'lista') {
      await handleLista(interaction);
    } else if (interaction.commandName === 'mercado') {
      await handleMercado(interaction);
    } else if (interaction.commandName === 'vender') {
      await handleVender(interaction);
    } else if (interaction.commandName === 'promover') {
      await handleRosterMove(interaction, 'promote');
    } else if (interaction.commandName === 'reserva') {
      await handleRosterMove(interaction, 'reserve');
    } else if (interaction.commandName === 'saldo') {
      await handleSaldo(interaction);
    } else if (interaction.commandName === 'rank') {
      await handleRank(interaction);
    } else if (interaction.commandName === 'daily') {
      await handleDaily(interaction);
    } else if (interaction.commandName === 'jogar') {
      await handleJogar(interaction);
    } else if (interaction.commandName === 'time') {
      await handleTime(interaction);
    }
  } catch (error) {
    console.error('Erro ao responder à interação:', error);
    if (interaction.replied || interaction.deferred) return;
    await interaction.reply({
      components: [
        makePanel('Erro inesperado', 'Não foi possível concluir a solicitação. Tente novamente.'),
      ],
      flags: EPHEMERAL_V2,
    });
  }
});

client.once('clientReady', (readyClient) => {
  console.log(`Guru conectado como ${readyClient.user.tag}.`);
});

if (!process.env.DISCORD_TOKEN) {
  throw new Error('Configure DISCORD_TOKEN no arquivo .env antes de iniciar o bot.');
}

client.login(process.env.DISCORD_TOKEN);
