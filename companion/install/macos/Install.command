#!/bin/bash
set -euo pipefail
umask 077

finish() {
  if [ -t 0 ]; then read -r -p "Pressione Enter para fechar esta janela." unused; fi
}
trap finish EXIT
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Este instalador precisa ser aberto em um Mac."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Library/Application Support/GravaSimples"
CONFIG_PATH="$APP_DIR/pairing.json"
LOG_DIR="$HOME/Library/Logs/GravaSimples"
AGENT_DIR="$HOME/Library/LaunchAgents"
AGENT_PATH="$AGENT_DIR/com.gravasimples.companion.plist"
AGENT_DOMAIN="gui/$(id -u)"
EXECUTABLE="$APP_DIR/gravasimples-companion"
AIRPLAY_DIR="$APP_DIR/airplay"
AIRPLAY_EXECUTABLE="$AIRPLAY_DIR/Popyachsa AirPlay.app/Contents/MacOS/popyachsa-airplay"
if [ ! -f "$SCRIPT_DIR/airplay/Popyachsa AirPlay.app/Contents/MacOS/popyachsa-airplay" ]; then
  AIRPLAY_EXECUTABLE="$AIRPLAY_DIR/uxplay"
fi
ARCH="$(uname -m)"
if [ "$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then ARCH="arm64"; fi
case "$ARCH" in
  arm64) PAYLOAD="$SCRIPT_DIR/binaries/gravasimples-companion-darwin-arm64" ;;
  x86_64) PAYLOAD="$SCRIPT_DIR/binaries/gravasimples-companion-darwin-amd64" ;;
  *) echo "Este Mac precisa de uma versao Apple Silicon ou Intel de 64 bits."; exit 1 ;;
esac
if [ ! -f "$PAYLOAD" ]; then
  echo "Extraia o ZIP completo antes de abrir Install.command."
  exit 1
fi

echo "Instalando o controle local do GravaSimples para este usuario..."
mkdir -p "$APP_DIR" "$LOG_DIR" "$AGENT_DIR"
if [ -f "$AGENT_PATH" ]; then /bin/launchctl bootout "$AGENT_DOMAIN" "$AGENT_PATH" >/dev/null 2>&1 || true; fi
if [ -x "$EXECUTABLE" ]; then "$EXECUTABLE" --stop --config "$CONFIG_PATH" >/dev/null 2>&1 || true; fi

# Replacing the program never replaces an existing pairing file.
/bin/cp "$PAYLOAD" "$EXECUTABLE.new"
/bin/chmod 755 "$EXECUTABLE.new"
/bin/mv -f "$EXECUTABLE.new" "$EXECUTABLE"
/bin/mkdir -p "$AIRPLAY_DIR"
if [ -d "$SCRIPT_DIR/airplay/Popyachsa AirPlay.app" ]; then
  /bin/cp -R "$SCRIPT_DIR/airplay/Popyachsa AirPlay.app" "$AIRPLAY_DIR/"
elif [ -f "$SCRIPT_DIR/airplay/uxplay" ]; then
  /bin/cp "$SCRIPT_DIR/airplay/uxplay" "$AIRPLAY_EXECUTABLE.new"
  /bin/chmod 755 "$AIRPLAY_EXECUTABLE.new"
  /bin/mv -f "$AIRPLAY_EXECUTABLE.new" "$AIRPLAY_EXECUTABLE"
fi
/bin/cp "$SCRIPT_DIR/Uninstall.command" "$APP_DIR/Uninstall.command"
/bin/chmod 755 "$APP_DIR/Uninstall.command"
for document in COPYING.txt THIRD-PARTY-NOTICES.txt LEIA-ME.txt; do
  if [ -f "$SCRIPT_DIR/$document" ]; then /bin/cp "$SCRIPT_DIR/$document" "$APP_DIR/$document"; fi
done

xml_escape() {
  local value="$1"
  value="${value//&/\&amp;}"
  value="${value//</\&lt;}"
  value="${value//>/\&gt;}"
  printf '%s' "$value"
}
cat > "$AGENT_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gravasimples.companion</string>
  <key>ProgramArguments</key><array>
    <string>$(xml_escape "$EXECUTABLE")</string>
    <string>--config</string><string>$(xml_escape "$CONFIG_PATH")</string>
    <string>--airplay-bin</string><string>$(xml_escape "$AIRPLAY_EXECUTABLE")</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG_DIR/companion.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG_DIR/companion.log")</string>
</dict></plist>
PLIST
/bin/chmod 600 "$AGENT_PATH"

if ! "$EXECUTABLE" --version; then
  echo "O macOS nao permitiu iniciar o aplicativo. Consulte LEIA-ME.txt e Privacidade e Seguranca."
  exit 1
fi
if ! /bin/launchctl bootstrap "$AGENT_DOMAIN" "$AGENT_PATH"; then
  echo "Nao foi possivel iniciar o controle. Consulte $LOG_DIR/companion.log."
  exit 1
fi
READY=0
for attempt in 1 2 3 4 5; do
  HEALTH="$(/usr/bin/curl --noproxy '*' -fsS --max-time 1 http://127.0.0.1:4455/health 2>/dev/null || true)"
  case "$HEALTH" in *'"name":"grava-simples-companion"'*) READY=1; break ;; esac
  /bin/sleep 1
done
if [ "$READY" != "1" ]; then
  echo "O controle nao iniciou. Confira se a porta 4455 esta livre e consulte $LOG_DIR/companion.log."
  exit 1
fi
echo "Instalacao concluida. O controle inicia automaticamente ao entrar neste usuario."
echo "Abra o estudio GravaSimples no Chrome e mantenha o celular na mesma rede Wi-Fi."
echo "Se o macOS solicitar acesso a rede local, permita para usar o OBS Blade."
echo "Para remover, abra Uninstall.command nesta pasta ou em $APP_DIR."
