'use strict';

const express = require('express');
const path = require('path');
const {
  EiscpClient,
  probeTcp,
  wakeOnLan,
  INPUTS,
  DEFAULT_PORT,
  hex2,
  tonePart,
} = require('./eiscp');

const HTTP_PORT = process.env.HTTP_PORT ? Number(process.env.HTTP_PORT) : 3000;
let deviceHost = process.env.DEVICE_HOST || '192.168.100.6';
let devicePort = process.env.DEVICE_PORT ? Number(process.env.DEVICE_PORT) : DEFAULT_PORT;

const client = new EiscpClient(deviceHost, devicePort);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Server-Sent Events: live state pushes
// ---------------------------------------------------------------------------

const sseClients = new Set();

function broadcast(event, data) {
  const payload = 'event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

client.on('status', (s) => broadcast('status', s));
client.on('state', (s) => broadcast('state', s));
client.on('log', (l) => broadcast('log', l));
  client.on('nla', (data) => broadcast('nla', data));

// ---------------------------------------------------------------------------
// Caricamento automatico della tracklist USB/NET
// ---------------------------------------------------------------------------
// Appena connesso il ricevitore invia spontaneamente solo le prime righe NLS
// della pagina corrente (tipicamente 4 voci) e NON la lista completa: quella
// si ottiene solo con NLA. Il caricamento non deve dipendere dal browser (che
// può aprirsi mentre il dispositivo è momentaneamente irraggiungibile),
// quindi lo orchestra il server, con retry finché la lista non è completa.
const LIST_INPUTS = ['2A', '2B', '2C'];
const LIST_RETRY_MS = 4000;
let listLoadTimer = null;
let listRequestPending = false;

function isListInput() {
  return LIST_INPUTS.includes(client.state.input);
}

function requestFullList(withListMode) {
  if (!client.connected) return false;
  if (listRequestPending) return false;
  listRequestPending = true;
  const ask = () => {
    if (!client.connected) {
      listRequestPending = false;
      return;
    }
    client.send('NLT', 'QSTN');
    client.send('NLA', buildNlaParam());
  };
  if (withListMode) {
    // Porta il dispositivo in modalità lista, poi chiede l'intera lista.
    client.send('NTC', 'LIST');
    setTimeout(ask, 500);
  } else {
    ask();
  }
  setTimeout(() => { listRequestPending = false; }, 1500);
  return true;
}

function scheduleFullList(delay, withListMode) {
  if (listLoadTimer) clearTimeout(listLoadTimer);
  listLoadTimer = setTimeout(() => requestFullList(withListMode), delay);
}

// Watchdog: finché la lista non è completa richiede NLA (senza NTC LIST, per
// non spostare il cursore del dispositivo durante la navigazione).
const listWatchdog = setInterval(() => {
  if (!client.connected || !isListInput() || client.state.listComplete) return;
  requestFullList(false);
}, LIST_RETRY_MS);
if (listWatchdog.unref) listWatchdog.unref();

let lastListInput = null;
client.on('state', (s) => {
  if (s.input !== lastListInput) {
    lastListInput = s.input;
    if (LIST_INPUTS.includes(s.input)) scheduleFullList(1000, true);
  }
});

// Ad ogni (ri)connessione il dispositivo riparte con le sole righe NLS:
// ricarica la lista completa se la sorgente attiva è USB/NET e la lista non
// è già completa (evita richieste inutili e il lampeggio delle icone).
client.on('status', (s) => {
  if (s.connected && isListInput() && !client.state.listComplete) {
    scheduleFullList(1200, true);
  }
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  res.write('event: status\ndata: ' + JSON.stringify(client.status()) + '\n\n');
  res.write('event: state\ndata: ' + JSON.stringify(client.state) + '\n\n');
  req.on('close', () => sseClients.delete(res));
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Catalogo delle sorgenti del Pioneer X-HM86D
// ---------------------------------------------------------------------------
// Raggruppa gli ingressi delle tre macro-categorie del dispositivo (locali,
// ingressi audio, rete/streaming) più il wireless. `server.js` lo invia al
// frontend in /api/state; i codici sono quelli eISCP (SLI). Se il dispositivo
// riporta una sorgente fuori catalogo, il frontend la mostra in "Altre".
const SOURCE_GROUPS = [
  {
    id: 'local',
    title: 'Sorgenti locali',
    hint: 'Lettori integrati',
    sources: [
      { code: '23', label: 'CD', action: 'input', desc: 'Lettore CD integrato: CD audio, CD-R/RW, MP3/WMA' },
      { code: '29', label: 'USB anteriore', action: 'input', desc: 'USB frontale: FAT16/FAT32, FLAC, WAV, ALAC, AIFF, DSD' },
      { code: '2A', label: 'USB posteriore', action: 'input', desc: 'USB posteriore: FAT16/FAT32, FLAC, WAV, ALAC, AIFF, DSD' },
      { code: '24', label: 'FM', action: 'input', desc: 'Radio FM analogica con RDS' },
      { code: '33', label: 'DAB/DAB+', action: 'input', desc: 'Radio digitale DAB/DAB+, senza fruscii' },
    ],
  },
  {
    id: 'wired',
    title: 'Ingressi audio',
    hint: 'Collegamenti via cavo',
    sources: [
      { code: '44', label: 'Ottico', action: 'input', desc: 'Ingresso ottico digitale: TV, console, lettore Blu-ray/DVD' },
      { code: '41', label: 'Linea', action: 'input', desc: 'Ingresso analogico RCA: cassette, giradischi, lettore MP3' },
    ],
    note: 'Questo modello non ha ingresso coassiale: usa l\'ottico per il segnale digitale.',
  },
  {
    id: 'network',
    title: 'Rete e streaming',
    hint: 'Connessione Internet',
    sources: [
      { code: '2B', label: 'NET', action: 'input', desc: 'Menu di rete: Spotify, TIDAL, Deezer, Amazon Music, AirPlay, Chromecast, FlareConnect, DTS Play-Fi, Music Server, TuneIn' },
    ],
    note: 'I servizi di rete (Spotify, TIDAL, Deezer, Amazon Music, TuneIn, AirPlay, Chromecast built-in, FlareConnect, DTS Play-Fi, Music Server) si selezionano dal menu NET del ricevitore o si avviano direttamente dall\'app: il Pioneer riproduce dalla rete.',
  },
  {
    id: 'wireless',
    title: 'Wireless e mobile',
    hint: 'Smartphone, tablet, computer',
    sources: [
      { code: '2E', label: 'Bluetooth', action: 'input', desc: 'Abbinamento universale con smartphone o PC' },
    ],
    note: 'AirPlay e Chromecast si avviano dal dispositivo Apple/Android: il Pioneer passa automaticamente in rete.',
  },
];

app.get('/api/state', (req, res) => {
  // Stato sempre fresco: senza no-store il browser può riusare una risposta
  // precedente (es. la pagina parziale inviata dal dispositivo all'avvio).
  res.set('Cache-Control', 'no-store');
  res.json({
    status: client.status(),
    state: client.state,
    inputs: INPUTS,
    sourceGroups: SOURCE_GROUPS,
  });
});

app.get('/api/log', (req, res) => {
  res.json(client.log.slice(-100));
});

// ---------------------------------------------------------------------------
// Album art: il ricevitore espone via eISCP (NJA) un URL all'immagine corrente.
// Il server la scarica e la serve al browser (evita problemi di permessi LAN,
// CORS e mixed-content nel browser).
// ---------------------------------------------------------------------------

let artCache = { key: null, buf: null, contentType: 'image/png' };
const artInflight = new Map();

async function fetchArt(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const contentType = r.headers.get('content-type') || 'image/png';
  return { buf, contentType };
}

app.get('/api/art', async (req, res) => {
  let url = client.state.albumArtUrl;
  // Fallback to known device art URL if not provided via NJA message
  if (!url || url.startsWith('data:')) {
    const fallbackUrl = client.state.host + '/album_art.cgi';
    if (!url) {
      url = fallbackUrl;
    }
  }

  const version = String(req.query.v || '');
  const key = url + '#' + version;

  if (artCache.key === key && artCache.buf) {
    res.set('Content-Type', artCache.contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(artCache.buf);
  }

  let pending = artInflight.get(key);
  if (!pending) {
    pending = fetchArt(url);
    artInflight.set(key, pending);
    pending.then(
      () => artInflight.delete(key),
      () => artInflight.delete(key)
    );
  }

  try {
    const { buf, contentType } = await pending;
    if (buf.length === 0) {
      return res.status(404).json({ error: 'album art non disponibile (vuoto)' });
    }
    artCache = { key, buf, contentType };
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'album art non disponibile: ' + e.message });
  }
});

// ---------------------------------------------------------------------------
// Testi canzone: proxy per superare i blocchi CORS del browser.
// Prova più fonti pubbliche e restituisce solo la PRIMA versione trovata.
// ---------------------------------------------------------------------------
async function fetchLyricsFromOvh(artist, title) {
  const url = 'https://api.lyrics.ovh/v1/' +
    encodeURIComponent(artist) + '/' + encodeURIComponent(title);
  const r = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'PioneerHM86DController/2.0' }
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.lyrics && j.lyrics.trim()) {
    return { text: j.lyrics, source: 'api.lyrics.ovh' };
  }
  return null;
}

