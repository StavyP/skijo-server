const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(cors());
app.get('/', (_req, res) => res.send('Skyjo Server OK'));

// ─────────────────────────────────────────────
// ROOMS
// ─────────────────────────────────────────────
const rooms = {};

function makeCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// ─────────────────────────────────────────────
// DECK / GAME LOGIC
// ─────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createDeck() {
  const d = [];
  for (let i = 0; i <  5; i++) d.push(-2);
  for (let i = 0; i < 10; i++) d.push(-1);
  for (let i = 0; i < 15; i++) d.push(0);
  for (let v = 1; v <= 12; v++) for (let i = 0; i < 10; i++) d.push(v);
  return shuffle(d);
}

function buildGame(roomPlayers, round = 1) {
  const deck    = createDeck();
  const discard = [deck.pop()];
  const players = roomPlayers.map((rp, idx) => ({
    id:         rp.id,
    name:       rp.name,
    idx,
    grid:       Array.from({ length: 12 }, () => ({ value: deck.pop(), up: false, gone: false })),
    initFlips:  0,
    done:       false,
    roundScore: 0,
    total:      rp.total || 0,
  }));
  return {
    players, deck, discard,
    cur: 0,           // sera recalculé après init
    phase: 'init',
    held: null, triggerBy: null, lastTurns: 0,
    round, gameOver: false, winner: null, showScore: false, penaltyOn: null,
    firstPlayerChosen: false,   // ← flag pour savoir si on a déjà choisi
  };
}

function initSum(p) {
  // Somme des cartes retournées pendant la phase init
  return p.grid.reduce((s, c) => s + (c.up && !c.gone ? c.value : 0), 0);
}

function checkCols(p) {
  for (let c = 0; c < 4; c++) {
    const idx   = [c, c + 4, c + 8];
    const cells = idx.map(i => p.grid[i]);
    if (cells.every(x => x.up && !x.gone && x.value === cells[0].value))
      idx.forEach(i => { p.grid[i].gone = true; });
  }
}

function allUp(p) { return p.grid.every(c => c.up || c.gone); }
function sum(p)   { return p.grid.reduce((s, c) => s + (c.gone ? 0 : c.value), 0); }

function afterPlace(g) {
  const p = g.players[g.cur];
  checkCols(p);
  if (allUp(p) && g.triggerBy === null) {
    g.triggerBy  = g.cur;
    g.lastTurns  = g.players.length - 1;
    p.done       = true;
  }
  nextTurn(g);
}

function nextTurn(g) {
  if (g.triggerBy !== null) {
    g.lastTurns--;
    if (g.lastTurns < 0) { endRound(g); return; }
  }
  g.cur   = (g.cur + 1) % g.players.length;
  g.held  = null;
  g.phase = 'choose';
}

function endRound(g) {
  g.players.forEach(p => p.grid.forEach(c => { if (!c.gone) c.up = true; }));
  const scores      = g.players.map(sum);
  const trig        = g.triggerBy;
  const lowestOther = Math.min(...scores.filter((_, i) => i !== trig));
  g.penaltyOn       = null;

  g.players.forEach((p, i) => {
    let s = scores[i];
    if (i === trig && s > lowestOther) { s *= 2; g.penaltyOn = i; }
    p.roundScore = s;
    p.total     += s;
  });

  g.showScore = true;
  g.phase     = 'scoring';

  if (g.players.some(p => p.total >= 100)) {
    g.gameOver = true;
    const min  = Math.min(...g.players.map(p => p.total));
    g.winner   = g.players.find(p => p.total === min).name;
  }
}

// ─────────────────────────────────────────────
// WHAT THE CLIENT RECEIVES
// ─────────────────────────────────────────────
function publicRoom(room) {
  return {
    code:    room.code,
    host:    room.host,
    started: room.started,
    players: room.players.map(p => ({ id: p.id, name: p.name, total: p.total })),
  };
}

