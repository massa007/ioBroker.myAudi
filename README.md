# 🎯 Darts Turnierplaner

Webanwendung zum Planen und Organisieren von Darts-Turnieren im **Einzel** und **Doppel**, mit Anmeldung, Benutzerkonten und **Seasons**, in denen Spieler über mehrere Termine hinweg Punkte sammeln.

Es werden keine externen Abhängigkeiten benötigt, nur Node.js ≥ 18.

```bash
npm start          # startet auf http://localhost:3000
npm test           # Turnier-Logik und API testen
```

Umgebungsvariablen: `PORT` (Standard `3000`) und `DATA_FILE` (Standard `data/db.json`). Alle Daten liegen in dieser einen JSON-Datei, für ein Backup genügt eine Kopie davon.

## Funktionen

- **Registrierung und Login**: Wer sich als Erstes registriert, wird automatisch **Administrator**. Admins können weitere Admins ernennen und **Gastspieler** ohne Account anlegen.
- **Seasons**: Zeitraum, aktive Season und eine frei einstellbare **Punktevergabe**. Die Season-Tabelle zeigt eine Gesamt-, Einzel- und Doppelwertung, Titel, Finals, Vorrunden-Siege und die Punkte je Termin.
- **Termine**: Einzel oder Doppel, beliebige Teilnehmerzahl mit optionalem Maximum, Anzahl der Vorrundenspiele (Standard 5) und einstellbares Best-of für Vorrunde, Cup und Finale.
- **Anmeldung**: Spieler melden sich selbst an. Im Doppel geht das mit Partner oder als „Partner gesucht“. Andere können einem Spieler ohne Partner beitreten. Der Admin kann übrige Einzelspieler per Knopfdruck zu Teams auslosen.
- **Ergebnisse** tragen der Admin oder die beteiligten Spieler selbst ein. Die Seite aktualisiert sich während des Turniers alle 15 Sekunden.

## Turniermodus

1. **Vorrunde**: Jeder Teilnehmer spielt 5 Spiele gegen zufällig ausgeloste Gegner. Wiederholte Begegnungen werden nach Möglichkeit vermieden. Bei ungerader Teilnehmerzahl gibt es pro Runde ein Freilos, das als Sieg zählt (gleichmäßig verteilt). Die Tabelle sortiert nach Siegen, Leg-Differenz, gewonnenen Legs und zuletzt per Los.
2. **Cup-Einteilung** (bis zu 3 Cups): Das obere Drittel kommt in den **Pro Cup**, das mittlere in den **Advanced Cup**, das untere in den **Beginners Cup**. Überzählige Plätze gehen an die oberen Cups. Die Anzahl der Cups wählt der Admin, voreingestellt sind ca. 4 oder mehr Teilnehmer je Cup.
3. **Cup**: Es gilt Doppel-K.o. Wer einmal verliert, wechselt ins **Losers Bracket** und kann darüber noch das Halbfinale erreichen. Wer zweimal verliert, scheidet aus. Gespielt wird, bis im Winners Bracket und im Losers Bracket je 2 übrig sind.
4. **Halbfinale und Finale** werden im einfachen K.o. gespielt (Winners gegen Losers über Kreuz). Wer hier verliert, ist raus.

Gesetzt wird nach der Vorrunden-Tabelle: In Runde 1 spielt der Beste gegen den Schwächsten, danach werden die Paarungen ausgelost. Hat ein Admin ein Ergebnis falsch eingetragen, kann er die zuletzt ausgeloste Runde zurücknehmen und das Ergebnis korrigieren.

### Punkte (Standard, je Season änderbar)

| | Sieger | Finalist | Halbfinale | sonstige |
|---|---|---|---|---|
| Pro Cup | 20 | 15 | 10 | 5 |
| Advanced Cup | 12 | 9 | 6 | 3 |
| Beginners Cup | 8 | 6 | 4 | 2 |

Dazu kommen **1 Punkt für die Teilnahme** und **1 Punkt je Vorrunden-Sieg** (Freilose ausgenommen). Im Doppel erhalten beide Spieler die Punkte. In die Season-Wertung fließen nur abgeschlossene Termine ein.

## Aufbau

```
server.js            HTTP-Server (node:http)
src/tournament.js    Turnier-Logik (Vorrunde, Cups, Doppel-K.o., Punkte)
src/app.js           REST-API, Sessions, Rechte
src/store.js         JSON-Speicher, Passwort-Hashing (scrypt)
public/              Oberfläche (Vanilla JS, ohne Build-Schritt)
test/                node:test-Tests
```
