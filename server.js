const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'host.html'))
);

// ── État global de la partie ─────────────────────────────────────────
let game = null;

const getLeaderboard = () =>
  !game
    ? []
    : Object.entries(game.players)
        .map(([id, p]) => ({ id, pseudo: p.pseudo, score: p.score }))
        .sort((a, b) => b.score - a.score)
        .map((p, i) => ({ ...p, rank: i + 1 }));

const endQuiz = () => {
  if (!game) return;
  game.status = 'leaderboard';
  io.emit('quiz:leaderboard', getLeaderboard());
};

// ── Socket.IO ────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  /* ═══════════════ HÔTE ═══════════════ */

  socket.on('host:create', ({ questions }, cb) => {
    const qs = questions.map((q) => q.trim()).filter(Boolean);
    if (!qs.length) return cb({ error: 'Aucune question valide !' });

    game = {
      questions: qs,
      currentQ: -1,
      status: 'lobby',
      players: {},
      answers: {},
      hostId: socket.id,
    };
    socket.join('host');
    cb({ ok: true, count: qs.length });
  });

  socket.on('host:next_question', () => {
    if (!game || socket.id !== game.hostId) return;
    game.currentQ++;
    if (game.currentQ >= game.questions.length) return endQuiz();

    game.status = 'question';
    game.answers[game.currentQ] = {};

    const qData = {
      index: game.currentQ,
      total: game.questions.length,
      text: game.questions[game.currentQ],
    };
    io.to('players').emit('quiz:question', qData);
    socket.emit('host:question_active', {
      ...qData,
      playerCount: Object.keys(game.players).length,
    });
  });

  socket.on('host:close_question', () => {
    if (!game || socket.id !== game.hostId) return;
    game.status = 'grading';
    io.to('players').emit('quiz:wait');

    const idx = game.currentQ;
    // On inclut TOUS les joueurs, même ceux qui n'ont pas répondu
    const answers = Object.entries(game.players).map(([sid, player]) => ({
      socketId: sid,
      pseudo: player.pseudo,
      answer: game.answers[idx]?.[sid]?.answer ?? null,
      points: 0,
    }));

    socket.emit('host:start_grading', {
      index: idx,
      total: game.questions.length,
      question: game.questions[idx],
      answers,
    });
  });

  socket.on('host:set_points', ({ socketId, points }) => {
    if (!game || socket.id !== game.hostId) return;
    const idx = game.currentQ;
    const pts = Math.max(0, parseInt(points) || 0);

    if (!game.answers[idx]) game.answers[idx] = {};
    if (!game.answers[idx][socketId]) {
      game.answers[idx][socketId] = {
        pseudo: game.players[socketId]?.pseudo || '?',
        answer: null,
        points: 0,
      };
    }
    const prev = game.answers[idx][socketId].points || 0;
    game.answers[idx][socketId].points = pts;
    if (game.players[socketId]) game.players[socketId].score += pts - prev;

    socket.emit('host:points_ack', {
      socketId,
      points: pts,
      totalScore: game.players[socketId]?.score ?? 0,
    });
  });

  socket.on('host:finish_grading', () => {
    if (!game || socket.id !== game.hostId) return;
    if (game.currentQ >= game.questions.length - 1) return endQuiz();

    game.status = 'between';
    const lb = getLeaderboard();
    io.to('players').emit('quiz:scores', lb);
    socket.emit('host:scores', { scores: lb });
  });

  socket.on('host:new_game', () => {
    game = null;
    io.emit('quiz:reset');
  });

  /* ═══════════════ JOUEURS ═══════════════ */

  socket.on('player:join', ({ pseudo }, cb) => {
    const name = pseudo?.trim();
    if (!name) return cb({ error: 'Pseudo requis' });
    if (!game)
      return cb({ error: "Aucune partie en cours. Attends que l'hôte crée le quiz !" });
    if (game.status === 'leaderboard')
      return cb({ error: 'La partie est déjà terminée.' });
    if (Object.values(game.players).some((p) => p.pseudo.toLowerCase() === name.toLowerCase()))
      return cb({ error: 'Ce pseudo est déjà pris !' });

    game.players[socket.id] = { pseudo: name, score: 0 };
    socket.join('players');
    cb({ ok: true });

    io.to('host').emit('host:player_update', {
      list: Object.values(game.players).map((p) => p.pseudo),
      count: Object.keys(game.players).length,
    });

    // Si une question est déjà en cours et pas encore répondu
    if (game.status === 'question' && !game.answers[game.currentQ]?.[socket.id]) {
      socket.emit('quiz:question', {
        index: game.currentQ,
        total: game.questions.length,
        text: game.questions[game.currentQ],
      });
    } else if (game.status !== 'lobby') {
      socket.emit('quiz:wait');
    }
  });

  socket.on('player:answer', ({ answer }, cb) => {
    if (!game || game.status !== 'question')
      return cb?.({ error: 'La question est fermée' });
    if (!game.players[socket.id]) return cb?.({ error: 'Non inscrit' });
    const ans = answer?.trim();
    if (!ans) return cb?.({ error: 'Réponse vide' });

    const idx = game.currentQ;
    const pseudo = game.players[socket.id].pseudo;
    game.answers[idx][socket.id] = { pseudo, answer: ans, points: 0 };

    socket.emit('quiz:answer_ok');
    cb?.({ ok: true });

    io.to('host').emit('host:answer_in', {
      socketId: socket.id,
      pseudo,
      count: Object.keys(game.answers[idx]).length,
      total: Object.keys(game.players).length,
    });
  });

  socket.on('disconnect', () => {
    if (!game) return;
    if (socket.id === game.hostId) {
      game.hostId = null;
    } else if (game.players[socket.id]) {
      delete game.players[socket.id];
      io.to('host').emit('host:player_update', {
        list: Object.values(game.players).map((p) => p.pseudo),
        count: Object.keys(game.players).length,
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(` Quiz → http://localhost:${PORT}`));