function publicGame(g, forId) {
  return {
    players: g.players.map(p => ({
      id:         p.id,
      name:       p.name,
      idx:        p.idx,
      total:      p.total,
      roundScore: p.roundScore,
      initFlips:  p.initFlips,
      initSum:    g.phase === 'init' ? initSum(p) : undefined,  // ← score init visible par tous
      done:       p.done,
      grid: p.grid.map(c => ({
        up:    c.up,
        gone:  c.gone,
        value: (c.up || c.gone || p.id === forId) ? c.value : null,
      })),
    })),
    deckCount:          g.deck.length,
    discardTop:         g.discard[g.discard.length - 1],
    discardCount:       g.discard.length,
    cur:                g.cur,
    phase:              g.phase,
    held:               g.held,
    triggerBy:          g.triggerBy,
    round:              g.round,
    gameOver:           g.gameOver,
    winner:             g.winner,
    showScore:          g.showScore,
    penaltyOn:          g.penaltyOn,
    firstPlayerChosen:  g.firstPlayerChosen,   // ← transmis au client
  };
}

function broadcastGame(room) {
  if (!room || !room.game || !room.players) return;
  room.players.forEach(p => {
    try {
      const sock = io.sockets.sockets.get(p.id);
      if (sock) sock.emit('game-update', publicGame(room.game, p.id));
    } catch (e) {
      console.error('broadcastGame error for player', p.id, e.message);
    }
  });
}

// ─────────────────────────────────────────────
// HELPER — récupérer la room d'un socket en toute sécurité
// ─────────────────────────────────────────────
function getRoom(socket) {
  const code = socket.data?.room;
  return code ? rooms[code] : null;
}

