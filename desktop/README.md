# Pioneer Controller — app desktop standalone (macOS, Tauri + Rust)

**Questa cartella trasforma il controller Pioneer HM86D in una vera applicazione macOS.**
Non serve più il Terminale, non serve tenere una scheda del browser aperta e non serve
avere Node.js installato: il bundle `.app` contiene tutto.

- L'interfaccia è la stessa UI web del progetto (`public/index.html`).
- Il **binario Rust (Tauri)** è il guscio nativo dell'app e apre una **finestra dedicata**.
- Il **server Express** e un **runtime Node.js ufficiale** sono inclusi in
  `Pioneer Controller.app/Contents/Resources`.
- Si avvia con **doppio clic** (Finder, Dock, `/Applications`) e si chiude come qualsiasi
  altra app: alla chiusura il processo Node viene terminato, senza server orfani.

---

## Requisiti (solo per compilare)

- macOS su **Apple Silicon (arm64)** o Intel (x64)
- **Node.js + npm** (per il CLI Tauri)
- **Rust** (toolchain stabile):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  ```
- **Xcode Command Line Tools**: `xcode-select --install`

Non serve nessuno di questi requisiti per *usare* l'app compilata, solo per ricompilarla.

---

## Build in un comando

```bash
cd desktop
./scripts/build-app.sh
```

Lo script:

1. installa `@tauri-apps/cli` se manca;
2. prepara le risorse con `scripts/prepare-resources.sh`:
   - `server.js`, `eiscp.js`, `public/` e `node_modules` di produzione (express);
   - runtime Node.js ufficiale (scaricato in `desktop/.cache` e firmato ad-hoc);
3. compila il binario Rust e crea `.app` + `.dmg`.

Risultato:

```
desktop/src-tauri/target/release/bundle/macos/Pioneer Controller.app
desktop/src-tauri/target/release/bundle/dmg/Pioneer Controller_2.0.0_aarch64.dmg
```

Trascina **Pioneer Controller.app** in `/Applications` e avviala con doppio clic.

---

## Come funziona l'app

1. All'avvio sceglie una **porta libera su `127.0.0.1`** (niente conflitti con la 3000).
2. Avvia `server.js` con il runtime Node incluso nel bundle e `HTTP_BIND=127.0.0.1`
   (l'interfaccia **non** è esposta alla rete locale).
3. Attende che il server risponda (max 25 s) e apre la **finestra nativa** sulla UI.
4. Alla chiusura (`Cmd+Q` o chiusura finestra) termina il processo Node.
5. Al primo avvio macOS chiede il permesso **Rete locale** (dichiarato in `Info.plist`
   tramite `NSLocalNetworkUsageDescription`): va concesso, altrimenti il server non
   raggiunge il ricevitore.

Log del server:

```
~/Library/Logs/com.andrea.pioneer/server.log
```

---

## Cosa può fare l'app

Tutte le funzioni del controller web, incluse le più recenti:

- **Accensione da standby** col pulsante ⏻: se il ricevitore è offline viene inviato un
  magic packet **Wake-on-LAN** e la connessione viene forzata; se `PWR 01` non ha effetto
  entro 3 s l'app riprova con WOL. Serve **Network Standby / Wake on LAN** attivo sul
  ricevitore.
- **Connessione auto-riparante**: TCP keepalive, watchdog che chiude le socket "fantasma"
  dopo 25 s di silenzio (tipico quando il ricevitore va in standby profondo) e riconnessione
  automatica.
- **Cambio brano durante la riproduzione**: il ricevitore passa in modalità playback e
  rifiuta le selezioni; l'app invia prima `NTC LIST` e poi `NLA I<layer><index>----` con il
  layer corretto della lista, quindi il nuovo brano parte senza fermare l'audio.
- **Tracklist USB/NET** con cartelle, ricerca, selezione e caricamento automatico all'avvio.
- **CD player**: disco animato, contatore traccia virtuale, tracklist e testi da MusicBrainz.
- **Diagnostica integrata** con ping TCP, test gateway e **log eISCP live** (`→` inviati,
  `←` ricevuti).
- Volume, mute, bassi/acuti, filtro DAC, sleep, dimmer, copertine, testi.

---

## Variabili d'ambiente

| Variabile | Default | Descrizione |
|---|---|---|
| `PIONEER_DEVICE_HOST` | `192.168.100.6` | IP del ricevitore |
| `PIONEER_DEVICE_PORT` | `60128` | Porta eISCP |
| `PIONEER_DEVICE_MAC` | `00:09:B0:1F:A9:DF` | MAC per il Wake-on-LAN |
| `PIONEER_DEVICE_BROADCAST` | `<rete dispositivo>.255` | Broadcast per il magic packet |

Si possono impostare lanciando l'app da terminale, es.:

```bash
PIONEER_DEVICE_HOST=192.168.1.50 open -a "Pioneer Controller"
```

---

## Se qualcosa non funziona

| Sintomo | Cosa controllare |
|---|---|
| Badge `Offline · EHOSTUNREACH` | Permesso **Rete locale** dell'app in *Impostazioni di Sistema → Privacy e sicurezza → Rete locale*; IP corretto; ricevitore acceso o in Network Standby |
| ⏻ non accende da standby | Sul ricevitore abilita **Network Standby** e **Wake on LAN**; verifica `DEVICE_MAC` |
| Badge `Connesso` ma comandi ignorati | Il watchdog riconnette entro ~25 s; nel log eISCP verifica che i comandi ricevano risposta |
| Selezione brano mentre suona | Aggiorna all'ultima build: serve `NTC LIST` prima di `NLA I…` (vedi sopra) |
| Finestra bianca all'avvio | Controlla `~/Library/Logs/com.andrea.pioneer/server.log` |

---

## Sviluppo

```bash
cd desktop
npm install
npm run dev          # prepara le risorse e apre la finestra Tauri in dev
./scripts/build-app.sh
```

Note:

- La UI è servita dal server locale: modificare `public/index.html`, `server.js` o
  `eiscp.js` richiede una **nuova build** dell'app.
- `desktop/src-tauri/resources`, `.cache/` e `target/` sono generati e non vanno versionati.
- La build è **firmata ad-hoc**: sufficiente sul proprio Mac. Per distribuirla ad altri
  servono firma Developer ID e notarizzazione Apple.
- Per l'uso "web" resta valido `./launch.sh` dalla radice del progetto.
