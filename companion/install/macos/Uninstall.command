#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != "Darwin" ]; then echo "Abra este desinstalador em um Mac."; exit 1; fi
APP_DIR="$HOME/Library/Application Support/GravaSimples"
CONFIG_PATH="$APP_DIR/pairing.json"
AGENT_PATH="$HOME/Library/LaunchAgents/com.gravasimples.companion.plist"
EXECUTABLE="$APP_DIR/gravasimples-companion"
if [ -f "$AGENT_PATH" ]; then /bin/launchctl bootout "gui/$(id -u)" "$AGENT_PATH" >/dev/null 2>&1 || true; fi
if [ -x "$EXECUTABLE" ]; then "$EXECUTABLE" --stop --config "$CONFIG_PATH" >/dev/null 2>&1 || true; fi
/bin/rm -f "$AGENT_PATH" "$EXECUTABLE" "$APP_DIR/Uninstall.command"
/bin/rm -rf "$APP_DIR/airplay"
for document in COPYING.txt THIRD-PARTY-NOTICES.txt LEIA-ME.txt; do /bin/rm -f "$APP_DIR/$document"; done
echo "O controle local e a inicializacao automatica foram removidos."
echo "Seus projetos e videos no navegador nao foram alterados."
if [ -f "$CONFIG_PATH" ] && [ -t 0 ]; then
  read -r -p "Excluir tambem o pareamento salvo? [s/N] " answer
  case "$answer" in s|S|sim|SIM) /bin/rm -f "$CONFIG_PATH" ;; esac
fi
/bin/rmdir "$APP_DIR" >/dev/null 2>&1 || true
if [ -t 0 ]; then read -r -p "Pressione Enter para fechar esta janela." unused; fi
