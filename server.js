// QuackOnline - servidor de salas (lobby)
// Node.js 18+ sem dependencias externas. Fala WebSocket no caminho /ws.
//
// O servidor so organiza: apelidos, lista de sessoes, chat, "pronto" e o repasse do codigo
// do host. O jogo em si vai direto de um PC para o outro pelo DuckStation Netplay.

'use strict';

const http = require('http');

const MAX_SPECTATORS = 2; // no maximo 2 pessoas assistindo (igual ao DuckStation, core/netplay.h)
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_USERS = 500;
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_CHAT_LENGTH = 200;
const MAX_NICK_LENGTH = 20;
const MAX_SESSION_NAME = 40;
const PING_INTERVAL_MS = 25000;
const CHAT_HISTORY = 30;

// ---------------------------------------------------------------------------
// WebSocket minimo (RFC 6455): handshake, quadros de texto, ping/pong, close
// ---------------------------------------------------------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Connection {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    this.alive = true;

    socket.setNoDelay(true);
    socket.on('data', (data) => this._onData(data));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
  }

  send(obj) {
    if (this.closed) return;
    this._sendFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  ping() {
    if (this.closed) return;
    if (!this.alive) {
      this.close();
      return;
    }
    this.alive = false;
    this._sendFrame(0x9, Buffer.alloc(0));
  }

  close() {
    if (this.closed) return;
    try {
      this._sendFrame(0x8, Buffer.alloc(0));
    } catch (e) {}
    this.socket.end();
    this._finish();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch (e) {}
    this.onClose();
  }

  _sendFrame(opcode, payload) {
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  _onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (this.buffer.length > MAX_MESSAGE_BYTES * 4) {
      this.close();
      return;
    }

    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          this.close();
          return;
        }
        len = Number(big);
        offset = 10;
      }

      if (len > MAX_MESSAGE_BYTES || !masked) {
        // clientes sempre mascaram; mensagem grande demais = desconecta
        this.close();
        return;
      }

      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = this.buffer[offset + 4 + i] ^ mask[i & 3];
      this.buffer = this.buffer.subarray(offset + 4 + len);

      if (opcode === 0x8) {
        this.close();
        return;
      } else if (opcode === 0x9) {
        this._sendFrame(0xA, payload);
      } else if (opcode === 0xA) {
        this.alive = true;
      } else if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.alive = true;
          let msg;
          try {
            msg = JSON.parse(text);
          } catch (e) {
            continue;
          }
          if (msg && typeof msg === 'object') this.onMessage(msg);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Estado do lobby
// ---------------------------------------------------------------------------

let nextUserId = 1;
let nextSessionId = 1;
const users = new Map(); // id -> user
const sessions = new Map(); // id -> session
const lobbyChat = [];

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // remove caracteres de controle e espacos sobrando
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function userStatus(u) {
  if (!u.sessionId) return 'livre';
  const s = sessions.get(u.sessionId);
  if (!s) return 'livre';
  if (s.spectators.includes(u.id)) return 'assistindo';
  return s.status === 'playing' || s.status === 'starting' ? 'jogando' : 'na sala';
}

// Distancia aproximada (km) entre dois jogadores, pela localizacao do IP (cidade aproximada).
// As coordenadas nunca sao enviadas aos jogadores: so a distancia. -1 = desconhecida.
function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return -1;
  if (a === b) return 0;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))));
}

// viewer: quem vai receber a lista (a distancia e calculada em relacao a ele)
function publicUser(u, viewer) {
  return {
    id: u.id,
    nick: u.nick,
    status: userStatus(u),
    build: u.build,
    country: u.country || '',
    km: distanceKm(viewer, u),
  };
}

function usersFor(viewer) {
  return [...users.values()].filter((u) => u.loggedIn).map((u) => publicUser(u, viewer));
}

function sessionsFor(viewer) {
  return [...sessions.values()].map((s) => publicSession(s, viewer));
}

function publicSession(s, viewer) {
  const host = users.get(s.hostId);
  return {
    id: s.id,
    name: s.name,
    host: host ? host.nick : '?',
    hostCountry: host ? host.country || '' : '',
    hostKm: distanceKm(viewer, host),
    game: s.game,
    serial: s.serial,
    build: s.build,
    players: s.players.length,
    maxPlayers: s.maxPlayers,
    spectators: s.spectators.length,
    status: s.status,
    hasPassword: !!s.password,
    allowSpectators: s.allowSpectators !== false,
    maxSpectators: MAX_SPECTATORS,
  };
}