async function fetchLyricsFromMakeItPersonal(artist, title) {
  const url = 'https://makeitpersonal.co/lyrics' +
    '?artist=' + encodeURIComponent(artist) +
    '&title=' + encodeURIComponent(title);
  const r = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'PioneerHM86DController/2.0' }
  });
  if (!r.ok) return null;
  const text = await r.text();
  if (text && text.trim() && !text.includes('No lyrics found')) {
    return { text: text.trim(), source: 'makeitpersonal.co' };
  }
  return null;
}

async function fetchLyricsFromSomeRandom(artist, title) {
  const url = 'https://some-random-api.ml/lyrics?' +
    'title=' + encodeURIComponent(artist + ' - ' + title);
  const r = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'PioneerHM86DController/2.0' }
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.lyrics && j.lyrics.trim()) {
    return { text: j.lyrics, source: 'some-random-api.ml' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// MusicBrainz: informazioni CD (Disc ID o artista + album)
// ---------------------------------------------------------------------------

const MB_BASE = 'https://musicbrainz.org/ws/2';

async function mbFetch(path, query = {}) {
  const url = MB_BASE + path + '?' + new URLSearchParams(query);
  const r = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': 'PioneerHM86DController/2.0 ( https://github.com/andrea/pioneer )'
    }
  });
  if (!r.ok) throw new Error('MusicBrainz HTTP ' + r.status);
  return r.json();
}

