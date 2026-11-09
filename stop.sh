#!/bin/bash
#
# Ferma il controller Pioneer HM86D (LaunchAgent com.andrea.pioneer)
#
LABEL="com.andrea.pioneer"
UID_NUM="$(id -u)"

if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null
  echo "Controller fermato."
else
  echo "Il controller non era in esecuzione."
fi
