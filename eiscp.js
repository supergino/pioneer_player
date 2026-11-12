'use strict';

/**
 * Minimal eISCP (Extended Integrated Services Control Protocol) client
 * for Onkyo / Pioneer / Integra network receivers.
 *
 * Protocol reference: https://github.com/mkulesh/onpc
 *
 * Wire format (TCP port 60128):
 *   "ISCP"            4 bytes magic
 *   headerSize        4 bytes big-endian (always 16)
 *   dataSize          4 bytes big-endian
 *   version           4 bytes (1)
 *   0,0,0             3 reserved bytes
 *   body              "!" + category(1) + code(3) + parameter + 0x1A
 *
 * Example: power query
 *   !1PWRQSTN\x1A
 */

const net = require('net');
const dgram = require('dgram');
const EventEmitter = require('events');

const DEFAULT_PORT = 60128;
const CATEGORY = '1';

// ---------------------------------------------------------------------------
// Packet building / parsing
// ---------------------------------------------------------------------------

function buildPacket(code, parameter = '', category = CATEGORY) {
  const body = Buffer.from('!' + category + code + parameter + '\x1A', 'utf8');
  const header = Buffer.alloc(16, 0);
  header.write('ISCP', 0, 'ascii');
  header.writeUInt32BE(16, 4);          // header size
  header.writeUInt32BE(body.length, 8); // data size
  header.writeUInt8(1, 12);             // version
  return Buffer.concat([header, body]);
}

/**
 * Try to extract one complete eISCP message from a buffer.
 * Returns { code, parameter, raw, consumed } or null if incomplete.
 */
function extractMessage(buf) {
  const idx = buf.indexOf('ISCP');
  if (idx < 0) return null;
  if (buf.length < idx + 16) return null;

  const headerSize = buf.readUInt32BE(idx + 4);
  const dataSize = buf.readUInt32BE(idx + 8);
  if (headerSize < 16 || dataSize <= 0) {
    // corrupted: drop one byte and resync
    return { resync: true, consumed: idx + 1 };
  }
  const end = idx + headerSize + dataSize;
  if (buf.length < end) return null;

  const body = buf.slice(idx + headerSize, end).toString('utf8');
  const clean = body.split(/[\x1A\r\n]/)[0];
  if (!clean.startsWith('!') || clean.length < 5) {
    return { resync: true, consumed: end };
  }
  const category = clean[1];
  const code = clean.substr(2, 3);
  const parameter = clean.slice(5);
  return { code, category, parameter, raw: clean, consumed: end };
}

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

function hex2(n) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function tonePart(marker, value) {
  if (value === 0) return marker + '00';
  const sign = value < 0 ? '-' : '+';
  return marker + sign + Math.abs(value).toString(16).toUpperCase();
}

const INPUTS = {
  '00': 'VIDEO1', '01': 'VIDEO2', '02': 'VIDEO3', '03': 'VIDEO4',
  '04': 'VIDEO5', '05': 'VIDEO6', '06': 'VIDEO7', '07': 'EXTRA1',
  '08': 'EXTRA2', '10': 'BD/DVD', '11': 'STRM BOX', '12': 'TV',
  '20': 'TAPE1', '21': 'TAPE2', '22': 'PHONO', '23': 'CD',
  '24': 'FM', '25': 'AM', '26': 'TUNER', '27': 'MUSIC SERVER',
  '28': 'INTERNET RADIO', '29': 'USB (front)', '2A': 'USB (rear)',
  '2B': 'NET', '2C': 'USB', '2D': 'AIRPLAY', '2E': 'BLUETOOTH',
  '2F': 'USB DAC', '30': 'MULTI CH', '31': 'XM', '32': 'SIRIUS',
  '33': 'DAB', '40': 'UNIVERSAL', '41': 'LINE', '42': 'LINE2',
  '44': 'OPTICAL', '45': 'COAXIAL', '55': 'HDMI5', '56': 'HDMI6',
  '57': 'HDMI7', '80': 'SOURCE',
};