function sessionDetail(s) {
  const p1 = users.get(s.players[0]);
  const p2 = users.get(s.players[1]);
  return {
    ...publicSession(s, null),
    hostId: s.hostId,
    delay: s.delay,
    playersKm: p2 ? distanceKm(p1, p2) : -1, // distancia entre 1P e 2P (sugestao do atraso)
    members: s.players.map((id, index) => {
      const u = users.get(id);
      return {
        id,
        nick: u ? u.nick : '?',
        slot: index + 1,
        ready: !!s.ready[id],
        country: u ? u.country || '' : '',
        ping: u ? u.rtt || 0 : 0,
      };
    }),
    watchers: s.spectators.map((id) => {
      const u = users.get(id);
      return { id, nick: u ? u.nick : '?', country: u ? u.country || '' : '' };
    }),
    chat: s.chat,
  };
}

function broadcast(obj, filter) {
  for (const u of users.values()) {
    if (!u.loggedIn) continue;
    if (filter && !filter(u)) continue;
    u.conn.send(obj);
  }
}

function broadcastUsers() {
  for (const u of users.values()) {
    if (u.loggedIn) u.conn.send({ type: 'users', users: usersFor(u) });
  }
}

function broadcastSessions() {
  for (const u of users.values()) {
    if (u.loggedIn) u.conn.send({ type: 'sessions', sessions: sessionsFor(u) });
  }
}

function sendSessionToMembers(s) {
  const detail = sessionDetail(s);
  for (const id of [...s.players, ...s.spectators]) {
    const u = users.get(id);
    if (u) u.conn.send({ type: 'session', session: detail });
  }
}

// key/args: o QuackOnline traduz as mensagens do sistema para o idioma de cada jogador
function sessionChat(s, from, text, system, key, args) {
  const line = { from, text, system: !!system, t: Date.now() };
  if (key) {
    line.key = key;
    line.args = args || [];
  }
  s.chat.push(line);
  if (s.chat.length > CHAT_HISTORY) s.chat.shift();
  for (const id of [...s.players, ...s.spectators]) {
    const u = users.get(id);
    if (u) u.conn.send({ type: 'chat', scope: 'session', ...line });
  }
}

function lobbyChatLine(from, text, system) {
  const line = { from, text, system: !!system, t: Date.now() };
  lobbyChat.push(line);
  if (lobbyChat.length > CHAT_HISTORY) lobbyChat.shift();
  broadcast({ type: 'chat', scope: 'lobby', ...line });
}

function sendError(u, key, args, text, code) {
  const msg = { type: 'error', key, args: args || [], text };
  if (code) msg.code = code;
  u.conn.send(msg);
}

function leaveSession(u, reason) {
  const s = sessions.get(u.sessionId);
  u.sessionId = 0;
  if (!s) return;

  const wasHost = s.hostId === u.id;
  s.players = s.players.filter((id) => id !== u.id);
  s.spectators = s.spectators.filter((id) => id !== u.id);
  delete s.ready[u.id];

  if (wasHost || s.players.length === 0) {
    // sem host a sessao acaba
    for (const id of [...s.players, ...s.spectators]) {
      const m = users.get(id);
      if (!m) continue;
      m.sessionId = 0;
      m.conn.send({
        type: 'session',
        session: null,
        reason: reason || `${u.nick} (host) saiu. A sessão foi fechada.`,
        reasonKey: reason ? 'host_disconnected' : 'host_left',
        reasonArgs: [u.nick],
      });
    }
    sessions.delete(s.id);
  } else {
    if (s.status !== 'playing') s.status = 'waiting';
    sessionChat(s, '', `${u.nick} saiu da sessão.`, true, 'left_session', [u.nick]);
    sendSessionToMembers(s);
  }

  u.conn.send({ type: 'session', session: null });
}

// ---------------------------------------------------------------------------
// Mensagens dos clientes
// ---------------------------------------------------------------------------

