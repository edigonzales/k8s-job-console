# Kubernetes Job Console

GRETL-Jobs in Headlamp parametrisieren, starten und überwachen. Der Generator
liest die Definitionen aus Git und erzeugt Katalog, Script-ConfigMaps und
CronJobs. Der Launcher validiert Eingaben und startet Kubernetes Jobs. Bei
Dateiuploads speichert er die Daten in RustFS. Ein InitContainer legt die
Eingaben für GRETL ab. Kubernetes liefert Status, Zeitpläne und Pod-Logs.

## Lokal starten

Vorausgesetzt sind macOS, Rancher Desktop mit Moby und aktiviertem Kubernetes,
Node.js 22, Java 25, Git, OpenSSL, Python 3, jq und rg. Die Repositories
`gretl-runtime` und `gretl-runtime-jobs` liegen neben diesem Checkout.
`GRETL_DIR` und `JOBS_DIR` können auf andere Checkouts zeigen.

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

Headlamp v0.46.0 und Launcher sind über einen Loopback-Port-Forward und
denselben Browser-Origin erreichbar. Der Reverse Proxy leitet
`/job-console-api/` an den internen Launcher weiter. Beide Dienste verwenden
ClusterIP. Der Launcher ist ausdrücklich für lokalen Einzelbenutzerbetrieb
konfiguriert. Für Mehrbenutzerbetrieb sind Authentisierung, Autorisierung,
TLS und eine geeignete Secret-Verwaltung erforderlich.

`dev-up.sh` baut bei Bedarf das generische GRETL-Image mit der Buildroutine des
Runtime-Repositorys. Für einen beabsichtigten Neubau entferne den lokalen Tag
`job-console-gretl:local` vor dem nächsten Start. `dev-down.sh` entfernt die
Anwendung und behält den RustFS-Datenträger. `dev-down.sh --purge-storage`
entfernt den reservierten Namespace samt Daten.

## Jobs bereitstellen

```sh
npm ci
npm run build
npm run generate -- --jobs-dir ../gretl-runtime-jobs --output build/generated
./scripts/deploy-jobs.sh
```

Die Ausgabedateien enthalten Katalog, ConfigMaps und CronJobs. Das Deployment
validiert sie am Kubernetes-API-Server und lädt den Launcher nach Änderungen
neu. Der Generator unterstützt numerische fünfstellige Kubernetes-Cron-Ausdrücke,
übliche Monats- und Wochentagskürzel sowie `H`, `H(min-max)` und `H/step`
in Minuten und Stunden. Kubernetes interpretiert den Zeitplan in der
angegebenen Zeitzone. Bei Zeitumstellungen können lokale Uhrzeiten ausfallen
oder wiederholt auftreten.

Die Job-Definition ist auf 32 Parameter begrenzt. Pro Upload sind maximal
512 MiB pro Datei und 1 GiB Nutzdaten pro Ausführung zulässig. RustFS bewahrt
Objekte standardmässig sieben Tage auf. Die Grenze lässt sich über
`S3_RETENTION_DAYS` beim Initialisieren des Buckets konfigurieren. Die übrigen
S3-Einstellungen stehen in `deploy/storage.yaml`, Zugangsdaten im Kubernetes
Secret. Job-Pods mounten die Eingaben read-only. Die Scripts stammen aus dem
vertrauenswürdigen Job-Repository und sind ausführbarer Code.

Abgeschlossene Jobs haben sieben Tage TTL. CronJobs bewahren bis zu drei
erfolgreiche und zwei fehlgeschlagene Ausführungen auf. Ein Abbruch suspendiert
den Job, damit Kubernetes den Pod beendet und keine weiteren Pods startet.
Abgebrochene Jobs bleiben über die API abrufbar, bis sie gelöscht werden.
Pod-Logs sind verfügbar, solange Kubernetes den Pod aufbewahrt.

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
Er testet reale Jobs, einen 100-MiB-Upload, Abbruch, Zeitplanung und Neustart.
Für den Abbruchtest wird ein temporärer Job in den Katalog aufgenommen und
am Ende entfernt. Der E2E-Test stellt den ursprünglichen Zeitplan wieder her.

Bei Startproblemen prüfe `kubectl -n job-console get pods` und
`kubectl -n job-console logs deploy/launcher`. Wenn der Port-Forward beim
Austausch des Headlamp-Pods endet, starte `dev-open.sh` erneut.