async function cdLookupByDiscId(discid) {
  return mbFetch('/discid/' + encodeURIComponent(discid), { inc: 'recordings+artist-credits', fmt: 'json' });
}

// Dettaglio di una release: la ricerca (/release/?query=...) restituisce
// "media" senza l'elenco delle tracce, che va richiesto con inc=recordings
// sul lookup della release specifica. Serve anche inc=artist-credits per
// avere il nome dell'artista.
async function cdReleaseById(id) {
  return mbFetch('/release/' + encodeURIComponent(id), { inc: 'recordings+artist-credits', fmt: 'json' });
}

async function cdSearchByArtistAlbum(artist, album) {
  const parts = [];
  if (artist) parts.push('artist:"' + artist + '"');
  if (album) parts.push('release:"' + album + '"');
  const q = parts.join(' AND ');
  // Costruisce l'URL a mano: spazi -> +, niente altro encoding per evitare
  // che MusicBrainz riceva %3A al posto di : o %22 al posto di "
  const encodedQ = q.replace(/\s+/g, '+').replace(/"/g, '%22');
  const url = MB_BASE + '/release/?query=' + encodedQ + '&fmt=json&limit=10';
  const r = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': 'PioneerHM86DController/2.0 ( https://github.com/andrea/pioneer )'
    }
  });
  if (!r.ok) throw new Error('MusicBrainz HTTP ' + r.status);
  return r.json();
}

