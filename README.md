# Kubernetes Job Console

GRETL-Jobs in Headlamp parametrisieren, starten und überwachen. Der Generator
liest Schema-V2-Definitionen aus einem Git-Commit. Der Launcher startet manuelle
Ausführungen über die interne Argo-API. Zeitpläne verwenden Argo CronWorkflows.
Argo lädt die vollständige Git-Revision und die RustFS-Eingaben, startet GRETL
und speichert deklarierte Ergebnisdateien in RustFS.

## Lokal starten

Vorausgesetzt sind macOS, Rancher Desktop mit Moby und aktiviertem Kubernetes,
Node.js 22, Java 25, Git, OpenSSL, Python 3, jq und rg. Der Runtime-Checkout liegt standardmässig neben der Console.
`GRETL_DIR` kann auf einen anderen Checkout zeigen.

```sh
kubectl config use-context rancher-desktop
docker context use rancher-desktop
./scripts/dev-up.sh
./scripts/dev-open.sh
```

Öffne [Headlamp](http://127.0.0.1:4466/), solange `dev-open.sh` läuft.
Wähle **Hello GRETL** für einen Start mit Nachricht, Wiederholungszahl und
Grossschreibung. Für **CSV analysieren** verwende `testdata/sample.csv` aus dem
Job-Repository. **Zeitbericht** kann manuell gestartet werden und erscheint
unter **Zeitpläne**. Das Design folgt dem Headlamp-Theme.

Headlamp v0.46.0, OAuth2 Proxy und der Launcher verwenden denselben
Browser-Origin. OAuth2 Proxy schützt den Einstieg, und der Launcher
prüft Signatur, Issuer, Ablauf und API-Audience des Access Tokens.
Benutzer- und Gruppenrechte stehen im Job-Katalog. Eine explizite
Benutzerkennung ist das JSON-Paar `["issuer","subject"]` als YAML-String.
Gruppennamen werden exakt verglichen. Ein Start-, Freigabe- oder
Verwaltungsrecht gewährt die notwendige Sichtbarkeit.

Die lokale Installation importiert in Keycloak einen Test-Realm mit
`admin`, `operator`, `reviewer`, `viewer` und `outsider`. Die zufällig
erzeugten Passwörter stehen im Kubernetes Secret
`job-console-local-realm` in `realm.json` unter `users`. Das Secret
ist für den lokalen Rancher-Desktop-Namespace vorgesehen. Die
Test-Sitzungen und Access Tokens laufen nach fünf Minuten ab.
Für eine Installation ausserhalb der lokalen Entwicklung setzt der
Launcher HTTPS-Origins, HTTPS-Issuer und HTTPS-JWKS voraus. Die
lokale Keycloak-Konfiguration und Branch-Vorschau bleiben dort deaktiviert.

`dev-up.sh` baut das generische GRETL-Image aus dem Runtime-Checkout und
kennzeichnet den lokalen Build mit seiner Image-ID. Der offizielle
[Argo-Namespace-Installer v4.1.6](https://github.com/argoproj/argo-workflows/releases/tag/v4.1.6)
stellt einen Workflow-Controller und einen internen API-Server bereit.
`dev-down.sh` erhält den RustFS-Datenträger. `dev-down.sh --purge-storage`
entfernt den Datenträger ausdrücklich.

## Jobs bereitstellen

Der Seeder holt alle fünf Minuten den konfigurierten Jobs-Branch aus Git.
**Jetzt synchronisieren** in Headlamp und `./scripts/deploy-jobs.sh` starten
denselben Argo-Workflow. Die lokale Entwicklung verwendet den expliziten
V2-Branch `feature/v2-job-console`, solange dieser separat abgenommen
wird. `JOBS_REPOSITORY` und `JOBS_REF` lassen sich beim lokalen Start
setzen. Für ein privates Repository kann das Secret `job-console-git`
mit den schreibgeschützten Feldern `username` und `password` hinterlegt
werden.

Der Generator bleibt lokal aufrufbar.

```sh
npm ci
npm run build
npm run generate -- --jobs-dir ../gretl-runtime-jobs --image job-console-gretl:BUILD_ID
```

Der Seeder prüft die Definitionen und erstellt unveränderliche
WorkflowTemplates, bevor er den aktiven Katalog aktualisiert.
Fehlerhafte Definitionen lassen den letzten Katalog aktiv.
Vorschau-Branches sind auf die Entwicklungsumgebung begrenzt. Der
Seeder aktiviert deren Zeitpläne nicht. Der Generator unterstützt
`H`, `H(min-max)` und `H/step` in Minuten und Stunden. Argo verwendet
die angegebene Zeitzone. Bei Zeitumstellungen können lokale Uhrzeiten
ausfallen oder wiederholt auftreten.

Eine Definition unterstützt bis zu 32 Parameter mit zusammen höchstens
128 KiB serialisierten Werten. Der Launcher verarbeitet jeweils einen
Dateiupload mit höchstens 512 MiB pro Datei und 1 GiB pro Ausführung.
RustFS bewahrt Eingaben und Ergebnisse standardmässig 30 Tage auf.
Zugangsdaten liegen im Kubernetes Secret. GRETL erhält Parameter über
die native JSON-Parameterdatei, Eingaben unter `/inputs` und
systemgesetzte Ausgabepfade unter `/outputs`.

Serielle Jobs verwenden einen Argo-Mutex je stabiler Job-ID. Manuelle und
geplante Läufe teilen dieselbe Sperre. Lokale Mutexes setzen einen aktiven
Workflow-Controller voraus. Die Console behält abgeschlossene Workflows
sieben Tage. Sie zeigt die Git-Revision, das Runtime-Image, Logs und
verfügbare Ergebnisdateien. **Abbrechen** terminiert über Argo.
**Wiederholen** startet einen neuen Lauf mit dem aktuellen Katalogstand.
Bei Dateieingaben führt der Link zurück zum Startformular.

## Tests und Fehlerdiagnose

```sh
npm test
npm --prefix apps/headlamp-plugin ci
npm --prefix apps/headlamp-plugin run check
npm run plugin
npx playwright install chromium
./scripts/e2e.sh
```

Der E2E-Test braucht eine laufende lokale Installation und den Port-Forward.
Er prüft reale GRETL-Läufe, Browserdownloads, Streaming-Uploads,
Abbruch und gemeinsame Sperren. Der V2-0-Durchstich
`./scripts/argo-smoke.sh` braucht zusätzlich das Runtime-Image
`job-console-gretl:18eaf3254a16`, gebaut vom Runtime-Commit
`18eaf3254a16c121362b78406be7c01c95f152c7`.

Bei Startproblemen prüfe `kubectl -n job-console get pods` und
`kubectl -n job-console logs deploy/launcher`. Wenn der Port-Forward beim
Austausch des Headlamp-Pods endet, starte `dev-open.sh` erneut.