function handleMessage(u, msg) {
  const type = msg.type;

  if (type === 'bye') {
    // o QuackOnline esta fechando: sai na hora da lista
    u.conn.close();
    return;
  }

  if (type === 'ping') {
    u.conn.send({ type: 'pong', t: msg.t });
    // o QuackOnline manda junto o ping que mediu na vez anterior (para sugerir o atraso de entrada)
    const rtt = Math.round(Number(msg.rtt) || 0);
    if (rtt > 0 && rtt < 5000 && rtt !== u.rtt) {
      u.rtt = rtt;
      const s = sessions.get(u.sessionId);
      if (s && s.players.includes(u.id) && s.status === 'waiting') sendSessionToMembers(s);
    }
    return;
  }

  if (!u.loggedIn) {
    if (type !== 'hello') return;

    const nick = cleanText(msg.nick, MAX_NICK_LENGTH);
    if (nick.length < 2) {
      sendError(u, 'nick_short', [], 'O apelido precisa ter pelo menos 2 letras.', 'nick');
      return;
    }
    // mesmo apelido vindo do mesmo IP = o programa foi reaberto: derruba a conexao antiga
    for (const o of [...users.values()]) {
      if (o !== u && o.loggedIn && o.nick.toLowerCase() === nick.toLowerCase() && o.ip && o.ip === u.ip) o.conn.close();
    }
    const taken = [...users.values()].some((o) => o.loggedIn && o.nick.toLowerCase() === nick.toLowerCase());
    if (taken) {
      sendError(u, 'nick_taken', [], 'Esse apelido já está em uso. Escolha outro.', 'nick');
      return;
    }

    u.nick = nick;
    u.build = cleanText(msg.build, 40);
    u.loggedIn = true;
    u.conn.send({
      type: 'welcome',
      you: { id: u.id, nick: u.nick },
      users: usersFor(u),
      sessions: sessionsFor(u),
      chat: lobbyChat,
    });
    broadcastUsers();
    return;
  }

  switch (type) {
    case 'chat': {
      const text = cleanText(msg.text, MAX_CHAT_LENGTH);
      if (!text) return;
      if (msg.scope === 'session') {
        const s = sessions.get(u.sessionId);
        if (s) sessionChat(s, u.nick, text, false);
      } else {
        lobbyChatLine(u.nick, text, false);
      }
      return;
    }

    case 'create_session': {
      if (u.sessionId) leaveSession(u);
      const name = cleanText(msg.name, MAX_SESSION_NAME) || `Sala de ${u.nick}`;
      const s = {
        id: nextSessionId++,
        name,
        hostId: u.id,
        password: cleanText(msg.password, 30),
        game: cleanText(msg.game, 80),
        serial: cleanText(msg.serial, 20),
        build: u.build,
        maxPlayers: 2,
        delay: 2, // atraso de entrada (quadros), o host escolhe na sessao
        allowSpectators: msg.allowSpectators !== false, // o host decide se outras pessoas podem assistir
        players: [u.id],
        spectators: [],
        ready: { [u.id]: false },
        status: 'waiting',
        hostCode: '',
        chat: [],
      };
      sessions.set(s.id, s);
      u.sessionId = s.id;
      sessionChat(s, '', `${u.nick} criou a sessão.`, true, 'created', [u.nick]);
      sendSessionToMembers(s);
      broadcastSessions();
      broadcastUsers();
      return;
    }

    case 'join_session': {
      const s = sessions.get(parseInt(msg.id, 10));
      if (!s) {
        sendError(u, 'session_gone', [], 'Essa sessão não existe mais.');
        return;
      }
      if (s.build !== u.build) {
        sendError(u, 'other_version', [s.build], `Essa sessão usa outra versão (${s.build}). Atualize o QuackOnline/DuckStation.`);
        return;
      }
      if (s.password && cleanText(msg.password, 30) !== s.password) {
        sendError(u, 'wrong_password', [], 'Senha errada.', 'password');
        return;
      }
      const spectate = !!msg.spectate;
      if (!spectate && s.players.length >= s.maxPlayers) {
        sendError(u, 'session_full', [], 'A sessão está cheia. Você pode entrar para assistir.');
        return;
      }
      if (spectate && s.allowSpectators === false) {
        sendError(u, 'spectators_off', [], 'O host não permite assistir esta partida.');
        return;
      }
      // limite de espectadores (igual ao netplay do DuckStation)
      if (spectate && s.spectators.length >= MAX_SPECTATORS) {
        sendError(u, 'spectators_full', [String(MAX_SPECTATORS)], `Esta partida já tem ${MAX_SPECTATORS} pessoas assistindo (o máximo).`);
        return;
      }
      if (u.sessionId) leaveSession(u);

      u.sessionId = s.id;
      if (spectate) {
        s.spectators.push(u.id);
        sessionChat(s, '', `${u.nick} entrou para assistir.`, true, 'joined_watch', [u.nick]);
      } else {
        s.players.push(u.id);
        s.ready[u.id] = false;
        sessionChat(s, '', `${u.nick} entrou na sessão.`, true, 'joined', [u.nick]);
      }
      sendSessionToMembers(s);
      broadcastSessions();
      broadcastUsers();

      // espectador chegando com a partida ja rolando: entra direto no DuckStation
      if (spectate && s.status === 'playing' && s.hostCode) {
        u.conn.send({ type: 'launch', role: 'spectator', hostCode: s.hostCode, delay: s.delay, session: sessionDetail(s) });
      }
      return;
    }

    case 'leave_session': {
      if (u.sessionId) leaveSession(u);
      broadcastSessions();
      broadcastUsers();
      return;
    }

    case 'set_delay': {
      // so o host escolhe o atraso de entrada, antes de iniciar
      const s = sessions.get(u.sessionId);
      if (!s || s.hostId !== u.id || s.status !== 'waiting') return;
      // acima de 4 quadros o jogo fica pior em qualquer distancia
      const delay = Math.max(0, Math.min(4, Math.round(Number(msg.delay))));
      if (!Number.isFinite(delay) || delay === s.delay) return;
      s.delay = delay;
      sessionChat(s, '', `Atraso de entrada: ${delay} quadros.`, true, 'delay_set', [String(delay)]);
      sendSessionToMembers(s);
      return;
    }

    case 'set_spectators': {
      // o host liga/desliga "permitir assistir"; ao desligar, quem estava assistindo sai da sessao
      const s = sessions.get(u.sessionId);
      if (!s || s.hostId !== u.id) return;
      const allow = !!msg.allow;
      if (allow === (s.allowSpectators !== false)) return;
      s.allowSpectators = allow;
      if (!allow) {
        for (const id of s.spectators) {
          const m = users.get(id);
          if (!m) continue;
          m.sessionId = 0;
          m.conn.send({
            type: 'session',
            session: null,
            reason: 'O host desativou a opção de assistir.',
            reasonKey: 'spectators_removed',
            reasonArgs: [],
          });
        }
        s.spectators = [];
      }
      sessionChat(
        s,
        '',
        allow ? 'Agora outras pessoas podem assistir.' : 'O host desativou a opção de assistir.',
        true,
        allow ? 'spectators_on_msg' : 'spectators_removed'
      );
      sendSessionToMembers(s);
      broadcastSessions();
      broadcastUsers();
      return;
    }

    case 'set_ready': {
      const s = sessions.get(u.sessionId);
      if (!s || !s.players.includes(u.id)) return;
      s.ready[u.id] = !!msg.ready;
      sendSessionToMembers(s);
      return;
    }

    case 'start_session': {
      const s = sessions.get(u.sessionId);
      if (!s || s.hostId !== u.id) return;
      if (s.players.length < 2) {
        sendError(u, 'wait_second', [], 'Espere o segundo jogador entrar.');
        return;
      }
      const notReady = s.players.filter((id) => id !== s.hostId && !s.ready[id]);
      if (notReady.length) {
        sendError(u, 'not_ready', [], 'O outro jogador ainda não marcou "pronto".');
        return;
      }
      s.status = 'starting';
      s.hostCode = '';
      sessionChat(s, '', 'Abrindo o DuckStation do host...', true, 'opening_host');
      sendSessionToMembers(s);
      broadcastSessions();
      broadcastUsers();
      u.conn.send({ type: 'launch', role: 'host', delay: s.delay, session: sessionDetail(s) });
      return;
    }

    case 'host_code': {
      // o DuckStation do host criou a sessao do netplay: repassa o codigo para os outros
      const s = sessions.get(u.sessionId);
      const code = cleanText(msg.code, 64);
      if (!s || s.hostId !== u.id || !code) return;
      s.hostCode = code;
      s.status = 'playing';
      sessionChat(s, '', 'Host pronto. Abrindo o DuckStation dos outros jogadores...', true, 'host_ready');
      for (const id of s.players) {
        if (id === s.hostId) continue;
        const m = users.get(id);
        if (m) m.conn.send({ type: 'launch', role: 'guest', hostCode: code, delay: s.delay, session: sessionDetail(s) });
      }
      for (const id of s.spectators) {
        const m = users.get(id);
        if (m) m.conn.send({ type: 'launch', role: 'spectator', hostCode: code, delay: s.delay, session: sessionDetail(s) });
      }
      sendSessionToMembers(s);
      broadcastSessions();
      broadcastUsers();
      return;
    }

    case 'game_ended': {
      // o host fechou a partida: a sessao volta a esperar
      const s = sessions.get(u.sessionId);
      if (!s || s.hostId !== u.id) return;
      s.status = 'waiting';
      s.hostCode = '';
      for (const id of s.players) s.ready[id] = false;
      sessionChat(s, '', 'A partida terminou.', true, 'match_ended');
      sendSessionToMembers(s);
      broadcastSessions();
      broadcastUsers();
      return;
    }

    case 'launch_failed': {
      const s = sessions.get(u.sessionId);
      if (!s) return;
      {
        const why = cleanText(msg.text, 120);
        if (why) sessionChat(s, '', `${u.nick}: ${why}`, true, 'launch_failed', [u.nick, why]);
        else sessionChat(s, '', `${u.nick}: não conseguiu abrir o DuckStation.`, true, 'launch_failed_default', [u.nick]);
      }
      if (s.hostId === u.id) {
        s.status = 'waiting';
        s.hostCode = '';
        sendSessionToMembers(s);
        broadcastSessions();
        broadcastUsers();
      }
      return;
    }

    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Pais pelo IP (para a bandeira). Usa o servico gratuito ip-api.com com cache em memoria.
// ---------------------------------------------------------------------------

const countryCache = new Map();

function clientIp(req) {
  // no Render o IP real vem no cabecalho x-forwarded-for
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  let ip = forwarded || req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function isPrivateIp(ip) {
  return (
    !ip ||
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('fe80')
  );
}

function fetchJson(url) {
  const lib = url.startsWith('https:') ? require('https') : http;
  return new Promise((resolve) => {
    const req = lib.get(url, { timeout: 5000, headers: { 'User-Agent': 'QuackOnline-lobby' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4000) req.destroy();
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Pais + localizacao aproximada (cidade) pelo IP. Retorna { country, lat, lon } ou null.
async function lookupGeo(ip) {
  if (isPrivateIp(ip)) return null;
  const cached = countryCache.get(ip);
  if (cached && cached.geo && Date.now() - cached.t < 24 * 3600 * 1000) return cached.geo;

  let geo = null;
  // 1o servico: ip-api.com
  const a = await fetchJson(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,lat,lon`);
  if (a && a.status === 'success' && /^[A-Z]{2}$/.test(a.countryCode))
    geo = { country: a.countryCode, lat: Number(a.lat), lon: Number(a.lon) };
  // 2o servico (reserva): ipwho.is
  if (!geo) {
    const b = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code,latitude,longitude`);
    if (b && b.success && /^[A-Z]{2}$/.test(b.country_code))
      geo = { country: b.country_code, lat: Number(b.latitude), lon: Number(b.longitude) };
  }
  if (geo && (!Number.isFinite(geo.lat) || !Number.isFinite(geo.lon))) {
    geo.lat = null;
    geo.lon = null;
  }
  console.log(`pais: ${geo ? geo.country : '(desconhecido)'}`);

  if (countryCache.size > 5000) countryCache.clear();
  countryCache.set(ip, { geo, t: Date.now() });
  return geo;
}

// ---------------------------------------------------------------------------
// HTTP + upgrade para WebSocket
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  // pagina simples (tambem serve para "acordar" o servidor em hospedagens gratuitas)
  const body = JSON.stringify({
    name: 'QuackOnline lobby',
    version: 9,
    ok: true,
    users: [...users.values()].filter((u) => u.loggedIn).length,
    sessions: sessions.size,
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const url = (req.url || '').split('?')[0];
  if (url !== '/ws' || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  if (users.size >= MAX_USERS) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const ip = clientIp(req);
  const user = { id: nextUserId++, nick: '', build: '', loggedIn: false, sessionId: 0, conn: null, country: '', ip };
  // pais do jogador pelo IP (bandeira na lista); o IP fica so na memoria enquanto ele esta conectado
  lookupGeo(ip).then((geo) => {
    if (!geo || !users.has(user.id)) return;
    user.country = geo.country;
    user.lat = geo.lat;
    user.lon = geo.lon;
    if (user.loggedIn) {
      broadcastUsers();
      broadcastSessions();
      const s = sessions.get(user.sessionId);
      if (s) sendSessionToMembers(s);
    }
  });
  user.conn = new Connection(
    socket,
    (msg) => {
      try {
        handleMessage(user, msg);
      } catch (e) {
        console.error('erro ao tratar mensagem:', e);
      }
    },
    () => {
      const wasLoggedIn = user.loggedIn;
      if (user.sessionId) leaveSession(user, `${user.nick} (host) desconectou. A sessão foi fechada.`);
      users.delete(user.id);
      if (wasLoggedIn) {
        broadcastSessions();
        broadcastUsers();
      }
    }
  );
  users.set(user.id, user);
});

setInterval(() => {
  for (const u of users.values()) u.conn.ping();
}, PING_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`QuackOnline lobby ouvindo na porta ${PORT} (WebSocket em /ws)`);
});
