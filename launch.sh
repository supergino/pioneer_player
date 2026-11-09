#!/bin/bash
#
# Pioneer HM86D Controller - avvio rapido
#
# IMPORTANTE (macOS 15+ / 27):
#   Se il server viene avviato da Cursor / VS Code / un terminale dell'IDE,
#   macOS puo' bloccare l'accesso alla "Rete locale" di quell'app e le
#   connessioni al Pioneer falliscono con EHOSTUNREACH.
#   Per questo lo script avvia il server tramite launchd (LaunchAgent):
#   il processo non dipende dall'app che ospita il terminale e la rete
#   locale funziona sempre.
#
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.andrea.pioneer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

DEVICE_HOST="${DEVICE_HOST:-192.168.100.6}"
DEVICE_PORT="${DEVICE_PORT:-60128}"
HTTP_PORT="${HTTP_PORT:-3000}"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERRORE: Node.js non trovato."
  echo "Installa Node.js (es. 'brew install node') e riprova."
  exit 1
fi

if [ ! -f "$DIR/server.js" ]; then
  echo "ERRORE: server.js non trovato in $DIR"
  exit 1
fi

# Installa le dipendenze al primo avvio
if [ ! -d "$DIR/node_modules" ]; then
  echo "Installazione dipendenze..."
  ( cd "$DIR" && npm install ) || exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

echo "=============================================="
echo "  Pioneer HM86D Controller (eISCP)"
echo "=============================================="
echo "  Dispositivo : $DEVICE_HOST:$DEVICE_PORT"
echo "  Interfaccia : http://localhost:$HTTP_PORT"
echo "  Avvio       : launchd ($LABEL)"
echo "=============================================="

# (Ri)scrive il LaunchAgent con i percorsi correnti
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIR/server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$DIR</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>DEVICE_HOST</key>
    <string>$DEVICE_HOST</string>
    <key>DEVICE_PORT</key>
    <string>$DEVICE_PORT</string>
    <key>HTTP_PORT</key>
    <string>$HTTP_PORT</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/pioneer-controller.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/pioneer-controller.err.log</string>
</dict>
</plist>
PLIST_EOF

# Ricarica il servizio (se era gia' attivo lo riavvia con la nuova config)
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
sleep 0.5

if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/tmp/pioneer-bootstrap.err; then
  echo "ERRORE nell'avvio del servizio:"
  cat /tmp/pioneer-bootstrap.err
  exit 1
fi

# Attende che il server risponda
READY=0
for _ in $(seq 1 60); do
  if curl -sf -m 1 "http://localhost:$HTTP_PORT/api/state" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.25
done

if [ "$READY" -ne 1 ]; then
  echo "Il server non risponde su http://localhost:$HTTP_PORT"
  echo "Controlla i log: /tmp/pioneer-controller.err.log"
  exit 1
fi

# Mostra lo stato della connessione al ricevitore
echo ""
curl -s -m 3 "http://localhost:$HTTP_PORT/api/state" | node -e '
let d="";
process.stdin.on("data",c=>d+=c).on("end",()=>{
  try {
    const j=JSON.parse(d), s=j.state, st=j.status;
    console.log(st.connected
      ? "  Stato: CONNESSO al ricevitore"
      : "  Stato: NON raggiungibile ("+(st.lastError||"errore")+")");
    if (st.connected) {
      console.log("  Power : "+(s.power||"?")+
        " | Volume: "+(s.volume!=null?s.volume:"?")+
        " | Input: "+(s.inputName||"?"));
    }
  } catch(e) {}
});
' 2>/dev/null || true

echo ""
open "http://localhost:$HTTP_PORT"
echo "Interfaccia aperta nel browser."
