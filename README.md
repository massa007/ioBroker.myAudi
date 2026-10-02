# 🎯 Darts Turnierplaner

Webanwendung zum Planen und Organisieren von Darts-Turnieren im **Einzel** und **Doppel**, mit Anmeldung, Benutzerkonten und **Seasons**, in denen Spieler über mehrere Termine hinweg Punkte sammeln. Sie ist für den öffentlichen Betrieb ausgelegt.

Es werden keine npm-Abhängigkeiten benötigt, nur Node.js ≥ 18. Ohne Fremdpakete gibt es auch keine Lieferkettenrisiken.

```bash
npm start          # http://127.0.0.1:3000 – der Setup-Code steht im Log
npm test           # Turnier-Logik, API und Sicherheit testen
```

## Funktionen

- **Registrierung und Login**: Der erste Admin braucht einen **Setup-Code** aus dem Server-Log. Neue Accounts müssen standardmäßig vom Admin **freigeschaltet** werden. Die Registrierung lässt sich auch ganz schließen.
- **Seasons**: Zeitraum, aktive Season und eine frei einstellbare **Punktevergabe**. Es gibt eine Gesamt-, Einzel- und Doppelwertung mit 3D-Podium.
- **Termine**: Einzel oder Doppel, beliebige Teilnehmerzahl mit optionalem Maximum, Anzahl der Vorrundenspiele und einstellbares Best-of.
- **Anmeldung**: Spieler melden sich selbst an. Im Doppel geht das mit Partner oder als „Partner gesucht“. Der Admin kann übrige Einzelspieler zu Teams auslosen und **Gastspieler** ohne Account anlegen.
- **Live-Ergebnisse**: Der Admin oder die beteiligten Spieler tragen die Ergebnisse ein. Die Seite aktualisiert sich alle 15 Sekunden.
- **Design**: Dunkles Thema, 3D-Dartscheibe, die der Maus und dem Scrollen folgt, Scroll-Reveal-Animationen, 3D-Tilt-Karten, animierte Zähler und Ranglisten-Balken. Die Seite funktioniert auch auf dem Handy und berücksichtigt `prefers-reduced-motion`.

## Turniermodus

1. **Vorrunde**: Jeder Teilnehmer spielt 5 Spiele gegen zufällige Gegner. Wiederholte Begegnungen werden nach Möglichkeit vermieden. Bei ungerader Zahl gibt es Freilose, die als Sieg zählen. Die Tabelle sortiert nach Siegen, Leg-Differenz, gewonnenen Legs und zuletzt per Los.
2. **Cup-Einteilung** (bis zu 3 Cups): Das obere Drittel kommt in den **Pro Cup**, das mittlere in den **Advanced Cup**, das untere in den **Beginners Cup**.
3. **Cup**: Es gilt Doppel-K.o. Wer einmal verliert, kommt ins **Losers Bracket** und kann darüber noch das Halbfinale erreichen.
4. **Halbfinale und Finale** werden im einfachen K.o. gespielt (Winners gegen Losers über Kreuz).

### Punkte (Standard, je Season änderbar)

| | Sieger | Finalist | Halbfinale | sonstige |
|---|---|---|---|---|
| Pro Cup | 20 | 15 | 10 | 5 |
| Advanced Cup | 12 | 9 | 6 | 3 |
| Beginners Cup | 8 | 6 | 4 | 2 |

Dazu kommen 1 Punkt für die Teilnahme und 1 Punkt je Vorrunden-Sieg (ohne Freilose). Im Doppel erhalten beide Spieler die Punkte.

## Sicherheit

