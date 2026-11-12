# Repository-Anweisungen

Wende Ockham’s Razor auf Implementierung, Tests und Dokumentation an.
Arbeite auf eigenen Branches und erhalte bestehende Änderungen. Respektiere
bestehende Tests und schwäche sie nicht ab. Prüfe Integrationsänderungen mit
echten Jobs auf Rancher Desktop. Verwende die bestehende generische
GRETL-Runtime. Vermeide unnötige Abstraktionen, Hashes und Fingerprints.

Argo Workflows ist die einzige Ausführungsengine. Verwende die nativen
Argo-Ressourcen ohne eigenen Workflow-Controller. Katalog, Workflow-Vertrag und
fachlicher Code eines Laufs stammen aus derselben Git-Revision. Fachliche
Rechte prüft der Launcher serverseitig. Freigaben beziehen sich auf konkrete
Läufe und Datenstände. Verifiziere Änderungen mit echten Integrationsläufen
und einer unabhängigen Abnahme.
