require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes,
  EmbedBuilder,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  NoSubscriberBehavior,
  entersState,
  StreamType,
} = require("@discordjs/voice");
const { REST } = require("@discordjs/rest");
const https = require("https");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const os = require("os");

const isWindows = os.platform() === "win32";
const ffmpegCommand = isWindows
  ? path.join(process.cwd(), "ffmpeg.exe")
  : "ffmpeg";

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const AUDD_API_KEY = process.env.AUDD_API_KEY;
const stations = {
  "Sfera FM": "https://sfera.live24.gr/sfera4132",
  "Rythmos 94.9": "https://rythmos.live24.gr/rythmos",
  "Athens DeeJay 95.2": "https://netradio.live24.gr/athensdeejay",
  "Kiss FM 92.9": "https://kissfm.live24.gr/kissfmathens",
  "Dromos FM 89.8": "https://stream.rcs.revma.com/10q3enqxbfhvv",
  "MAD Radio 106.2": "http://mediaserver.mad.tv/stream",
  "Radio ELGreko": "https://s3.free-shoutcast.com/stream/18192",
  "ERA Sport": "https://radiostreaming.ert.gr/ert-erasport",
  "Easy 97.2": "https://easy972.live24.gr/easy972",
  "Music 89.2": "https://netradio.live24.gr/music892",
  "Skai 100.3": "https://skai.live24.gr/skai1003",
  "Sport FM": "https://sportfm.live24.gr/sportfm7712",
  "Real FM": "https://realfm.live24.gr/realfm",
  "Galaxy 92.0": "https://galaxy.live24.gr/galaxy9292",
  "Crete FM 87.5":
    "https://tls-chrome.live24.gr/1361?http://s3.onweb.gr:8878/;",
  "105.5 Rock":
    "https://tls-chrome.live24.gr/304?http://radio.1055rock.gr:30000/1055",
  "Avanti FM": "https://netradio.live24.gr/radiohotlips",
  "Blackman Radio":
    "https://cloud.123hosting.gr:2200/radio/black9326?mp=/stream",
  "Derti 98.6": "https://derti.live24.gr/derty1000",
  "En Lefko 87.7": "https://stream.rcs.revma.com/trm75ret4c3vv",
  "Hot FM": "https://hotfm.live24.gr/hotfm",
  Lampsi: "https://az11.yesstreaming.net:8140/radio.mp3",
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const connections = new Map(); // key: guildId, value: { connection, player }

client.once("ready", async () => {
  console.log(`✅ Συνδέθηκε ως ${client.user.tag}`);

  // Deploy slash commands
  const commands = [
    new SlashCommandBuilder()
      .setName("play-radio")
      .setDescription("Παίξε έναν ελληνικό ραδιοφωνικό σταθμό")
      .addStringOption((option) =>
        option
          .setName("station")
          .setDescription("Όνομα σταθμού π.χ. sfera")
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("stop-radio")
      .setDescription("Σταματάει το ραδιόφωνο"),
    new SlashCommandBuilder()
      .setName("list-stations")
      .setDescription("Δείξε τη λίστα με τους διαθέσιμους σταθμούς"),

    new SlashCommandBuilder()
      .setName("identify-song")
      .setDescription("Αναγνώριση του τραγουδιού που παίζει τώρα"),
  ].map((cmd) => cmd.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Slash commands deployed.");
  } catch (err) {
    console.error("❌ Σφάλμα στο deploy των εντολών:", err);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guild.id;

  // ===== PLAY RADIO =====
  if (interaction.commandName === "play-radio") {
    const input = interaction.options.getString("station").toLowerCase();
    const matchedStation = Object.entries(stations).find(([name]) =>
      name.toLowerCase().includes(input),
    );

    if (!matchedStation) {
      await interaction.reply({
        content: `⛔ Ο σταθμός "${input}" δεν βρέθηκε.`,
        ephemeral: true,
      });
      return;
    }

    const [stationName, stationUrl] = matchedStation;

    const channel = interaction.member.voice.channel;
    if (!channel) {
      await interaction.reply({
        content: `⛔ Πρέπει να είσαι σε voice κανάλι.`,
        ephemeral: true,
      });
      return;
    }

    try {
      await interaction.deferReply();
    } catch (err) {
      console.warn("⚠️ Could not defer reply:", err);
      return; // error there
    }

    const existing = connections.get(guildId);
    if (existing) {
      existing.player.stop();
      existing.connection.destroy();
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      debug: true,
      selfDeaf: false,
      selfMute: false,
    });

    connection.on("stateChange", (oldState, newState) => {
      console.log(
        `[Voice:${guildId}] ${oldState.status} -> ${newState.status}`,
      );

      if (newState.status === VoiceConnectionStatus.Disconnected) {
        const reasonName = Object.entries(VoiceConnectionDisconnectReason).find(
          ([, value]) => value === newState.reason,
        )?.[0];

        console.log(
          `[Voice:${guildId}] Disconnected reason: ${reasonName ?? newState.reason}`,
        );

        if (typeof newState.closeCode !== "undefined") {
          console.log(
            `[Voice:${guildId}] WebSocket close code: ${newState.closeCode}`,
          );
        }
      }
    });

    connection.on("error", (error) => {
      console.error(`[Voice:${guildId}] Connection error:`, error);
    });

    connection.on("debug", (message) => {
      console.log(`[Voice:${guildId}] ${message}`);
    });

    const ffmpegArgs = [
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-i",
      stationUrl,
      "-analyzeduration",
      "0",
      "-loglevel",
      "warning",
      "-vn",
      "-nostdin",
      "-acodec",
      "libopus",
      "-f",
      "ogg",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ];

    const ffmpegProcess = spawn(ffmpegCommand, ffmpegArgs);

    ffmpegProcess.stderr.on("data", (chunk) => {
      console.error(`ffmpeg stderr: ${chunk.toString()}`);
    });

    ffmpegProcess.on("error", (err) => {
      console.error("ffmpeg process failed to start:", err);
      let errorMessage = "⚠️ Σφάλμα κατά την εκκίνηση του ffmpeg.";
      if (err.code === "ENOENT") {
        errorMessage +=
          " Βεβαιωθείτε ότι το ffmpeg είναι εγκατεστημένο και στο PATH.";
      } else {
        errorMessage += ` Σφάλμα: ${err.message}`;
      }
      interaction.editReply(errorMessage);
      const current = connections.get(guildId);
      if (current && current.connection) {
        current.connection.destroy();
        connections.delete(guildId);
      }
    });

    ffmpegProcess.on("close", (code, signal) => {
      console.log(
        `ffmpeg process closed with code ${code} and signal ${signal}`,
      );
      const current = connections.get(guildId);
      if (
        current &&
        current.connection &&
        current.player &&
        current.player.state.status !== AudioPlayerStatus.Idle
      ) {
        console.log(
          "FFmpeg closed unexpectedly while player was not idle. Cleaning up.",
        );
        current.player.stop();
        current.connection.destroy();
        connections.delete(guildId);
      }
    });

    ffmpegProcess.on("exit", (code, signal) => {
      console.log(
        `ffmpeg process exited with code ${code} and signal ${signal}`,
      );
    });

    const resource = createAudioResource(ffmpegProcess.stdout, {
      inputType: StreamType.OggOpus,
    });

    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
      debug: true,
    });

    player.on("stateChange", (oldState, newState) => {
      console.log(
        `[Player:${guildId}] ${oldState.status} -> ${newState.status}`,
      );
    });

    player.on("debug", (message) => {
      console.log(`[Player:${guildId}] ${message}`);
    });

    player.on(AudioPlayerStatus.Playing, () => {
      interaction.editReply(`📻 Παίζει τώρα: **${stationName}**`);
    });

    player.on(AudioPlayerStatus.Idle, () => {
      const current = connections.get(guildId);
      if (current && current.connection) {
        current.connection.destroy();
        if (current.ffmpegProcess && !current.ffmpegProcess.killed) {
          current.ffmpegProcess.kill("SIGKILL");
        }
        connections.delete(guildId);
      }
    });

    player.on("error", (error) => {
      console.error("Audio player error:", error.message);
      console.error(error);
      interaction.editReply(`⚠️ Σφάλμα στο player: ${error.message}`);
      const current = connections.get(guildId);
      if (current && current.connection) {
        current.connection.destroy();
        if (current.ffmpegProcess && !current.ffmpegProcess.killed) {
          current.ffmpegProcess.kill("SIGKILL");
        }
        connections.delete(guildId);
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (error) {
      console.error(`[Voice:${guildId}] Failed to become ready:`, error);
      connection.destroy();
      await interaction.editReply(
        "⚠️ Δεν κατάφερα να συνδεθώ στο voice channel. Δοκίμασε ξανά.",
      );
      return;
    }

    connection.subscribe(player);
    player.play(resource);

    connections.set(guildId, {
      connection,
      player,
      ffmpegProcess,
      currentStation: stationName,
    });
  }

  // ===== STOP RADIO =====
  else if (interaction.commandName === "stop-radio") {
    const existing = connections.get(guildId);

    if (!existing) {
      await interaction.reply({
        content: `⛔ Δεν παίζει κάτι αυτή τη στιγμή.`,
        ephemeral: true,
      });
      return;
    }

    existing.player.stop();
    existing.connection.destroy();
    if (existing.ffmpegProcess && !existing.ffmpegProcess.killed) {
      existing.ffmpegProcess.kill("SIGKILL");
    }
    connections.delete(guildId);

    await interaction.reply(`🛑 Το ραδιόφωνο σταμάτησε.`);
  }

  // ===== LIST STATIONS =====
  else if (interaction.commandName === "list-stations") {
    const list = Object.entries(stations)
      .map(([name, url]) => `🎵 **${name}** → <${url}>`)
      .join("\n");

    await interaction.reply({
      content: `📻 **Διαθέσιμοι Σταθμοί:**\n\n${list}`,
      ephemeral: true,
    });
  }

  // ===== IDENTIFY SONG =====
  else if (interaction.commandName === "identify-song") {
    const existing = connections.get(guildId);

    if (!existing) {
      await interaction.reply({
        content: `⛔ Δεν παίζει κάτι αυτή τη στιγμή. Ξεκίνησε πρώτα ένα ραδιοφωνικό σταθμό.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      console.log("Starting song identification process");
      const stationName = existing.currentStation;
      const stationUrl = stations[stationName];
      console.log(
        `Identifying song from station: ${stationName}, URL: ${stationUrl}`,
      );

      if (!stationUrl) {
        console.error("Station URL not found for:", stationName);
        await interaction.editReply(
          "⚠️ Δεν ήταν δυνατή η αναγνώριση του σταθμού.",
        );
        return;
      }

      const tempDir = path.join(__dirname, "temp");
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
        console.log(`Created temp directory: ${tempDir}`);
      }

      const samplePath = path.join(tempDir, `sample_${Date.now()}.mp3`);
      console.log(`Sample will be saved to: ${samplePath}`);

      await interaction.editReply(
        "🎵 Ακούω το τραγούδι... Παρακαλώ περιμένετε.",
      );

      console.log("Starting FFmpeg recording process");
      const recordProcess = spawn(ffmpegCommand, [
        "-i",
        stationUrl,
        "-t",
        "10", // 10 seconds recording
        "-y", // Overwrite output file
        "-q:a",
        "0", // Best audio quality
        "-map",
        "a", // Only audio stream
        samplePath,
      ]);

      recordProcess.stderr.on("data", (chunk) => {
        console.log(`FFmpeg stderr: ${chunk.toString()}`);
      });

      recordProcess.on("close", async (code) => {
        console.log(`FFmpeg recording process closed with code: ${code}`);

        if (code !== 0) {
          console.error(`FFmpeg recording failed with code: ${code}`);
          await interaction.editReply(
            "⚠️ Σφάλμα κατά την δημιουργία δείγματος ήχου.",
          );
          return;
        }

        try {
          if (fs.existsSync(samplePath)) {
            const stats = fs.statSync(samplePath);
            console.log(`Sample file size: ${stats.size} bytes`);
            if (stats.size === 0) {
              console.error("Sample file is empty");
              await interaction.editReply(
                "⚠️ Το δείγμα ήχου είναι κενό. Προσπαθήστε ξανά.",
              );
              fs.unlinkSync(samplePath);
              return;
            }
          } else {
            console.error("Sample file was not created");
            await interaction.editReply(
              "⚠️ Δεν δημιουργήθηκε αρχείο ήχου. Προσπαθήστε ξανά.",
            );
            return;
          }

          await interaction.editReply("🔍 Αναζήτηση τραγουδιού...");

          const FormData = require("form-data");
          const formData = new FormData();
          formData.append("api_token", AUDD_API_KEY);
          formData.append("file", fs.createReadStream(samplePath));

          console.log("Sending request to AudD API");

          const response = await axios.post("https://api.audd.io/", formData, {
            headers: formData.getHeaders(),
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
          });

          console.log(
            "Response received from AudD API:",
            JSON.stringify(response.data).substring(0, 200) + "...",
          );

          fs.unlinkSync(samplePath);
          console.log("Temporary file deleted");

          if (response.data && response.data.result) {
            const result = response.data.result;
            console.log(`Song identified: ${result.title} by ${result.artist}`);

            const embed = new EmbedBuilder()
              .setColor(0x3498db)
              .setTitle(`🎵 ${result.title}`)
              .setDescription(`Από ${result.artist}`)
              .addFields(
                {
                  name: "Άλμπουμ",
                  value: result.album || "Άγνωστο",
                  inline: true,
                },
                {
                  name: "Έτος",
                  value: result.release_date || "Άγνωστο",
                  inline: true,
                },
                { name: "Σταθμός", value: stationName, inline: true },
              );

            if (result.song_link) {
              embed.setURL(result.song_link);
            }

            if (
              result.apple_music &&
              result.apple_music.artwork &&
              result.apple_music.artwork.url
            ) {
              embed.setThumbnail(
                result.apple_music.artwork.url
                  .replace("{w}", "500")
                  .replace("{h}", "500"),
              );
            }

            await interaction.editReply({
              content: "✅ Βρέθηκε τραγούδι!",
              embeds: [embed],
            });
          } else {
            console.log("No song identified in the response:", response.data);
            await interaction.editReply(
              "❓ Συγγνώμη, δεν μπόρεσα να αναγνωρίσω το τραγούδι. Προσπαθήστε ξανά αργότερα.",
            );
          }
        } catch (error) {
          console.error("Error identifying song:", error);
          if (error.response) {
            console.error("API error response:", error.response.data);
          }
          await interaction.editReply(
            "⚠️ Σφάλμα κατά την αναγνώριση τραγουδιού: " + error.message,
          );

          if (fs.existsSync(samplePath)) {
            fs.unlinkSync(samplePath);
            console.log("Cleaned up temporary file after error");
          }
        }
      });

      recordProcess.on("error", async (err) => {
        console.error("Error spawning FFmpeg process:", err);
        await interaction.editReply(
          "⚠️ Σφάλμα κατά την εγγραφή δείγματος ήχου: " + err.message,
        );
      });
    } catch (error) {
      console.error("Error in identify-song command:", error);
      await interaction.editReply(
        "⚠️ Σφάλμα κατά την αναγνώριση τραγουδιού: " + error.message,
      );
    }
  }
});

client.on("ready", async () => {
  const appCommands = await client.application.commands.fetch();
  console.log(
    "📜 Commands:",
    [...appCommands.values()].map((cmd) => cmd.name),
  );
});

client.on("voiceStateUpdate", (oldState, newState) => {
  // Only handle events for channels where we have a connection
  const connectionEntry = connections.get(oldState.guild.id);
  if (!connectionEntry) return;

  const botChannelId = connectionEntry.connection.joinConfig.channelId;

  // If user left or moved from the bot's channel
  if (oldState.channelId === botChannelId) {
    const voiceChannel = oldState.channel;
    if (!voiceChannel) return;

    // Check if there are any non-bot members left in the channel
    const nonBotMembers = voiceChannel.members.filter(
      (member) => !member.user.bot,
    );

    if (nonBotMembers.size === 0) {
      console.log(
        `👋 Disconnecting from ${voiceChannel.name} as no humans remain.`,
      );
      connectionEntry.player.stop();
      connectionEntry.connection.destroy();
      if (
        connectionEntry.ffmpegProcess &&
        !connectionEntry.ffmpegProcess.killed
      ) {
        connectionEntry.ffmpegProcess.kill("SIGKILL");
      }
      connections.delete(oldState.guild.id);
    }
  }
});

client.login(TOKEN);