| Thema | Umsetzung |
|---|---|
| Übernahme einer frischen Installation | Erster Admin nur mit Einmal-Setup-Code aus dem Server-Log |
| Spam-Accounts | Freischaltung durch den Admin (Standard), Registrierung abschaltbar, max. 5 Registrierungen pro IP und Stunde |
| Passwörter | scrypt mit Salt, mindestens 8 Zeichen, Passwortwechsel beendet andere Sitzungen |
| Brute Force | max. 5 Fehlversuche pro Benutzer und IP sowie 30 pro IP in 15 Minuten, gleiche Antwortzeit auch bei unbekannten Benutzern |
| Sitzungen | 256-Bit-Zufallstoken, Cookie `HttpOnly`, `SameSite=Lax`, `Secure`; in der Datenbank liegt nur der SHA-256-Hash |
| CSRF | Schreibzugriffe nur als JSON und nur mit passendem `Origin` |
| XSS | Alle Inhalte werden escaped; strenge Content-Security-Policy ohne Inline-Skripte oder Inline-Styles, keine externen Quellen (Schriftarten liegen lokal) |
| Clickjacking und Co. | `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS unter HTTPS |
| Überlastung | Größenlimit für Anfragen (100 KB), Request-Timeouts, Drosselung von Schreibzugriffen |
| Daten | `db.json` ist nur für den Dienst-Benutzer lesbar (0600), atomare Schreibvorgänge |
| Betrieb | Die App lauscht nur auf `127.0.0.1`, HTTPS übernimmt Caddy, der systemd-Dienst läuft in einer Sandbox (nur das Datenverzeichnis ist beschreibbar) |

**Datenspeicher:** Alle Daten liegen in einer JSON-Datei. Für einen Verein oder eine Liga mit einigen hundert Spielern ist das unproblematisch und sehr einfach zu sichern. Für deutlich größere Installationen mit tausenden aktiven Nutzern wäre eine Datenbank wie SQLite oder PostgreSQL sinnvoll.

## Betrieb im Proxmox-LXC (Debian 12/13)

1. Lege einen **unprivilegierten** Container mit Debian an (1 CPU, 512 MB RAM, 4 GB Disk) und aktiviere unter *Optionen → Features* **Nesting**, das die systemd-Sandbox braucht.
2. Leite im Router die **Ports 80 und 443** auf den Container weiter. Die Domain bzw. DynDNS muss auf deine öffentliche IP zeigen.
3. Installiere im Container:
   ```bash
   apt update && apt install -y git
   git clone -b darts-turnier https://github.com/massa007/ioBroker.myAudi.git /root/darts
   bash /root/darts/deploy/install.sh darts.deine-domain.de
   ```
   Das Skript installiert Node.js, Caddy (automatisches HTTPS über Let's Encrypt) und automatische Sicherheitsupdates. Es richtet den Dienst ein und gibt den **Setup-Code** aus.
4. Öffne `https://darts.deine-domain.de/#/register` und lege mit dem Setup-Code den Admin-Account an.
5. Richte das tägliche Backup ein:
   ```bash
   echo '15 3 * * * root /opt/darts/app/deploy/backup.sh' > /etc/cron.d/darts-backup
   ```

**Update:** `cd /root/darts && git pull && bash deploy/install.sh darts.deine-domain.de`

**Logs:** `journalctl -u darts -f`

**Ohne Portfreigabe:** Statt Caddy kann ein Cloudflare Tunnel `http://127.0.0.1:3000` veröffentlichen. Setze dann im Dienst weiterhin `TRUST_PROXY=1`.

### Umgebungsvariablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind-Adresse. Nur auf `0.0.0.0` setzen, wenn der Proxy auf einem anderen Host läuft. Dann per Firewall sicherstellen, dass nur der Proxy den Port erreicht, sonst ließe sich mit `TRUST_PROXY` die Client-IP fälschen. |
| `PORT` | `3000` | Port |
| `DATA_FILE` | `data/db.json` | Datendatei |
| `TRUST_PROXY` | aus | `X-Forwarded-*` vom Reverse Proxy auswerten (Client-IP, HTTPS) |
| `COOKIE_SECURE` | aus | Cookies immer mit `Secure` setzen |
| `SETUP_CODE` | zufällig | Fester Setup-Code für den ersten Admin |

## Aufbau

```
server.js            HTTP-Server (node:http), Timeouts, Setup-Code
src/tournament.js    Turnier-Logik (Vorrunde, Cups, Doppel-K.o., Punkte)
src/app.js           REST-API, Rechte, Freischaltung
src/security.js      Rate-Limits, Security-Header, CSRF-/Origin-Prüfung
src/store.js         JSON-Speicher, Passwort-Hashing (scrypt)
public/              Oberfläche (Vanilla JS, ohne Build-Schritt)
deploy/              systemd-Dienst, Caddyfile, Install- und Backup-Skript
test/                node:test-Tests
```