app.get('/api/cd/lookup', async (req, res) => {
  const { discid } = req.query || {};
  if (!discid) {
    return res.status(400).json({ error: 'discid richiesto' });
  }
  try {
    const data = await cdLookupByDiscId(discid);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'MusicBrainz lookup fallito: ' + e.message });
  }
});

app.get('/api/cd/search', async (req, res) => {
  const { artist, album } = req.query || {};
  if (!artist && !album) {
    return res.status(400).json({ error: 'artista o album richiesti' });
  }

  // Costruisce una query MusicBrainz flessibile: artista e/o album,
  // entrambi opzionali, ricerca parziale (non esatta).
  try {
    const data = await cdSearchByArtistAlbum(artist, album);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'MusicBrainz search fallito: ' + e.message });
  }
});

// Dettaglio release con elenco tracce (necessario dopo la ricerca).
app.get('/api/cd/release', async (req, res) => {
  const { id } = req.query || {};
  if (!id) {
    return res.status(400).json({ error: 'id release richiesto' });
  }
  try {
    const data = await cdReleaseById(id);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'MusicBrainz release fallito: ' + e.message });
  }
});

// Allinea il contatore delle tracce CD con quello mostrato dal ricevitore.
// Necessario quando la skip viene data dal telecomando del dispositivo:
// l'HM86D non comunica il numero di traccia del CD via eISCP.
app.post('/api/cd/track', (req, res) => {
  const { delta, value } = req.body || {};
  if (value !== undefined && value !== null && value !== '') {
    client.cdSetTrack(value);
  } else {
    const d = parseInt(delta, 10) || 0;
    if (d !== 0) client.cdSkip(d);
    else client.cdEnsureTrack();
  }
  res.json({ ok: true, cdTrack: client.state.cdTrack });
});

// Tracklist CD con durate (da MusicBrainz): permette al controller di
// calcolare l'avanzamento automatico del contatore tracce, dato che il
// ricevitore non comunica né numero di traccia né tempo del CD.
app.post('/api/cd/tracklist', (req, res) => {
  const tracks = (req.body && req.body.tracks) || [];
  if (!Array.isArray(tracks)) {
    return res.status(400).json({ error: 'tracks deve essere un array' });
  }
  const list = client.setCdTracklist(tracks);
  res.json({ ok: true, tracks: list.length });
});

function cleanArtist(artist) {
  return String(artist || '')
    .replace(/\s*\(.*?fe[ae]t.*?\)/gi, '')
    .replace(/\s*[Ff]eat\..*/gi, '')
    .replace(/\s*[Ff]t\..*/gi, '')
    .replace(/\s*\(.*?con.*?\)/gi, '')
    .replace(/\s*\(.*?and.*?\)/gi, '')
    .replace(/\s*\(.*?vs\..*?\)/gi, '')
    .trim();
}

function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*\(.*?\)/g, '')
    .replace(/\s*\[.*?\]/g, '')
    .replace(/\s*-.*[Rr]emix.*/gi, '')
    .replace(/\s*-.*[Ll]ive.*/gi, '')
    .replace(/\s*-.*[Vv]ersion.*/gi, '')
    .replace(/\s*-.*[Rr]adio.*/gi, '')
    .replace(/\s*-.*[Ee]dit.*/gi, '')
    .replace(/\s*-.*[Mm]ix.*/gi, '')
    .trim();
}

