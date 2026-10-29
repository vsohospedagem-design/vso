require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('addplayer')
    .setDescription('Adiciona uma carta de jogador ao Guru.')
    .addStringOption((option) =>
      option
        .setName('nome')
        .setDescription('Nome do jogador')
        .setRequired(true)
        .setMaxLength(80),
    )
    .addIntegerOption((option) =>
      option
        .setName('over')
        .setDescription('Overall da carta (1 a 99)')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(99),
    )
    .addStringOption((option) =>
      option
        .setName('posicao')
        .setDescription('Posição do jogador, por exemplo ATA ou MEI')
        .setRequired(true)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option
        .setName('clube')
        .setDescription('Clube do jogador')
        .setRequired(true)
        .setMaxLength(80),
    )
    .addStringOption((option) =>
      option
        .setName('valor_de_mercado')
        .setDescription('Valor em reais, por exemplo 10000 ou 10.000,50')
        .setRequired(true)
        .setMaxLength(40),
    )
    .addAttachmentOption((option) =>
      option
        .setName('foto')
        .setDescription('Anexe a foto da carta (alternativa ao link)'),
    )
    .addStringOption((option) =>
      option
        .setName('link_foto')
        .setDescription('Link público para a foto da carta (alternativa ao anexo)')
        .setMaxLength(500),
    ),
  new SlashCommandBuilder()
    .setName('players')
    .setDescription('Mostra as cartas cadastradas no Guru.'),
  new SlashCommandBuilder()
    .setName('obter')
    .setDescription('Sorteia uma carta do elenco; cartas com OVR alto são mais raras.'),
  new SlashCommandBuilder()
    .setName('elenco')
    .setDescription('Mostra o time titular e as reservas de um membro.')
    .addUserOption((option) =>
      option.setName('membro').setDescription('Membro que deseja consultar').setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName('pagina').setDescription('Página do elenco').setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName('remover-player')
    .setDescription('Remove uma carta do catálogo global.')
    .addStringOption((option) =>
      option
        .setName('nome')
        .setDescription('Nome da carta a remover')
        .setRequired(true)
        .setMaxLength(80),
    ),
  new SlashCommandBuilder()
    .setName('carta')
    .setDescription('Mostra os detalhes e a foto de uma carta.')
    .addStringOption((option) =>
      option
        .setName('nome')
        .setDescription('Nome do jogador')
        .setRequired(true)
        .setMaxLength(80),
    ),
  new SlashCommandBuilder()
    .setName('lista')
    .setDescription('Lista as cartas do catálogo.')
    .addIntegerOption((option) =>
      option.setName('pagina').setDescription('Página da lista').setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName('mercado')
    .setDescription('Veja cartas disponíveis e compre com seu saldo.'),
  new SlashCommandBuilder()
    .setName('vender')
    .setDescription('Venda cartas da sua reserva por 90% do valor de mercado.'),
  new SlashCommandBuilder()
    .setName('promover')
    .setDescription('Promove reserva; troca o titular da mesma posição ou preenche uma vaga.')
    .addStringOption((option) =>
      option
        .setName('nome')
        .setDescription('Jogador reserva a promover')
        .setRequired(true)
        .setMaxLength(80),
    ),
  new SlashCommandBuilder()
    .setName('reserva')
    .setDescription('Move um titular para o banco de reservas.')
    .addStringOption((option) =>
      option
        .setName('nome')
        .setDescription('Titular a mover para a reserva')
        .setRequired(true)
        .setMaxLength(80),
    ),
  new SlashCommandBuilder()
    .setName('saldo')
    .setDescription('Mostra seu saldo na liga.'),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Mostra o ranking dos membros mais ricos da liga.')
    .addIntegerOption((option) =>
      option.setName('pagina').setDescription('Página do ranking').setMinValue(1),
    ),
  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Resgate R$ 25.000 uma vez a cada 24 horas.'),
  new SlashCommandBuilder()
    .setName('jogar')
    .setDescription('Jogue uma partida em tempo real com seu time titular.')
    .addUserOption((option) =>
      option
        .setName('membro')
        .setDescription('Membro para enfrentar; deixe vazio para jogar contra a IA')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('time')
    .setDescription('Cria ou atualiza seu time na liga.')
    .addStringOption((option) =>
      option
        .setName('nome')
        .setDescription('Nome do time')
        .setRequired(true)
        .setMaxLength(60),
    )
    .addStringOption((option) =>
      option
        .setName('sigla')
        .setDescription('Sigla do time, por exemplo GUR')
        .setRequired(true)
        .setMaxLength(6),
    ),
].map((command) => command.toJSON());

async function main() {
  const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
    throw new Error('Configure DISCORD_TOKEN e DISCORD_CLIENT_ID no arquivo .env.');
  }

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID);

  await rest.put(route, { body: commands });
  console.log(
    DISCORD_GUILD_ID
      ? `Comandos registrados no servidor ${DISCORD_GUILD_ID}.`
      : 'Comandos globais registrados. A propagação pode levar alguns minutos.',
  );
}

main().catch((error) => {
  console.error('Não foi possível registrar os comandos:', error);
  process.exitCode = 1;
});