const PLAY_STATES = {
  S: 'stop', P: 'play', p: 'pause', F: 'fast-forward',
  R: 'rewind', E: 'end',
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

class EiscpClient extends EventEmitter {
  constructor(host, port = DEFAULT_PORT) {
    super();
    this.host = host;
    this.port = port;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.lastError = null;
    this.buffer = Buffer.alloc(0);
    this.reconnectDelay = 2000;
    this.reconnectTimer = null;
    this.shouldReconnect = true;
    this.lastMessageAt = 0;
    this.connectedAt = 0;
    this.pollTimer = null;
    this.state = {
      power: null,            // 'on' | 'standby'
      volume: null,           // 0..100
      volumeMax: null,
      mute: null,             // boolean
      input: null,            // code e.g. '23'
      inputName: null,
      listeningMode: null,
      playStatus: null,
      title: null,
      artist: null,
      album: null,
      track: null,          // traccia corrente (NET/USB), numero
      trackTotal: null,     // tracce totali (NET/USB)
      listInfo: null,
      time: null,
      // --- Lettore CD integrato (sorgente 23) ---
      cdStatus: null,       // stop / play / pause / fast-forward / rewind (CST)
      cdRepeat: null,       // '-' spentto, 'R' tutto, '1' traccia singola (CST)
      cdShuffle: null,      // '-' spentto, 'S' casuale (CST)
      cdDisc: null,         // 'none' / 'audio' / 'mp3' (DST)
      cdTrack: null,        // numero della traccia CD in ascolto
      cdTrackKnown: false,  // true se cdTrack è valorizzato
      cdTracklist: [],      // durate (ms) delle tracce CD, indice 0 = traccia 1
      cdAvgDuration: 0,     // durata media (ms) delle tracce con durata nota
      cdElapsed: 0,         // secondi trascorsi nella traccia CD corrente
      cdTime: null,         // "elapsed/total" del CD (CTM), se il dispositivo lo invia
      albumArtUrl: null,
      albumArtVersion: 0,
      albumArtAt: 0,
      bass: null,
      treble: null,
      digitalFilter: null,   // filtro DAC: '00' slow, '01' sharp, '02' short (DGF)
      sleep: null,
      dimmer: null,
      networkService: null,
      raw: {},                // last parameter per code
      listItems: [],          // USB / NET track list snapshot
      listTotal: 0,           // total number of tracks reported by device
      listComplete: false,    // true when we have the full list
      listNumberOfItems: 0,   // totale tracce dichiarato dal dispositivo (NLT)
      listCursor: 0,           // cursore nella lista NET (NLT)
      listLayer: 1,            // layer corrente della lista (1 = radice del servizio)
      listLayers: 1,           // ultimo valore di layer dichiarato da NLT
      listUiType: null,        // '0' lista, '2' riproduzione (NLT)
      listReqLayer: 1,         // layer usato nell'ultima richiesta XML (NLA)
      fileFormat: null,       // formato file (MP3, FLAC, DSD, WAV, …)
      sampleFrequency: null,  // frequenza di campionamento (Hz)
      bitRate: null,          // bitrate / bit profondità
    };
    this.log = [];
  }

  setHost(host, port = DEFAULT_PORT) {
    this.host = host;
    this.port = port;
    this.disconnect();
    this.connect();
  }

  logLine(dir, text) {
    const entry = { t: Date.now(), dir, text };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    this.emit('log', entry);
  }

  connect() {
    if (this.connecting || this.connected) return;
    this.connecting = true;
    this.lastError = null;

    const socket = new net.Socket();
    this.socket = socket;

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      this.connecting = false;
      this.connected = false;
      this.lastError = err && err.code ? err.code : (err && err.message) || 'error';
      this.emit('status', this.status());
      try { socket.destroy(); } catch (_) {}
      this.scheduleReconnect();
    };

    socket.setTimeout(5000);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      this.connecting = false;
      this.connected = true;
      this.lastError = null;
      this.connectedAt = Date.now();
      this.lastMessageAt = Date.now();
      socket.setTimeout(0);
      // Keepalive TCP: rileva più in fretta socket morte dopo lo standby.
      try { socket.setKeepAlive(true, 15000); } catch (_) {}
      this.buffer = Buffer.alloc(0);
      this.logLine('out', 'TCP connected to ' + this.host + ':' + this.port);
      this.emit('status', this.status());
      this.queryAll();
      this.startPolling();
    });

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('timeout', () => fail(new Error('timeout')));
    socket.on('error', (err) => {
      if (!this.connected) {
        fail(err);
      } else {
        this.lastError = err.code || err.message;
        this.emit('status', this.status());
      }
    });
    socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.connecting = false;
      this.stopPolling();
      if (wasConnected) this.logLine('out', 'TCP disconnected');
      this.emit('status', this.status());
      if (this.shouldReconnect) this.scheduleReconnect();
    });

    socket.connect(this.port, this.host);
  }

  // Forza un tentativo di connessione immediato, annullando l'attesa del
  // prossimo reconnect schedulato (usato dopo il Wake-on-LAN).
  reconnectNow() {
    this.shouldReconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.connected && !this.connecting) this.connect();
  }

  scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopPolling();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
    this.connected = false;
    this.connecting = false;
  }

  startPolling() {
    this.stopPolling();
    // Refresh key values periodically (every 10s)
    this.pollTimer = setInterval(() => {
      if (!this.connected) return;
      this.send('PWR', 'QSTN');
      this.send('MVL', 'QSTN');
      this.send('AMT', 'QSTN');
      this.send('SLI', 'QSTN');
      this.send('TFR', 'QSTN');
      this.send('DGF', 'QSTN');
      this.send('NFI', 'QSTN');
      if (this.state.input === '23') {
        // Sorgente CD: il lettore integrato risponde solo ai comandi CD
        // (CST = stato, DST = disco). NST/NTR restano muti.
        this.send('CST', 'QSTN');
        this.send('DST', 'QSTN');
      } else {
        this.send('NST', 'QSTN');
        this.send('NTR', 'QSTN');
      }
    }, 10000);
    if (this.pollTimer.unref) this.pollTimer.unref();

    // Orologio virtuale del CD: il dispositivo non comunica il numero di
    // traccia (NTR/CTM muti in sorgente CD), quindi l'avanzamento viene
    // calcolato con lo stato play/pause (CST) e le durate delle tracce
    // inviate dal browser (MusicBrainz).
    this.cdClockTimer = setInterval(() => this.tickCdClock(), 1000);
    if (this.cdClockTimer.unref) this.cdClockTimer.unref();

    // Polling ravvicinato dello stato del lettore CD: serve a cogliere subito
    // play/pausa/stop (anche dati dal telecomando), così l'orologio virtuale
    // si ferma entro pochi secondi invece che al polling generale da 10 s.
    this.cdPollTimer = setInterval(() => {
      if (!this.connected || this.state.input !== '23') return;
      this.send('CST', 'QSTN');
    }, 2000);
    if (this.cdPollTimer.unref) this.cdPollTimer.unref();

    // Watchdog della connessione: se il ricevitore va in standby profondo la
    // socket TCP può restare "aperta" senza FIN (half-open). In quel caso il
    // client crederebbe di essere connesso e i comandi andrebbero persi.
    // Se non arriva alcun messaggio per 25 s, la connessione viene chiusa e
    // riavviata (il polling invia query ogni 10 s, quindi il silenzio è anomalo).
    this.watchdogTimer = setInterval(() => this.checkStaleConnection(), 5000);
    if (this.watchdogTimer.unref) this.watchdogTimer.unref();
  }

  // True se la socket è connessa ma il dispositivo non risponde più.
  checkStaleConnection() {
    if (!this.connected) return;
    const last = this.lastMessageAt || this.connectedAt || 0;
    if (!last) return;
    const silentMs = Date.now() - last;
    if (silentMs < 25000) return;
    this.logLine('out', 'Nessuna risposta da ' + Math.round(silentMs / 1000) +
      's: riconnessione');
    try { this.socket.destroy(); } catch (_) {}
  }

  // Avanza il contatore delle tracce CD in base al tempo effettivamente
  // trascorso in riproduzione e alla durata delle tracce note.
  tickCdClock() {
    const st = this.state;
    if (st.input !== '23' || !st.cdTracklist || !st.cdTracklist.length) return;
    if (st.cdStatus !== 'play') {
      // In pausa/stop l'orologio è fermo: azzeriamo il riferimento temporale
      // così il tempo di pausa non viene conteggiato.
      this.cdLastTick = null;
      return;
    }

    const now = Date.now();
    const last = this.cdLastTick || now;
    this.cdLastTick = now;
    let delta = (now - last) / 1000;
    if (!isFinite(delta) || delta <= 0) return;
    // ignora salti enormi (sospensione, cambio host): massimo 5 minuti
    if (delta > 300) delta = 300;

    // Tempo trascorso (ms) dall'inizio della traccia corrente.
    let remaining = (st.cdElapsed || 0) * 1000 + delta * 1000;
    let advanced = false;

    // Durata della traccia corrente: se MusicBrainz non la pubblica si usa
    // la media delle durate note come stima.
    const durationOf = (track) => {
      const known = st.cdTracklist[track - 1] || 0;
      return known || st.cdAvgDuration || 0;
    };

    let duration = durationOf(st.cdTrack || 1);
    // Consuma il tempo trascorso: può attraversare più traguardi (recupero
    // dopo un blocco del server o del sistema).
    let guard = 0;
    while (duration > 0 && remaining >= duration && guard < 100) {
      guard++;
      if (st.cdTrack >= st.cdTracklist.length) {
        // Ultima traccia della tracklist: il contatore non può avanzare,
        // il tempo resta fermo al valore della durata.
        remaining = duration;
        break;
      }
      remaining -= duration;
      st.cdTrack = st.cdTrack + 1;
      advanced = true;
      duration = durationOf(st.cdTrack);
    }

    st.cdElapsed = Math.max(0, remaining) / 1000;
    if (advanced) {
      this.emit('state', st);
      this.logLine('out', 'CD: traccia ' + st.cdTrack + ' (avanzamento automatico)');
    }
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.cdClockTimer) {
      clearInterval(this.cdClockTimer);
      this.cdClockTimer = null;
    }
    if (this.cdPollTimer) {
      clearInterval(this.cdPollTimer);
      this.cdPollTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  queryAll() {
    const queries = [
      ['PWR', 'QSTN'], ['MVL', 'QSTN'], ['AMT', 'QSTN'],
      ['SLI', 'QSTN'], ['LMD', 'QSTN'], ['NST', 'QSTN'],
      ['TFR', 'QSTN'], ['DGF', 'QSTN'], ['SLP', 'QSTN'], ['DIM', 'QSTN'],
      ['NTI', 'QSTN'], ['NAT', 'QSTN'], ['NAL', 'QSTN'],
      ['NTR', 'QSTN'], ['NTM', 'QSTN'], ['NSV', 'QSTN'],
      ['CST', 'QSTN'], ['DST', 'QSTN'], ['CTM', 'QSTN'],
      ['NFI', 'QSTN'], ['NJA', 'REQ'],
    ];
    for (const [code, par] of queries) this.send(code, par);
  }

  send(code, parameter = '') {
    if (!this.connected || !this.socket) {
      this.logLine('out', '(offline) ' + code + parameter);
      return false;
    }
    const packet = buildPacket(code, parameter);
    this.socket.write(packet);
    this.logLine('>>', code + (parameter ? ' ' + parameter : ''));
    return true;
  }

  onData(chunk) {
    this.lastMessageAt = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Guard against runaway buffer
    if (this.buffer.length > 1024 * 1024) {
      this.buffer = this.buffer.slice(-4096);
    }

    for (;;) {
      const msg = extractMessage(this.buffer);
      if (!msg) break;
      if (msg.resync) {
        this.buffer = this.buffer.slice(msg.consumed);
        continue;
      }
      this.buffer = this.buffer.slice(msg.consumed);
      this.handleMessage(msg);
    }
  }

  handleMessage(msg) {
    const { code, parameter } = msg;
    this.state.raw[code] = parameter;
    this.logLine('<<', code + ' ' + parameter);

    switch (code) {
      case 'PWR':
        if (parameter === '00') this.state.power = 'standby';
        else if (parameter === '01') this.state.power = 'on';
        break;
      case 'MVL': {
        const v = parseInt(parameter, 16);
        if (!isNaN(v)) this.state.volume = v;
        break;
      }
      case 'AMT':
        if (parameter === '00') this.state.mute = false;
        else if (parameter === '01') this.state.mute = true;
        break;
      case 'SLI':
        if (parameter && parameter !== 'N/A') {
          this.state.input = parameter;
          this.state.inputName = INPUTS[parameter] || parameter;
        }
        if (parameter === '23') {
          // Selezionata la sorgente CD: interroga subito il lettore integrato.
          setTimeout(() => {
            if (!this.connected) return;
            this.send('CST', 'QSTN');
            this.send('DST', 'QSTN');
          }, 300);
        }
        break;
      case 'LMD':
        this.state.listeningMode = parameter;
        break;
      case 'NST':
        if (parameter.length) {
          this.state.playStatus = PLAY_STATES[parameter[0]] || parameter[0];
        }
        break;
      case 'NTI': {
        const title = parameter.replace(/^N\/A$/, null);
        if (title !== this.state.title) {
          this.state.title = title;
        }
        break;
      }
      case 'NJA': {
        // Formato: <tipo immagine><flag pacchetto><payload>
        // tipo: 0=BMP, 1=JPEG, 2=URL, n=nessuna immagine
        const imageType = parameter.charAt(0);
        const payload = parameter.slice(2);
        const now = Date.now();
        if (imageType === '2' && /^https?:\/\//i.test(payload)) {
          // Evita refresh multipli ravvicinati (es. risposta a NJA REQ)
          if (this.state.albumArtUrl !== payload || now - this.state.albumArtAt > 2000) {
            this.state.albumArtUrl = payload;
            this.state.albumArtVersion++;
            this.state.albumArtAt = now;
          }
        } else if ((imageType === '1' || imageType === '0') && /^[0-9a-f]+$/i.test(payload)) {
          const mime = imageType === '1' ? 'image/jpeg' : 'image/bmp';
          try {
            const b64 = Buffer.from(payload, 'hex').toString('base64');
            this.state.albumArtUrl = `data:${mime};base64,${b64}`;
            this.state.albumArtVersion++;
            this.state.albumArtAt = now;
          } catch (_) { /* ignora payload non valido */ }
        } else if (imageType === 'n' && !this.state.albumArtUrl) {
          // Only set to null if we don't already have a valid art URL
          this.state.albumArtUrl = null;
          this.state.albumArtVersion++;
          this.state.albumArtAt = now;
        }
        break;
      }
      case 'NAT':
        this.state.artist = parameter.replace(/^N\/A$/, null);
        break;
      case 'NAL':
        this.state.album = parameter.replace(/^N\/A$/, null);
        break;
      case 'NTR': {
        // NET/USB Track Info: "<traccia corrente>/<tracce totali>"
        // es. "0003/0012"; se sconosciuto il dispositivo risponde "----/----".
        const parts = parameter.split('/');
        const cur = (parts[0] || '').trim();
        const max = (parts[1] || '').trim();
        this.state.track = /^\d+$/.test(cur) ? parseInt(cur, 10) : null;
        this.state.trackTotal = /^\d+$/.test(max) ? parseInt(max, 10) : null;
        break;
      }
      case 'CST': {
        // CD Play Status (3 lettere): "S--", "P--", "p--", "F--", "R--"
        // 1ª lettera = play status, 2ª = repeat, 3ª = shuffle.
        const p = parameter.replace(/\s+/g, '');
        const cdState = PLAY_STATES[p.charAt(0)];
        if (cdState) {
          const changed = this.state.cdStatus !== cdState;
          this.state.cdStatus = cdState;
          // In sorgente CD lo stato di riproduzione arriva da CST, non da NST.
          if (this.state.input === '23') this.state.playStatus = cdState;
          if (changed) {
            if (cdState === 'stop' || cdState === 'end') {
              // Stop/fine: la traccia ripartirà dall'inizio.
              this.cdLastTick = null;
              this.state.cdElapsed = 0;
            } else {
              // Play/pausa: l'orologio si ferma e riparte conservando la
              // posizione nella traccia corrente.
              this.cdLastTick = cdState === 'play' ? Date.now() : null;
            }
          }
        }
        this.state.cdRepeat = p.charAt(1) || null;
        this.state.cdShuffle = p.charAt(2) || null;
        break;
      }
      case 'DST': {
        // Current disc status notice:
        // 00 = nessun disco, 04 = CD audio, 07 = CD MP3, FF = sconosciuto.
        const code = parameter.trim().toUpperCase();
        const disc = { '00': 'none', '04': 'audio', '07': 'mp3', 'FF': 'unknown' }[code] || 'unknown';
        const prev = this.state.cdDisc;
        this.state.cdDisc = disc;
        if (disc === 'none') {
          // Nessun disco: il contatore tracce non è più valido.
          this.state.cdTrack = null;
          this.state.cdTrackKnown = false;
          this.state.cdElapsed = 0;
          this.cdLastTick = null;
        } else if (prev !== disc) {
          // Disco appena inserito: si riparte dalla traccia 1.
          this.state.cdTrack = 1;
          this.state.cdTrackKnown = true;
          this.state.cdElapsed = 0;
          this.cdLastTick = Date.now();
        }
        break;
      }
      case 'CTM': {
        // CD Time Info: "mm:ss/mm:ss" (elapsed/total)
        this.state.cdTime = parameter.trim() || null;
        break;
      }
      case 'NTM':
        this.state.time = parameter;
        break;
      case 'NFI': {
        // NET/USB File Info
        // Format: FORMAT/SAMPLE_FREQUENCY/BITRATE (separated by '/')
        // es. "FLAC/192000/24" o "MP3/44100/320"
        const parts = parameter.split('/');
        this.state.fileFormat = parts[0] || null;
        this.state.sampleFrequency = parts[1] || null;
        this.state.bitRate = parts[2] || null;
        break;
      }
      case 'TFR': {
        // Il ricevitore risponde con cifre esadecimali a lunghezza variabile,
        // es. "B+4T+A" (bassi +4, alti +10) oppure "B-2T00".
        const bass = /B([+-]?)([0-9A-Fa-f]{1,2})/.exec(parameter);
        const treble = /T([+-]?)([0-9A-Fa-f]{1,2})/.exec(parameter);
        if (bass) {
          const n = parseInt(bass[2], 16);
          this.state.bass = bass[1] === '-' ? -n : n;
        }
        if (treble) {
          const n = parseInt(treble[2], 16);
          this.state.treble = treble[1] === '-' ? -n : n;
        }
        break;
      }
      case 'SLP':
        this.state.sleep = parameter;
        break;
      case 'DIM':
        this.state.dimmer = parameter;
        break;
      case 'DGF':
        // Filtro digitale del DAC: '00' Slow, '01' Sharp, '02' Short.
        this.state.digitalFilter = String(parameter || '').trim().toUpperCase() || null;
        break;
      case 'NLT': {
        // NET/USB List Title Info
        // Format: xxuycccciiiillsraabbss + titleBar
        //   u    = UI type (0 lista, 2 riproduzione, 3 popup)
        //   cccc = current cursor position (HEX)
        //   iiii = number of list items (HEX)
        //   ll   = number of layers (HEX)
        // Il HM86D tronca alcune risposte a 20 caratteri: si leggono i campi
        // disponibili invece di scartare tutto.
        if (parameter.length >= 3) {
          this.state.listUiType = parameter.charAt(2);
        }
        if (parameter.length >= 14) {
          const cursorPos = parseInt(parameter.substring(4, 8), 16);
          const numberOfItems = parseInt(parameter.substring(8, 12), 16);
          const numberOfLayers = parseInt(parameter.substring(12, 14), 16);
          const titleBar = parameter.substring(22);
          const cleanTitle = titleBar.replace(/[\x00-\x1F]/g, '').trim();
          this.state.listCursor = isNaN(cursorPos) ? this.state.listCursor : cursorPos;
          this.state.listNumberOfItems = isNaN(numberOfItems) ? 0 : numberOfItems;
          this.state.listNumberOfLayers = isNaN(numberOfLayers) ? 0 : numberOfLayers;
          // In UI "playback" il NLT descrive il brano in riproduzione, non la
          // lista: il layer di navigazione non va aggiornato da lì.
          if (!isNaN(numberOfLayers) && numberOfLayers > 0 &&
              this.state.listUiType !== '2') {
            this.state.listLayers = numberOfLayers;
            this.state.listLayer = numberOfLayers;
          }
          if (cleanTitle && cleanTitle !== this.state.title) {
            this.state.title = cleanTitle;
          }
        }
        break;
      }
      case 'NLS': {
        // NET/USB List Info
        // Format: <type><line><property>-<data>
        // type: U=Unicode, A=ASCII, C=Cursor, P=Page
        // line: 0-9 (1st to 10th line)
        // property: -=no, 0=playing, A=artist, B=album, F=folder, M=music, etc.
        const infoType = parameter.charAt(0);
        const lineChar = parameter.charAt(1);
        const property = parameter.charAt(2);
        const listedData = parameter.substring(3);
        
        if (infoType === 'U' || infoType === 'A') {
          // Unicode or ASCII list item
          const lineNum = parseInt(lineChar, 10);
          if (!isNaN(lineNum) && listedData) {
            // Con una lista completa già caricata (NLA), le righe NLS che il
            // dispositivo invia alla riconnessione non devono sovrascrivere
            // titoli e icone: aggiorna solo l'indicatore di riproduzione.
            if (this.state.listComplete && this.state.listItems &&
                this.state.listItems[lineNum]) {
              const cur = this.state.listItems[lineNum];
              if (property === '0') cur.iconid = '36';
              else if (cur.iconid === '36') cur.iconid = (cur.icontype === 'F') ? '29' : '2d';
              this.emit('nla', {
                items: this.state.listItems,
                total: this.state.listTotal,
                complete: true,
              });
              break;
            }
            // First line of a new list: drop previous items so tracks from
            // a parent folder don't linger when going back.
            // Skip the reset if the full XML list (NLA) has already been loaded,
            // so NLS lines arriving right after NLA don't wipe the complete set.
            if (lineNum === 0 && !this.state.listComplete) {
              this.state.listItems = [];
              this.state.listComplete = false;
            }
            if (!this.state.listItems) {
              this.state.listItems = [];
            }
            // Ensure array is large enough
            while (this.state.listItems.length <= lineNum) {
              this.state.listItems.push({ title: '', iconid: '', selectable: true });
            }
            this.state.listItems[lineNum] = {
              id: lineNum,
              title: listedData,
              iconid: property === 'F' ? '29' : (property === '0' ? '36' : '2d'),
              icontype: property === 'F' ? 'F' : 'M',
              layers: this.state.listLayer,
              selectable: true
            };
            const complete = this.state.listTotal > 0 &&
              this.state.listItems.length >= this.state.listTotal;
            this.state.listComplete = complete;
            this.emit('nla', {
              items: this.state.listItems,
              total: this.state.listTotal,
              complete: complete
            });
          }
        } else if (infoType === 'C') {
          // Cursor info
          this.state.listCursor = parameter.substring(4);
        } else if (infoType === 'P') {
          // Page info
          this.state.listPage = parameter.substring(4);
        }
        break;
      }
      case 'NSV':
        this.state.networkService = parameter;
        break;
      case 'NLU': {
        // NET/USB List Item Update - contains index and total count
        // Format: "IIIINNNN" where IIII = index (0-based), NNNN = total count
        const idxCode = parameter.substring(0, 4);
        const numCode = parameter.substring(4, 8);
        const idx = parseInt(idxCode, 16);  // 0-based track index
        const total = parseInt(numCode, 16);  // total number of tracks
        
        // Initialize listItems array if not exists
        if (!this.state.listItems) {
          this.state.listItems = [];
        }
        
        // If this is a new total or we need to update, adjust the array
        if (total > this.state.listItems.length) {
          // Fill missing spots with placeholder
          while (this.state.listItems.length < total) {
            this.state.listItems.push({ title: "", selectable: true });
          }
        }
        
        // Store the index-position info
        // We'll use the NLU to know how many tracks there are,
        // but actual titles come from NLA/XML
        this.state.listTotal = total;
        const complete = this.state.listItems.length >= total;
        this.state.listComplete = complete;
        this.emit('nla', {
          items: this.state.listItems,
          total: this.state.listTotal,
          complete: complete
        });
        break;
      }
case 'NLA': {
        // NET/USB List Info with XML - contain all tracks
        const xmlStart = parameter.indexOf('<');
        if (xmlStart >= 0) {
          const xml = parameter.substring(xmlStart);
          this.state.listXml = xml;
          // Try to extract item titles using simple regex
          // Parse items with their IDs and icons
    const itemRegex = /<item\b([^>]*)\/?>/gi;
    const items = [];
    let m;
    let idx = 0;
    while ((m = itemRegex.exec(xml)) !== null) {
      const attrs = m[1];
      const titleMatch = /title="([^"]*)"/i.exec(attrs);
      const iconMatch = /iconid="([^"]*)"/i.exec(attrs);
      const selectableMatch = /selectable="([^"]*)"/i.exec(attrs);
      const icontypeMatch = /icontype="([^"]*)"/i.exec(attrs);
      
      const title = titleMatch ? titleMatch[1] : '';
      const iconid = iconMatch ? iconMatch[1] : '';
      const selectable = selectableMatch ? selectableMatch[1] : '1';
      const icontype = icontypeMatch ? icontypeMatch[1] : '';
      
      if (title) {
        items.push({ 
          id: idx, 
          title: title, 
          iconid: iconid,
          icontype: icontype,
          layers: this.state.listReqLayer || this.state.listLayer,
          selectable: selectable === '1'
        });
      }
      idx++;
    }
    
    // Store total items from the XML
    const totalMatch = /totalitems="([^"]*)"/i.exec(xml);
    const total = totalMatch ? parseInt(totalMatch[1], 10) : items.length;
    
    // Always replace the list when the device answers OK. This guarantees
    // the full USB content on first connect and prevents stale tracks from
    // staying behind when going back to a parent folder.
    if (xml.indexOf('status="ok"') >= 0) {
      this.state.listItems = items;
      this.state.listTotal = total;
      this.state.listComplete = true;
    }
    this.emit('nla', {
      items: items,
      total: total,
      complete: this.state.listComplete === undefined ? true : this.state.listComplete
    });
        }
        break;
      }
      default:
        break;
    }

    this.emit('message', msg);
    this.emit('state', this.state);
  }

  status() {
    return {
      host: this.host,
      port: this.port,
      connected: this.connected,
      connecting: this.connecting,
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Lettore CD integrato
  // ---------------------------------------------------------------------------
  // Il Pioneer HM86D non comunica il numero di traccia del CD via eISCP: in
  // sorgente CD il dispositivo non risponde a NTR né a CTM, ma solo a CST
  // (stato di riproduzione) e DST (disco inserito). Il contatore delle tracce
  // viene quindi tenuto dal controller e aggiornato sui comandi di skip
  // inviati al dispositivo (CCD SKIP.F / CCD SKIP.R).
  cdEnsureTrack() {
    if (!this.state.cdTrackKnown || !this.state.cdTrack) {
      this.state.cdTrack = 1;
      this.state.cdTrackKnown = true;
    }
    return this.state.cdTrack;
  }

  cdSkip(delta) {
    const current = this.cdEnsureTrack();
    this.state.cdTrack = Math.max(1, current + delta);
    this.state.cdTrackKnown = true;
    // La nuova traccia riparte da zero.
    this.state.cdElapsed = 0;
    this.cdLastTick = Date.now();
    this.emit('state', this.state);
    return this.state.cdTrack;
  }

  cdSetTrack(value) {
    const n = parseInt(value, 10);
    if (isNaN(n)) return this.state.cdTrack;
    this.state.cdTrack = Math.max(1, n);
    this.state.cdTrackKnown = true;
    this.state.cdElapsed = 0;
    this.cdLastTick = Date.now();
    this.emit('state', this.state);
    return this.state.cdTrack;
  }

  // Riceve dal browser le durate delle tracce CD (MusicBrainz) per poter
  // calcolare l'avanzamento automatico del contatore.
  setCdTracklist(tracks) {
    const list = Array.isArray(tracks) ? tracks : [];
    this.state.cdTracklist = list.map((t) => {
      const ms = Number(t && (t.durationMs !== undefined ? t.durationMs : t.ms));
      return isFinite(ms) && ms > 0 ? ms : 0;
    });
    // Durata media delle tracce con durata nota: serve come stima per le
    // tracce per cui MusicBrainz non pubblica la lunghezza.
    const known = this.state.cdTracklist.filter((d) => d > 0);
    this.state.cdAvgDuration = known.length
      ? Math.round(known.reduce((a, b) => a + b, 0) / known.length)
      : 0;
    this.state.cdElapsed = 0;
    this.cdLastTick = Date.now();
    this.emit('state', this.state);
    return this.state.cdTracklist;
  }
}

// ---------------------------------------------------------------------------
// Wake-on-LAN
// ---------------------------------------------------------------------------

async function wakeOnLan(mac, broadcast = null) {
  const cleaned = mac.replace(/[^0-9a-fA-F]/g, '');
  if (cleaned.length !== 12) throw new Error('Invalid MAC address');
  const bytes = cleaned.match(/../g).map((x) => parseInt(x, 16));
  const buf = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) buf[6 + i * 6 + j] = bytes[j];
  }
  const targets = broadcast
    ? [broadcast]
    : ['255.255.255.255', '192.168.100.255'];

  const sendTo = (target) => new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { s.close(); } catch (_) {}
      resolve(err ? { ok: false, target, error: err.code || err.message } : { ok: true, target });
    };
    s.once('error', finish);
    s.bind(() => {
      try { s.setBroadcast(true); } catch (e) { return finish(e); }
      s.send(buf, 9, target, (err) => finish(err));
    });
  });

  const results = await Promise.all(targets.map(sendTo));
  const good = results.find((r) => r.ok);
  if (good) return { ok: true, results };
  const err = new Error('WoL failed: ' + results.map((r) => r.target + ' ' + r.error).join('; '));
  err.results = results;
  throw err;
}

// ---------------------------------------------------------------------------
// Raw probe (for diagnostics)
// ---------------------------------------------------------------------------

function probeTcp(host, port = DEFAULT_PORT, timeout = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve({ ...result, host, port, ms: Date.now() - started });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, error: 'ETIMEDOUT' }));
    socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
    socket.connect(port, host);
  });
}

module.exports = {
  EiscpClient,
  buildPacket,
  extractMessage,
  probeTcp,
  wakeOnLan,
  INPUTS,
  DEFAULT_PORT,
  hex2,
  tonePart,
};
