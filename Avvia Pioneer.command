#!/bin/bash
# Doppio clic dal Finder per avviare il controller.
# Il server viene eseguito tramite launchd, quindi funziona anche se
# Terminale non ha il permesso "Rete locale".
cd "$(dirname "$0")" || exit 1
./launch.sh
