#!/bin/bash
# Doppio clic dal Finder per fermare il controller e chiudere il server.
# Ferma il LaunchAgent avviato da "Avvia Pioneer.command" (launch.sh).
cd "$(dirname "$0")" || exit 1

echo "=============================================="
echo "  Pioneer HM86D Controller (eISCP)"
echo "=============================================="

./stop.sh

# Chiude anche l'interfaccia nel browser, se aperta
osascript -e 'tell application "Safari" to close (every tab of every window whose URL contains "localhost:3000")' >/dev/null 2>&1 || true
osascript -e 'tell application "Google Chrome" to close (every tab of every window whose URL contains "localhost:3000")' >/dev/null 2>&1 || true

echo ""
echo "Premi INVIO per chiudere questa finestra."
read -r _