function lyricVariants(artist, title) {
  const a = cleanArtist(artist) || artist;
  const t = cleanTitle(title) || title;
  const variants = [];
  if (a !== artist || t !== title) variants.push({ artist: a, title: t });
  if (a !== artist) variants.push({ artist: a, title });
  if (t !== title) variants.push({ artist, title: t });
  // evita duplicati
  const seen = new Set();
  return variants.filter((v) => {
    const key = v.artist + '||' + v.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

app.get('/api/lyrics', async (req, res) => {
  const artist = req.query.artist || '';
  const title = req.query.title || '';
  if (!artist || !title) {
    return res.status(400).json({ error: 'artist e title richiesti' });
  }

  const variants = [{ artist, title }, ...lyricVariants(artist, title)];
  const sources = [
    (a, t) => fetchLyricsFromOvh(a, t),
    (a, t) => fetchLyricsFromMakeItPersonal(a, t),
    (a, t) => fetchLyricsFromSomeRandom(a, t),
  ];

  for (const v of variants) {
    for (const makeSource of sources) {
      try {
        const r = await makeSource(v.artist, v.title);
        if (r) {
          return res.json(r);
        }
      } catch (_) {
        // prova la fonte successiva
      }
    }
  }
  res.status(404).json({ error: 'Testo non trovato', artist, title });
});

app.post('/api/host', async (req, res) => {
  const { host, port } = req.body || {};
  if (!host) return res.status(400).json({ error: 'host required' });
  deviceHost = host;
  devicePort = port ? Number(port) : DEFAULT_PORT;
  client.setHost(deviceHost, devicePort);
  res.json({ ok: true, host: deviceHost, port: devicePort });
});

app.get('/api/diag', async (req, res) => {
  const parts = String(deviceHost).split('.');
  const gatewayHost = parts.length === 4 ? parts.slice(0, 3).join('.') + '.1' : null;

  const tcp = await probeTcp(deviceHost, devicePort, 4000);
  const http = await probeTcp(deviceHost, 8080, 2000).catch(() => ({ ok: false }));
  const airplay = await probeTcp(deviceHost, 5000, 2000).catch(() => ({ ok: false }));
  const gateway = gatewayHost
    ? await probeTcp(gatewayHost, 80, 2500).catch(() => ({ ok: false }))
    : null;

  // Un processo avviato da launchd ha PPID 1: e' il modo corretto di eseguire
  // il server su macOS, perche' non eredita i limiti "Rete locale" dell'editor.
  const underLaunchd = process.ppid === 1;

  let analysis;
  if (tcp.ok) {
    analysis = {
      level: 'ok',
      message: 'Dispositivo raggiungibile: i comandi eISCP funzionano.' +
        (underLaunchd ? ' Server avviato correttamente tramite launchd.' : ''),
    };
  } else if (gateway && gateway.ok && !underLaunchd) {
    analysis = {
      level: 'permission',
      message:
        'Il gateway (' + gatewayHost + ') risponde ma il dispositivo no. Su macOS 15/26/27 ' +
        'l\'accesso alla "Rete locale" e\' bloccato per le app che ospitano il terminale ' +
        '(Cursor, VS Code, ecc.). Avvia il server con ./launch.sh (usa launchd) oppure ' +
        'concedi il permesso in Impostazioni di Sistema > Privacy e sicurezza > Rete locale.',
    };
  } else if (gateway && gateway.ok) {
    analysis = {
      level: 'unreachable',
      message:
        'Il gateway (' + gatewayHost + ') è raggiungibile ma il dispositivo no: ' +
        'controlla che il ricevitore sia acceso e che l\'IP ' + deviceHost + ' sia corretto.',
    };
  } else {
    analysis = {
      level: 'offline',
      message:
        'Né il dispositivo né il gateway rispondono: rete assente, Wi-Fi diversa o IP errato.',
    };
  }

  res.json({
    host: deviceHost,
    port: devicePort,
    gateway: gatewayHost,
    tcp60128: tcp,
    http8080: http,
    airplay5000: airplay,
    gatewayTest: gateway,
    serverContext: {
      pid: process.pid,
      ppid: process.ppid,
      underLaunchd,
    },
    analysis,
    clientStatus: client.status(),
    lastError: client.lastError,
  });
});

app.post('/api/wol', async (req, res) => {
  const mac = (req.body && req.body.mac) || '00:09:B0:1F:A9:DF';
  const broadcast = (req.body && req.body.broadcast) || null;
  try {
    const result = await wakeOnLan(mac, broadcast);
    res.json({ ok: true, mac, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message, results: e.results });
  }
});

// Costruisce il parametro NLA che chiede l'intera lista (0 → totale),
// invece di un numero fisso di tracce. Segue lo stesso schema del progetto
// mkulesh/onpc (XmlListInfoMsg.getListedData).
function buildNlaParam() {
  const layers = client.state.listNumberOfLayers || 4;
  const total = client.state.listNumberOfItems || 0xFFFF;
  const end = total.toString(16).toUpperCase().padStart(4, '0');
  const layerHex = layers.toString(16).toUpperCase().padStart(2, '0');
  return 'L0000' + layerHex + '0000' + end;
}

app.post('/api/list/refresh', (req, res) => {
  if (!client.connected) {
    return res.status(503).json({ error: 'Device not reachable' });
  }
  // Reset any previous snapshot so we build the USB list from scratch.
  client.state.listItems = [];
  client.state.listTotal = 0;
  client.state.listComplete = false;
  client.state.listNumberOfItems = 0;
  // NTC LIST per entrare in modalità lista + NLA per l'intera lista.
  // NLS non va inviato: restituisce solo le prime righe della pagina e può
  // sovrascrivere/azzerare la lista completa (vedi AGENTS §7).
  listRequestPending = false;
  requestFullList(true);
  res.json({ ok: true });
});

app.get('/api/list/snapshot', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    items: client.state.listItems || [],
    total: client.state.listTotal || 0,
    complete: client.state.listComplete === undefined ? false : client.state.listComplete,
    title: client.state.title || '',
    layers: client.state.listNumberOfLayers || 0,
  });
});

