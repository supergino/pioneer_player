# ISTRUZIONI PER LLM / SVILUPPATORI AI — Repo `pioneer`

Questo file descrive come è strutturato il progetto, come funziona il codice e quali convenzioni seguire quando si modificano i file. Ogni LLM che opera su questo repository deve leggere questo documento prima di proporre o applicare cambiamenti.

---

## 1. Struttura del repository

```
pioneer/
├── AGENTS.md              # questo file
├── README.md              # documentazione utente
├── package.json           # dipendenze Node.js (express)
├── package-lock.json
├── server.js              # server Express + client eISCP + API REST
├── eiscp.js               # client TCP per protocollo eISCP (Pioneer/Onkyo HM86D)
├── public/
│   └── index.html         # interfaccia web monolitica (HTML + CSS + JS inline)
├── launch.sh              # avvia server in background
├── stop.sh                # ferma server
└── Avvia Pioneer.command  # scorciatoia macOS
```

Non ci sono cartelle `src/`, `dist/`, build step o framework frontend. Tutto gira su Node.js + Express con un unico file HTML servito come static.

---

## 2. Stack tecnologico

| Componente | Tecnologia | Note |
|---|---|---|
| Runtime | Node.js | versione LTS |
| Server web | Express 4 | `server.js` |
| Protocollo dispositivo | eISCP su TCP porta 60128 | `eiscp.js` |
| Comunicazione server→browser | Server-Sent Events (SSE) | `GET /api/events` |
| Frontend | HTML/CSS/JS puro in `public/index.html` | nessun framework, nessun bundler |
| Avvio | `launch.sh` / `stop.sh` | shell script |

---

## 3. Come funziona il sistema

### 3.1 Server (`server.js`)
- Crea un'istanza `EiscpClient` collegata al ricevitore Pioneer/Onkyo (IP default `192.168.100.6`, porta `60128`).
- Serve i file statici di `public/`.
- Espone API REST sotto `/api/*`.
- Spinge aggiornamenti in tempo reale al browser via SSE (`/api/events`): eventi `status`, `state`, `log`, `nla`.