// ─────────────────────────────────────────────
// SOCKET EVENTS
// ─────────────────────────────────────────────
io.on('connection', socket => {
  console.log('+ connect', socket.id);

  // ── CREATE ──
  socket.on('create-room', ({ name }) => {
    try {
      const code = makeCode();
      rooms[code] = {
        code,
        host:    socket.id,
        players: [{ id: socket.id, name, total: 0 }],
        game:    null,
        started: false,
      };
      socket.join(code);
      socket.data.room = code;
      socket.emit('room-joined', { code, playerId: socket.id });
      io.to(code).emit('room-update', publicRoom(rooms[code]));
    } catch(e) { console.error('create-room error', e.message); }
  });

  // ── JOIN ──
  socket.on('join-room', ({ name, code }) => {
    try {
      const room = rooms[code];
      if (!room)                    return socket.emit('err', 'Salle introuvable.');
      if (room.started)             return socket.emit('err', 'La partie a déjà commencé.');
      if (room.players.length >= 8) return socket.emit('err', 'Salle pleine (8 max).');

      room.players.push({ id: socket.id, name, total: 0 });
      socket.join(code);
      socket.data.room = code;
      socket.emit('room-joined', { code, playerId: socket.id });
      io.to(code).emit('room-update', publicRoom(room));
    } catch(e) { console.error('join-room error', e.message); }
  });

// ── START ──
  socket.on('start-game', () => {
    try {
      const code = socket.data?.room;
      const room = rooms[code];
      if (!room || room.host !== socket.id || room.started) return;

      // 1. ORDRE ALÉATOIRE : Mélange complet des participants
      room.players = shuffle(room.players);

      // 2. Initialisation du jeu avec votre vraie fonction buildGame
      room.started = true;
      room.game = buildGame(room.players);

      // 3. On envoie le signal de transition d'écran au client (index.html / script.js)
      io.to(code).emit('game-start');

      // 4. On partage l'état initial du jeu
      broadcastGame(room);
    } catch (e) {
      console.error('start-game error', e.message);
    }
  });

function determineFirstPlayer(room) {
  let highestValue = -999;
  let startingIndex = 0;

  room.players.forEach((player, index) => {
    // Calcul de la somme des valeurs des cartes visibles du joueur
    const pGrid = room.game.grids[index];
    let playerInitScore = 0;
    
    // On somme uniquement les cartes retournées (visibles)
    pGrid.forEach(card => {
      if (card.visible) {
        playerInitScore += card.value;
      }
    });

    if (playerInitScore > highestValue) {
      highestValue = playerInitScore;
      startingIndex = index;
    }
  });

  // Assigne le premier tour au joueur possédant le plus de points
  room.game.turnIndex = startingIndex;
}

  // ── ACTIONS ──
  socket.on('action', ({ type, ci }) => {
    try {
      const room = getRoom(socket);
      if (!room?.game) return;
      const g   = room.game;
      const cur = g.players[g.cur];

      // ── INIT FLIP ──
      if (type === 'init-flip') {
        const me = g.players.find(p => p.id === socket.id);
        if (!me || me.initFlips >= 2 || g.phase !== 'init') return;
        const cell = me.grid[ci];
        if (!cell || cell.up) return;
        cell.up = true;
        me.initFlips++;

        // Tous prêts → choisir le premier joueur
        if (g.players.every(p => p.initFlips >= 2)) {
          // Celui avec la somme la plus haute commence
          let bestIdx   = 0;
          let bestScore = initSum(g.players[0]);
          for (let i = 1; i < g.players.length; i++) {
            const s = initSum(g.players[i]);
            if (s > bestScore) { bestScore = s; bestIdx = i; }
          }
          g.cur               = bestIdx;
          g.firstPlayerChosen = true;
          g.phase             = 'choose';
        }

        broadcastGame(room);
        return;
      }

      // Toutes les autres actions : c'est bien ton tour
      if (!cur || cur.id !== socket.id) return;

      if (type === 'draw-deck') {
        if (g.phase !== 'choose') return;
        if (g.deck.length === 0) {
          const top = g.discard.pop();
          g.deck = shuffle([...g.discard]);
          g.discard.length = 0;
          g.discard.push(top);
        }
        g.held  = { value: g.deck.pop() };
        g.phase = 'hold';

      } else if (type === 'take-discard') {
        if (g.phase !== 'choose' || !g.discard.length) return;
        g.held  = { value: g.discard.pop() };
        g.phase = 'place_disc';

      } else if (type === 'discard-held') {
        if (g.phase !== 'hold') return;
        g.discard.push(g.held.value);
        g.held  = null;
        g.phase = 'flip_free';

      } else if (type === 'cell') {
        const p    = g.players[g.cur];
        const cell = p.grid[ci];
        if (!cell || cell.gone) return;

        if (g.phase === 'hold') {
          g.discard.push(cell.value);
          cell.value = g.held.value;
          cell.up    = true;
          g.held     = null;
          afterPlace(g);
        } else if (g.phase === 'flip_free') {
          if (cell.up) return;
          cell.up = true;
          afterPlace(g);
        } else if (g.phase === 'place_disc') {
          g.discard.push(cell.value);
          cell.value = g.held.value;
          cell.up    = true;
          g.held     = null;
          afterPlace(g);
        }

      } else if (type === 'next-round') {
        if (!g.showScore || g.gameOver) return;
        const prevTotals = g.players.map(p => p.total);
        room.game = buildGame(
          room.players.map((rp, i) => ({ ...rp, total: prevTotals[i] ?? 0 })),
          g.round + 1
        );

      } else if (type === 'new-game') {
        if (!g.gameOver) return;
        room.players.forEach(p => { p.total = 0; });
        room.game    = null;
        room.started = false;
        io.to(room.code).emit('room-update', publicRoom(room));
        return;
      }

      broadcastGame(room);
    } catch(e) {
      console.error('action error', e.message, e.stack);
    }
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    try {
      const code = socket.data?.room;
      const room = rooms[code];
      if (!room) return;
      const name = room.players.find(p => p.id === socket.id)?.name || '?';
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) { delete rooms[code]; return; }
      if (room.host === socket.id) room.host = room.players[0].id;
      io.to(code).emit('player-left', { name });
      io.to(code).emit('room-update', publicRoom(room));
      console.log(`- ${name} left ${code}`);
    } catch(e) { console.error('disconnect error', e.message); }
  });
});

// ─────────────────────────────────────────────
// ANTI-CRASH GLOBAL
// ─────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Skyjo server listening on :${PORT}`));