app.post('/api/list/select', (req, res) => {
  const { id } = req.body || {};
  if (!client.connected) {
    return res.status(503).json({ error: 'Device not reachable' });
  }
  const layers = client.state.listNumberOfLayers || 4;
  const itemId = parseInt(id, 10) || 0;
  const param = 'I' + layers.toString(16).padStart(2, '0').toUpperCase() + itemId.toString(16).padStart(4, '0').toUpperCase() + '----';
  // La lista sta per cambiare: consenti alle righe NLS di ricostruire la
  // nuova pagina, poi NLA la completa.
  client.state.listComplete = false;
  client.send('NLA', param);
  // Request updated list after selection
  setTimeout(() => {
    client.send('NLT', 'QSTN');
    client.send('NLA', buildNlaParam());
  }, 1000);
  res.json({ ok: true, param });
});

app.post('/api/list/back', (req, res) => {
  if (!client.connected) {
    return res.status(503).json({ error: 'Device not reachable' });
  }
  // Send NTC RETURN to go back
  client.state.listComplete = false;
  client.send('NTC', 'RETURN');
  setTimeout(() => {
    client.send('NLT', 'QSTN');
    client.send('NLA', buildNlaParam());
  }, 500);
  res.json({ ok: true });
});

app.post('/api/list/up', (req, res) => {
  if (!client.connected) {
    return res.status(503).json({ error: 'Device not reachable' });
  }
  client.send('NTC', 'UP');
  client.state.listComplete = false;
  setTimeout(() => {
    client.send('NLT', 'QSTN');
    client.send('NLA', buildNlaParam());
  }, 500);
  res.json({ ok: true });
});

app.post('/api/list/down', (req, res) => {
  if (!client.connected) {
    return res.status(503).json({ error: 'Device not reachable' });
  }
  client.send('NTC', 'DOWN');
  client.state.listComplete = false;
  setTimeout(() => {
    client.send('NLT', 'QSTN');
    client.send('NLA', buildNlaParam());
  }, 500);
  res.json({ ok: true });
});

