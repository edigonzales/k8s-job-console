FROM ghcr.io/headlamp-k8s/headlamp:v0.46.0
RUN mkdir -m 0755 /headlamp/plugins/job-console
COPY --chmod=644 package.json dist/main.js /headlamp/plugins/job-console/