### 3.2 Client eISCP (`eiscp.js`)
- Classe `EiscpClient extends EventEmitter`.
- Si connette via TCP al ricevitore, invia comandi `!1<CODICE><PARAM>\x1A` incapsulati in header ISCP.
- Riceve messaggi asincroni, li parse e aggiorna `this.state` (oggetto con tutti i campi: power, volume, input, title, artist, album, listItems, fileFormat, sampleFrequency, bitRate, digitalFilter, ecc.).
- Emette eventi: `status`, `state`, `log`, `nla`, `message`.
- Polling periodico ogni 10s: `PWR, MVL, AMT, SLI, TFR, DGF, NFI` + `CST, DST` in sorgente CD, oppure `NST, NTR` per le altre sorgenti.
- **Caricamento automatico della tracklist**: all'avvio (e ad ogni riconnessione, se la lista non è completa) `server.js` invia `NTC LIST` + `NLA` per ottenere l'intera lista USB/NET. Un watchdog ogni 4 s richiede `NLA` finché `state.listComplete` non è true. Il caricamento non dipende dal browser.
- `queryAll()` all'avvio chiede stato iniziale.
- In sorgente CD (`23`) il lettore integrato usa un set di comandi dedicato: `CST` (stato di riproduzione, 3 lettere), `DST` (disco inserito: `00` nessuno / `04` CD audio / `07` CD MP3), `CTM` (tempo, non supportato dall'HM86D), `CCD` (operazioni: `PLAY`, `STOP`, `PAUSE`, `SKIP.F`, `SKIP.R`).
- **L'HM86D non comunica il numero di traccia del CD**: in sorgente CD `NTR`, `NTM` e `CTM` restano muti. Il contatore (`state.cdTrack`) è quindi tenuto dal controller e aggiornato sui comandi `CCD SKIP.F` / `CCD SKIP.R` inviati dall'app (`cdSkip()`, `cdSetTrack()`, `cdEnsureTrack()`). Va riallineato a mano (pulsanti ±) se la skip viene data dal telecomando del dispositivo.
- **Orologio virtuale del CD** (`tickCdClock()`, timer 1 Hz in `startPolling()`): siccome il dispositivo non comunica né traccia né tempo del CD, il controller calcola l'avanzamento sommando il tempo effettivamente trascorso in riproduzione (stato `CST`) e consumando la durata delle tracce inviate dal browser (`state.cdTracklist`, ms; indice 0 = traccia 1). Quando il tempo trascorso raggiunge la durata della traccia corrente il contatore passa alla successiva e il tempo residuo viene riportato (`cdElapsed`).
  - Campi di stato: `cdTracklist` (durate in ms), `cdAvgDuration` (media delle durate note, usata come stima per le tracce senza durata), `cdElapsed` (secondi trascorsi nella traccia corrente).
  - Il delta temporale è limitato a 300 s per tick (anti-sospensione: se il Mac si sospende il contatore non sbalza) e il tempo attraversa più traguardi quando il blocco è sotto quel limite.
  - In sorgente CD lo stato viene richiesto più spesso: `cdPollTimer` ogni 2 s manda `CST QSTN` (oltre al polling generale da 10 s) e `server.js` fa una `CST QSTN` 200 ms dopo ogni comando di trasporto `CCD`. Così play/pausa/stop (anche dati dal telecomando) vengono recepiti entro ~2 s e l'orologio si ferma subito.
  - **Reset di `cdElapsed`**: skip avanti/indietro (`cdSkip`), allineamento manuale (`cdSetTrack`), nuova tracklist MusicBrainz (`setCdTracklist`), disco inserito/estratto (`DST`), stato `stop`/`end` (`CST`). In **pausa il tempo si congela** (non si azzera) e riprende dalla posizione esatta.
  - L'avanzamento è una **stima**: può discostarsi dal display del ricevitore se la release selezionata non corrisponde al disco fisico, se la skip è data col telecomando o se MusicBrainz non pubblica la durata. In quel caso si riallinea con i pulsanti ±.

### 3.3 Frontend (`public/index.html`)
- **Layout a 3 colonne**: tracklist + pannello Sistema (sinistra), now playing (centro), controlli (destra).
- Nella colonna destra il pannello **Riproduzione** (`.transport-panel`: precedente, play/pausa, successivo, stop + `#playState`) sta sopra il pannello **Volume**; su viewport ≤ 900px la colonna destra diventa una griglia a 2 colonne e il pannello Riproduzione occupa l'intera riga (`grid-column: 1 / -1`).
- **Pannello sinistro dinamico**: `syncListMode()` sceglie il contenuto in base a `state.input === '23'`. In USB/NET mostra `usbList` (se lo snapshot non è ancora arrivato usa `state.listItems`); in CD mostra le tracce di `currentCdInfo` con la traccia corrente evidenziata (`state.cdTrack`) e click che allinea il contatore (`POST /api/cd/track`). In CD i pulsanti ↑/↓/←/↻ sono nascosti. `renderTrackList()` delega a `renderCdTrackList()` quando la sorgente è CD, così gli eventi `nla` e gli snapshot USB non sovrascrivono la lista CD.
- **Pannello Sorgente**: le sorgenti sono raggruppate in quattro categorie (`SOURCE_GROUPS` in `server.js`, inviate in `/api/state`): *Sorgenti locali* (CD `23`, USB anteriore `29`, USB posteriore `2A`, FM `24`, DAB `33`), *Ingressi audio* (Ottico `44`, Linea `41` — il modello X-HM86D non ha ingresso coassiale), *Rete e streaming* (NET `2B`, che espone il menu dei servizi: Spotify, TIDAL, Deezer, Amazon Music, TuneIn, AirPlay, Chromecast built-in, FlareConnect, DTS Play-Fi, Music Server), *Wireless e mobile* (Bluetooth `2E`). I servizi di rete non sono ingressi `SLI` separati su questo modello e si selezionano dal menu NET o si avviano dall'app. `renderInputChips()` costruisce i gruppi (`.source-group`), evidenzia la sorgente attiva e aggiunge un gruppo "Altre sorgenti" se il dispositivo ne segnala una fuori catalogo. La pillola usa `sourceLabel()` e, in rete, mostra il servizio attivo (titolo). In `eiscp.js` le risposte `SLI N/A` (ingressi non disponibili su questo modello) vengono ignorate mantenendo la sorgente precedente.
- **Filtro DAC**: sotto le manopole Bass/Treble nel pannello **Toni** c'è il selettore `.dac-filter` (`#dacOptions`): tre pulsanti `.dac-option` (Slow `00`, Sharp `01`, Short `02`) e la descrizione `#dacFilterHint`. `renderState` evidenzia il valore di `st.digitalFilter`; il click invia `command('digitalFilter', v)` con aggiornamento ottimistico.
- JS inline sotto `<script>`.
- Si connette a `/api/events` via `EventSource` e reagisce agli eventi.
- Mantiene una snapshot locale `usbList` per la tracklist USB (vedi sezione 5).
- Barra di ricerca tracklist (`cerca artista`) filtra `usbList.items` in tempo reale su titolo e artista; il termine persiste anche cambiando cartella.
- Copertina album: se non c'è URL valido si mostra un placeholder grafico (disco vinile stilizzato + testo "Nessuna copertina"); quando cambia brano la cover viene ricaricata con cache-busting (`?t=timestamp`).
- In sorgente CD (`23`) la copertina del dispositivo viene sostituita da un **disco CD generico animato** (SVG inline + animazione CSS `spin`): gira quando il lettore è in play e si ferma in pausa/stop. La modalità è gestita dalla classe `cd-mode` su `#coverFrame` (più `cd-paused` per lo stato di pausa).
- Pannello "Info CD (MusicBrainz)" visibile solo con sorgente CD (codice `23`): permette di cercare per Disc ID, artista o titolo disco e selezionare una tracklist da MusicBrainz per consultazione.
- Contatore tracce CD: la pillola sorgente mostra `CD Audio · Traccia N` (N da `st.cdTrack`); il pannello CD ripete lo stesso numero con i pulsanti `−`/`+` (`/api/cd/track`) per riallinearlo al display del ricevitore. La traccia corrente è evidenziata nella tracklist MusicBrainz.
- **Avanzamento automatico del CD**: quando l'utente seleziona una release MusicBrainz, `applyCdRelease()` invia le durate delle tracce al server con `POST /api/cd/tracklist` (`durationMs` = campo `length` di MusicBrainz). Il controller le usa per avanzare da solo il contatore (vedi "Orologio virtuale del CD" in 3.2). Il pannello `cdDurationNote` avvisa se la release non ha durate (avanzamento non disponibile) o se sono parziali (stima).
- Icona play/pause sincronizzata con `st.playStatus` (per il CD lo stato arriva da `CST`).
- Pulsante "Testo" attivo anche in sorgente CD: artista e titolo della traccia corrente arrivano dalla tracklist MusicBrainz selezionata, quindi il testo del brano viene cercato normalmente.

---

## 4. Comandi eISCP principali (codici usati)

| Codice | Significato | Uso |
|---|---|---|
| `PWR` | Power | `01` on, `00` off, `QSTN` query |
| `MVL` | Volume | valore esadecimale `00`..`62`, `UP`, `DOWN`, `QSTN` |
| `AMT` | Mute | `01` on, `00` off, `TG` toggle |
| `SLI` | Input Selector | codice input es. `2A` USB rear, `23` CD |
| `NTC` | NET/USB Track Control | `LIST`, `UP`, `DOWN`, `RETURN` |
| `NLT` | List Title Info | `QSTN` query, restituisce totale tracce e layers |
| `NLS` | List Info (riga singola) | `QSTN` query, restituisce traccia per traccia |
| `NLA` | List Info XML / selezione | `L0000<layer>0000<end>` chiede lista completa; `I<layer><id>----` seleziona traccia/cartella |
| `NLU` | List Item Update | indice + totale |
| `NFI` | File Info | formato/frequenza/bitrate es. `FLAC/192000/24` |
| `TFR` | Tone (bass/treble) | `B±nT±n`, `QSTN` |
| `DGF` | Digital Filter (DAC) | `00` Slow, `01` Sharp (predefinito), `02` Short, `QSTN` query |
| `NST` | Play status | `S` stop, `P` play, `p` pause |
| `NTI/NAT/NAL/NTR/NTM` | Titolo/Artista/Album/Traccia/Tempo | query `QSTN` |
| `NSV` | Network Service | query |
| `NJA` | Album Art | `REQ` restituisce URL o immagine inline |
| `CST` | CD Play Status (sorgente CD) | `QSTN` → 3 lettere: play status + repeat + shuffle (es. `P--`) |
| `DST` | Current disc status notice (sorgente CD) | `QSTN` → `00` nessun disco, `04` CD audio, `07` CD MP3 |
| `CTM` | CD Time Info (sorgente CD) | `QSTN` → `mm:ss/mm:ss`; l'HM86D non risponde |
| `CCD` | CD Player Operation (sorgente CD) | `PLAY`, `STOP`, `PAUSE`, `SKIP.F` (avanti), `SKIP.R` (indietro); `TRUP`/`TRDN` NON valgono per il CD |

> Nota: in sorgente CD i comandi `NST`/`NTR`/`NTM` non ricevono risposta e `NTI`/`NAT`/`NAL` tornano vuoti: il ricevitore non espone i metadati del CD audio via eISCP. I titoli delle tracce CD arrivano quindi solo dal browser (MusicBrainz) e il numero di traccia è tenuto dal controller.

Formato parametro `NLA` per lista completa (seguendo lo schema del progetto `mkulesh/onpc`):
```
L0000<LL>0000<EEEE>
```
dove `<LL>` = numero di layer (2 cifre hex, default `04`) e `<EEEE>` = indice fine lista (4 cifre hex, default `FFFF` se sconosciuto).

---

## 5. Endpoint API

| Endpoint | Method | Descrizione |
|---|---|---|
| `/api/state` | GET | Stato corrente del client e del dispositivo; include `inputs` (codici `SLI`) e `sourceGroups` (catalogo sorgenti raggruppate per la UI) |
| `/api/events` | GET | SSE stream (`status`, `state`, `log`, `nla`) |
| `/api/log` | GET | Ultimi 100 log |
| `/api/art` | GET | Copertina album (proxy per evitare CORS/mixed-content) |
| `/api/host` | POST | Cambia IP/porta del dispositivo |
| `/api/diag` | GET | Diagnostica di rete (TCP ping, gateway, launchd) |
| `/api/wol` | POST | Wake-on-LAN |
| `/api/list/refresh` | POST | Ricarica lista USB/NET da zero |
| `/api/list/select` | POST `{id}` | Seleziona traccia o entra in cartella |
| `/api/list/back` | POST | Torna alla cartella padre (`NTC RETURN`) |
| `/api/list/up` | POST | Su nella lista (`NTC UP`) |
| `/api/list/down` | POST | Giù nella lista (`NTC DOWN`) |
| `/api/list/snapshot` | GET | Restituisce snapshot lista in memoria sul server |
| `/api/lyrics` | GET `?artist=…&title=…` | Proxy per testi canzone. Prova più fonti pubbliche (api.lyrics.ovh, makeitpersonal.co, some-random-api.ml) con varianti di artista/titolo (pulizia feat/remix/live, ecc.) e restituisce solo la PRIMA versione trovata |
| `/api/cd/lookup` | GET `?discid=…` | Cerca release MusicBrainz per Disc ID (`inc=recordings+artist-credits` per elenco tracce e artista) |
| `/api/cd/search` | GET `?artist=…&album=…` | Cerca release MusicBrainz per artista e/o titolo disco (ricerca parziale, entrambi opzionali, max 10 risultati) |
| `/api/cd/release` | GET `?id=…` | Dettaglio release MusicBrainz con l'elenco tracce e l'artista (`inc=recordings+artist-credits`): la ricerca restituisce `media` **senza** `tracks`, quindi va richiesto il dettaglio |
| `/api/cd/track` | POST `{delta}` o `{value}` | Allinea il contatore tracce CD (`state.cdTrack`); `delta` incrementa/decrementa, `value` imposta il numero assoluto |
| `/api/cd/tracklist` | POST `{tracks:[{index,durationMs}]}` | Invia dal browser le durate delle tracce CD (MusicBrainz `length` in ms) al controller: alimenta l'orologio virtuale che avanza il contatore (`state.cdTracklist`, `state.cdAvgDuration`) |
| `/api/command` | POST `{action, value}` | Comandi generici (power, volume, input, play, bass, treble, digitalFilter, sleep, dimmer, raw). `digitalFilter` accetta `00`/`01`/`02` e invia `DGF` |

---

## 6. Convenzioni di codice

### 6.1 JavaScript (`server.js`, `eiscp.js`)
- CommonJS (`require` / `module.exports`).
- `'use strict';` in testa.
- Nomi variabili in `camelCase`.
- Commenti in italiano (il progetto è in italiano).
- Non usare `var`; usare `const` / `let`.
- Gestione errori con `try/catch` intorno a operazioni di rete.
- I log di rete passano attraverso `client.logLine(dir, text)` e finiscono in `this.log` (max 200 entry).
- In `eiscp.js`, `extractMessage()` decodifica il corpo del messaggio eISCP come **UTF-8** (non Latin-1): i titoli/artista/album contengono caratteri Unicode (smart quote, accenti) e vanno preservati.

### 6.2 Frontend (`public/index.html`)
- Funzione helper `$ = id => document.getElementById(id)`.
- Stili inline nel `<style>`; poche classi CSS.
- Gli handler di click sui `track-item` devono distinguere `dataset.folder === "1"` (cartella) da traccia audio.
- Quando si invia `/api/list/select`, il server risponde e il dispositivo aggiorna la lista via SSE (`event: nla`).
- `renderTrackList(items, total, complete)` accetta un terzo parametro booleano `complete`. Se falso, mostra "Caricamento…"; se vero, renderizza tutto. In sorgente CD delega a `renderCdTrackList()`.
- I termini di ricerca sono separati: `searchTerm` per USB e `cdSearchTerm` per CD. `syncListMode()` rimette nell'input il termine della modalità attiva quando cambia la sorgente.
- Non sovrascrivere mai `usbList` con dati parziali se già completa (vedi sezione 7).
- Testi canzone: `fetchLyrics(artist, title)` prova le fonti in sequenza e restituisce solo la PRIMA versione trovata. Risultato cacheato in `lyricsCache` per chiave `"artista - titolo"`. `renderLyrics(st)` si chiama dentro `renderState` al cambio traccia. Il toggle UI è `$('lyricsToggle')` / `$('lyricsPanel')`.
- Artisti/titolo per i testi (e per il Now Playing) arrivano da `currentTrackInfo(st)`: per le sorgenti normali usa `st.artist`/`st.title`, per il CD audio usa i dati della tracklist MusicBrainz selezionata (`currentCdInfo`), perché il ricevitore non invia i metadata del CD.
- `applyCdRelease(rel)` è il punto in cui la release MusicBrainz diventa la tracklist attiva del CD: salva `currentCdInfo` (con `durationMs` = `length` della traccia), aggiorna il pannello (`renderSelectedCd()` + nota `cdDurationNote`), **invia le durate al server** (`POST /api/cd/tracklist`) e rilancia `renderLyrics(state)`. Se manca il pannello `cdDurationNote` non si blocca la selezione.

### 6.3 Stato condiviso
- `client.state` è l'unico stato "di verità" per il dispositivo.
- `usbList` nel frontend è la snapshot della tracklist USB.
- `renderState(st)` aggiorna UI (volume, knobs, titolo, artista, album, info file, tracklist).
- `renderStatus(s)` aggiorna badge connessione e abilitazione controlli.
- Campi di stato aggiunti per il CD: `cdTrack`, `cdTrackKnown`, `cdTracklist` (durate ms), `cdAvgDuration`, `cdElapsed` (secondi), `cdDisc`, `cdStatus`, `cdRepeat`, `cdShuffle`.

---

## 7. Problemi già risolti (non regressare)

Quando si modifica il codice, assicurarsi di non reintrodurre questi bug già fixati:

| Problema | Soluzione applicata | File |
|---|---|---|
| Tracklist USB carica solo 4 voci all'avvio | Il ricevitore, appena connesso, invia solo le prime righe `NLS` della pagina (es. 4 voci) e non la lista completa. Il server carica da solo la lista completa (`NTC LIST` + `NLA`) all'avvio, al cambio sorgente USB/NET e ad ogni riconnessione, con un watchdog ogni 4 s finché `listComplete` non è true; rimosso `NLS QSTN` dalle sequenze `NLA`. Le righe `NLS` non sovrascrivono più una lista completa (aggiornano solo l'indicatore di riproduzione). Il frontend mostra "Caricamento…" finché la lista non è completa (solo dopo 12 s mostra l'eventuale parziale) | `server.js` + `eiscp.js` + `public/index.html` |
| Lista pannello che sembra "in cache" | `/api/state` e `/api/list/snapshot` inviano `Cache-Control: no-store` | `server.js` |
| Tracklist mostra solo prime 19 tracce | `buildNlaParam()` chiede `0 → 0xFFFF` invece di `L00000400000013` fisso | `server.js` |
| Tornando indietro restano tracce vecchie | Nel `NLS`, se `lineNum === 0` e `listComplete` non è true si svuota `listItems` | `eiscp.js` |
| `NLA` non sostituisce lista più corta | `NLA` sostituisce sempre se `status="ok"` | `eiscp.js` |
| Tracklist bloccata su "Caricamento…" | Timeout 12s: dopo mostra comunque quanto raccolto | `public/index.html` |
| Knobs bass/treble bloccati | Rimosso `return` anticipato in `renderState` quando tracklist completa | `public/index.html` |
| Nessun info formato file/qualità | Aggiunto parsing `NFI` e visualizzazione `trackInfo` | `eiscp.js` + `public/index.html` |
| Valori bass/treble mostrano sempre 0 | Se `TFR` non risponde si mostra `--` e si invia `TFR QSTN` dopo 2s | `public/index.html` |
| Cover non si aggiorna al cambio traccia | Cache-busting con timestamp su `/api/art` quando cambia titolo/artista/album | `public/index.html` |
| Nessuna cover disponibile | Placeholder grafico (disco vinile stilizzato + testo "Nessuna copertina") | `public/index.html` |
| Copertina del dispositivo mostrata in sorgente CD | In sorgente CD `updateArt()` attiva `cd-mode` su `#coverFrame`: viene mostrato un disco CD generico animato (gira in play, si ferma in pausa) e la cover reale viene ignorata | `public/index.html` |
| Ricerca brano in tracklist USB | Barra "cerca artista" filtra titolo e artista; il termine persiste cambiando cartella | `public/index.html` |
| Info titoli CD mancanti | Nuovo pannello "Info CD (MusicBrainz)" per sorgente CD: ricerca per Disc ID, artista o titolo disco, seleziona tracklist da consultare | `server.js` + `public/index.html` |
| Titoli delle tracce CD non compaiono dopo la ricerca | La risposta di `/release/?query=` contiene `media` **senza** l'array `tracks`: alla selezione si richiede il dettaglio della release (`/api/cd/release?id=…`, `inc=recordings+artist-credits`) | `server.js` + `public/index.html` |
| Numero traccia CD non visualizzato | In sorgente CD il dispositivo non risponde a `NTR`/`CTM`: si usa `CST` (stato) + `DST` (disco) e il contatore tracce è tenuto dal controller (`cdTrack`), con pulsanti ± per riallinearlo | `eiscp.js` + `server.js` + `public/index.html` |
| Tasti avanti/indietro traccia CD non funzionano | Comandi trasporto CD: `CCD SKIP.F` / `CCD SKIP.R` (non `TRUP`/`TRDN`); NET/USB restano `NTC TRUP`/`NTC TRDN` | `server.js` |
| Pannello play non risponde | Icona play/pause aggiornata ottimisticamente al click e poi allineata a `st.playStatus` (per il CD arriva da `CST`) | `public/index.html` |
| Testo del brano non disponibile per il CD | Il CD audio non ha metadata dal dispositivo: `currentTrackInfo(st)` ricava artista/titolo dalla tracklist MusicBrainz e il pulsante "Testo" cerca il brano normalmente | `public/index.html` |
| Stato di riproduzione CD assente | `CST` mappa lo stato del lettore CD su `playStatus` quando la sorgente è `23` | `eiscp.js` |
| Il titolo del CD non cambia da solo durante la riproduzione | Il dispositivo non invia la traccia del CD: l'app invia le durate MusicBrainz (`POST /api/cd/tracklist`) e il controller le consuma con un orologio virtuale (`tickCdClock()`) basato sul tempo effettivamente trascorso in play (`CST`), così il contatore e il titolo avanzano da soli | `eiscp.js` + `server.js` + `public/index.html` |
| Il contatore CD si "consuma" dopo un blocco del server | Il tempo attraversa più traguardi in un solo tick (loop in `tickCdClock()`), ma il delta è limitato a 300 s per non sballare dopo una sospensione del Mac | `eiscp.js` |
| La pausa del CD impiega 10 s per essere rilevata | In sorgente CD `cdPollTimer` interroga `CST` ogni 2 s e `server.js` forza `CST QSTN` 200 ms dopo ogni comando `CCD`: l'orologio virtuale si ferma/riparte entro ~2 s | `eiscp.js` + `server.js` |
| Release MusicBrainz senza durate (campo `length` a 0) | Le tracce senza durata usano `cdAvgDuration` (media delle durate note) come stima; se nessuna traccia ha durata l'avanzamento automatico non è disponibile e il pannello CD lo segnala (`cdDurationNote`) | `eiscp.js` + `public/index.html` |
| La tracklist a sinistra resta sempre quella USB | `syncListMode()` cambia intestazione e contenuto in base alla sorgente: in CD mostra `currentCdInfo`, tornando su USB ripristina `usbList` (o `state.listItems`); gli eventi `nla` non sovrascrivono la lista CD | `public/index.html` |
| Caratteri accentati/smart quote mostrati male (es. `â`) | Il corpo del messaggio eISCP veniva decodificato come Latin-1; cambiato in UTF-8 in `extractMessage()` (`eiscp.js`) | `eiscp.js` |
| Pannello Sistema in basso a destra | Spostato sotto il pannello tracklist nella colonna sinistra (`.left-col`: flex column) | `public/index.html` |
| Filtro DAC non gestito dall'app | Aggiunto il comando `DGF` (`00` Slow, `01` Sharp, `02` Short): parsing in `eiscp.js`, azione `digitalFilter` in `/api/command` e selettore nel pannello Toni | `eiscp.js` + `server.js` + `public/index.html` |

---

## 8. Checklist prima di modificare

Prima di proporre o applicare una modifica, verificare:

1. `node --check eiscp.js` e `node --check server.js` passano senza errori.
2. Se si tocca `eiscp.js`, verificare che il nuovo case di parsifica non rompa gli switch esistenti (`handleMessage`).
3. Se si tocca `server.js`, verificare che gli endpoint lista usino `buildNlaParam()` invece di stringhe hardcode `L00000400000013`.
4. Se si tocca `public/index.html`, verificare che `renderState` non contenga `return` anticipati che saltino l'aggiornamento di knobs/volume.
5. Se si aggiunge un nuovo comando eISCP, aggiungerlo a `queryAll()` e/o `startPolling()` in `eiscp.js` se serve polling periodico.
6. Se si tocca `public/index.html` per la ricerca tracklist, verificare che `searchTerm` non venga resettato quando si cambia cartella.
7. Se si tocca `server.js` per `/api/cd/*`, verificare che l'endpoint Express usi `cdSearchByArtistAlbum()` (non codice inline con `encodeURIComponent`) e che MusicBrainz riceva `:` e `"` non encodificati (`%3A` e `%22` rompono la query syntax). Attenzione: la risposta della *ricerca* non contiene l'array `tracks` ( serve `inc=recordings` sul dettaglio release).
8. Testare manualmente: `./stop.sh && ./launch.sh`, aprire browser, selezionare USB, premere ↻, navigare cartelle, girare knobs, cambiare traccia e verificare che `trackInfo` si aggiorni.
9. Testare CD: selezionare sorgente CD, cercare su MusicBrainz, selezionare una release e verificare che la tracklist appaia nel pannello dedicato.
10. Testare CD (lettore integrato): verificare in `/api/state` che `cdDisc` sia `audio` con un disco inserito, che `cdStatus`/`playStatus` cambino con play/pausa/stop, che `cdTrack` si incrementi con la skip avanti e si decrementi con la skip indietro, e che la pillola sorgente mostri `CD Audio · Traccia N`. Se la skip è stata data dal telecomando del ricevitore, riallineare il contatore con i pulsanti ±.
11. Testare l'avanzamento automatico del CD: selezionare una release MusicBrainz **con durate** (campo `length` valorizzato), verificare in `/api/state` che `cdTracklist` contenga le durate in ms e che `cdElapsed` cresca durante il play e resti fermo in pausa. Il contatore deve passare alla traccia successiva quando il tempo raggiunge la durata.
12. Testare il filtro DAC: verificare in `/api/state` che `digitalFilter` sia `00`/`01`/`02`, che il pulsante corrispondente sia attivo nel pannello Toni e che un click invii `DGF`. Per non modificare l'impostazione del ricevitore, provare con il valore già attivo.

---

## 9. Come testare le modifiche

```bash
# Fermare eventuale istanza in esecuzione
./stop.sh

# Avviare il server
./launch.sh

# Aprire nel browser
open http://localhost:3000

# Oppure specificare IP dispositivo diverso
DEVICE_HOST=192.168.1.50 ./launch.sh
```

Cosa verificare dopo ogni cambio:
- [ ] Server parte senza errori nella console.
- [ ] Badge connessione diventa "Connesso".
- [ ] USB tracklist carica completamente (non solo prime 19 tracce).
- [ ] Click su cartella 📁 entra nella sottocartella.
- [ ] Click su traccia 🎵 avvia riproduzione.
- [ ] Pulsante ← Indietro torna alla cartella padre.
- [ ] Knobs Bass/Treble si muovono e cambiano valore nel dispositivo.
- [ ] Durante riproduzione appare `trackInfo` con formato es. `FLAC · 192 kHz · 24 bit`.

---

## 10. Variabili d'ambiente

| Variabile | Default | Descrizione |
|---|---|---|
| `HTTP_PORT` | `3000` | Porta del server web |
| `DEVICE_HOST` | `192.168.100.6` | IP del ricevitore Pioneer |
| `DEVICE_PORT` | `60128` | Porta eISCP |

---

## 11. Riferimenti esterni utili

Protocollo eISCP / ISCP: documentazione Pioneer/Onkyo (porte TCP 60128).

### 11.1 Progetti open source di riferimento

Da consultare **prima** di aggiungere un nuovo comando o una nuova funzione: contengono il
database comandi e implementazioni complete dello stesso protocollo.

| Repo | Linguaggio | Utilità |
|---|---|---|
| [`mkulesh/onpc`](https://github.com/mkulesh/onpc) | Java / Android | Implementazione matura e completa (Enhanced Music Controller). Fonte principale per capire come il ricevitore risponde ai comandi e come gestire le liste. |
| [`miracle2k/onkyo-eiscp`](https://github.com/miracle2k/onkyo-eiscp) | Python | Database comandi più completo: una scheda YAML per comando in `eiscp/commands/main/*.yaml` e `eiscp/commands/dock/*.yaml` (nome, parametri, valori, descrizione). Il file `eiscp/core.py` mostra codifica/decodifica dei pacchetti e gestione delle risposte asincrone. |
| [`tillbaks/node-eiscp`](https://github.com/tillbaks/node-eiscp) | JavaScript / Node | Implementazione Node.js dello stesso protocollo. `eiscp-commands.json` è lo stesso database comandi in JSON, comodo da confrontare con il nostro parser; `eiscp.js` è il client TCP minimale. |
| [`owagner/onkyo2mqtt`](https://github.com/owagner/onkyo2mqtt) | Python | Bridge eISCP → MQTT: esempio di discovery, riconnessione automatica e gestione degli eventi asincroni. |
| [`cljk/jEISCP`](https://github.com/cljk/jEISCP) | Java | Remote JavaFX con console ISCP: utile per inviare comandi raw e osservare le risposte reali del dispositivo durante il debug. |
| [`crowbarz/aiopioneer`](https://github.com/crowbarz/aiopioneer) | Python (asyncio) | Libreria completa per l'**API Pioneer** (famiglia pre-2016, la stessa dell'HM86D): decodifica di tutti i messaggi in `aiopioneer/decoders/{amp,audio,dsp,system,tuner,video}.py` e `aiopioneer/decoders/code_map.py`, più registry delle proprietà e feature detection per modello. |
| [`crowbarz/ha-pioneer_async`](https://github.com/crowbarz/ha-pioneer_async) | Python | Integrazione Home Assistant basata su `aiopioneer`: mostra come esporre in UI zone, input, tuner, listening mode, toni, livelli canali e parametri amp/DSP/video. Utile come elenco di funzioni già modellate. |
| [`okeck1982/ioBroker.pioneer_sc_vsx`](https://github.com/okeck1982/ioBroker.pioneer_sc_vsx) | JavaScript | Adapter ioBroker per Pioneer SC/VSX pre-2016. `lib/PioneerPropertyDefinition.js` e `lib/PioneerTypes.js` mappano proprietà → comandi e sono un buon confronto per gli stati lato Node. |
| [`domblb/avrpi`](https://github.com/domblb/avrpi) | JavaScript / Node | Remote completo (web + Android) per VSX/SC: `lib/protocol.js` e `catalog-raw.json` contengono un catalogo comandi molto ampio, `lib/discovery.js` fa discovery SSDP, `lib/fake-device.js` + `lib/fake-eiscp.js` simulano un ricevitore. |
| [`HerrRiebmann/eISCP-Interface`](https://github.com/HerrRiebmann/eISCP-Interface) | C++ (ESP32) | Controller ESP32 con OLED: `Outgoing.ino` / `Incoming.ino` mostrano costruzione e parsing dei pacchetti raw, `Udp.ino` la discovery UDP. Riferimento minimale sul protocollo. |

### 11.2 File utili in `mkulesh/onpc`

Percorso base: `app/src/main/java/com/mkulesh/onpc/`

- `iscp/messages/FileFormatMsg.java` → parsing `NFI` (formato file, frequenza, bitrate)
- `iscp/messages/XmlListInfoMsg.java` → parsing XML lista completa `NLA` (offset, totalitems, item)
- `iscp/messages/ListTitleInfoMsg.java` → parsing `NLT` (numero tracce, layers, cursor)
- `iscp/messages/ListItemInfoMsg.java` → parsing `NLU` (indice + totale)
- `iscp/messages/CdPlayerOperationCommandMsg.java` → comandi `CCD` del lettore CD
- `iscp/messages/DimmerLevelMsg.java` / `SleepMsg.java` → comandi `DIM` e `SLP`
- `iscp/StateManager.java` → schema completo di richieste iniziali e gestione liste (`requestXmlListState`, `getListedData`)

### 11.3 Idee di funzioni da aggiungere (già mappate nei repo)

Usare il database comandi (`commands/main/*.yaml` di onkyo-eiscp o `eiscp-commands.json`
di node-eiscp) per verificare codice e parametri prima di implementare. Candidati sensati
per questa UI:

- **Listening mode** `LMD`: mostra/cambia la modalità di ascolto (Direct, Stereo, All Ch Stereo…).
- **Zone 2 / Zone 3** (`ZPW`, `ZMT`, `ZVL`): seconda zona volume/power/input.
- **Auto power / sleep** (`APD`, `SLP`): spegnimento automatico e timer.
- **Dimmer / display** (`DIM`, `DIF`): luminosità e informazioni display.
- **Late Night / Dynamic EQ / Cinema Filter** (`LTN`, `ADY`, `CFS`): opzioni audio.
- **Tuner** (`TUN`, `TUN`/`PRS`): radio AM/FM, preset e frequenza.
- **HDMI CEC / ARC** (`CEC`, `ARC`): stato e attivazione.
- **Media server / network service** (`NSV`, `NLS`): elenco servizi di rete (Spotify, TuneIn…).
- **Firmware / device info** (`FWV`, `IFN`, `DVC`): versione firmware, nome device, modello.

### 11.4 Spunti concreti per questo progetto

- **Discovery automatica** (`avrpi/lib/discovery.js`, `eISCP-Interface/Udp.ino`): SSDP/UDP per
  trovare il ricevitore e non dover impostare l'IP a mano (`DEVICE_HOST`).
- **Feature detection per modello** (`aiopioneer`, `avrpi/test/models.test.js`): abilitare o
  nascondere i controlli in base a cosa risponde davvero il dispositivo.
- **Test senza hardware** (`avrpi/lib/fake-device.js`, `avrpi/lib/fake-eiscp.js`): simulatore
  eISCP per testare parser e UI in locale o in CI.
- **Zone 2/3 e tuner** (`ha-pioneer_async/custom_components/pioneer_async/{media_player,select,number}.py`):
  esempi già pronti di entità e comandi.
- **Catalogo comandi esteso** (`avrpi/catalog-raw.json`, `aiopioneer/decoders/code_map.py`):
  nomi e valori per listening mode, DSP, video e tuner.

### 11.5 Come usarli senza aggiungerli al repo

Non serve clonarli dentro `pioneer/`: si possono consultare online oppure clonare in una
cartella esterna (es. `~/Documents/GitHub/onpc`, `~/Documents/GitHub/onkyo-eiscp`) e leggere
i file indicati. Se si clonano nel repo, aggiungerli a `.gitignore` per non versionarli.

Per le istruzioni utente vedi `README.md`.

---

Firma del documento: questo file deve essere aggiornato ogni volta che si introduce una nuova funzionalità o si modifica il flusso dati tra server, client eISCP e frontend.