app.post('/api/command', (req, res) => {
  const { action, value, player } = req.body || {};

  if (!client.connected) {
    return res.status(503).json({
      error: 'Device not reachable',
      detail: client.lastError || 'not connected',
      hint: 'Check that the receiver is powered on and reachable at ' +
        deviceHost + ':' + devicePort + '. Use the diagnostics panel.',
    });
  }

  let ok = false;

  switch (action) {
    case 'power':
      if (value === 'on') ok = client.send('PWR', '01');
      else if (value === 'off') ok = client.send('PWR', '00');
      else ok = client.send('PWR', client.state.power === 'on' ? '00' : '01');
      break;
    case 'volume':
      ok = client.send('MVL', hex2(Math.max(0, Math.min(100, Number(value)))));
      break;
    case 'volumeUp':
      ok = client.send('MVL', 'UP');
      break;
    case 'volumeDown':
      ok = client.send('MVL', 'DOWN');
      break;
    case 'mute':
      if (value === true || value === 'on') ok = client.send('AMT', '01');
      else if (value === false || value === 'off') ok = client.send('AMT', '00');
      else ok = client.send('AMT', 'TG');
      break;
    case 'input':
      ok = client.send('SLI', String(value));
      break;
    case 'play':
    case 'pause':
    case 'stop':
    case 'next':
    case 'prev': {
      const isCd = player === 'cd' || client.state.input === '23';
      if (isCd) {
        // Lettore CD integrato: comandi CCD. Le skip sono SKIP.F / SKIP.R
        // (non TRUP/TRDN, che valgono solo per il trasporto NET/USB).
        const mapCd = { play: 'PLAY', pause: 'PAUSE', stop: 'STOP', next: 'SKIP.F', prev: 'SKIP.R' };
        ok = client.send('CCD', mapCd[action]);
        if (ok) {
          if (action === 'play') {
            client.cdEnsureTrack();
            client.emit('state', client.state);
          } else if (action === 'next') {
            client.cdSkip(1);
          } else if (action === 'prev') {
            client.cdSkip(-1);
          }
          // Richiede subito lo stato del lettore: l'orologio virtuale deve
          // fermarsi (pausa/stop) o ripartire (play) senza attendere il
          // polling periodico.
          setTimeout(() => client.send('CST', 'QSTN'), 200);
        }
      } else {
        const mapNet = { play: 'PLAY', pause: 'PAUSE', stop: 'STOP', next: 'TRUP', prev: 'TRDN' };
        ok = client.send('NTC', mapNet[action]);
      }
      break;
    }
    case 'bass':
      ok = client.send('TFR', tonePart('B', Math.max(-10, Math.min(10, Number(value)))));
      if (ok) setTimeout(() => client.send('TFR', 'QSTN'), 250);
      break;
    case 'treble':
      ok = client.send('TFR', tonePart('T', Math.max(-10, Math.min(10, Number(value)))));
      if (ok) setTimeout(() => client.send('TFR', 'QSTN'), 250);
      break;
    case 'digitalFilter': {
      // Filtro digitale del DAC interno (DGF): 00 Slow, 01 Sharp, 02 Short.
      const v = String(value || '').toUpperCase();
      if (!['00', '01', '02'].includes(v)) {
        return res.status(400).json({ error: 'digitalFilter non valido (00/01/02)' });
      }
      ok = client.send('DGF', v);
      if (ok) setTimeout(() => client.send('DGF', 'QSTN'), 250);
      break;
    }
    case 'sleep': {
      if (value === 'off' || value === 0) ok = client.send('SLP', 'OFF');
      else ok = client.send('SLP', Number(value).toString(16).toUpperCase().padStart(2, '0'));
      break;
    }
    case 'dimmer':
      ok = client.send('DIM', String(value));
      break;
    case 'raw':
      if (req.body.code) ok = client.send(String(req.body.code), String(req.body.param || ''));
      break;
    default:
      return res.status(400).json({ error: 'Unknown action: ' + action });
  }

  if (!ok) return res.status(500).json({ error: 'Failed to send command' });
  res.json({ ok: true, action, state: client.state });
});

app.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  Pioneer HM86D Controller (eISCP)');
  console.log('==============================================');
  console.log('  Web UI   : http://localhost:' + HTTP_PORT);
  console.log('  Device   : ' + deviceHost + ':' + devicePort + ' (eISCP)');
  console.log('  Protocol : eISCP over TCP (Onkyo/Pioneer/Integra)');
  console.log('==============================================');
  client.connect();
});
